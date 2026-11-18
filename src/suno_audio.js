import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { pool } from './db.js';
import { SunoError, publicError } from './suno_errors.js';

// Download da faixa Suno por proxy (T5, contrato v3 FINAL + RN16/v3.2):
//   GET /device/music/generations/:id/tracks/:n/audio
// Faz stream do audio_url guardado em music_generation_tracks, sem gravar em
// disco. Qualquer device pareado da MESMA conta PIA pode baixar (confere
// account_id, não device_id). O link do Suno nunca sai em header, erro ou log.

export const sunoAudio = {
  maxBytes: 100 * 1024 * 1024, // 100 MiB
  maxRedirects: 3,
  headersTimeoutMs: 30000, // até receber os headers do upstream (cada salto)
  idleTimeoutMs: 30000, // sem bytes do upstream durante o corpo
  allowLoopbackForTests: false, // libera http:// e 127.0.0.0/8 / ::1 (só testes)
  lookup: dnsLookup, // (host, options, callback); injetável nos testes
};

const AUDIO_TYPES = /^(audio\/[a-z0-9.+-]+|application\/octet-stream)(\s*;.*)?$/i;
const RANGE = /^bytes=(\d+)-(\d*)$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Faixa da conta. Store Postgres sobre music_generations/music_generation_tracks.

export const pgTrackStore = {
  // { generation: false } | { generation: true, audio_url: string | null }
  async findTrack(accountId, generationId, n) {
    const { rows: [row] } = await pool.query(`SELECT g.source, t.audio_url FROM pia_server.music_generations g
      LEFT JOIN pia_server.music_generation_tracks t ON t.generation_id=g.id AND t.n=$3
      WHERE g.id=$1 AND g.account_id=$2`, [generationId, accountId, n]);
    if (!row) return { generation: false };
    return { generation: true, audio_url: row.source === 'suno' && row.audio_url ? row.audio_url : null };
  },
};

let store = pgTrackStore;
export function useSunoTrackStore(next) { store = next || pgTrackStore; }

// ---------------------------------------------------------------------------
// Erros (texto fixo, nunca com o link).

const generationNotFound = () => new SunoError('music_generation_not_found', 'Geração não encontrada.', 404);
const trackNotFound = () => new SunoError('suno_track_not_found', 'Esta faixa não tem áudio do Suno para baixar.', 404);
const trackUnavailable = () => new SunoError('suno_track_unavailable', 'Esta música não está mais disponível no Suno.', 410);
const unavailable = () => new SunoError('suno_unavailable', 'Suno indisponível no momento, tente de novo ou use outro gerador', 502);
const timeout = () => new SunoError('suno_timeout', 'O Suno não respondeu a tempo.', 502);
const tooLarge = () => new SunoError('suno_track_too_large', 'O áudio passa do limite de 100 MiB.', 502);
const blocked = () => new SunoError('download_failed', 'Não foi possível baixar a música. Tente de novo pelo Histórico.', 502);

// ---------------------------------------------------------------------------
// Destino seguro: só https (http só em loopback com a flag de teste), sem
// credenciais na URL, e IPs públicos depois da resolução DNS.

const privateRanges = new BlockList();
for (const [net, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) privateRanges.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96],
  ['2001:db8::', 32], ['100::', 64]]) privateRanges.addSubnet(net, prefix, 'ipv6');
const loopbacks = new BlockList();
loopbacks.addSubnet('127.0.0.0', 8, 'ipv4');
loopbacks.addAddress('::1', 'ipv6');

function mappedV4(address) {
  const match = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return match ? match[1] : null;
}

const split = (address) => {
  const v4 = isIP(address) === 6 ? mappedV4(address) : null;
  return v4 ? [v4, 'ipv4'] : [address, isIP(address) === 6 ? 'ipv6' : 'ipv4'];
};
const isLoopback = (address) => isIP(address) > 0 && loopbacks.check(...split(address));

// `loopbackOnly`: destino http:// (só com allowLoopbackForTests) precisa
// resolver para loopback. https:// precisa resolver para IP público; loopback
// só passa com a flag de teste.
export function allowedAddress(address, { loopbackOnly = false } = {}) {
  if (!isIP(address)) return false;
  if (isLoopback(address)) return sunoAudio.allowLoopbackForTests;
  return !loopbackOnly && !privateRanges.check(...split(address));
}

function safeLookup(loopbackOnly) {
  return (hostname, options, callback) => {
    sunoAudio.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: isIP(addresses) }];
      if (!list.length || list.some((item) => !allowedAddress(item.address, { loopbackOnly })))
        return callback(Object.assign(new Error('blocked address'), { code: 'PIA_BLOCKED_ADDRESS' }));
      if (options?.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  };
}

function checkUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw blocked(); }
  if (url.username || url.password) throw blocked();
  const loopbackOnly = url.protocol === 'http:';
  if (loopbackOnly ? !sunoAudio.allowLoopbackForTests : url.protocol !== 'https:') throw blocked();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !allowedAddress(host, { loopbackOnly })) throw blocked(); // IP literal não passa pelo DNS
  return { url, loopbackOnly };
}

// ---------------------------------------------------------------------------
// Upstream.

function requestOnce({ url, loopbackOnly }, headers, signal) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(url, { method: 'GET', headers, lookup: safeLookup(loopbackOnly), signal, agent: false });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('headers timeout'), { code: 'PIA_TIMEOUT' })), sunoAudio.headersTimeoutMs);
    req.once('response', (res) => { clearTimeout(timer); resolve({ req, res }); });
    req.once('error', (error) => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

function upstreamError(error, signal) {
  if (error instanceof SunoError) return error;
  if (signal?.aborted) return Object.assign(new Error('client gone'), { clientGone: true });
  if (error?.code === 'PIA_BLOCKED_ADDRESS') return blocked();
  if (error?.code === 'PIA_TIMEOUT' || error?.name === 'TimeoutError') return timeout();
  return unavailable();
}

async function openUpstream(rawUrl, { range, signal }) {
  let target = checkUrl(rawUrl);
  const headers = { Accept: 'audio/*, application/octet-stream;q=0.5', 'User-Agent': 'pia-server', 'Accept-Encoding': 'identity' };
  if (range) headers.Range = range;
  for (let hop = 0; ; hop++) {
    let opened;
    try { opened = await requestOnce(target, headers, signal); } catch (error) { throw upstreamError(error, signal); }
    const { res } = opened;
    if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
      res.resume();
      const location = res.headers.location;
      if (!location || hop >= sunoAudio.maxRedirects) throw blocked();
      let next;
      try { next = new URL(location, target.url).toString(); } catch { throw blocked(); }
      target = checkUrl(next); // cada salto revalidado (esquema, IP literal e DNS)
      continue;
    }
    return opened;
  }
}

function statusError(status) {
  if ([401, 403, 404, 410].includes(status)) return trackUnavailable();
  if (status === 408 || status === 504) return timeout();
  return unavailable();
}

// Faz o stream da faixa para `res`. Erros antes dos headers viram JSON; depois
// dos headers só derrubam a conexão (o cliente vê o corpo incompleto).
export async function streamSunoTrack(account, generationId, rawN, req, res) {
  if (!uuid.test(generationId || '')) throw generationNotFound();
  const n = /^\d{1,2}$/.test(rawN || '') ? Number(rawN) : 0; // 0 nunca existe (n começa em 1)
  const found = await store.findTrack(account.id, generationId.toLowerCase(), n);
  if (!found.generation) throw generationNotFound();
  if (!Number.isInteger(n) || n < 1 || !found.audio_url) throw trackNotFound();
  const rawRange = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
  const range = RANGE.test(rawRange) && (!RANGE.exec(rawRange)[2] || Number(RANGE.exec(rawRange)[2]) >= Number(RANGE.exec(rawRange)[1]))
    ? rawRange : null; // só um intervalo simples; o resto é ignorado (200 inteiro)

  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort); // cliente desconectou: aborta o upstream
  let upstream;
  try {
    upstream = await openUpstream(found.audio_url, { range, signal: controller.signal });
  } catch (error) {
    res.off('close', abort);
    throw error;
  }
  const { req: upstreamReq, res: upstreamRes } = upstream;
  const fail = (error) => { upstreamRes.resume(); upstreamReq.destroy(); res.off('close', abort); throw error; };
  const status = upstreamRes.statusCode;
  if (status === 416 && range) fail(new SunoError('bad_request', 'Intervalo inválido.', 416));
  if (status !== 200 && !(status === 206 && range)) fail(statusError(status));
  const type = String(upstreamRes.headers['content-type'] || '');
  if (!AUDIO_TYPES.test(type)) fail(blocked());
  const declared = upstreamRes.headers['content-length'];
  const length = declared !== undefined && /^\d+$/.test(declared) ? Number(declared) : null;
  if (length !== null && length > sunoAudio.maxBytes) fail(tooLarge());

  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (length !== null) headers['Content-Length'] = String(length);
  if (upstreamRes.headers['accept-ranges'] === 'bytes') headers['Accept-Ranges'] = 'bytes';
  if (status === 206 && /^bytes \d+-\d+\/(\d+|\*)$/.test(upstreamRes.headers['content-range'] || ''))
    headers['Content-Range'] = upstreamRes.headers['content-range'];
  res.writeHead(status, headers);

  let bytes = 0;
  await new Promise((resolve) => {
    let idle;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      res.off('close', abort);
      if (!ok) { upstreamReq.destroy(); res.destroy(); }
      resolve();
    };
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => finish(false), sunoAudio.idleTimeoutMs); };
    arm();
    upstreamRes.on('data', (chunk) => {
      if (done) return;
      bytes += chunk.length;
      if (bytes > sunoAudio.maxBytes || (length !== null && bytes > length)) return finish(false);
      arm();
      if (!res.write(chunk)) { upstreamRes.pause(); res.once('drain', () => upstreamRes.resume()); }
    });
    upstreamRes.once('end', () => {
      if (length !== null && bytes !== length) return finish(false); // truncado
      res.end();
      finish(true);
    });
    upstreamRes.once('aborted', () => finish(false));
    upstreamRes.once('error', () => finish(false));
    res.once('close', () => { if (!res.writableFinished) finish(false); });
  });
}

// ---------------------------------------------------------------------------
// Rota.

const TRACK_PATH = /^\/device\/music\/generations\/([^/]+)\/tracks\/([^/]+)\/audio$/;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function sunoAudioRoute(req, res, url, { authenticateDevice }) {
  const match = TRACK_PATH.exec(url.pathname);
  if (!match) return false;
  try {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); send(res, 405, { error: 'Método indisponível.', code: 'bad_request' }); return true; }
    const account = await authenticateDevice(req.headers.authorization);
    if (!account) { send(res, 401, { error: 'Pareamento inválido.' }); return true; }
    let id, n;
    try { id = decodeURIComponent(match[1]); n = decodeURIComponent(match[2]); } catch { throw generationNotFound(); }
    await streamSunoTrack(account, id, n, req, res);
  } catch (error) {
    if (res.headersSent) { res.destroy(); return true; }
    if (error?.clientGone) { res.destroy(); return true; }
    const known = publicError(error);
    if (known) send(res, known.status, known.body);
    else { console.error('Falha no download da faixa Suno.'); send(res, 500, { error: 'A operação falhou.', code: 'internal_error' }); }
  }
  return true;
}
