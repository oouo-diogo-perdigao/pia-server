import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

process.env.PIA_ENCRYPTION_KEY ||= '11'.repeat(32);
process.env.PIA_ADMIN_EMAIL ||= 'admin@example.invalid';

const { migrate, pool } = await import('../src/db.js');
const { isAdminVpnAllowed } = await import('../src/admin_vpn.js');
const {
  ADMIN_VPN_ERROR,
  accountStatusFlags,
  authorizeAdminAccount,
  isAdminRequestAuthorized,
  listAdminAccounts,
  setAccountPro,
  setProcessingMode,
} = await import('../src/admin_routes.js');

function createAccountsPoolFixture(initialAccounts) {
  let nextId = initialAccounts.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1;
  const accounts = initialAccounts.map((row) => ({ ...row }));
  const queries = [];

  return {
    accounts,
    queries,
    async query(sql, params = []) {
      const text = String(sql).trim();
      queries.push({ sql: text, params });

      if (text.startsWith('SELECT id, email, admin, pro, server_processing FROM pia_server.accounts')) {
        return {
          rows: [...accounts]
            .sort((a, b) => Number(a.id) - Number(b.id))
            .map((a) => ({ ...a })),
          rowCount: accounts.length,
        };
      }

      if (text.startsWith('INSERT INTO pia_server.accounts(email)')) {
        const email = params[0];
        let existing = accounts.find((a) => a.email === email);
        if (!existing) {
          existing = {
            id: String(nextId++),
            email,
            admin: false,
            pro: false,
            server_processing: false,
          };
          accounts.push(existing);
        }
        return { rows: [{ ...existing }], rowCount: 1 };
      }

      if (text.startsWith('UPDATE pia_server.accounts SET pro=$2 WHERE id=$1')) {
        const [id, pro] = params;
        const found = accounts.find((a) => String(a.id) === String(id));
        if (!found) return { rows: [], rowCount: 0 };
        found.pro = Boolean(pro);
        return { rows: [{ ...found }], rowCount: 1 };
      }

      if (text.includes('SET server_processing=true') && text.includes('WHERE id=$1 AND pro=true')) {
        const [id] = params;
        const found = accounts.find((a) => String(a.id) === String(id) && a.pro === true);
        if (!found) return { rows: [], rowCount: 0 };
        found.server_processing = true;
        return { rows: [{ pro: found.pro, server_processing: found.server_processing }], rowCount: 1 };
      }

      if (text.includes('SET server_processing=false') && text.includes('WHERE id=$1')) {
        const [id] = params;
        const found = accounts.find((a) => String(a.id) === String(id));
        if (!found) return { rows: [], rowCount: 0 };
        found.server_processing = false;
        return { rows: [{ pro: found.pro, server_processing: found.server_processing }], rowCount: 1 };
      }

      throw new Error(`Unexpected query in fixture: ${text}`);
    },
  };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const parts = [];
  for await (const part of req) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function startTestServer(poolFixture, getSessionAccount, envConfig) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const path = url.pathname;
      const account = getSessionAccount(req);
      if (!account) return json(res, 401, { error: 'Entre com Google.' });

      const vpnCheck = (r) => isAdminVpnAllowed(r, envConfig());
      if ((path === '/api/admin' || path.startsWith('/api/admin/')) && !isAdminRequestAuthorized(req, account, vpnCheck)) {
        return json(res, 403, { error: ADMIN_VPN_ERROR });
      }
      if (req.method === 'GET' && path === '/api/status') {
        return json(res, 200, {
          email: account.email,
          ...accountStatusFlags(account, req, vpnCheck),
        });
      }
      if (req.method === 'GET' && path === '/api/admin/accounts') {
        return json(res, 200, await listAdminAccounts(poolFixture));
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Método indisponível.' });
      const data = await readJsonBody(req);
      if (path === '/api/recordings/processing-mode') {
        const result = await setProcessingMode(poolFixture, account, data);
        return json(res, result.status, result.body);
      }
      if (path === '/api/admin/accounts') {
        return json(res, 200, await authorizeAdminAccount(poolFixture, data));
      }
      if (path === '/api/admin/accounts/pro') {
        const result = await setAccountPro(poolFixture, data);
        return json(res, result.status, result.body);
      }
      return json(res, 404, { error: 'Rota não encontrada.' });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('migration adds pro and server_processing columns to pia_server.accounts', async (t) => {
  const statements = [];
  t.mock.method(pool, 'query', async (sql) => {
    statements.push(String(sql));
    return { rows: [{ name: 'pia_server' }], rowCount: 0 };
  });
  await migrate();
  const ddl = statements.join('\n');
  assert.match(ddl, /ALTER TABLE pia_server\.accounts ADD COLUMN IF NOT EXISTS pro boolean NOT NULL DEFAULT false;/);
  assert.match(ddl, /ALTER TABLE pia_server\.accounts ADD COLUMN IF NOT EXISTS server_processing boolean NOT NULL DEFAULT false;/);
});

test('accountStatusFlags enforces effective server_processing=false for non-pro and admin=false outside VPN', () => {
  const vpnAllowed = () => true;
  const vpnDenied = () => false;
  const fakeReq = {};

  assert.deepEqual(
    accountStatusFlags({ admin: true, pro: false, server_processing: true }, fakeReq, vpnDenied),
    { pro: false, server_processing: false, isAdminAccount: true, adminVpnAllowed: false, admin: false },
  );
  assert.deepEqual(
    accountStatusFlags({ admin: true, pro: true, server_processing: true }, fakeReq, vpnAllowed),
    { pro: true, server_processing: true, isAdminAccount: true, adminVpnAllowed: true, admin: true },
  );
  assert.deepEqual(
    accountStatusFlags({ admin: false, pro: false, server_processing: true }, fakeReq, vpnAllowed),
    { pro: false, server_processing: false, isAdminAccount: false, adminVpnAllowed: true, admin: false },
  );
});

test('HTTP C1/C2 routes enforce VPN 403, manage Pro accounts, and update processing-mode atomically', async () => {
  const poolFixture = createAccountsPoolFixture([
    { id: '1', email: 'admin@example.invalid', admin: true, pro: false, server_processing: false },
    { id: '2', email: 'user@example.invalid', admin: false, pro: false, server_processing: true },
  ]);
  const envState = {
    vpnCidrs: '100.64.0.0/10,fd7a:115c:a1e0::/48',
    trustedProxies: '127.0.0.1/32,::1/128',
  };
  const srv = await startTestServer(
    poolFixture,
    (req) => {
      const id = req.headers['x-test-account'] || '1';
      return poolFixture.accounts.find((a) => a.id === id) || null;
    },
    () => envState,
  );

  try {
    // 1. Admin outside VPN: /api/status hides admin, /api/admin/* returns 403
    const statusOutside = await fetch(`${srv.baseUrl}/api/status`, {
      headers: { 'x-test-account': '1', 'x-forwarded-for': '198.51.100.20' },
    });
    assert.equal(statusOutside.status, 200);
    assert.deepEqual(await statusOutside.json(), {
      email: 'admin@example.invalid',
      pro: false,
      server_processing: false,
      isAdminAccount: true,
      adminVpnAllowed: false,
      admin: false,
    });

    for (const [method, path, payload] of [
      ['GET', '/api/admin/accounts'],
      ['POST', '/api/admin/accounts', { email: 'new@example.invalid' }],
      ['POST', '/api/admin/accounts/pro', { id: 2, pro: true }],
      ['POST', '/api/admin/future-route', {}],
    ]) {
      const res = await fetch(`${srv.baseUrl}${path}`, {
        method,
        headers: {
          'x-test-account': '1',
          'x-forwarded-for': '198.51.100.20',
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
      });
      assert.equal(res.status, 403, `${method} ${path} outside VPN must return 403`);
    }

    // 2. Fail-closed when PIA_ADMIN_VPN_CIDRS is empty
    const savedCidrs = envState.vpnCidrs;
    envState.vpnCidrs = '';
    const failClosed = await fetch(`${srv.baseUrl}/api/admin/accounts`, {
      headers: { 'x-test-account': '1', 'x-forwarded-for': '100.64.0.5' },
    });
    assert.equal(failClosed.status, 403);
    envState.vpnCidrs = savedCidrs;

    // 3. Non-admin inside VPN still gets 403 on admin routes
    const nonAdminRes = await fetch(`${srv.baseUrl}/api/admin/accounts`, {
      headers: { 'x-test-account': '2', 'x-forwarded-for': '100.64.0.5' },
    });
    assert.equal(nonAdminRes.status, 403);

    // 4. Admin inside VPN lists accounts (effective server_processing is false when pro is false)
    const listRes = await fetch(`${srv.baseUrl}/api/admin/accounts`, {
      headers: { 'x-test-account': '1', 'x-forwarded-for': '100.64.0.5' },
    });
    assert.equal(listRes.status, 200);
    assert.deepEqual(await listRes.json(), {
      accounts: [
        { id: '1', email: 'admin@example.invalid', admin: true, pro: false, server_processing: false },
        { id: '2', email: 'user@example.invalid', admin: false, pro: false, server_processing: false },
      ],
    });

    // 5. Admin inside VPN authorizes new email and receives persisted account
    const addRes = await fetch(`${srv.baseUrl}/api/admin/accounts`, {
      method: 'POST',
      headers: {
        'x-test-account': '1',
        'x-forwarded-for': '100.64.0.5',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ email: 'NEWUSER@example.invalid' }),
    });
    assert.equal(addRes.status, 200);
    assert.deepEqual(await addRes.json(), {
      ok: true,
      account: { id: '3', email: 'newuser@example.invalid', admin: false, pro: false, server_processing: false },
    });

    // 6. Common account (id=3) cannot enable server_processing -> 403
    const modeDenied = await fetch(`${srv.baseUrl}/api/recordings/processing-mode`, {
      method: 'POST',
      headers: { 'x-test-account': '3', 'content-type': 'application/json' },
      body: JSON.stringify({ server_processing: true }),
    });
    assert.equal(modeDenied.status, 403);
    assert.deepEqual(await modeDenied.json(), {
      error: 'O processamento no servidor exige o Plano Pro.',
      pro: false,
      server_processing: false,
    });
    assert.ok(
      poolFixture.queries.some((q) => q.sql.includes('WHERE id=$1 AND pro=true')),
      'must check pro=true atomically in SQL UPDATE',
    );

    // 7. Admin promotes account 3 to Pro -> server_processing starts false (D1)
    const proOn = await fetch(`${srv.baseUrl}/api/admin/accounts/pro`, {
      method: 'POST',
      headers: {
        'x-test-account': '1',
        'x-forwarded-for': 'fd7a:115c:a1e0::1',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 3, pro: true }),
    });
    assert.equal(proOn.status, 200);
    assert.deepEqual(await proOn.json(), {
      ok: true,
      account: { id: '3', email: 'newuser@example.invalid', admin: false, pro: true, server_processing: false },
    });

    // 8. Pro account (id=3) enables server_processing -> 200
    const modeOn = await fetch(`${srv.baseUrl}/api/recordings/processing-mode`, {
      method: 'POST',
      headers: { 'x-test-account': '3', 'content-type': 'application/json' },
      body: JSON.stringify({ server_processing: true }),
    });
    assert.equal(modeOn.status, 200);
    assert.deepEqual(await modeOn.json(), { ok: true, pro: true, server_processing: true });

    // 9. Admin demotes account 3 -> effective server_processing becomes false immediately
    const proOff = await fetch(`${srv.baseUrl}/api/admin/accounts/pro`, {
      method: 'POST',
      headers: {
        'x-test-account': '1',
        'x-forwarded-for': '100.64.0.5',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: '3', pro: false }),
    });
    assert.equal(proOff.status, 200);
    assert.deepEqual(await proOff.json(), {
      ok: true,
      account: { id: '3', email: 'newuser@example.invalid', admin: false, pro: false, server_processing: false },
    });

    const statusDemoted = await fetch(`${srv.baseUrl}/api/status`, {
      headers: { 'x-test-account': '3' },
    });
    assert.deepEqual(await statusDemoted.json(), {
      email: 'newuser@example.invalid',
      pro: false,
      server_processing: false,
      isAdminAccount: false,
      adminVpnAllowed: false,
      admin: false,
    });

    // 10. Non-existent account returns 404
    const proMissing = await fetch(`${srv.baseUrl}/api/admin/accounts/pro`, {
      method: 'POST',
      headers: {
        'x-test-account': '1',
        'x-forwarded-for': '100.64.0.5',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 999, pro: true }),
    });
    assert.equal(proMissing.status, 404);
  } finally {
    await srv.close();
  }
});
