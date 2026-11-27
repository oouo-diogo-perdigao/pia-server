import { mantineCss, workspaceHtml } from './workspace_ui.js';
import { recordingFolder } from './recording_format.js';
import { approveDeviceLogin, beginDeviceLogin, deviceLoginDetails, pollDeviceLogin } from './device_login.js';
import { issueMcpToken } from './mcp_tokens.js';
import { confirmGuildLink, guildLinkRequest } from './discord_guild_links.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { Routes } from 'discord.js';
import { createPodcastWorker } from './podcast_worker.js';
import { resolvePodcastConfig } from './podcast_config.js';
import { createServerRecordingRunner, isServerRecording } from './server_recording.js';
import { accountProfile, begin, cookie, finish, oauthReady, origin } from './auth.js';
import { identify, migrate, pool, seal, unseal } from './db.js';
import { DiscordRecorder } from './recorder.js';
import { createFolder, recordingDestination, recordingFolderPath, recordingFolders } from './drive.js';
import { needsSidecar, prepareRecording, processRecording, processRecordingSidecar, recordings, recover, saveRecordingEdits } from './queue.js';
import { hash, validateRules } from './state.js';
import { authenticateDevice, complete, devices, enqueue, jobStatus, pair, poll, revoke } from './devices.js';
import { acknowledge, configure, monitor, pendingNotices, preferences } from './secretary.js';
import { receiveMedia } from './media.js';
import { accessToken, botCredential, enableDiscordLink, isConnectorCallback, migrateConnectorRows, oauthFinish, oauthStart, publicConnectors, registry, removeConnector, runtime, saveConnector, splitProfile, storageCredential, testConnector } from './connectors.js';
import { renderOAuthCallback } from './oauth_callback.js';
import { authorizationPage } from './auth_page.js';
import { legalFiles } from './legal.js';
import { publicResponse, sendPublic } from './public_files.js';
import { sunoCapabilities, sunoRoute } from './suno_auth.js';
import { publicError } from './suno_errors.js';
import { musicGenerationsRoute } from './music_generations.js';
import { sunoAdminRoute } from './suno_client.js';
import { recoverSunoJobs, sunoJobsRoute } from './suno_jobs.js';
import { sunoAudioRoute } from './suno_audio.js';
import { cleanupOrphanTemp } from './cleanup_tmp.js';
import {
  ADMIN_VPN_ERROR,
  accountStatusFlags,
  authorizeAdminAccount,
  isAdminRequestAuthorized,
  listAdminAccounts,
  setAccountPro,
  setProcessingMode,
} from './admin_routes.js';

const runtimes = new Map();
const discordSlots = {
  primary: { token: 'discord_token', id: 'discord_bot_id' },
  dark: { token: 'discord_dark_token', id: 'discord_dark_bot_id' },
};
const runtimeKey = (id, slot) => slot === 'dark' ? id + ':dark' : id;
const recovered = new Set();
let tick, closing = false;
const publicFiles = new Map([
  ['/', ['text/html; charset=utf-8', workspaceHtml(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'))]],
  ['/ui.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../web/ui.js', import.meta.url))]],
  ['/oauth-callback.js', ['text/javascript; charset=utf-8', readFileSync(new URL('../web/oauth-callback.js', import.meta.url))]],
  ['/pia.svg', ['image/svg+xml', readFileSync(new URL('../web/pia.svg', import.meta.url))]],
  ['/secretary.svg', ['image/svg+xml', readFileSync(new URL('../web/secretary.svg', import.meta.url))]],
  ['/login.css', ['text/css; charset=utf-8', readFileSync(new URL('../web/login.css', import.meta.url))]],
  ['/legal.css', ['text/css; charset=utf-8', readFileSync(new URL('../web/legal.css', import.meta.url))]],
  ['/google-signin.png', ['image/png', readFileSync(new URL('../web/google-signin.png', import.meta.url))]],
  ['/mantine.css', ['text/css; charset=utf-8', mantineCss]],
  ['/style.css', ['text/css; charset=utf-8', readFileSync(new URL('../web/style.css', import.meta.url))]],
  ...legalFiles(origin),
]);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function googleSignIn(path) {
  return '<a href="' + path + '" class="google-signin"><img src="/google-signin.png" alt=""> Continuar com Google</a>';
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

function status(account, req) {
  const runtime = runtimes.get(account.id)?.runtime;
  return {
    ...accountProfile(account), ...accountStatusFlags(account, req), discordConfigured: Boolean(account.discord_token),
    discordConnected: runtime?.client.isReady() || false, discordError: runtime?.error || '',
    discordDarkConfigured: Boolean(account.discord_dark_token),
    discordDarkConnected: runtimes.get(runtimeKey(account.id, 'dark'))?.runtime.client.isReady() || false,
    discordDarkError: runtimes.get(runtimeKey(account.id, 'dark'))?.runtime.error || '',
    driveConnected: Boolean(account.drive_refresh), folderId: recordingFolder(account), folderName: account.recording_folder_name,
    recordingDriveAccount: account.recording_drive_account, rules: account.rules,
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
  if (path.startsWith('/device/') || path === '/mcp' || path === '/health') {
    res.setHeader('X-PIA-Protocol', '1');
  }
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://*.googleusercontent.com; frame-ancestors 'none'; base-uri 'none'");
  if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true, googleLogin: oauthReady() });
  const publicPage = publicResponse(req.method, path, publicFiles);
  if (publicPage) return sendPublic(res, publicPage);
  const blessing = /^\/discord\/bless\/([A-Za-z0-9_-]{43})(\/login)?$/.exec(path);
  if (blessing) {
    const [, token, login] = blessing;
    const target = '/discord/bless/' + token;
    const request = await guildLinkRequest(token);
    if (req.method === 'GET' && login) return begin(req, res, target);
    const account = await identify(cookie(req, '__Host-pia_session'), 'web');
    const escape = (value) => value.replace(/[&<>]/g, (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
    const guild = '<strong>' + escape(request.guild_name) + '</strong>';
    let content;
    if (req.method === 'GET') {
      content = '<p>Servidor Discord: ' + guild + '</p>' + (account ?
        '<p>As novas gravações irão para a conta <strong>' + escape(account.email) + '</strong>.</p>' +
        '<form method="post" action="' + target + '"><button>Confirmar vínculo</button></form>' +
        '<a href="' + target + '/login">Usar outra conta Google</a>' :
        '<p>Entre com a conta PIA que receberá as gravações.</p>' + googleSignIn(target + '/login'));
    } else if (req.method === 'POST' && !login && account && req.headers.origin === origin) {
      await confirmGuildLink(token, account.id);
      content = '<p>Servidor ' + guild + ' abençoado e vinculado à sua conta PIA.</p>' +
        '<a href="/#recordings">Abrir gravações</a>';
    } else return json(res, 403, { error: 'Entre na sua conta PIA e abra o link enviado pelo Discord.' });
    // Formulário (GET) leva a frase de aceite do RF05; o resultado (POST) só os links.
    return authorizationPage(res, 'Vincular Discord à PIA', content, req.method === 'GET' ? 'aceite' : 'links');
  }
  if (req.method === 'POST' && path === '/device/login/start') {
    const result = beginDeviceLogin(await body(req, 2048));
    return json(res, 200, { ...result, url: origin + '/auth/device/' + result.id });
  }
  if (req.method === 'POST' && path === '/device/login/poll')
    return json(res, 200, await pollDeviceLogin(await body(req, 2048)));
  const deviceLogin = /^\/auth\/device\/([A-Za-z0-9_-]{43})(\/login)?$/.exec(path);
  if (deviceLogin) {
    const [, id, login] = deviceLogin;
    const attempt = deviceLoginDetails(id);
    const target = '/auth/device/' + id;
    if (req.method === 'GET' && login) return begin(req, res, target);
    const account = await identify(cookie(req, '__Host-pia_session'), 'web');
    const escape = (value) => value.replace(/[&<>]/g, (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
    let content;
    if (req.method === 'GET' && !login) {
      const signIn = googleSignIn(target + '/login');
      content = '<p>Confira se o código <strong>' + attempt.code + '</strong> aparece em <strong>' +
        escape(attempt.name) + '</strong> antes de autorizar.</p>' + (account ?
        '<p>Conta: ' + escape(account.email) + '</p><form method="post" action="' + target +
        '"><button>Autorizar computador</button></form>' + signIn : signIn);
    } else if (req.method === 'POST' && !login) {
      if (!account) return json(res, 403, { error: 'Entre com Google antes de autorizar o computador.' });
      if (req.headers.origin !== origin) return json(res, 403, {
        error: 'Origem do formulário inválida. Reabra o link na PIA local e tente novamente.',
      });
      approveDeviceLogin(id, account);
      content = '<p>Computador autorizado. Você pode fechar esta aba e voltar à PIA.</p>';
    } else return json(res, 405, { error: 'Método indisponível.' });
    // Formulário (GET) leva a frase de aceite do RF05; o resultado (POST) só os links.
    return authorizationPage(res, 'Entrar na PIA', content, req.method === 'GET' ? 'aceite' : 'links');
  }
  if (req.method === 'GET' && path === '/auth/google') return begin(req, res);
  const connectorCallback = path === '/auth/connectors/microsoft' ? 'microsoft' :
    path === '/auth/google/callback' && isConnectorCallback(url.searchParams.get('state')) ? 'google' : '';
  if (req.method === 'GET' && connectorCallback) {
    const account = await identify(cookie(req, '__Host-pia_session'), 'web');
    if (!account) return json(res, 401, { error: 'Entre com Google primeiro.' });
    await oauthFinish(account, connectorCallback, url.searchParams);
    res.writeHead(303, { Location: '/#connectors' });
    return res.end();
  }
  if (req.method === 'GET' && path === '/auth/google/callback') return finish(req, res, url);
  if (req.method === 'GET' && path === '/oauth/callback') {
    const result = renderOAuthCallback(url);
    res.writeHead(result.status, result.headers);
    return res.end(result.body);
  }
  if (path === '/auth/connectors/suno' || path.startsWith('/device/suno/')) {
    if (path.startsWith('/device/suno/jobs') && await sunoJobsRoute(req, res, url, { authenticateDevice, readBody: body })) return;
    if (await sunoRoute(req, res, url, { authenticateDevice, readBody: body })) return;
  }
  if (req.method === 'POST' && path === '/device/logout') {
    const account = await authenticateDevice(req.headers.authorization);
    if (!account) return json(res, 401, { error: 'Sessão do computador inválida.' });
    return json(res, 200, await revoke(account, account.device_id));
  }
  if (req.method === 'GET' && path === '/device/account') {
    const account = await authenticateDevice(req.headers.authorization);
    if (!account) return json(res, 401, { error: 'Pareamento inválido.' });
    return json(res, 200, { ...accountProfile(account), capabilities: [...sunoCapabilities] });
  }
  if (req.method === 'POST' && path === '/device/media') {
    const account = await authenticateDevice(req.headers.authorization);
    if (!account) return json(res, 401, { error: 'Pareamento inválido.' });
    return json(res, 200, await receiveMedia(account, req));
  }
  if (path.startsWith('/device/music/generations/') && path.endsWith('/audio') &&
    await sunoAudioRoute(req, res, url, { authenticateDevice })) return;
  if (path.startsWith('/device/music/generations') && await musicGenerationsRoute(req, res, url, authenticateDevice)) return;
  if (req.method === 'POST' && ['/device/poll', '/device/complete', '/device/notices/ack',
    '/device/profile/read', '/device/profile/write', '/device/connectors/runtime', '/device/connectors/access'].includes(path)) {
    const account = await authenticateDevice(req.headers.authorization);
    if (!account) return json(res, 401, { error: 'Pareamento inválido.' });
    const large = ['/device/complete', '/device/profile/write'].includes(path);
    const input = await body(req, large ? 32 * 1024 * 1024 : undefined);
    if (path === '/device/connectors/runtime') return json(res, 200, await runtime(account, input.provider, input.id));
    if (path === '/device/connectors/access') return json(res, 200, await accessToken(account, input.provider, input.id));
    if (path === '/device/notices/ack') return json(res, 200, await acknowledge(account, input.ids));
    if (path === '/device/poll') return json(res, 200, {
      ...await poll(account, input.capabilities), notices: await pendingNotices(account),
    });
    if (path === '/device/complete') return json(res, 200, await complete(account, input));
    if (path === '/device/profile/read') {
      const { rows: [profile] } = await pool.query('SELECT revision,ciphertext FROM pia_server.profiles WHERE account_id=$1', [account.id]);
      if (!input.metadata && profile) await registry(account);
      return json(res, 200, profile ? { revision: profile.revision,
        ...(input.metadata ? {} : { snapshot: splitProfile(JSON.parse(unseal(profile.ciphertext))).snapshot }),
      } : { revision: '0' });
    }
    if (typeof input.revision !== 'string' || !/^\d{1,18}$/.test(input.revision) ||
        !input.snapshot || input.snapshot.version !== 1 || typeof input.snapshot.backup !== 'string' ||
        !input.snapshot.chats || typeof input.snapshot.chats !== 'object') throw new Error('Perfil inválido.');
    const profile = splitProfile(input.snapshot);
    await registry(account, profile.state);
    const ciphertext = seal(JSON.stringify(profile.snapshot));
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
  if ((path === '/api/admin' || path.startsWith('/api/admin/')) && !isAdminRequestAuthorized(req, account)) {
    return json(res, 403, { error: ADMIN_VPN_ERROR });
  }
  if (req.method === 'GET' && path === '/api/status') {
    const snapshot = status(account, req);
    if (snapshot.pro) {
      try {
        const { missing } = await podcastConfig(account);
        snapshot.missingPrerequisites = missing;
        snapshot.serverProcessingEligible = missing.length === 0;
      } catch {
        snapshot.serverProcessingEligible = false;
        snapshot.missingPrerequisites = ['configuração de Podcast Automation'];
      }
    }
    return json(res, 200, snapshot);
  }
  if (req.method === 'GET' && path === '/api/admin/accounts') return json(res, 200, await listAdminAccounts(pool));
  if (req.method === 'GET' && path === '/api/recording-folder') {
    const id = recordingFolder(account);
    const folders = id ? await recordingFolderPath(account, account.recording_drive_account, id) : [];
    return json(res, 200, { id, path: folders });
  }
  if (req.method === 'GET' && path === '/api/devices') return json(res, 200, await devices(account));
  if (req.method === 'GET' && path === '/api/secretary') return json(res, 200, await preferences(account));
  if (req.method === 'GET' && path === '/api/connectors') return json(res, 200, await publicConnectors(account));
  if (req.method !== 'POST') return json(res, 405, { error: 'Método indisponível.' });
  if (req.headers.origin !== origin) return json(res, 403, { error: 'Origem inválida.' });
  const data = await body(req);
  if (path === '/api/connectors/save') return json(res, 200, await saveConnector(account, data));
  if (path === '/api/connectors/storage-credential') return json(res, 200, await storageCredential(account, data));
  if (path === '/api/connectors/bot-credential') return json(res, 200, await botCredential(account, data.provider));
  if (path === '/api/connectors/remove') return json(res, 200, await removeConnector(account, data));
  if (path === '/api/connectors/oauth') return json(res, 200, await oauthStart(account, data.provider));
  if (path === '/api/connectors/test') return json(res, 200, await testConnector(account, data));
  if (path === '/api/connectors/discord-link') {
    const application = runtimes.get(account.id)?.runtime.client.application?.id;
    return json(res, 200, await enableDiscordLink(account, application));
  }
  if (path === '/api/secretary') return json(res, 200, await configure(account, data));
  if (path === '/api/devices/pair') return json(res, 200, await pair(account, data.name));
  if (path === '/api/devices/revoke') return json(res, 200, await revoke(account, data.id));
  if (path === '/api/rules') {
    const rules = validateRules(data.rules);
    await pool.query('UPDATE pia_server.accounts SET rules=$2 WHERE id=$1', [account.id, JSON.stringify(rules)]);
    return json(res, 200, { ok: true, rules });
  }
  if (path === '/api/discord') {
    const slot = data.slot ?? 'primary';
    if (typeof slot !== 'string' || !Object.hasOwn(discordSlots, slot)) throw new Error('Bot Discord inválido.');
    const fields = discordSlots[slot];
    if (slot === 'dark' && data.remove === true) {
      await pool.query('UPDATE pia_server.accounts SET discord_dark_token=NULL, discord_dark_bot_id=NULL WHERE id=$1', [account.id]);
      return json(res, 200, { ok: true });
    }
    const token = typeof data.token === 'string' ? data.token.trim() : '';
    if (typeof token !== 'string' || !/^[\w.-]{30,180}$/.test(token)) throw new Error('Token do bot inválido.');
    const check = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: 'Bot ' + token }, signal: AbortSignal.timeout(10000),
    });
    const bot = check.ok && await check.json();
    if (!bot?.bot || typeof bot.id !== 'string') throw new Error('O Discord não aceitou o token do bot.');
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('pia-discord-bot:' || $1, 0))", [bot.id]);
      const duplicate = await db.query(`SELECT 1 FROM pia_server.accounts
        WHERE (discord_bot_id=$1 AND (id<>$2 OR $3<>'primary'))
           OR (discord_dark_bot_id=$1 AND (id<>$2 OR $3<>'dark'))`, [bot.id, account.id, slot]);
      if (duplicate.rowCount) throw new Error('Este bot já está cadastrado em outra conexão.');
      await db.query(`UPDATE pia_server.accounts SET ${fields.token}=$2, ${fields.id}=$3 WHERE id=$1`,
        [account.id, seal(token), bot.id]);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      if (error.code === '23505') throw new Error('Este bot já está cadastrado em outra conexão.');
      throw error;
    } finally {
      db.release();
    }
    return json(res, 200, { ok: true });
  }
  if (path === '/api/recording-folders') return json(res, 200, await recordingFolders(account, data));
  if (path === '/api/recording-folder') {
    const folder = await recordingDestination(account, data);
    await pool.query(`UPDATE pia_server.accounts SET recording_folder_id=$2,
      recording_folder_name=$3, recording_drive_account=$4 WHERE id=$1`,
    [account.id, folder.id, folder.name, data.identity || null]);
    return json(res, 200, folder);
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
  if (path === '/api/recordings/processing-mode') {
    const result = await setProcessingMode(pool, account, data);
    return json(res, result.status, result.body);
  }
  if (path === '/api/recordings/stop') {
    const stopped = [...runtimes.values()].some(({ runtime }) => runtime.stop(data.channelId, account.id, { label: 'Painel PIA Server' }));
    return json(res, stopped ? 200 : 404, stopped ? { ok: true } : { error: 'Gravação ativa não encontrada.' });
  }
  if (path === '/api/mcp/token') return json(res, 200, await issueMcpToken(account.id, data.expiresInDays));
  if (path === '/api/mcp/revoke') {
    await pool.query("DELETE FROM pia_server.sessions WHERE account_id=$1 AND purpose='mcp'", [account.id]);
    return json(res, 200, { ok: true });
  }
  if (path === '/api/logout') {
    await pool.query('DELETE FROM pia_server.sessions WHERE digest=$1', [hash(session)]);
    res.setHeader('Set-Cookie', '__Host-pia_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
    return json(res, 200, { ok: true });
  }
  if (path === '/api/admin/accounts') {
    return json(res, 200, await authorizeAdminAccount(pool, data));
  }
  if (path === '/api/admin/accounts/pro') {
    const result = await setAccountPro(pool, data);
    return json(res, result.status, result.body);
  }
  // Spike T10: tools/list de uma conta Suno conectada (só admin; sem tokens).
  if (path === '/api/admin/suno/spike') return json(res, 200, await sunoAdminRoute(account, path, data));
  return json(res, 404, { error: 'Rota não encontrada.' });
}

const uploads = new Set();
const serverJobs = new Set();
const podcastRoot = process.env.PIA_PODCAST_ROOT;
const podcastPython = process.env.PIA_PODCAST_PYTHON;
const podcastAppContext = process.env.PIA_PODCAST_APP_CONTEXT;
function podcastContextConfigured(raw) {
  try {
    const { url, token, model, max_upload_bytes: maxUploadBytes } = JSON.parse(raw);
    const endpoint = new URL(url);
    return ['https:', 'http:'].includes(endpoint.protocol) &&
      !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash &&
      typeof token === 'string' && Boolean(token.trim()) &&
      typeof model === 'string' && Boolean(model.trim()) &&
      Number.isSafeInteger(maxUploadBytes) && maxUploadBytes > 0;
  } catch {
    return false;
  }
}
const podcastWorkerReady = Boolean(podcastRoot && podcastPython && podcastContextConfigured(podcastAppContext));
const podcastWorker = createPodcastWorker({
  command: podcastPython,
  args: ['-m', 'podcast_automation.server_worker'],
  cwd: podcastRoot,
  env: podcastRoot ? {
    ...Object.fromEntries(['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR']
      .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    PYTHONPATH: [resolve(podcastRoot, 'Plugins/Apps/podcast_automation/src'), resolve(podcastRoot)].join(delimiter),
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    ...(podcastWorkerReady ? { PIA_APP_CONTEXT: podcastAppContext } : {}),
  } : undefined,
});
const podcastConfig = (account) => resolvePodcastConfig(account, { workerReady: podcastWorkerReady });
const panelRuntime = (meta) => {
  const runtime = runtimes.get(runtimeKey(meta.botAccountId, meta.botSlot))?.runtime;
  return runtime?.client.isReady() ? runtime : null;
};
const serverRecording = createServerRecordingRunner({
  worker: podcastWorker,
  prepareArchive: prepareRecording,
  resolveConfig: podcastConfig,
  panelsFor: (meta) => panelRuntime(meta)?.panels,
  async announce(meta, announcement) {
    const runtime = panelRuntime(meta);
    if (!runtime || !Array.isArray(announcement?.parts) || !announcement.parts.length) {
      throw new Error('Anúncio indisponível');
    }
    const mentions = Array.isArray(announcement.mentions)
      ? announcement.mentions.filter((item) => typeof item === 'string' && /^\d{17,20}$/.test(item))
      : [];
    for (const content of announcement.parts) {
      await runtime.client.rest.post(Routes.channelMessages(meta.noticeChannelId), {
        body: { content, allowed_mentions: { parse: [], users: mentions } },
      });
    }
  },
});
async function reconcile() {
  await monitor();
  const { rows: links } = await pool.query('SELECT guild_id, bot_account_id, bot_slot, account_id FROM pia_server.discord_guild_links');
  const { rows } = await pool.query('SELECT * FROM pia_server.accounts');
  const accounts = new Map(rows.map((account) => [account.id, account]));
  const destinations = new Map();
  for (const link of links) {
    if (!accounts.has(link.account_id)) continue;
    const key = runtimeKey(link.bot_account_id, link.bot_slot);
    if (!destinations.has(key)) destinations.set(key, new Map());
    destinations.get(key).set(link.guild_id, accounts.get(link.account_id));
  }
  for (const account of rows) {
    if (closing) return;
    if (!recovered.has(account.id)) { recover(account); recovered.add(account.id); }
    for (const [slot, fields] of Object.entries(discordSlots)) {
      const key = runtimeKey(account.id, slot);
      const routes = destinations.get(key) || new Map();
      const previous = runtimes.get(key);
      const encrypted = account[fields.token];
      if (previous?.encrypted !== encrypted) {
        previous?.runtime.close();
        runtimes.delete(key);
        if (encrypted) runtimes.set(key, {
          encrypted, runtime: new DiscordRecorder(account, unseal(encrypted), routes, slot),
        });
      } else if (previous) {
        previous.runtime.account = account;
        previous.runtime.setDestinations(routes);
      }
    }
    const items = recordings(account).sort((a, b) => a.meta.startedAt.localeCompare(b.meta.startedAt));
    const now = Date.now();
    for (const item of items) {
      const { dir, meta } = item;
      if (isServerRecording(account, meta)) {
        if (meta.poll?.status === 'open' && Date.parse(meta.poll.endsAt) > now) {
          const panels = panelRuntime(meta)?.panels;
          if (panels && !panels.polls.has(meta.id)) {
            await panels.restorePoll(dir, { autoClose: false, refreshPanel: true });
          }
          continue;
        }
        if (serverJobs.has(account.id) || ['failed', 'skipped'].includes(meta.processing?.status) ||
          ['failed', 'published'].includes(meta.publication?.status)) continue;
        serverJobs.add(account.id);
        serverRecording.run(account, item)
          .catch(() => console.error('Falha na fila de processamento do podcast.'))
          .finally(() => serverJobs.delete(account.id));
        continue;
      }
      if (meta.state === 'recording' || !meta.editUntil) continue;
      panelRuntime(meta)?.panels.finish(meta, () => saveRecordingEdits(dir, meta));
    }
    if (uploads.has(account.id) || !account.drive_refresh) continue;
    const sidecar = items.find(({ meta }) => needsSidecar(meta, now));
    const next = sidecar ? null : items.find(({ meta }) =>
      !isServerRecording(account, meta) && meta.state === 'queued' && (meta.retryAt || 0) <= now);
    if (next || sidecar) {
      uploads.add(account.id);
      (next ? processRecording(account, next) : processRecordingSidecar(account, sidecar)).catch(() => console.error('Falha na fila de gravação.'))
        .finally(() => uploads.delete(account.id));
    }
  }
}

await migrate();
await migrateConnectorRows();
// Jobs do Suno que estavam na fila ou rodando viram interrupted; nunca refazem tools/call.
await recoverSunoJobs();
// Restos de mídia e de gravações já enviadas; nunca lança nem toca na fila de gravação.
await cleanupOrphanTemp();
const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    if (res.headersSent) { res.end(); return; }
    const known = publicError(error);
    if (known) return json(res, known.status, known.body);
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
