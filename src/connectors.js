import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool, seal, unseal } from './db.js';
import { googleToken } from './drive.js';
import { origin } from './auth.js';

const providers = ['google', 'microsoft', 'object_storage', 'discord', 'taverns'];
const sections = new Set(providers.map((id) => 'Connectors/' + id));
const empty = () => ({ settings: {}, documents: {}, secrets: {} });
const prefix = 'PIA-BACKUP-PLAIN-1\n';
const states = new Map();
const primaryGoogle = 'server-google-primary';
const redirect = (provider) => origin + (provider === 'google' ? '/auth/google/callback' : '/auth/connectors/microsoft');
const endpoint = {
  google: ['https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token',
    'https://openidconnect.googleapis.com/v1/userinfo',
    'openid email profile https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly'],
  microsoft: ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    'https://login.microsoftonline.com/common/oauth2/v2.0/token', 'https://graph.microsoft.com/v1.0/me',
    'openid profile offline_access User.Read Mail.Read Calendars.Read Files.Read'],
};

const managedSecret = (key) => typeof key === 'string' && (
  /^(?:token|client):(google|microsoft)(?::|$)/.test(key) ||
  key.startsWith('storage:') || /^(?:setting|file):Connectors\/(google|microsoft|object_storage|discord|taverns):/.test(key)
);

export function splitProfile(snapshot) {
  const raw = Buffer.from(snapshot.backup, 'base64').toString('utf8');
  if (!raw.startsWith(prefix)) throw new Error('Formato de perfil inválido.');
  const payload = JSON.parse(raw.slice(prefix.length));
  const state = empty();
  for (const [key, value] of Object.entries(payload.secrets || {})) {
    if (managedSecret(key)) { state.secrets[key] = value; delete payload.secrets[key]; }
  }
  payload.settings = (payload.settings || []).filter(([section, key, value, , ref]) => {
    if (!sections.has(section)) return true;
    if (/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) {
      const settings = state.settings[section] ||= {};
      settings[key] = ref ? state.secrets[ref] : JSON.parse(value);
      if (ref) delete state.secrets[ref];
    }
    return false;
  });
  payload.documents = (payload.documents || []).filter(([name, value]) => {
    if (!sections.has(name)) return true;
    state.documents[name] = JSON.parse(value);
    return false;
  });
  return { state, snapshot: { ...snapshot, backup: Buffer.from(prefix + JSON.stringify(payload)).toString('base64') } };
}

export function partitionConnectors(state) {
  const parts = new Map();
  for (const provider of providers) {
    const section = 'Connectors/' + provider;
    const part = empty();
    if (Object.hasOwn(state.settings, section)) part.settings[section] = state.settings[section];
    if (Object.hasOwn(state.documents, section)) part.documents[section] = state.documents[section];
    for (const [key, value] of Object.entries(state.secrets)) {
      if ((provider === 'object_storage' && key.startsWith('storage:')) ||
          key === 'client:' + provider || key.startsWith('token:' + provider + ':') ||
          key.startsWith('setting:' + section + ':') || key.startsWith('file:' + section + ':')) part.secrets[key] = value;
    }
    if (Object.values(part).some((group) => Object.keys(group).length)) parts.set(provider, part);
  }
  return parts;
}

function mergeRows(rows) {
  const state = empty();
  for (const row of rows) {
    if (!row.ciphertext) continue;
    const part = JSON.parse(unseal(row.ciphertext));
    for (const group of Object.keys(state)) Object.assign(state[group], part[group]);
  }
  return state;
}

async function persist(client, accountId, state) {
  const parts = partitionConnectors(state);
  await client.query('DELETE FROM pia_server.connectors WHERE account_id=$1 AND NOT(type=ANY($2::text[]))',
    [accountId, [...parts.keys()]]);
  for (const [type, part] of parts) {
    await client.query(`INSERT INTO pia_server.connectors(account_id,type,ciphertext) VALUES($1,$2,$3)
      ON CONFLICT(account_id,type) DO UPDATE SET ciphertext=EXCLUDED.ciphertext`, [accountId, type, seal(JSON.stringify(part))]);
  }
}

async function readRegistry(client, accountId) {
  const { rows } = await client.query(`SELECT a.connectors_initialized AS initialized,c.ciphertext
    FROM pia_server.accounts a LEFT JOIN pia_server.connectors c ON c.account_id=a.id WHERE a.id=$1`, [accountId]);
  return { initialized: rows[0]?.initialized, state: mergeRows(rows), hasRows: rows.some((row) => row.ciphertext) };
}

async function edit(account, change, fallback = empty()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM pia_server.accounts WHERE id=$1 FOR UPDATE', [account.id]);
    const current = await readRegistry(client, account.id);
    let state = current.state;
    if (!current.initialized && !current.hasRows) {
      const { rows: [profile] } = await client.query('SELECT ciphertext FROM pia_server.profiles WHERE account_id=$1', [account.id]);
      state = profile ? splitProfile(JSON.parse(unseal(profile.ciphertext))).state : fallback;
    }
    const result = await change(state);
    await persist(client, account.id, state);
    if (!current.initialized) await client.query('UPDATE pia_server.accounts SET connectors_initialized=true WHERE id=$1', [account.id]);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

// Seed each account once and migrate its aggregate row inside the same transaction.
export async function registry(account, fallback = empty()) {
  const current = await readRegistry(pool, account.id);
  return current.initialized ? current.state : edit(account, (state) => state, fallback);
}

export async function migrateConnectorRows() {
  const { rows } = await pool.query("SELECT account_id AS id FROM pia_server.connectors WHERE type='legacy'");
  for (const account of rows) await registry(account);
}

function document(state, provider) {
  return state.documents['Connectors/' + provider] ||= { accounts: [] };
}

const oauthAccounts = (config) => (config.accounts || []).map(({ id, email, label }) => ({ id, email, label }));
const storageAccounts = (config) => (config.accounts || []).map(
  ({ id, name, provider, endpoint, public_url, bucket, region, color }) =>
    ({ id, name, provider, endpoint, public_url, bucket, region, color }),
);

export async function publicConnectors(account) {
  const state = await registry(account);
  return {
    google: oauthAccounts(state.documents['Connectors/google'] || {}),
    microsoft: oauthAccounts(state.documents['Connectors/microsoft'] || {}),
    microsoftClient: state.documents['Connectors/microsoft']?.client_id || '',
    primaryGoogle: account.drive_refresh ? { email: account.email, id: primaryGoogle } : null,
    objectStorage: storageAccounts(state.documents['Connectors/object_storage'] || {}),
    storageDefault: state.documents['Connectors/object_storage']?.default || '',
    discord: { configured: Boolean(account.discord_token || state.settings['Connectors/discord']?.DISCORD_BOT_TOKEN),
      channel: state.settings['Connectors/discord']?.DISCORD_CHANNEL_ID || '' },
    taverns: { configured: Boolean(state.settings['Connectors/taverns']?.TAVERNS_BOT_TOKEN) },
  };
}

export async function storageCredential(account, { id, reveal }) {
  if (!safeId(id)) throw new Error('Conta de Object Storage inválida.');
  const state = await registry(account);
  const config = state.documents['Connectors/object_storage'];
  if (!config?.accounts?.some((item) => item.id === id)) throw new Error('Conta de Object Storage não encontrada.');
  const secret = state.secrets['storage:' + id] || {};
  return reveal === true ? { secretKey: secret.secret_key || '' } :
    { accessKey: secret.access_key || '', hasSecret: Boolean(secret.secret_key) };
}

export async function botCredential(account, provider) {
  if (provider !== 'discord' && provider !== 'taverns') throw new Error('Conector de bot inválido.');
  const { settings } = await runtime(account, provider);
  return { token: settings[provider === 'discord' ? 'DISCORD_BOT_TOKEN' : 'TAVERNS_BOT_TOKEN'] || '' };
}

export async function runtime(account, provider, identity) {
  if (!providers.includes(provider)) throw new Error('Conector inválido.');
  const state = await registry(account);
  const section = 'Connectors/' + provider;
  const config = structuredClone(state.documents[section] || { accounts: [] });
  if (provider === 'google' && account.drive_refresh)
    config.accounts = [...(config.accounts || []), { id: primaryGoogle, label: 'Google da PIA Server', email: account.email }];
  const settings = { ...state.settings[section] };
  if (provider === 'discord' && account.discord_token) settings.DISCORD_BOT_TOKEN = unseal(account.discord_token);
  if (provider === 'google' && account.folder_id && !settings.GOOGLE_DRIVE_FOLDER_ID)
    settings.GOOGLE_DRIVE_FOLDER_ID = account.folder_id;
  const secret = provider === 'object_storage' && config.accounts?.some((a) => a.id === identity) ?
    state.secrets['storage:' + identity] : undefined;
  return { config, settings, ...(secret ? { secret } : {}) };
}

const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
const string = (value, limit = 1024) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

export async function saveConnector(account, data) {
  const provider = data.provider;
  if (!providers.includes(provider)) throw new Error('Conector inválido.');
  return edit(account, (state) => {
    const section = 'Connectors/' + provider;
    if (provider === 'discord' || provider === 'taverns') {
      const settings = state.settings[section] ||= {};
      const token = string(data.token);
      if (provider === 'taverns' && token) {
        if (!/^tavbot_[a-zA-Z0-9_.-]+$/.test(token)) throw new Error('Token Taverns inválido.');
        settings.TAVERNS_BOT_TOKEN = token;
      }
      if (provider === 'discord' && data.channel !== undefined) {
        if (typeof data.channel !== 'string' || (data.channel && !/^\d{17,20}$/.test(data.channel))) throw new Error('ID de canal Discord inválido.');
        settings.DISCORD_CHANNEL_ID = string(data.channel, 20);
      }
      return { ok: true };
    }
    const config = document(state, provider);
    if (provider === 'microsoft') {
      const client = string(data.clientId, 100);
      if (!/^[a-f0-9-]{36}$/i.test(client)) throw new Error('Client ID Microsoft inválido.');
      if (client !== config.client_id && !data.clientSecret) throw new Error('Informe o segredo do novo cliente Microsoft.');
      config.client_id = client;
      if (data.clientSecret) state.secrets['client:microsoft'] = string(data.clientSecret);
      return { ok: true };
    }
    if (provider !== 'object_storage') throw new Error('Adicione a conta Google pelo login do provedor.');
    const id = data.id || randomUUID().replaceAll('-', '');
    if (!safeId(id)) throw new Error('Conta inválida.');
    const existing = (config.accounts || []).find((item) => item.id === id);
    if (data.id && !existing) throw new Error('Conta não encontrada.');
    const type = data.type || 's3';
    const url = string(data.endpoint);
    const publicUrl = string(data.publicUrl);
    for (const value of [url, publicUrl].filter(Boolean)) {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
        throw new Error('URL de storage inválida.');
    }
    if (!['s3','r2','compatible'].includes(type) || (type !== 's3' && !url) || !string(data.name, 100))
      throw new Error('Informe um nome e um endpoint compatível.');
    const old = state.secrets['storage:' + id] || {};
    const credentials = { access_key: string(data.accessKey) || old.access_key,
      secret_key: string(data.secretKey) || old.secret_key,
      session_token: string(data.sessionToken) || old.session_token || '' };
    if (!credentials.access_key || !credentials.secret_key) throw new Error('Informe Access Key e Secret Key.');
    const color = data.color || existing?.color || '#9b7aff';
    if (!/^#[a-f0-9]{6}$/i.test(color)) throw new Error('Cor inválida.');
    state.secrets['storage:' + id] = credentials;
    config.accounts = [...(config.accounts || []).filter((item) => item.id !== id), {
      id, name: string(data.name, 100), provider: type, endpoint: url, public_url: publicUrl,
      bucket: string(data.bucket, 100), region: string(data.region, 60) || 'auto', color,
    }];
    if (data.default || !config.default) config.default = id;
    return { id };
  });
}

export async function removeConnector(account, { provider, id }) {
  if (!providers.includes(provider)) throw new Error('Conector inválido.');
  if (provider === 'discord') {
    await pool.query('UPDATE pia_server.accounts SET discord_token=NULL,discord_bot_id=NULL WHERE id=$1', [account.id]);
  }
  return edit(account, (state) => {
    if (provider === 'discord' || provider === 'taverns') {
      delete state.settings['Connectors/' + provider];
      delete state.documents['Connectors/' + provider];
      return { ok: true };
    }
    if (!safeId(id) || id === primaryGoogle) throw new Error('Conta inválida.');
    const config = document(state, provider);
    config.accounts = (config.accounts || []).filter((item) => item.id !== id);
    if (config.default === id) delete config.default;
    delete state.secrets[provider === 'object_storage' ? 'storage:' + id : 'token:' + provider + ':' + id];
    return { ok: true };
  });
}

const discordId = /^\d{17,20}$/;
const tavernsId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export async function testConnector(account, { provider, destination }) {
  if (typeof destination !== 'string') throw new Error('Informe o canal de teste.');
  const { settings } = await runtime(account, provider);
  let url, token;
  if (provider === 'discord' && discordId.test(destination)) {
    url = 'https://discord.com/api/v10/channels/' + destination + '/messages';
    token = settings.DISCORD_BOT_TOKEN;
  } else if (provider === 'taverns') {
    const parts = destination.split('/');
    if (parts.length !== 2 || !parts.every((part) => tavernsId.test(part)))
      throw new Error('Informe o destino como ID da taverna/ID do canal.');
    url = 'https://api.tav.gg/api/v1/taverns/' + parts[0] + '/channels/' + parts[1] + '/messages';
    token = settings.TAVERNS_BOT_TOKEN;
  } else throw new Error('Informe um canal Discord válido.');
  if (!token) throw new Error('Configure o bot antes de testar.');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'PIA · Mensagem de teste do conector.' }),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    const hint = detail.error === 'AGE_VERIFICATION_REQUIRED' ? ' O canal exige verificação de idade.' : '';
    throw new Error('O provedor recusou a mensagem (HTTP ' + response.status + ').' + hint);
  }
  const result = await response.json();
  if (!result.id || ['FILTERED', 'DELETED'].includes(result.status)) throw new Error('O provedor não confirmou a publicação.');
  return { id: result.id };
}

export async function enableDiscordLink(account, application) {
  if (!account.discord_token || !discordId.test(application)) throw new Error('Conecte o bot Discord primeiro.');
  const response = await fetch('https://discord.com/api/v10/applications/' + application + '/commands', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bot ' + unseal(account.discord_token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'link', description: 'Vincula este canal às publicações da PIA Server.',
      type: 1, default_member_permissions: '8', contexts: [0], integration_types: [0] }),
  });
  if (!response.ok) throw new Error('Não foi possível registrar /link (HTTP ' + response.status + ').');
  return edit(account, (state) => {
    (state.settings['Connectors/discord'] ||= {}).DISCORD_LINK_ENABLED = 'true';
    return { ok: true };
  });
}

export async function linkDiscordChannel(account, interaction) {
  const channel = interaction.channel;
  if (!interaction.inGuild() || !interaction.memberPermissions?.has(8n))
    throw new Error('Somente administradores do servidor podem usar /link.');
  if (!channel || ![0, 5].includes(channel.type) || !interaction.appPermissions?.has(3072n))
    throw new Error('Use um canal de texto em que o bot possa ver e enviar mensagens.');
  await edit(account, (state) => {
    const settings = state.settings['Connectors/discord'] || {};
    const config = document(state, 'discord');
    if (settings.DISCORD_LINK_ENABLED !== 'true') throw new Error('Habilite /link na PIA Server.');
    const admins = (settings.DISCORD_ADMIN_USER_IDS || '').split(/[\s,;]+/).filter(Boolean);
    if (admins.length && !admins.includes(interaction.user.id)) throw new Error('Administrador fora da lista autorizada.');
    const guild = settings.DISCORD_GUILD_ID || config.linked?.guild;
    if (guild && guild !== interaction.guildId) throw new Error('O bot está vinculado a outro servidor do Discord.');
    const linked = { guild: interaction.guildId, guild_name: interaction.guild.name, channel: channel.id, name: channel.name };
    config.channels = [...(config.channels || []).filter((item) => item.channel !== channel.id), linked];
    config.linked = linked;
    settings.DISCORD_CHANNEL_ID = channel.id;
  });
}

function clientFor(state, provider, useServerGoogle = false) {
  const serverGoogle = provider === 'google' && (useServerGoogle || document(state, provider).serverOAuth);
  return serverGoogle ? [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET] :
    [document(state, provider).client_id, state.secrets['client:' + provider]];
}

async function exchange(provider, params) {
  const response = await fetch(endpoint[provider][1], {
    method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error('O provedor recusou a autorização. Reconecte a conta no servidor.');
  const token = await response.json();
  if (!token.access_token) throw new Error('O provedor não retornou um token válido.');
  return token;
}

export async function oauthStart(account, provider) {
  if (!Object.hasOwn(endpoint, provider)) throw new Error('Conector inválido.');
  const data = await registry(account);
  const [client] = clientFor(data, provider, true);
  if (!client) throw new Error('Configure o cliente OAuth primeiro.');
  for (const [id, state] of states) if (state.expires < Date.now()) states.delete(id);
  if (states.size >= 200) throw new Error('Muitas conexões pendentes.');
  const id = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  states.set(id, { owner: account.id, provider, verifier, expires: Date.now() + 600000 });
  const query = new URLSearchParams({
    client_id: client, redirect_uri: redirect(provider), response_type: 'code',
    scope: endpoint[provider][3], state: id, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', prompt: provider === 'google' ? 'consent select_account' : 'select_account',
    ...(provider === 'google' ? { access_type: 'offline' } : {}),
  });
  return { url: endpoint[provider][0] + '?' + query };
}

export function isConnectorCallback(state) {
  return states.get(state)?.provider === 'google';
}

export async function oauthFinish(account, provider, query) {
  const id = query.get('state');
  const pending = states.get(id);
  if (!pending || pending.owner !== account.id || pending.provider !== provider || pending.expires < Date.now() || !query.get('code'))
    throw new Error('Autorização inválida ou expirada.');
  states.delete(id);
  const state = await registry(account);
  const [clientId, clientSecret] = clientFor(state, provider, true);
  const token = await exchange(provider, { grant_type: 'authorization_code', code: query.get('code'),
    redirect_uri: redirect(provider), code_verifier: pending.verifier, client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}) });
  const response = await fetch(endpoint[provider][2], {
    headers: { Authorization: 'Bearer ' + token.access_token }, signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  if (!response.ok) throw new Error('Não foi possível identificar a conta.');
  const profile = await response.json();
  const subject = profile.sub || profile.id;
  if (!subject) throw new Error('Identidade de conta indisponível.');
  const identity = createHash('sha256').update(provider + ':' + subject).digest('hex').slice(0, 24);
  const email = profile.email || profile.mail || profile.userPrincipalName || '';
  await edit(account, (data) => {
    const config = document(data, provider);
    const key = 'token:' + provider + ':' + identity;
    const old = data.secrets[key] || {};
    if (!token.refresh_token && !old.refresh_token) throw new Error('O provedor não autorizou acesso contínuo.');
    data.secrets[key] = { ...old, ...token, serverOAuth: provider === 'google', expires_at: Date.now() / 1000 + Number(token.expires_in || 3600) };
    config.accounts = [...(config.accounts || []).filter((item) => item.id !== identity),
      { id: identity, email, label: profile.displayName || profile.name || email || 'Minha conta' }];
  });
}

export async function accessToken(account, provider, identity) {
  if (!Object.hasOwn(endpoint, provider) || !safeId(identity)) throw new Error('Conta inválida.');
  if (provider === 'google' && identity === primaryGoogle && account.drive_refresh) {
    const token = await googleToken({ grant_type: 'refresh_token', refresh_token: unseal(account.drive_refresh) });
    return { token: token.access_token };
  }
  const key = 'token:' + provider + ':' + identity;
  const state = await registry(account);
  const cached = state.secrets[key];
  if (cached?.access_token && cached.expires_at > Date.now() / 1000 + 60) return { token: cached.access_token };
  return edit(account, async (current) => {
    const saved = current.secrets[key];
    if (!saved?.refresh_token) throw new Error('Reconecte a conta no servidor.');
    if (saved.access_token && saved.expires_at > Date.now() / 1000 + 60) return { token: saved.access_token };
    const [clientId, clientSecret] = clientFor(current, provider, saved.serverOAuth);
    if (!clientId) throw new Error('Configure o cliente OAuth primeiro.');
    const token = await exchange(provider, { grant_type: 'refresh_token', refresh_token: saved.refresh_token,
      client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) });
    current.secrets[key] = { ...saved, ...token, expires_at: Date.now() / 1000 + Number(token.expires_in || 3600) };
    return { token: token.access_token };
  });
}
