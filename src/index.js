import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { begin, cookie, finish, oauthReady, origin } from './auth.js';
import { accountSession, identify, migrate, pool, seal, unseal } from './db.js';
import { DiscordRecorder } from './recorder.js';
import { createFolder } from './drive.js';
import { processRecording, recordings, recover } from './queue.js';
import { hash, validateRules } from './state.js';
import { authenticateDevice, complete, devices, enqueue, jobStatus, pair, poll, revoke } from './devices.js';
import { acknowledge, configure, monitor, pendingNotices, preferences } from './secretary.js';

const runtimes = new Map();
const recovered = new Set();
let tick, closing = false;
const publicFiles = new Map([
  ['/', ['text/html; charset=utf-8', readFileSync(new URL('../web/index.html', import.meta.url))]],
  ['/ui.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../web/ui.js', import.meta.url))]],
]);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function body(req, limit = 65536) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Envie JSON.');
  let size = 0;
  const parts = [];
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new Error('Corpo acima do limite da rota.');
    parts.push(part);
  }
  const data = JSON.parse(Buffer.concat(parts));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Objeto JSON obrigatório.');
  return data;
}

function status(account) {
  const runtime = runtimes.get(account.id)?.runtime;
  return {
    email: account.email, admin: account.admin, discordConfigured: Boolean(account.discord_token),
    discordConnected: runtime?.client.isReady() || false, discordError: runtime?.error || '',
    driveConnected: Boolean(account.drive_refresh), folderId: account.folder_id, rules: account.rules,
    recordings: recordings(account).map(({ meta }) => ({
      id: meta.id, channelId: meta.channelId, name: meta.name, state: meta.state,
      startedAt: meta.startedAt, endedAt: meta.endedAt, note: meta.note, error: meta.lastError,
    })).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50),
  };
}

const mcpTools = [
  { name: 'pia_server_status', description: 'Veja o estado do gravador e os uploads da sua conta.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'pia_devices', description: 'Liste seus computadores pareados e as ações locais autorizadas.',
    inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'pia_device_capture', description: 'Somente quando solicitado, capture câmera ou tela no computador escolhido e salve no Drive privado.',
    inputSchema: { type: 'object', properties: { device: { type: 'string' },
      action: { type: 'string', enum: ['camera', 'screenshot'] } }, required: ['device','action'] } },
  { name: 'pia_device_job', description: 'Consulte o resultado de uma ação local, inclusive o link privado no Drive.',
    inputSchema: { type: 'object', properties: { job: { type: 'string' } }, required: ['job'] },
    annotations: { readOnlyHint: true } },
];

async function mcp(data, account, res) {
  if (data.jsonrpc !== '2.0') return json(res, 400, { error: 'JSON-RPC inválido.' });
  if (data.id === undefined && data.method?.startsWith('notifications/')) { res.writeHead(202); return res.end(); }
  const base = { jsonrpc: '2.0', id: data.id ?? null };
  let result;
  if (data.method === 'initialize') result = { protocolVersion: '2025-06-18',
    capabilities: { tools: {} }, serverInfo: { name: 'pia-server', version: '0.1.0' } };
  else if (data.method === 'ping') result = {};
  else if (data.method === 'tools/list') result = { tools: mcpTools };
  else if (data.method === 'tools/call') {
    const args = data.params?.arguments || {};
    const tool = data.params?.name;
    try {
      let value;
      if (tool === 'pia_server_status') value = status(account);
      else if (tool === 'pia_devices') value = await devices(account);
      else if (tool === 'pia_device_capture') value = await enqueue(account, args.device, args.action);
      else if (tool === 'pia_device_job') value = await jobStatus(account, args.job);
      else throw new Error('Ferramenta indisponível.');
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      result = { isError: true, content: [{ type: 'text', text: error.code ? 'Operação indisponível.' : error.message }] };
    }
  }
  else return json(res, 200, { ...base, error: { code: -32601, message: 'Método ou ferramenta indisponível.' } });
  return json(res, 200, { ...base, result });
}

async function route(req, res) {
  const url = new URL(req.url, origin);
  const path = url.pathname;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, googleLogin: oauthReady() });
  if (req.method === 'GET' && publicFiles.has(path)) {
    const [type, data] = publicFiles.get(path);
    res.writeHead(200, { 'Content-Type': type });
    return res.end(data);
  }
  if (req.method === 'GET' && path === '/auth/google') return begin(req, res);
  if (req.method === 'GET' && path === '/auth/google/callback') return finish(req, res, url);
  if (req.method === 'POST' && ['/device/poll', '/device/complete', '/device/notices/ack',
    '/device/profile/read', '/device/profile/write'].includes(path)) {
    const account = await authenticateDevice(req.headers.authorization);
    if (!account) return json(res, 401, { error: 'Pareamento inválido.' });
    const large = ['/device/complete', '/device/profile/write'].includes(path);
    const input = await body(req, large ? 32 * 1024 * 1024 : undefined);
    if (path === '/device/notices/ack') return json(res, 200, await acknowledge(account, input.ids));
    if (path === '/device/poll') return json(res, 200, {
      ...await poll(account, input.capabilities), notices: await pendingNotices(account),
    });
    if (path === '/device/complete') return json(res, 200, await complete(account, input));
    if (path === '/device/profile/read') {
      const { rows: [profile] } = await pool.query('SELECT revision,ciphertext FROM pia_server.profiles WHERE account_id=$1', [account.id]);
      return json(res, 200, profile ? { revision: profile.revision,
        ...(input.metadata ? {} : { snapshot: JSON.parse(unseal(profile.ciphertext)) }),
      } : { revision: '0' });
    }
    if (typeof input.revision !== 'string' || !/^\d{1,18}$/.test(input.revision) ||
        !input.snapshot || input.snapshot.version !== 1 || typeof input.snapshot.backup !== 'string' ||
        !input.snapshot.chats || typeof input.snapshot.chats !== 'object') throw new Error('Perfil inválido.');
    const ciphertext = seal(JSON.stringify(input.snapshot));
    const result = input.revision === '0' ?
      await pool.query('INSERT INTO pia_server.profiles(account_id,ciphertext) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING revision',
        [account.id, ciphertext]) :
      await pool.query(`UPDATE pia_server.profiles SET ciphertext=$2,revision=revision+1,updated=now()
        WHERE account_id=$1 AND revision=$3 RETURNING revision`, [account.id, ciphertext, input.revision]);
    return result.rowCount ? json(res, 200, result.rows[0]) :
      json(res, 409, { error: 'O perfil do servidor mudou. Confira a versão antes de sincronizar.' });
  }
  if (path === '/mcp') {
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Origem inválida.' });
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const account = await identify(token, 'mcp');
    if (!account) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="PIA Server"');
      return json(res, 401, { error: 'Emita um token MCP no painel após o login Google.' });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
    return mcp(await body(req), account, res);
  }
  if (!path.startsWith('/api/')) return json(res, 404, { error: 'Rota não encontrada.' });
  const session = cookie(req, '__Host-pia_session');
  const account = await identify(session, 'web');
  if (!account) return json(res, 401, { error: 'Entre com Google.' });
  if (req.method === 'GET' && path === '/api/status') return json(res, 200, status(account));
  if (req.method === 'GET' && path === '/api/devices') return json(res, 200, await devices(account));
  if (req.method === 'GET' && path === '/api/secretary') return json(res, 200, await preferences(account));
  if (req.method !== 'POST') return json(res, 405, { error: 'Método indisponível.' });
  if (req.headers.origin !== origin) return json(res, 403, { error: 'Origem inválida.' });
  const data = await body(req);
  if (path === '/api/secretary') return json(res, 200, await configure(account, data));
  if (path === '/api/devices/pair') return json(res, 200, await pair(account, data.name));
  if (path === '/api/devices/revoke') return json(res, 200, await revoke(account, data.id));
  if (path === '/api/rules') {
    const rules = validateRules(data.rules);
    await pool.query('UPDATE pia_server.accounts SET rules=$2 WHERE id=$1', [account.id, JSON.stringify(rules)]);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/discord') {
    const token = typeof data.token === 'string' ? data.token.trim() : '';
    if (typeof token !== 'string' || !/^[\w.-]{30,180}$/.test(token)) throw new Error('Token do bot inválido.');
    const check = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: 'Bot ' + token }, signal: AbortSignal.timeout(10000),
    });
    const bot = check.ok && await check.json();
    if (!bot?.bot || typeof bot.id !== 'string') throw new Error('O Discord não aceitou o token do bot.');
    try {
      await pool.query('UPDATE pia_server.accounts SET discord_token=$2, discord_bot_id=$3 WHERE id=$1',
        [account.id, seal(token), bot.id]);
    } catch (error) {
      if (error.code === '23505') throw new Error('Este bot já está vinculado a outra conta.');
      throw error;
    }
    return json(res, 200, { ok: true });
  }
  if (path === '/api/drive/folder') {
    if (account.folder_id) return json(res, 200, { id: account.folder_id });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [locked] } = await client.query('SELECT * FROM pia_server.accounts WHERE id=$1 FOR UPDATE', [account.id]);
      const folder = locked.folder_id ? { id: locked.folder_id } : await createFolder(locked);
      await client.query('UPDATE pia_server.accounts SET folder_id=$2 WHERE id=$1', [account.id, folder.id]);
      await client.query('COMMIT');
      return json(res, 200, folder);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  if (path === '/api/recordings/stop') {
    const stopped = runtimes.get(account.id)?.runtime.stop(data.channelId);
    return json(res, stopped ? 200 : 404, stopped ? { ok: true } : { error: 'Gravação ativa não encontrada.' });
  }
  if (path === '/api/mcp/token') return json(res, 200, { token: await accountSession(account.id, 'mcp', 24 * 30) });
  if (path === '/api/mcp/revoke') {
    await pool.query("DELETE FROM pia_server.sessions WHERE account_id=$1 AND purpose='mcp'", [account.id]);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/logout') {
    await pool.query('DELETE FROM pia_server.sessions WHERE digest=$1', [hash(session)]);
    res.setHeader('Set-Cookie', '__Host-pia_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (path === '/api/admin/accounts' && account.admin) {
    const email = data.email?.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || email.length > 254) throw new Error('E-mail inválido.');
    await pool.query('INSERT INTO pia_server.accounts(email) VALUES($1) ON CONFLICT(email) DO NOTHING', [email]);
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Rota não encontrada.' });
}

const uploads = new Set();
async function reconcile() {
  await monitor();
  const { rows } = await pool.query('SELECT * FROM pia_server.accounts');
  for (const account of rows) {
    if (closing) return;
    if (!recovered.has(account.id)) { recover(account); recovered.add(account.id); }
    const previous = runtimes.get(account.id);
    if (previous?.encrypted !== account.discord_token) {
      previous?.runtime.close();
      runtimes.delete(account.id);
      if (account.discord_token) runtimes.set(account.id, {
        encrypted: account.discord_token, runtime: new DiscordRecorder(account, unseal(account.discord_token)),
      });
    } else if (previous) {
      const changed = JSON.stringify(previous.runtime.account.rules) !== JSON.stringify(account.rules) ||
        previous.runtime.account.folder_id !== account.folder_id;
      previous.runtime.account = account;
      if (changed) previous.runtime.evaluate();
    }
    if (uploads.has(account.id) || !account.drive_refresh) continue;
    const next = recordings(account).find(({ meta }) => meta.state === 'queued' && (meta.retryAt || 0) <= Date.now());
    if (next) {
      uploads.add(account.id);
      processRecording(account, next).catch(() => console.error('Falha na fila de gravação.'))
        .finally(() => uploads.delete(account.id));
    }
  }
}

await migrate();
const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    if (res.headersSent) { res.end(); return; }
    const message = error.code || error instanceof TypeError ? 'A operação falhou.' : error.message;
    json(res, 400, { error: message });
  });
});
server.listen(Number(process.env.PORT || 8787), '0.0.0.0');
async function loop() {
  try { await reconcile(); }
  catch { console.error('Falha ao atualizar o estado do serviço.'); }
  finally { if (!closing) tick = setTimeout(loop, 5000); }
}
void loop();

function close() {
  closing = true;
  clearTimeout(tick);
  for (const { runtime } of runtimes.values()) runtime.close();
  server.close(() => pool.end().finally(() => process.exit()));
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
