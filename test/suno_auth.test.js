import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

process.env.PIA_ENCRYPTION_KEY ||= '22'.repeat(32);
process.env.PIA_ADMIN_EMAIL ||= 'admin@example.invalid';
const { migrate, pool, unseal } = await import('../src/db.js');
const auth = await import('../src/suno_auth.js');
const { resolveSunoIdentity, sunoIdentity } = await import('../src/suno_identity.js');
const { SunoError, publicError, sunoMessages } = await import('../src/suno_errors.js');
const { splitProfile } = await import('../src/connectors.js');
const { startFakeSunoOAuth } = await import('./fixtures/fake_suno_oauth.js');
const { startFakeSunoMcp } = await import('./fixtures/fake_suno_mcp.js');
const { createMemorySunoStore } = await import('./fixtures/memory_suno_store.js');
const { lockSunoTables } = await import('./fixtures/pg_suno_lock.js');

// O redirect segue PIA_PUBLIC_URL (origin de src/auth.js); o teste não depende do ambiente.
const { origin } = await import('../src/auth.js');
const REDIRECT = origin + '/auth/connectors/suno';
const SUNO_A = { id: 'suno-user-a', email: 'a@suno.test', label: 'Suno A' };
const SUNO_B = { id: 'suno-user-b', email: 'b@suno.test', label: 'Suno B' };
const original = { ...auth.sunoOAuth };
const originalIdentity = { ...sunoIdentity, sources: [...sunoIdentity.sources] };

// Captura tudo o que vai para o console durante a suíte (para provar que nenhum segredo vaza).
const logged = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const previous = console[level];
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); if (process.env.SUNO_TEST_VERBOSE) previous(...args); };
}

const modes = [{ name: 'memory store' }];
if (process.env.PIA_TEST_PG === '1') modes.push({ name: 'postgres store', pg: true });

for (const mode of modes) {
  describe('Suno auth (' + mode.name + ')', () => {
    let oauth, mcp, server, base, memory, unlock;
    const devices = new Map();
    const pia = {};

    async function readJson(req) {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Envie JSON.');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Objeto JSON obrigatório.');
      return data;
    }

    async function call(method, path, { device, body } = {}) {
      const headers = {};
      if (device) headers.Authorization = 'Bearer ' + device;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
      const text = await response.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: response.status, json, text };
    }

    async function callback(params) {
      const query = new URLSearchParams(params);
      return call('GET', '/auth/connectors/suno?' + query);
    }

    async function connect(device, sunoAccount, body = {}) {
      const started = await call('POST', '/device/suno/connect', { device, body });
      assert.equal(started.status, 200, started.text);
      const { code, state } = oauth.authorize(started.json.url, { account: sunoAccount });
      const page = await callback({ code, state });
      const attempt = await call('GET', '/device/suno/connect/' + started.json.attempt_id, { device });
      return { started, page, attempt: attempt.json };
    }

    async function sunoRows() {
      if (!mode.pg) return [...memory.accounts.values()];
      const { rows } = await pool.query('SELECT * FROM pia_server.suno_accounts ORDER BY created');
      return rows;
    }

    async function expireAttempt(id) {
      if (!mode.pg) { memory.attempts.get(id).expires = new Date(Date.now() - 1000); return; }
      await pool.query("UPDATE pia_server.suno_connect_attempts SET expires=now() - interval '1 second' WHERE id=$1", [id]);
    }

    before(async () => {
      mcp = await startFakeSunoMcp({ accounts: { 'unused-bearer': null } });
      oauth = await startFakeSunoOAuth({ onToken: (access, account) => mcp.addAccount(access, account) });
      Object.assign(auth.sunoOAuth, { registerUrl: oauth.base + '/register', authorizeUrl: oauth.base + '/authorize', tokenUrl: oauth.base + '/token' });
      sunoIdentity.mcpUrl = mcp.url;
      if (mode.pg) {
        unlock = await lockSunoTables(pool);
        await migrate();
        auth.useSunoStore(auth.pgStore);
      }
      server = createServer((req, res) => {
        const url = new URL(req.url, 'http://pia.test');
        auth.sunoRoute(req, res, url, { authenticateDevice: async (header) => devices.get(/^Bearer (.+)$/.exec(header || '')?.[1]) || null,
          readBody: readJson }).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = 'http://127.0.0.1:' + server.address().port;
    });

    beforeEach(async () => {
      devices.clear();
      oauth.config.expiresIn = 900;
      oauth.config.refreshDelayMs = 0;
      oauth.config.rotate = true;
      auth.sunoOAuth.timeoutMs = original.timeoutMs;
      for (const key of Object.keys(oauth.calls)) oauth.calls[key] = 0;
      sunoIdentity.sources = [...originalIdentity.sources];
      if (mode.pg) {
        await pool.query('DELETE FROM pia_server.suno_connect_attempts');
        await pool.query('DELETE FROM pia_server.suno_accounts');
        await pool.query('DELETE FROM pia_server.suno_oauth_clients');
        await pool.query("DELETE FROM pia_server.accounts WHERE email LIKE 'suno-test-%'");
      } else {
        memory = createMemorySunoStore();
        auth.useSunoStore(memory);
      }
      for (const name of ['a', 'b']) {
        let id = name === 'a' ? 101 : 202;
        let deviceId = randomUUID();
        if (mode.pg) {
          ({ rows: [{ id }] } = await pool.query('INSERT INTO pia_server.accounts(email) VALUES($1) RETURNING id', ['suno-test-' + name + '@example.invalid']));
          await pool.query('INSERT INTO pia_server.devices(id,account_id,name,digest) VALUES($1,$2,$3,$4)', [deviceId, id, 'PC ' + name, randomUUID()]);
        }
        const token = randomBytes(32).toString('base64url');
        devices.set(token, { id, device_id: deviceId, email: 'suno-test-' + name + '@example.invalid' });
        pia[name] = { token, id };
      }
    });

    after(async () => {
      await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
      await oauth.close();
      await mcp.close();
      Object.assign(auth.sunoOAuth, original);
      Object.assign(sunoIdentity, originalIdentity);
      auth.useSunoStore(null);
      await unlock?.();
    });

    test('connect registers the OAuth client once (DCR) and returns an async attempt with PKCE', async () => {
      const first = await call('POST', '/device/suno/connect', { device: pia.a.token, body: {} });
      const second = await call('POST', '/device/suno/connect', { device: pia.a.token });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200, 'connect sem corpo também funciona');
      assert.equal(oauth.calls.register, 1);
      assert.deepEqual(Object.keys(first.json).sort(), ['attempt_id', 'expires_in', 'url']);
      assert.equal(first.json.expires_in, 600);
      assert.match(first.json.attempt_id, /^[0-9a-f-]{36}$/);
      const url = new URL(first.json.url);
      assert.equal(url.origin + url.pathname, oauth.base + '/authorize');
      assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.match(url.searchParams.get('scope'), /offline_access/);
      assert.ok(url.searchParams.get('state').length >= 43);
      assert.equal(url.searchParams.get('client_id'), new URL(second.json.url).searchParams.get('client_id'));
      assert.deepEqual([...oauth.clients.values()][0].redirects, [REDIRECT]);
      const pending = await call('GET', '/device/suno/connect/' + first.json.attempt_id, { device: pia.a.token });
      assert.deepEqual(pending.json, { state: 'pending' });
    });

    test('DCR failure is reported as suno_unavailable with code', async () => {
      oauth.failures.register.push(503);
      const result = await call('POST', '/device/suno/connect', { device: pia.a.token, body: {} });
      assert.equal(result.status, 502);
      assert.equal(result.json.code, 'suno_unavailable');
    });

    test('callback exchanges the code, resolves the identity and stores sealed tokens', async () => {
      const { page, attempt } = await connect(pia.a.token, SUNO_A);
      assert.equal(page.status, 200);
      assert.match(page.text, /Suno conectado, pode voltar à PIA\./);
      assert.equal(attempt.state, 'connected');
      assert.match(attempt.account_id, /^[0-9a-f-]{36}$/);
      const status = await call('GET', '/device/suno/status', { device: pia.a.token });
      assert.equal(status.status, 200);
      assert.equal(status.json.accounts.length, 1);
      const [item] = status.json.accounts;
      assert.equal(item.id, attempt.account_id);
      assert.equal(item.label, 'Suno A');
      assert.equal(item.email, 'a@suno.test');
      assert.equal(item.credential_state, 'configured');
      assert.equal(item.available, true);
      assert.ok(Date.parse(item.expires_at) > Date.now());
      assert.equal(status.json.default_account_id, item.id);
      assert.equal(status.json.active_job, null);
      assert.deepEqual(status.json.settings, { max_count: 10, duration: [10, 180], instrumental: true });
      const issued = oauth.issued.at(-1);
      assert.ok(!status.text.includes(issued.access_token) && !status.text.includes(issued.refresh_token));
      const [row] = await sunoRows();
      assert.equal(row.suno_subject, 'suno-user-a');
      assert.equal(String(row.account_id), String(pia.a.id));
      assert.ok(!row.ciphertext.includes(issued.access_token) && !row.ciphertext.includes(issued.refresh_token));
      assert.deepEqual(JSON.parse(unseal(row.ciphertext)), { access_token: issued.access_token, refresh_token: issued.refresh_token });
    });

    test('the OAuth state is single use, bound to the attempt and expires', async () => {
      const started = await call('POST', '/device/suno/connect', { device: pia.a.token, body: {} });
      const { code, state } = oauth.authorize(started.json.url, { account: SUNO_A });
      assert.equal((await callback({ code, state })).status, 200);
      const reused = await callback({ code, state });
      assert.equal(reused.status, 400);
      assert.match(reused.text, /Autorização inválida ou expirada/);
      assert.equal((await callback({ code: 'x', state: 'nao-existe' })).status, 400);
      const other = await call('GET', '/device/suno/connect/' + started.json.attempt_id, { device: pia.b.token });
      assert.equal(other.status, 404);
      assert.equal(other.json.code, 'suno_connect_not_found');
      const late = await call('POST', '/device/suno/connect', { device: pia.a.token, body: {} });
      await expireAttempt(late.json.attempt_id);
      const lateGrant = oauth.authorize(late.json.url, { account: SUNO_A });
      assert.equal((await callback(lateGrant)).status, 400);
      assert.deepEqual((await call('GET', '/device/suno/connect/' + late.json.attempt_id, { device: pia.a.token })).json, { state: 'expired' });
    });

    test('two concurrent callbacks with the same state complete the attempt only once', async () => {
      const started = await call('POST', '/device/suno/connect', { device: pia.a.token, body: {} });
      const { code, state } = oauth.authorize(started.json.url, { account: SUNO_A });
      const pages = await Promise.all([callback({ code, state }), callback({ code, state }), callback({ code, state })]);
      assert.deepEqual(pages.map((page) => page.status).sort(), [200, 400, 400]);
      assert.equal(oauth.calls.authorizationCode, 1);
      assert.equal((await sunoRows()).length, 1);
    });

    test('a code that does not match the PKCE verifier or a denied consent fails the attempt', async () => {
      const started = await call('POST', '/device/suno/connect', { device: pia.a.token, body: {} });
      const { state } = oauth.authorize(started.json.url, { account: SUNO_A });
      assert.equal((await callback({ code: 'codigo-errado', state })).status, 400);
      assert.deepEqual((await call('GET', '/device/suno/connect/' + started.json.attempt_id, { device: pia.a.token })).json,
        { state: 'failed', code: 'suno_oauth_invalid' });
      const denied = await call('POST', '/device/suno/connect', { device: pia.a.token, body: {} });
      const deniedState = new URL(denied.json.url).searchParams.get('state');
      assert.equal((await callback({ error: 'access_denied', state: deniedState })).status, 400);
      assert.deepEqual((await call('GET', '/device/suno/connect/' + denied.json.attempt_id, { device: pia.a.token })).json,
        { state: 'failed', code: 'suno_oauth_denied' });
      assert.equal((await sunoRows()).length, 0);
    });

    test('several Suno accounts per PIA account; reconnecting the same one only renews the tokens', async () => {
      const first = await connect(pia.a.token, SUNO_A);
      const [before] = await sunoRows();
      const again = await connect(pia.a.token, SUNO_A);
      assert.equal(again.attempt.state, 'connected');
      assert.equal(again.attempt.account_id, first.attempt.account_id);
      let rows = await sunoRows();
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0].ciphertext, before.ciphertext);
      const second = await connect(pia.a.token, SUNO_B);
      assert.notEqual(second.attempt.account_id, first.attempt.account_id);
      rows = await sunoRows();
      assert.equal(rows.length, 2);
      const status = await call('GET', '/device/suno/status', { device: pia.a.token });
      assert.deepEqual(status.json.accounts.map((item) => item.label).sort(), ['Suno A', 'Suno B']);
      assert.equal(status.json.default_account_id, null, 'com 2+ contas válidas não há conta padrão');
    });

    test('a Suno account owned by another PIA account is refused with suno_account_taken and nothing is stored', async () => {
      await connect(pia.a.token, SUNO_A);
      const [owned] = await sunoRows();
      const taken = await connect(pia.b.token, SUNO_A);
      assert.equal(taken.page.status, 409);
      assert.ok(taken.page.text.includes('Esta conta Suno já está conectada a outra conta PIA. Desconecte-a lá antes de conectá-la aqui.'));
      assert.deepEqual(taken.attempt, { state: 'failed', code: 'suno_account_taken' });
      const rows = await sunoRows();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].ciphertext, owned.ciphertext, 'os tokens da conta PIA A não mudam');
      assert.deepEqual((await call('GET', '/device/suno/status', { device: pia.b.token })).json.accounts, []);
      const removed = await call('DELETE', '/device/suno/accounts/' + owned.id, { device: pia.a.token });
      assert.deepEqual(removed.json, { ok: true });
      const free = await connect(pia.b.token, SUNO_A);
      assert.equal(free.attempt.state, 'connected');
      assert.equal(String((await sunoRows())[0].account_id), String(pia.b.id));
    });

    test('replace_account_id renews the chosen account and refuses another Suno identity', async () => {
      const { attempt } = await connect(pia.a.token, SUNO_A);
      const mismatch = await connect(pia.a.token, SUNO_B, { replace_account_id: attempt.account_id });
      assert.deepEqual(mismatch.attempt, { state: 'failed', code: 'suno_account_mismatch' });
      assert.equal((await sunoRows()).length, 1);
      const renewed = await connect(pia.a.token, SUNO_A, { replace_account_id: attempt.account_id });
      assert.deepEqual(renewed.attempt, { state: 'connected', account_id: attempt.account_id });
      const unknown = await call('POST', '/device/suno/connect', { device: pia.a.token, body: { replace_account_id: randomUUID() } });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.code, 'suno_account_not_found');
      const foreign = await call('POST', '/device/suno/connect', { device: pia.b.token, body: { replace_account_id: attempt.account_id } });
      assert.equal(foreign.json.code, 'suno_account_not_found');
      const invalid = await call('POST', '/device/suno/connect', { device: pia.a.token, body: { replace_account_id: 42 } });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.json.code, 'bad_request');
      const broken = await fetch(base + '/device/suno/connect', { method: 'POST', body: '{',
        headers: { Authorization: 'Bearer ' + pia.a.token, 'Content-Type': 'application/json' } });
      assert.equal(broken.status, 400);
      assert.equal((await broken.json()).code, 'bad_request');
    });

    test('a Suno without identity fails with suno_identity_unavailable and discards the token', async () => {
      const result = await connect(pia.a.token, null);
      assert.deepEqual(result.attempt, { state: 'failed', code: 'suno_identity_unavailable' });
      assert.equal(result.page.status, 400);
      assert.equal((await sunoRows()).length, 0);
    });

    test('resolveSunoIdentity reads each configured source in order', async () => {
      const token = 'fake-identity-' + randomUUID();
      mcp.addAccount(token, SUNO_B);
      for (const source of ['mcp_get_account', 'mcp_initialize_meta', 'mcp_get_credits']) {
        const identity = await resolveSunoIdentity(token, { sources: [source] });
        assert.deepEqual(identity, { subject: 'suno-user-b', email: 'b@suno.test', name: 'Suno B', source });
      }
      const jwt = ['e30', Buffer.from(JSON.stringify({ sub: 'jwt-user', email: 'j@suno.test' })).toString('base64url'), 'sig'].join('.');
      assert.deepEqual(await resolveSunoIdentity(jwt, { sources: ['mcp_get_account', 'token_claims'] }),
        { subject: 'jwt-user', email: 'j@suno.test', name: null, source: 'token_claims' });
      await assert.rejects(resolveSunoIdentity('sem-conta', { sources: ['mcp_get_account', 'userinfo', 'token_claims'] }),
        (error) => error instanceof SunoError && error.code === 'suno_identity_unavailable');
    });

    test('DELETE removes only the caller\'s own account', async () => {
      const { attempt } = await connect(pia.a.token, SUNO_A);
      const foreign = await call('DELETE', '/device/suno/accounts/' + attempt.account_id, { device: pia.b.token });
      assert.equal(foreign.status, 404);
      assert.equal(foreign.json.code, 'suno_account_not_found');
      assert.equal((await sunoRows()).length, 1);
      assert.deepEqual((await call('DELETE', '/device/suno/accounts/' + attempt.account_id, { device: pia.a.token })).json, { ok: true });
      assert.equal((await sunoRows()).length, 0);
      assert.equal((await call('DELETE', '/device/suno/accounts/' + attempt.account_id, { device: pia.a.token })).status, 404);
      assert.equal((await call('DELETE', '/device/suno/accounts/nao-e-uuid', { device: pia.a.token })).status, 404);
      assert.deepEqual((await call('GET', '/device/suno/connect/' + attempt.account_id, { device: pia.a.token })).json.code, 'suno_connect_not_found');
    });

    test('unpaired devices get the standard /device/* 401', async () => {
      for (const [method, path] of [['GET', '/device/suno/status'], ['POST', '/device/suno/connect'],
        ['GET', '/device/suno/connect/' + randomUUID()], ['DELETE', '/device/suno/accounts/' + randomUUID()]]) {
        const result = await call(method, path, { device: method === 'GET' ? undefined : 'invalido', body: method === 'POST' ? {} : undefined });
        assert.equal(result.status, 401, path);
        assert.deepEqual(result.json, { error: 'Pareamento inválido.' }, path);
      }
      assert.equal((await call('GET', '/device/suno/nada', { device: pia.a.token })).status, 404, 'rota fora da T2 não é tratada');
    });

    test('preventive refresh (< 60 s) rotates the refresh token', async () => {
      oauth.config.expiresIn = 30;
      const { attempt } = await connect(pia.a.token, SUNO_A);
      const grant = oauth.issued.at(-1);
      const account = devices.get(pia.a.token);
      const token = await auth.sunoAccessToken(account, attempt.account_id);
      assert.equal(oauth.calls.refresh, 1);
      assert.notEqual(token, grant.access_token);
      assert.equal(oauth.refreshTokens.has(grant.refresh_token), false, 'o refresh antigo foi invalidado');
      const [row] = await sunoRows();
      assert.equal(JSON.parse(unseal(row.ciphertext)).refresh_token, oauth.issued.at(-1).refresh_token);
      oauth.config.expiresIn = 900;
      const status = await call('GET', '/device/suno/status', { device: pia.a.token });
      assert.equal(oauth.calls.refresh, 2, 'o status renova a conta que expira em < 60 s');
      assert.equal(status.json.accounts[0].credential_state, 'configured');
      assert.equal(await auth.sunoAccessToken(account, attempt.account_id), oauth.issued.at(-1).access_token);
      assert.equal(oauth.calls.refresh, 2, 'token válido não renova');
    });

    test('a refresh without rotation keeps the previous refresh token', async () => {
      oauth.config.expiresIn = 30;
      oauth.config.rotate = false;
      const { attempt } = await connect(pia.a.token, SUNO_A);
      const grant = oauth.issued.at(-1);
      await auth.sunoAccessToken(devices.get(pia.a.token), attempt.account_id);
      const [row] = await sunoRows();
      assert.equal(JSON.parse(unseal(row.ciphertext)).refresh_token, grant.refresh_token);
    });

    test('reactive refresh on 401, then suno_credential_expired if the new token is refused too', async () => {
      const { attempt } = await connect(pia.a.token, SUNO_A);
      const account = devices.get(pia.a.token);
      const resource = (token) => fetch(oauth.base + '/resource', { headers: { Authorization: 'Bearer ' + token } });
      oauth.revokeAll();
      const response = await auth.withSunoToken(account, attempt.account_id, resource);
      assert.equal(response.status, 200);
      assert.equal(oauth.calls.refresh, 1);
      await assert.rejects(auth.withSunoToken(account, attempt.account_id, async () => ({ status: 401 })),
        (error) => error.code === 'suno_credential_expired');
      assert.equal(oauth.calls.refresh, 2);
    });

    test('concurrent requests share a single refresh (row lock)', async () => {
      oauth.config.expiresIn = 30;
      const { attempt } = await connect(pia.a.token, SUNO_A);
      oauth.config.expiresIn = 900;
      oauth.config.refreshDelayMs = 50;
      const account = devices.get(pia.a.token);
      const results = await Promise.all(Array.from({ length: 6 }, () => auth.sunoAccessToken(account, attempt.account_id)));
      assert.equal(oauth.calls.refresh, 1);
      assert.equal(new Set(results).size, 1);
      assert.equal(results[0], oauth.issued.at(-1).access_token);
    });

    test('invalid_grant marks refresh_failed, drops the tokens and maps to suno_credential_expired', async () => {
      oauth.config.expiresIn = 30;
      const { attempt } = await connect(pia.a.token, SUNO_A);
      oauth.revokeRefresh();
      const account = devices.get(pia.a.token);
      await assert.rejects(auth.sunoAccessToken(account, attempt.account_id), (error) => error.code === 'suno_credential_expired');
      const [row] = await sunoRows();
      assert.equal(row.state, 'refresh_failed');
      assert.equal(row.ciphertext, null);
      assert.equal(row.last_error_code, 'suno_credential_expired');
      const status = await call('GET', '/device/suno/status', { device: pia.a.token });
      assert.deepEqual(status.json.accounts.map(({ credential_state, available, expires_at }) => ({ credential_state, available, expires_at })),
        [{ credential_state: 'refresh_failed', available: false, expires_at: null }]);
      const calls = oauth.calls.refresh;
      await assert.rejects(auth.sunoAccessToken(account, attempt.account_id), (error) => error.code === 'suno_credential_expired');
      assert.equal(oauth.calls.refresh, calls, 'sem nova chamada ao Suno');
      oauth.config.expiresIn = 900;
      const again = await connect(pia.a.token, SUNO_A, { replace_account_id: attempt.account_id });
      assert.deepEqual(again.attempt, { state: 'connected', account_id: attempt.account_id });
      assert.equal((await sunoRows())[0].state, 'connected');
      const unknown = auth.sunoAccessToken(account, randomUUID());
      await assert.rejects(unknown, (error) => error.code === 'suno_not_connected');
    });

    test('a temporary refresh failure (5xx or timeout) makes the account unavailable and keeps the tokens', async () => {
      oauth.config.expiresIn = 30;
      const { attempt } = await connect(pia.a.token, SUNO_A);
      const account = devices.get(pia.a.token);
      const [before] = await sunoRows();
      oauth.failures.refresh.push(503);
      await assert.rejects(auth.sunoAccessToken(account, attempt.account_id), (error) => error.code === 'suno_unavailable');
      let [row] = await sunoRows();
      assert.equal(row.state, 'connected');
      assert.equal(row.ciphertext, before.ciphertext, 'tokens mantidos');
      assert.equal(row.last_error_code, 'suno_unavailable');
      oauth.failures.refresh.push(500);
      const status = await call('GET', '/device/suno/status', { device: pia.a.token });
      assert.deepEqual(status.json.accounts.map(({ credential_state, available }) => ({ credential_state, available })),
        [{ credential_state: 'unavailable', available: false }]);
      assert.equal(status.json.default_account_id, null);
      oauth.config.expiresIn = 900;
      const single = await auth.sunoAccountStatus(account, attempt.account_id);
      assert.equal(single.credential_state, 'configured', 'o refresh volta a funcionar');
      assert.equal(auth.sunoCredentialRefusal('unavailable'), 'suno_unavailable');
      assert.equal(auth.sunoCredentialRefusal('refresh_failed'), 'suno_credential_expired');
      assert.equal(auth.sunoCredentialRefusal('configured'), null);
      oauth.config.expiresIn = 30;
      await auth.sunoAccessToken(account, attempt.account_id, { rejected: await auth.sunoAccessToken(account, attempt.account_id) });
      auth.sunoOAuth.timeoutMs = 100;
      oauth.config.refreshDelayMs = 400;
      await assert.rejects(auth.sunoAccessToken(account, attempt.account_id), (error) => error.code === 'suno_unavailable');
      const late = await call('GET', '/device/suno/status', { device: pia.a.token });
      assert.equal(late.json.accounts[0].credential_state, 'unavailable');
      [row] = await sunoRows();
      assert.ok(row.ciphertext);
      for (const item of [status, late]) assert.ok(item.json.accounts.every((entry) => auth.sunoCredentialStates.includes(entry.credential_state)));
    });

    test('PATCH renames an own account (trim, 1 to 80 chars) and reconnecting keeps the nickname', async () => {
      const { attempt } = await connect(pia.a.token, SUNO_A);
      const path = '/device/suno/accounts/' + attempt.account_id;
      const renamed = await call('PATCH', path, { device: pia.a.token, body: { label: '  Conta do estúdio  ' } });
      assert.equal(renamed.status, 200);
      assert.deepEqual(Object.keys(renamed.json).sort(), ['available', 'credential_state', 'email', 'expires_at', 'id', 'label', 'name', 'scopes']);
      assert.equal(renamed.json.label, 'Conta do estúdio');
      assert.equal(renamed.json.id, attempt.account_id);
      assert.equal(renamed.json.credential_state, 'configured');
      const issued = oauth.issued.at(-1);
      assert.ok(!renamed.text.includes(issued.access_token) && !renamed.text.includes(issued.refresh_token));
      assert.equal((await call('PATCH', path, { device: pia.a.token, body: { label: 'é'.repeat(80) } })).json.label, 'é'.repeat(80));
      for (const body of [{ label: '   ' }, { label: 'x'.repeat(81) }, { label: 7 }, {}]) {
        const invalid = await call('PATCH', path, { device: pia.a.token, body });
        assert.equal(invalid.status, 400, JSON.stringify(body));
        assert.equal(invalid.json.code, 'bad_request');
      }
      const foreign = await call('PATCH', path, { device: pia.b.token, body: { label: 'Minha' } });
      assert.equal(foreign.status, 404);
      assert.equal(foreign.json.code, 'suno_account_not_found');
      assert.equal((await call('PATCH', '/device/suno/accounts/' + randomUUID(), { device: pia.a.token, body: { label: 'x' } })).json.code,
        'suno_account_not_found');
      assert.equal((await call('PATCH', path, { body: { label: 'x' } })).status, 401);
      await call('PATCH', path, { device: pia.a.token, body: { label: 'Apelido' } });
      await connect(pia.a.token, SUNO_A);
      const status = await call('GET', '/device/suno/status', { device: pia.a.token });
      assert.equal(status.json.accounts[0].label, 'Apelido');
      assert.equal(status.json.accounts[0].email, 'a@suno.test');
    });

    test('no token, code, verifier or client secret ever reaches the logs', async () => {
      const secrets = oauth.issued.flatMap((item) => [item.access_token, item.refresh_token]).filter(Boolean);
      assert.ok(secrets.length > 0);
      for (const line of logged) for (const secret of secrets) assert.ok(!line.includes(secret), 'segredo no log');
    });
  });
}

test('error responses only expose whitelisted codes', () => {
  assert.deepEqual(publicError(new SunoError('suno_account_taken', sunoMessages.taken, 409)),
    { status: 409, body: { error: sunoMessages.taken, code: 'suno_account_taken' } });
  assert.equal(publicError(new SunoError('ECONNREFUSED', 'x')), null);
  assert.equal(publicError(Object.assign(new Error('pg'), { code: '23505' })), null);
});

test('the server advertises the suno:3 capability', () => {
  assert.ok(auth.sunoCapabilities.includes('suno:3'));
});

test('splitProfile discards device-local mcp: secrets', () => {
  const prefix = 'PIA-BACKUP-PLAIN-1\n';
  const payload = { version: 1, settings: [], documents: [], secrets: {
    'mcp:connector:suno_mcp:default:oauth_access_token': 'local-only', 'setting:general:OPENAI_COMPAT_API_KEY': 'kept',
    'token:google:acc': { refresh_token: 'managed' },
  } };
  const { state, snapshot } = splitProfile({ version: 1, backup: Buffer.from(prefix + JSON.stringify(payload)).toString('base64'), chats: {} });
  const cleaned = JSON.parse(Buffer.from(snapshot.backup, 'base64').toString().slice(prefix.length));
  assert.deepEqual(cleaned.secrets, { 'setting:general:OPENAI_COMPAT_API_KEY': 'kept' });
  assert.ok(!JSON.stringify(state).includes('local-only'));
});

after(async () => { if (process.env.PIA_TEST_PG === '1') await pool.end(); });
