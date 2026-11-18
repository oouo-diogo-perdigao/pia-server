/**
 * Histórico de gerações de música da conta PIA (T5b; RN13, RN14, RN25/CA24 dos requisitos v3.2).
 *
 * Rotas de dispositivo (Authorization: Bearer <token do device>, como as outras /device/*):
 *
 *   POST /device/music/generations
 *     Registra uma geração LOCAL (Local/ACE-Step, Gemini e demais provedores locais). O registro
 *     source 'suno' é criado pelo job do Suno (T4), nunca por esta rota.
 *     Body: { source: 'local', client_id: uuid, prompt, provider?='local', lyrics?, title?, duration?,
 *             instrumental?=false, count?=1, state?='completed', code?, created?, tracks?: [{ n, title?,
 *             duration?, extra?=false }] }
 *     Idempotente por (account_id, client_id): 201 com o item na primeira vez; 200 com o MESMO item
 *     (o registro original, ignorando diferenças no body) nas repetições.
 *     Nunca aceita audio_url (nem no item nem nas faixas): o áudio local fica só no PC.
 *
 *   GET /device/music/generations?limit=100&cursor=
 *     Histórico da conta do device (todos os PCs da conta), jobs ativos (queued/running) primeiro e
 *     depois do mais novo para o mais antigo: ORDER BY ativo DESC, created DESC, id DESC.
 *     Resposta: { items: [{ id, client_id, source, provider, device_id, from_this_device,
 *       suno_account: { id, name } | null, prompt, lyrics, count, duration, state, code, created,
 *       tracks: [{ n, title, duration, extra }] }], next_cursor: string | null }.
 *     audio_url nunca sai (nem nas faixas). limit de 1 a 100 (padrão 100).
 *     O cursor é opaco (base64url de { a: ativo, c: created com microssegundos, i: id }) e só
 *     posiciona a página: o filtro por account_id vale sempre, então um cursor forjado ou de outra
 *     conta nunca mostra itens alheios. Cursor malformado -> 400 invalid_cursor.
 *
 *   DELETE /device/music/generations/:id
 *     HARD delete (v3.2): apaga o registro, o prompt, a letra e as faixas (com os links), em cascata.
 *     Qualquer device da conta pode apagar; some para todos os PCs. Não apaga arquivo no PC.
 *     200 { ok: true }. Id de outra conta, inexistente, já apagado ou malformado -> 404
 *     music_generation_not_found (não revela se existe). Geração ativa (queued/running) -> 409
 *     music_generation_active: o job do Suno (T4) ainda escreve nela; cancele primeiro.
 *
 * Erros: 4xx { error, code }.
 */
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

export const MAX_PAGE = 100;
export const ACTIVE_STATES = Object.freeze(['queued', 'running']);
export const STATES = Object.freeze(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']);
export const LOCAL_STATES = Object.freeze(['completed', 'failed', 'interrupted', 'cancelled']);
const LIMITS = Object.freeze({ prompt: 4000, lyrics: 20000, title: 200, tracks: 20, duration: 3600, count: 10 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER = /^[a-z][a-z0-9_]{0,31}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const BODY_LIMIT = 256 * 1024;
const BACKDATE_MS = 31 * 24 * 3600 * 1000; // fila local: até 30 dias (DECISÕES DE CONTRATO)
const FUTURE_MS = 5 * 60 * 1000;

export class MusicGenerationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.musicCode = code;
  }
}

const invalid = (code, message) => new MusicGenerationError(400, code, message);
const notFound = () => new MusicGenerationError(404, 'music_generation_not_found', 'Geração não encontrada.');

function optionalText(data, field, max) {
  const value = data[field];
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw invalid('invalid_' + field, `Campo ${field} inválido.`);
  return value;
}

function optionalInteger(value, field, min, max) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < min || value > max) throw invalid('invalid_' + field, `Campo ${field} inválido.`);
  return value;
}

function hasAudioUrl(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'audio_url');
}

/** Valida o body do POST local e devolve os valores normalizados. */
export function validateLocalGeneration(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid('invalid_body', 'Objeto JSON obrigatório.');
  if (data.source === 'suno') {
    throw invalid('music_source_not_allowed', 'Gerações do Suno são registradas pelo servidor.');
  }
  if (data.source !== 'local') throw invalid('invalid_source', 'Campo source deve ser "local".');
  if (typeof data.client_id !== 'string' || !UUID.test(data.client_id)) throw invalid('invalid_client_id', 'client_id deve ser um UUID.');
  if (hasAudioUrl(data) || (Array.isArray(data.tracks) && data.tracks.some(hasAudioUrl))) {
    throw invalid('audio_url_not_allowed', 'O áudio de gerações locais fica só no computador.');
  }
  const provider = data.provider ?? 'local';
  if (typeof provider !== 'string' || !PROVIDER.test(provider) || provider.startsWith('suno')) {
    throw invalid('invalid_provider', 'Provedor local inválido.');
  }
  if (typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > LIMITS.prompt) {
    throw invalid('invalid_prompt', 'Informe o prompt (até 4000 caracteres).');
  }
  if (data.instrumental != null && typeof data.instrumental !== 'boolean') throw invalid('invalid_instrumental', 'Campo instrumental inválido.');
  const state = data.state ?? 'completed';
  if (!LOCAL_STATES.includes(state)) throw invalid('invalid_state', 'Estado final inválido para geração local.');
  const code = data.code ?? null;
  if (code !== null && (typeof code !== 'string' || !CODE.test(code))) throw invalid('invalid_code', 'Campo code inválido.');
  let created = null;
  if (data.created != null) {
    const time = typeof data.created === 'string' ? Date.parse(data.created) : NaN;
    if (!Number.isFinite(time) || time < Date.now() - BACKDATE_MS || time > Date.now() + FUTURE_MS) {
      throw invalid('invalid_created', 'Data da geração inválida.');
    }
    created = new Date(time).toISOString();
  }
  const tracks = data.tracks ?? [];
  if (!Array.isArray(tracks) || tracks.length > LIMITS.tracks) throw invalid('invalid_tracks', 'Faixas inválidas.');
  const seen = new Set();
  const normalized = tracks.map((track) => {
    if (!track || typeof track !== 'object' || Array.isArray(track)) throw invalid('invalid_tracks', 'Faixas inválidas.');
    const n = optionalInteger(track.n, 'tracks', 1, LIMITS.tracks);
    if (n === null || seen.has(n)) throw invalid('invalid_tracks', 'Número de faixa inválido ou repetido.');
    seen.add(n);
    if (track.extra != null && typeof track.extra !== 'boolean') throw invalid('invalid_tracks', 'Faixas inválidas.');
    return {
      n,
      title: optionalText(track, 'title', LIMITS.title),
      duration: optionalInteger(track.duration, 'duration', 0, LIMITS.duration),
      extra: track.extra ?? false,
    };
  });
  return {
    client_id: data.client_id.toLowerCase(),
    provider,
    prompt: data.prompt,
    lyrics: optionalText(data, 'lyrics', LIMITS.lyrics),
    title: optionalText(data, 'title', LIMITS.title),
    duration: optionalInteger(data.duration, 'duration', 1, LIMITS.duration),
    instrumental: data.instrumental ?? false,
    count: optionalInteger(data.count, 'count', 1, LIMITS.count) ?? 1,
    state,
    code,
    created,
    tracks: normalized,
  };
}

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ a: row.active, c: row.created_key, i: row.id })).toString('base64url');
}

/** Decodifica o cursor; qualquer coisa fora do formato vira 400 invalid_cursor. */
export function decodeCursor(cursor) {
  const fail = () => invalid('invalid_cursor', 'Cursor inválido.');
  if (typeof cursor !== 'string' || !cursor || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw fail();
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw fail();
  }
  if (!value || typeof value !== 'object' || typeof value.a !== 'boolean' || typeof value.c !== 'string' ||
      !CURSOR_TIME.test(value.c) || !Number.isFinite(Date.parse(value.c)) || typeof value.i !== 'string' || !UUID.test(value.i)) {
    throw fail();
  }
  return { active: value.a, created: value.c, id: value.i.toLowerCase() };
}

export function parseLimit(raw) {
  if (raw == null || raw === '') return MAX_PAGE;
  if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_PAGE) throw invalid('invalid_limit', 'limit deve ser de 1 a 100.');
  return Number(raw);
}

/**
 * Conta Suno do item: { id, name } com name = label (apelido do RN07) → suno_name → suno_email
 * → suno_account_name (nome guardado na criação do job). O join também exige a mesma conta PIA,
 * por defesa. Conta apagada (SET NULL): { id: null, name: nome guardado }. Sem conta nenhuma -> null.
 */
export const SUNO_ACCOUNT_SQL = Object.freeze({
  join: 'LEFT JOIN pia_server.suno_accounts sa ON sa.id=g.suno_account_id AND sa.account_id=g.account_id',
  name: 'COALESCE(sa.label, sa.suno_name, sa.suno_email, g.suno_account_name)',
});

const ITEM_COLUMNS = `g.id,g.client_id,g.source,g.provider,g.device_id,g.suno_account_id,
  ${SUNO_ACCOUNT_SQL.name} AS suno_account_name,g.prompt,g.lyrics,g.count,g.duration,g.state,g.code,g.created,
  (g.state IN ('queued','running')) AS active,
  to_char(g.created AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key,
  (SELECT COALESCE(json_agg(json_build_object('n',t.n,'title',t.title,'duration',t.duration,'extra',t.extra)
    ORDER BY t.n), '[]'::json) FROM pia_server.music_generation_tracks t WHERE t.generation_id=g.id) AS tracks`;

/** Monta o item público: lista branca de campos, sem audio_url em lugar nenhum. */
export function publicItem(row, deviceId) {
  const tracks = Array.isArray(row.tracks) ? row.tracks : [];
  return {
    id: row.id,
    client_id: row.client_id,
    source: row.source,
    provider: row.provider,
    device_id: row.device_id ?? null,
    from_this_device: Boolean(deviceId && row.device_id && row.device_id === deviceId),
    suno_account: row.suno_account_id || row.suno_account_name
      ? { id: row.suno_account_id ?? null, name: row.suno_account_name ?? null } : null,
    prompt: row.prompt,
    lyrics: row.lyrics ?? null,
    count: row.count,
    duration: row.duration ?? null,
    state: row.state,
    code: row.code ?? null,
    created: row.created instanceof Date ? row.created.toISOString() : row.created,
    tracks: tracks.map((track) => ({ n: track.n, title: track.title ?? null, duration: track.duration ?? null, extra: Boolean(track.extra) })),
  };
}

async function itemByClientId(accountId, clientId) {
  const { rows: [row] } = await pool.query(`SELECT ${ITEM_COLUMNS} FROM pia_server.music_generations g
    ${SUNO_ACCOUNT_SQL.join} WHERE g.account_id=$1 AND g.client_id=$2`, [accountId, clientId]);
  return row;
}

/** POST local: { status: 201|200, item }. */
export async function createLocalGeneration(device, data) {
  const value = validateLocalGeneration(data);
  const { rows: [created] } = await pool.query(`
    WITH g AS (
      INSERT INTO pia_server.music_generations(id,account_id,client_id,source,provider,device_id,prompt,lyrics,title,
        count,duration,instrumental,state,code,created)
      VALUES($1,$2,$3,'local',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::timestamptz,now()))
      ON CONFLICT (account_id,client_id) DO NOTHING RETURNING id
    ), t AS (
      INSERT INTO pia_server.music_generation_tracks(generation_id,n,title,duration,extra)
      SELECT g.id,x.n,x.title,x.duration,x.extra FROM g,
        jsonb_to_recordset($15::jsonb) AS x(n integer, title text, duration integer, extra boolean)
      RETURNING 1
    )
    SELECT (SELECT id FROM g) AS id, (SELECT count(*) FROM t) AS tracks`, [
    randomUUID(), device.id, value.client_id, value.provider, device.device_id, value.prompt, value.lyrics,
    value.title, value.count, value.duration, value.instrumental, value.state, value.code, value.created,
    JSON.stringify(value.tracks),
  ]);
  const row = await itemByClientId(device.id, value.client_id);
  if (!row) throw new Error('Registro de geração ausente.');
  return { status: created?.id ? 201 : 200, item: publicItem(row, device.device_id) };
}

/** GET do histórico: { items, next_cursor }. */
export async function listGenerations(device, query = {}) {
  const limit = parseLimit(query.limit);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  const params = [device.id, limit + 1];
  let after = '';
  if (cursor) {
    params.push(cursor.active, cursor.created, cursor.id);
    after = 'AND ((g.state IN (\'queued\',\'running\')), g.created, g.id) < ($3::boolean, $4::timestamptz, $5::uuid)';
  }
  const { rows } = await pool.query(`SELECT ${ITEM_COLUMNS} FROM pia_server.music_generations g
    ${SUNO_ACCOUNT_SQL.join} WHERE g.account_id=$1 ${after}
    ORDER BY (g.state IN ('queued','running')) DESC, g.created DESC, g.id DESC LIMIT $2`, params);
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => publicItem(row, device.device_id)),
    next_cursor: rows.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
}

/** DELETE (hard): { ok: true } ou 404/409. */
export async function deleteGeneration(device, id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw notFound();
  const { rows: [row] } = await pool.query(`WITH target AS (
      SELECT id,state FROM pia_server.music_generations WHERE account_id=$1 AND id=$2
    ), removed AS (
      DELETE FROM pia_server.music_generations g USING target
      WHERE g.id=target.id AND g.account_id=$1 AND target.state NOT IN ('queued','running') RETURNING g.id
    )
    SELECT (SELECT state FROM target) AS state, (SELECT count(*) FROM removed) AS removed`, [device.id, id.toLowerCase()]);
  if (!row?.state) throw notFound();
  if (Number(row.removed) !== 1) {
    throw new MusicGenerationError(409, 'music_generation_active', 'Esta geração ainda está em andamento. Cancele antes de excluir.');
  }
  return { ok: true };
}

async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw invalid('invalid_body', 'Envie JSON.');
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > BODY_LIMIT) throw invalid('invalid_body', 'Corpo acima do limite da rota.');
    parts.push(part);
  }
  try {
    return JSON.parse(Buffer.concat(parts));
  } catch {
    throw invalid('invalid_body', 'JSON inválido.');
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const ITEM_PATH = /^\/device\/music\/generations\/([^/]+)$/;

/**
 * Atende /device/music/generations*. Devolve false se a rota não for desta área.
 * `authenticate(header)` é o authenticateDevice (injetável nos testes).
 */
export async function musicGenerationsRoute(req, res, url, authenticate) {
  const path = url.pathname;
  const item = ITEM_PATH.exec(path);
  if (path !== '/device/music/generations' && !item) return false;
  try {
    const allowed = item ? ['DELETE'] : ['GET', 'POST'];
    if (!allowed.includes(req.method)) {
      res.setHeader('Allow', allowed.join(', '));
      throw new MusicGenerationError(405, 'method_not_allowed', 'Método indisponível.');
    }
    const device = await authenticate(req.headers.authorization);
    if (!device) throw new MusicGenerationError(401, 'device_unauthorized', 'Pareamento inválido.');
    if (item) {
      let id;
      try {
        id = decodeURIComponent(item[1]);
      } catch {
        throw notFound();
      }
      return send(res, 200, await deleteGeneration(device, id)), true;
    }
    if (req.method === 'GET') {
      return send(res, 200, await listGenerations(device, {
        limit: url.searchParams.get('limit'), cursor: url.searchParams.get('cursor'),
      })), true;
    }
    const { status, item: created } = await createLocalGeneration(device, await readJson(req));
    send(res, status, created);
  } catch (error) {
    if (!(error instanceof MusicGenerationError)) throw error;
    send(res, error.status, { error: error.message, code: error.musicCode });
  }
  return true;
}
