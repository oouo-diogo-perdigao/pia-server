// Servidor OAuth falso do Suno em node:http para testes (DCR, authorize,
// token com authorization_code/refresh_token e um recurso protegido que só
// aceita o access token vigente). Nunca fala com o Suno real.
// `onToken(access, account)` liga cada access token emitido à conta Suno do
// consentimento (use com fake_suno_mcp.addAccount para a identidade).
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export async function startFakeSunoOAuth(options = {}) {
  const config = { rotate: true, expiresIn: 900, refreshDelayMs: 0, issueRefresh: true, ...options };
  const clients = new Map();
  const codes = new Map();
  const refreshTokens = new Map();
  const accessTokens = new Set();
  const calls = { register: 0, authorizationCode: 0, refresh: 0, resource: 0 };
  const failures = { register: [], token: [], refresh: [] };
  const issued = [];
  const token = (prefix) => prefix + '_' + randomBytes(18).toString('base64url');

  function issue(clientId, account) {
    const access = token('fake_access');
    accessTokens.add(access);
    config.onToken?.(access, account);
    const body = { access_token: access, token_type: 'Bearer', expires_in: config.expiresIn, scope: 'api:v0 offline_access' };
    if (config.issueRefresh) {
      const refresh = token('fake_refresh');
      refreshTokens.set(refresh, { clientId, account });
      body.refresh_token = refresh;
    }
    issued.push(body);
    return body;
  }

  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://fake');
    if (req.method === 'POST' && url.pathname === '/register') {
      calls.register++;
      const fail = failures.register.shift();
      if (fail) return reply(res, fail, { error: 'server_error' });
      const data = JSON.parse(raw || '{}');
      if (!Array.isArray(data.redirect_uris) || !data.redirect_uris.length) return reply(res, 400, { error: 'invalid_redirect_uri' });
      const clientId = token('client');
      clients.set(clientId, { redirects: data.redirect_uris, name: data.client_name });
      return reply(res, 201, { client_id: clientId, redirect_uris: data.redirect_uris });
    }
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(raw);
      if (form.get('grant_type') === 'authorization_code') {
        calls.authorizationCode++;
        const fail = failures.token.shift();
        if (fail) return reply(res, fail, { error: 'server_error' });
        const entry = codes.get(form.get('code'));
        codes.delete(form.get('code'));
        const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (!entry || entry.clientId !== form.get('client_id') || entry.redirect !== form.get('redirect_uri') || entry.challenge !== challenge)
          return reply(res, 400, { error: 'invalid_grant' });
        return reply(res, 200, issue(entry.clientId, entry.account));
      }
      if (form.get('grant_type') === 'refresh_token') {
        calls.refresh++;
        if (config.refreshDelayMs) await new Promise((resolve) => setTimeout(resolve, config.refreshDelayMs));
        const fail = failures.refresh.shift();
        if (fail) return reply(res, fail, fail === 400 ? { error: 'invalid_grant' } : { error: 'server_error' });
        const owner = refreshTokens.get(form.get('refresh_token'));
        if (!owner || owner.clientId !== form.get('client_id')) return reply(res, 400, { error: 'invalid_grant' });
        const body = issue(owner.clientId, owner.account);
        if (config.rotate) refreshTokens.delete(form.get('refresh_token'));
        else { refreshTokens.delete(body.refresh_token); delete body.refresh_token; }
        return reply(res, 200, body);
      }
      return reply(res, 400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/resource') {
      calls.resource++;
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
      return accessTokens.has(bearer) ? reply(res, 200, { ok: true }) : reply(res, 401, { error: 'invalid_token' });
    }
    reply(res, 404, { error: 'not_found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    base, calls, failures, issued, clients, refreshTokens, accessTokens, config,
    // Simula o consentimento do usuário na página de autorização do Suno.
    authorize(authorizationUrl, { account = null } = {}) {
      const url = new URL(authorizationUrl);
      const client = clients.get(url.searchParams.get('client_id'));
      if (!client || !client.redirects.includes(url.searchParams.get('redirect_uri'))) throw new Error('client/redirect inválido');
      if (url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE ausente');
      const code = token('code');
      codes.set(code, { clientId: url.searchParams.get('client_id'), redirect: url.searchParams.get('redirect_uri'),
        challenge: url.searchParams.get('code_challenge'), account });
      return { code, state: url.searchParams.get('state') };
    },
    revokeAll() { accessTokens.clear(); },
    revokeRefresh() { refreshTokens.clear(); },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
