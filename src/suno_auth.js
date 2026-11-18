import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pool, seal, unseal } from './db.js';
import { origin } from './auth.js';
import { legalFooter } from './legal.js';
import { SunoError, publicError, sunoMessages } from './suno_errors.js';
import { resolveSunoIdentity } from './suno_identity.js';

// Contas Suno do lado do servidor (T2, contrato v3 final). N contas Suno por
// conta PIA; cada conta Suno (suno_subject) pertence a uma única conta PIA. Os
// tokens ficam só aqui, selados com seal() em pia_server.suno_accounts, e nunca
// passam pelo registry de connectors, que devolve credenciais aos dispositivos.

export const sunoOAuth = {
  registerUrl: 'https://studio-api-prod.suno.com/api/v2/external/oauth/register/',
  authorizeUrl: 'https://studio-api-prod.suno.com/api/v2/external/oauth/authorize/',
  tokenUrl: 'https://studio-api-prod.suno.com/api/v2/external/oauth/token/',
  scopes: 'api:v0 credits:spend download library:read library:search library:write offline_access profile:read',
  clientName: 'pia.travelrpg.com',
  redirectUri: origin + '/auth/connectors/suno',
  timeoutMs: 15000,
};

export const sunoCapabilities = Object.freeze(['suno:3']);
export const sunoSettings = Object.freeze({ max_count: 10, duration: [10, 180], instrumental: true });
// Ponto de extensão da T4: devolve o job ativo da conta PIA (ou null).
export const sunoHooks = { activeJob: async () => null };

const attemptTtl = 600;
const refreshMargin = 60000;
const maxPendingAttempts = 10;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const digest = (value) => createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------
// Persistência em Postgres. Os testes rodam a mesma lógica contra este store
// (Postgres descartável) e contra um store em memória com a mesma interface.

const accountColumns = 'id,account_id,suno_subject,suno_email,suno_name,label,client_id,ciphertext,expires_at,scopes,state,last_error_code,created';
const attemptColumns = 'id,account_id,device_id,client_id,verifier,replace_account_id,status,suno_account_id,code,expires';

function setClause(patch, offset) {
  const keys = Object.keys(patch);
  return [keys.map((key, i) => key + '=$' + (i + offset)).join(','), keys.map((key) => patch[key])];
}

function pgTx(client) {
  return {
    async lockBySubject(subject) {
      const { rows } = await client.query('SELECT ' + accountColumns + ' FROM pia_server.suno_accounts WHERE suno_subject=$1 FOR UPDATE', [subject]);
      return rows[0] || null;
    },
    async lockById(id) {
      const { rows } = await client.query('SELECT ' + accountColumns + ' FROM pia_server.suno_accounts WHERE id=$1 FOR UPDATE', [id]);
      return rows[0] || null;
    },
    async insertAccount(row) {
      const keys = Object.keys(row);
      await client.query('INSERT INTO pia_server.suno_accounts(' + keys.join(',') + ') VALUES(' + keys.map((_, i) => '$' + (i + 1)).join(',') + ')',
        keys.map((key) => row[key]));
    },
    async updateAccount(id, patch) {
      const [set, values] = setClause(patch, 2);
      await client.query('UPDATE pia_server.suno_accounts SET ' + set + ',updated=now() WHERE id=$1', [id, ...values]);
    },
    async updateAttempt(id, patch) {
      const [set, values] = setClause(patch, 2);
      await client.query('UPDATE pia_server.suno_connect_attempts SET ' + set + ' WHERE id=$1', [id, ...values]);
    },
  };
}

export const pgStore = {
  async transaction(change) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await change(pgTx(client));
      await client.query('COMMIT');
      return result;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  },
  async getClient(redirectUri) {
    const { rows } = await pool.query('SELECT client_id FROM pia_server.suno_oauth_clients WHERE redirect_uri=$1', [redirectUri]);
    return rows[0]?.client_id || null;
  },
  // Um DCR concorrente pode ter gravado antes: o primeiro client salvo vence.
  async saveClient(redirectUri, clientId) {
    await pool.query('INSERT INTO pia_server.suno_oauth_clients(redirect_uri,client_id) VALUES($1,$2) ON CONFLICT(redirect_uri) DO NOTHING',
      [redirectUri, clientId]);
    return this.getClient(redirectUri);
  },
  async createAttempt(attempt) {
    await pool.query(`DELETE FROM pia_server.suno_connect_attempts WHERE expires < now() - interval '1 day'`);
    await pool.query(`DELETE FROM pia_server.suno_connect_attempts WHERE id IN (SELECT id FROM pia_server.suno_connect_attempts
      WHERE account_id=$1 AND status='pending' ORDER BY created DESC OFFSET $2)`, [attempt.account_id, maxPendingAttempts - 1]);
    await pool.query(`INSERT INTO pia_server.suno_connect_attempts(id,account_id,device_id,state_digest,verifier,client_id,replace_account_id,expires)
      VALUES($1,$2,$3,$4,$5,$6,$7,now() + make_interval(secs => $8))`, [attempt.id, attempt.account_id, attempt.device_id,
      attempt.state_digest, attempt.verifier, attempt.client_id, attempt.replace_account_id, attemptTtl]);
  },
  async getAttempt(accountId, id) {
    const { rows } = await pool.query('SELECT ' + attemptColumns + ', expires < now() AS expired FROM pia_server.suno_connect_attempts WHERE id=$1 AND account_id=$2',
      [id, accountId]);
    return rows[0] || null;
  },
  // Uso único: só uma requisição consegue tomar a tentativa (o verifier é zerado).
  async claimAttempt(stateDigest) {
    const { rows } = await pool.query(`UPDATE pia_server.suno_connect_attempts a SET verifier='' FROM
      (SELECT id, verifier FROM pia_server.suno_connect_attempts WHERE state_digest=$1 FOR UPDATE) old
      WHERE a.id=old.id AND a.status='pending' AND a.expires > now() AND old.verifier <> ''
      RETURNING a.id,a.account_id,a.device_id,a.client_id,old.verifier,a.replace_account_id`, [stateDigest]);
    return rows[0] || null;
  },
  async finishAttempt(id, patch) {
    const [set, values] = setClause(patch, 2);
    await pool.query('UPDATE pia_server.suno_connect_attempts SET ' + set + ' WHERE id=$1', [id, ...values]);
  },
  async listAccounts(accountId) {
    const { rows } = await pool.query('SELECT ' + accountColumns + ' FROM pia_server.suno_accounts WHERE account_id=$1 ORDER BY created,id', [accountId]);
    return rows;
  },
  async getAccount(accountId, id) {
    const { rows } = await pool.query('SELECT ' + accountColumns + ' FROM pia_server.suno_accounts WHERE id=$1 AND account_id=$2', [id, accountId]);
    return rows[0] || null;
  },
  async updateLabel(accountId, id, label) {
    const { rows } = await pool.query('UPDATE pia_server.suno_accounts SET label=$3,updated=now() WHERE id=$1 AND account_id=$2 RETURNING ' +
      accountColumns, [id, accountId, label]);
    return rows[0] || null;
  },
  async deleteAccount(accountId, id) {
    const { rowCount } = await pool.query('DELETE FROM pia_server.suno_accounts WHERE id=$1 AND account_id=$2', [id, accountId]);
    return rowCount > 0;
  },
};

let store = pgStore;
export function useSunoStore(next) { store = next || pgStore; }

// ---------------------------------------------------------------------------
// HTTP com o servidor OAuth do Suno. Nenhum corpo de resposta ou token é logado.

async function post(url, body, form) {
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(sunoOAuth.timeoutMs),
    headers: { Accept: 'application/json', 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
  });
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  return { status: response.status, ok: response.ok, data: data && typeof data === 'object' ? data : {} };
}

const unavailable = () => new SunoError('suno_unavailable', sunoMessages.unavailable, 502);
const expired = () => new SunoError('suno_credential_expired', sunoMessages.expired, 400);
const notConnected = () => new SunoError('suno_not_connected', sunoMessages.notConnected, 400);
const accountNotFound = () => new SunoError('suno_account_not_found', 'Conta Suno não encontrada.', 404);

async function oauthClient() {
  const saved = await store.getClient(sunoOAuth.redirectUri);
  if (saved) return saved;
  let result;
  try {
    result = await post(sunoOAuth.registerUrl, {
      client_name: sunoOAuth.clientName, redirect_uris: [sunoOAuth.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', scope: sunoOAuth.scopes,
    });
  } catch { throw unavailable(); }
  const clientId = typeof result.data.client_id === 'string' ? result.data.client_id.trim() : '';
  if (!result.ok || !clientId) throw unavailable();
  return store.saveClient(sunoOAuth.redirectUri, clientId);
}

function tokenFields(token, previous = {}) {
  const access = typeof token.access_token === 'string' ? token.access_token : '';
  if (!access) return null;
  const refresh = typeof token.refresh_token === 'string' && token.refresh_token ? token.refresh_token : previous.refresh_token;
  if (!refresh) return null;
  const seconds = Number(token.expires_in);
  return {
    access, ciphertext: seal(JSON.stringify({ access_token: access, refresh_token: refresh })),
    expires_at: new Date(Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000),
    scopes: typeof token.scope === 'string' ? token.scope : previous.scopes ?? sunoOAuth.scopes,
  };
}

const tokens = (row) => (row?.ciphertext ? JSON.parse(unseal(row.ciphertext)) : null);
const fresh = (row) => Boolean(row?.ciphertext) && new Date(row.expires_at).getTime() - Date.now() > refreshMargin;
const failedFields = { state: 'refresh_failed', ciphertext: null, expires_at: null, last_error_code: 'suno_credential_expired' };

// ---------------------------------------------------------------------------
// Connect assíncrono: POST devolve a URL e o attempt_id; o callback público
// conclui; o PC consulta GET /device/suno/connect/:attempt_id.

export async function sunoConnect(account, input = {}) {
  const replace = input.replace_account_id ?? null;
  if (replace !== null && (typeof replace !== 'string' || !uuid.test(replace)))
    throw new SunoError('bad_request', 'replace_account_id inválido.');
  if (replace && !await store.getAccount(account.id, replace)) throw accountNotFound();
  const clientId = await oauthClient();
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const id = randomUUID();
  await store.createAttempt({ id, account_id: account.id, device_id: account.device_id || null, state_digest: digest(state),
    verifier: seal(verifier), client_id: clientId, replace_account_id: replace });
  const query = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: sunoOAuth.redirectUri, scope: sunoOAuth.scopes, state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  });
  return { url: sunoOAuth.authorizeUrl + '?' + query, attempt_id: id, expires_in: attemptTtl };
}

export async function sunoConnectAttempt(account, id) {
  const attempt = uuid.test(id || '') ? await store.getAttempt(account.id, id) : null;
  if (!attempt) throw new SunoError('suno_connect_not_found', 'Tentativa de conexão não encontrada.', 404);
  if (attempt.status === 'connected') return { state: 'connected', account_id: attempt.suno_account_id };
  if (attempt.status === 'failed') return { state: 'failed', code: attempt.code };
  return { state: attempt.expired ? 'expired' : 'pending' };
}

function labelFor(identity) {
  return (identity.name || identity.email || 'Conta Suno').slice(0, 80);
}

// Grava a conexão já com a identidade resolvida. Regras do RN08: conta Suno de
// outra conta PIA -> suno_account_taken (nada gravado); mesma conta -> só renova.
async function saveConnection(attempt, identity, fields) {
  return store.transaction(async (tx) => {
    const owner = await tx.lockBySubject(identity.subject);
    if (owner && String(owner.account_id) !== String(attempt.account_id)) return { code: 'suno_account_taken' };
    if (attempt.replace_account_id) {
      const target = await tx.lockById(attempt.replace_account_id);
      if (target && target.suno_subject !== identity.subject) return { code: 'suno_account_mismatch' };
    }
    const profile = { suno_email: identity.email, suno_name: identity.name, label: labelFor(identity) };
    const credential = { client_id: attempt.client_id, ciphertext: fields.ciphertext, expires_at: fields.expires_at,
      scopes: fields.scopes, state: 'connected', last_error_code: null };
    if (owner) {
      // Reconectar não sobrescreve o apelido escolhido pelo usuário (RN07).
      await tx.updateAccount(owner.id, { suno_email: profile.suno_email, suno_name: profile.suno_name, ...credential });
      return { id: owner.id };
    }
    const id = randomUUID();
    await tx.insertAccount({ id, account_id: attempt.account_id, suno_subject: identity.subject, ...profile, ...credential });
    return { id };
  });
}

async function completeAttempt(attempt, code) {
  let result;
  try {
    result = await post(sunoOAuth.tokenUrl, { grant_type: 'authorization_code', code, redirect_uri: sunoOAuth.redirectUri,
      code_verifier: unseal(attempt.verifier), client_id: attempt.client_id }, true);
  } catch { return { code: 'suno_unavailable' }; }
  if (result.status >= 500) return { code: 'suno_unavailable' };
  const fields = result.ok ? tokenFields(result.data) : null;
  if (!fields) return { code: result.ok ? 'suno_oauth_denied' : 'suno_oauth_invalid' };
  let identity;
  try { identity = await resolveSunoIdentity(fields.access); } catch { return { code: 'suno_identity_unavailable' }; }
  for (let tries = 0; ; tries++) {
    try { return await saveConnection(attempt, identity, fields); }
    catch (error) { if (error.code !== '23505' || tries) throw error; } // corrida no UNIQUE(suno_subject): relê e decide de novo
  }
}

const callbackMessages = {
  suno_account_taken: sunoMessages.taken, suno_account_mismatch: sunoMessages.mismatch,
  suno_identity_unavailable: sunoMessages.identity, suno_unavailable: sunoMessages.unavailable,
  suno_oauth_denied: sunoMessages.denied, suno_oauth_invalid: sunoMessages.invalid,
};

export async function sunoCallback(query) {
  const state = query.get('state') || '';
  const attempt = state && state.length <= 200 ? await store.claimAttempt(digest(state)) : null;
  if (!attempt) return { ok: false, code: 'suno_oauth_invalid' };
  const code = query.get('code');
  let outcome;
  if (query.get('error')) outcome = { code: 'suno_oauth_denied' };
  else if (!code || code.length > 2048) outcome = { code: 'suno_oauth_invalid' };
  else {
    try { outcome = await completeAttempt(attempt, code); }
    catch { console.error('Falha ao concluir a conexão do Suno.'); outcome = { code: 'suno_unavailable' }; }
  }
  if (outcome.id) {
    await store.finishAttempt(attempt.id, { status: 'connected', suno_account_id: outcome.id, code: null });
    return { ok: true, suno_account_id: outcome.id };
  }
  await store.finishAttempt(attempt.id, { status: 'failed', code: outcome.code });
  return { ok: false, code: outcome.code };
}

// ---------------------------------------------------------------------------
// Token de acesso por conta Suno, com refresh preventivo (< 60 s) e reativo
// (`rejected` = token que o Suno acabou de recusar com 401). O refresh roda com a
// linha travada (SELECT … FOR UPDATE): requests concorrentes da mesma conta fazem
// um único refresh e todas usam o refresh token rotacionado.

export async function sunoAccessToken(account, sunoAccountId, { rejected } = {}) {
  const usable = (row) => row?.state === 'connected' && fresh(row) && tokens(row).access_token !== rejected;
  const cached = uuid.test(sunoAccountId || '') ? await store.getAccount(account.id, sunoAccountId) : null;
  if (!cached) throw notConnected();
  if (cached.state === 'refresh_failed') throw expired();
  if (usable(cached)) return tokens(cached).access_token;
  const outcome = await store.transaction(async (tx) => {
    const row = await tx.lockById(cached.id);
    if (!row || String(row.account_id) !== String(account.id)) return { error: notConnected() };
    if (row.state === 'refresh_failed' || !row.ciphertext) return { error: expired() };
    if (usable(row)) return { token: tokens(row).access_token };
    const saved = tokens(row);
    let result;
    try {
      result = await post(sunoOAuth.tokenUrl, { grant_type: 'refresh_token', refresh_token: saved.refresh_token, client_id: row.client_id }, true);
    } catch {
      await tx.updateAccount(row.id, { last_error_code: 'suno_unavailable' });
      return { error: unavailable() };
    }
    const grant = result.data.error;
    if (!result.ok && (grant === 'invalid_grant' || grant === 'invalid_client' || result.status === 401)) {
      await tx.updateAccount(row.id, failedFields);
      return { error: expired() };
    }
    const fields = result.ok ? tokenFields(result.data, { refresh_token: saved.refresh_token, scopes: row.scopes }) : null;
    if (!fields) {
      await tx.updateAccount(row.id, { last_error_code: 'suno_unavailable' });
      return { error: unavailable() };
    }
    const { access, ...patch } = fields;
    await tx.updateAccount(row.id, { ...patch, state: 'connected', last_error_code: null });
    return { token: access };
  });
  if (outcome.error) {
    if (outcome.error.code === 'suno_unavailable') console.error('Falha ao renovar o token do Suno.');
    throw outcome.error;
  }
  return outcome.token;
}

// Executa `call(token)`; se o Suno responder 401 (status 401 no retorno, ou
// upstreamStatus 401 no erro), renova uma vez e repete. Um segundo 401 vira suno_credential_expired.
export async function withSunoToken(account, sunoAccountId, call) {
  // `status` 401 num retorno simples ou `upstreamStatus` 401 num erro do cliente
  // MCP (em SunoError, `status` é o HTTP da nossa API, nunca o do Suno).
  const unauthorized = (value) => value?.upstreamStatus === 401 || (!(value instanceof SunoError) && value?.status === 401);
  const attempt = async (token) => {
    try { return await call(token); } catch (error) { if (unauthorized(error)) return error; throw error; }
  };
  const token = await sunoAccessToken(account, sunoAccountId);
  const first = await attempt(token);
  if (!unauthorized(first)) return first;
  const second = await attempt(await sunoAccessToken(account, sunoAccountId, { rejected: token }));
  if (unauthorized(second)) throw expired();
  return second;
}

// ---------------------------------------------------------------------------
// Status e desconexão.

// credential_state por conta Suno:
//   configured     token válido (ou renovado agora); available = true
//   unavailable    token vencido ou perto de vencer e o refresh falhou por 5xx,
//                  timeout ou rede; os tokens são mantidos; available = false
//   refresh_failed invalid_grant/401 no refresh: precisa reconectar
export const sunoCredentialStates = Object.freeze(['configured', 'unavailable', 'refresh_failed']);

// Code de recusa de um job para cada estado (T4): unavailable nunca vira
// suno_credential_expired.
export function sunoCredentialRefusal(credentialState) {
  if (credentialState === 'refresh_failed') return 'suno_credential_expired';
  if (credentialState === 'unavailable') return 'suno_unavailable';
  return null;
}

async function describeAccounts(account, rows) {
  const transient = new Set();
  const stale = rows.filter((row) => row.state === 'connected' && !fresh(row));
  if (stale.length) {
    await Promise.all(stale.map((row) => sunoAccessToken(account, row.id).catch((error) => {
      if (error?.code === 'suno_unavailable') transient.add(row.id);
    })));
    const ids = new Set(rows.map((row) => row.id));
    rows = (await store.listAccounts(account.id)).filter((row) => ids.has(row.id));
  }
  return rows.map((row) => {
    const credential_state = row.state === 'refresh_failed' ? 'refresh_failed' :
      transient.has(row.id) || !(new Date(row.expires_at).getTime() > Date.now()) ? 'unavailable' : 'configured';
    return { id: row.id, label: row.label, email: row.suno_email || null, name: row.suno_name || null, credential_state,
      available: credential_state === 'configured',
      expires_at: row.state === 'connected' && row.expires_at ? new Date(row.expires_at).toISOString() : null,
      scopes: row.state === 'connected' ? row.scopes || '' : null };
  });
}

export async function sunoStatus(account) {
  const accounts = await describeAccounts(account, await store.listAccounts(account.id));
  const available = accounts.filter((item) => item.available);
  return { accounts, default_account_id: available.length === 1 ? available[0].id : null,
    active_job: await sunoHooks.activeJob(account), settings: sunoSettings };
}

// Estado de uma conta Suno no formato do status (para a T4 decidir a recusa).
export async function sunoAccountStatus(account, id) {
  const row = uuid.test(id || '') ? await store.getAccount(account.id, id) : null;
  if (!row) throw accountNotFound();
  return (await describeAccounts(account, [row]))[0];
}

// RN07: apelido da conta Suno (trim, 1 a 80 caracteres).
export async function sunoRename(account, id, input = {}) {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label || [...label].length > 80) throw new SunoError('bad_request', 'O apelido deve ter de 1 a 80 caracteres.');
  const row = uuid.test(id || '') ? await store.updateLabel(account.id, id, label) : null;
  if (!row) throw accountNotFound();
  return (await describeAccounts(account, [row]))[0];
}

export async function sunoDisconnect(account, id) {
  // Sem revogação remota até o spike: apaga o registro e os tokens.
  if (!uuid.test(id || '') || !await store.deleteAccount(account.id, id)) throw accountNotFound();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Rotas. Erros das rotas Suno levam `code`; o 401 de device segue o padrão das
// outras rotas /device/* (`401 {error: 'Pareamento inválido.'}`).

const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function sunoCallbackPage(title, message, status) {
  return {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    body: '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + escape(title) + '</title><link rel="icon" href="/pia.svg"><link rel="stylesheet" href="/style.css">' +
      '<link rel="stylesheet" href="/login.css"><main class="pia-login"><section class="pia-login-card">' +
      '<img class="pia-login-logo" src="/pia.svg" alt="" width="64" height="64"><h2>' + escape(title) + '</h2>' +
      '<p>' + escape(message) + '</p>' + legalFooter() + '</section></main></html>',
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function failure(res, error) {
  const known = publicError(error);
  if (known) return send(res, known.status, known.body);
  if (error instanceof SyntaxError || ['Envie JSON.', 'Corpo acima do limite da rota.', 'Objeto JSON obrigatório.'].includes(error?.message))
    return send(res, 400, { error: 'Requisição inválida.', code: 'bad_request' });
  console.error('Falha na rota Suno.');
  return send(res, 500, { error: 'A operação falhou.', code: 'internal_error' });
}

// Trata as rotas Suno da T2. Devolve false quando a rota não é dela.
export async function sunoRoute(req, res, url, { authenticateDevice, readBody }) {
  const path = url.pathname;
  if (path === '/auth/connectors/suno') {
    if (req.method !== 'GET') { send(res, 405, { error: 'Método indisponível.', code: 'bad_request' }); return true; }
    let page;
    try {
      const result = await sunoCallback(url.searchParams);
      page = result.ok ? sunoCallbackPage('Suno conectado', 'Suno conectado, pode voltar à PIA.', 200) :
        sunoCallbackPage('Não foi possível conectar o Suno', callbackMessages[result.code] || sunoMessages.invalid,
          result.code === 'suno_account_taken' ? 409 : 400);
    } catch {
      console.error('Falha no callback do Suno.');
      page = sunoCallbackPage('Não foi possível conectar o Suno', 'A operação falhou.', 500);
    }
    res.writeHead(page.status, page.headers);
    res.end(page.body);
    return true;
  }
  const attemptMatch = /^\/device\/suno\/connect\/([^/]+)$/.exec(path);
  const accountMatch = /^\/device\/suno\/accounts\/([^/]+)$/.exec(path);
  const known = (req.method === 'GET' && (path === '/device/suno/status' || attemptMatch)) ||
    (req.method === 'POST' && path === '/device/suno/connect') || ((req.method === 'DELETE' || req.method === 'PATCH') && accountMatch);
  if (!known) return false;
  try {
    const account = await authenticateDevice(req.headers.authorization);
    if (!account) { send(res, 401, { error: 'Pareamento inválido.' }); return true; }
    if (path === '/device/suno/status') send(res, 200, await sunoStatus(account));
    else if (attemptMatch) send(res, 200, await sunoConnectAttempt(account, attemptMatch[1]));
    else if (accountMatch && req.method === 'PATCH') send(res, 200, await sunoRename(account, accountMatch[1], await readBody(req, 2048)));
    else if (accountMatch) send(res, 200, await sunoDisconnect(account, accountMatch[1]));
    else {
      const input = req.headers['content-type'] || Number(req.headers['content-length'] || 0) ? await readBody(req, 2048) : {};
      send(res, 200, await sunoConnect(account, input));
    }
  } catch (error) { failure(res, error); }
  return true;
}
