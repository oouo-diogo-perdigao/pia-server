import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';

process.env.PIA_ENCRYPTION_KEY ||= '11'.repeat(32);
process.env.PIA_ADMIN_EMAIL ||= 'admin@example.invalid';
const { migrate, pool } = await import('../src/db.js');
const {
  MAX_PAGE, decodeCursor, encodeCursor, musicGenerationsRoute, parseLimit, publicItem, validateLocalGeneration,
} = await import('../src/music_generations.js');

const realDb = process.env.PIA_TEST_PG === '1';

/** Sobe um servidor só com a rota, autenticando por um mapa token -> device. */
async function serve(devices) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://pia.test');
    musicGenerationsRoute(req, res, url, async (header) => devices.get(/^Bearer (.+)$/.exec(header || '')?.[1]) || null)
      .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } })
      .catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };
  return { call, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
}

const local = (overrides = {}) => ({ source: 'local', client_id: randomUUID(), prompt: 'samba lento', ...overrides });

// ---------------------------------------------------------------- unidade (sem banco, roda no CI)

test('migration creates music_generations and its tracks with the agreed columns, FKs and names', async (t) => {
  const statements = [];
  t.mock.method(pool, 'query', async (sql) => {
    statements.push(String(sql));
    return { rows: [{ name: 'pia_server' }], rowCount: 0 };
  });
  await migrate();
  const ddl = statements.join('\n');
  const table = /CREATE TABLE IF NOT EXISTS pia_server\.music_generations \(([\s\S]*?)\n {4}\);/.exec(ddl)?.[1];
  assert.ok(table, 'music_generations table');
  assert.match(table, /id uuid PRIMARY KEY/);
  assert.match(table, /account_id bigint NOT NULL REFERENCES pia_server\.accounts\(id\) ON DELETE CASCADE/);
  assert.match(table, /device_id uuid REFERENCES pia_server\.devices\(id\) ON DELETE SET NULL/);
  assert.match(table, /suno_account_id uuid,/);
  assert.doesNotMatch(table, /suno_accounts/, 'FK added by an idempotent ALTER right below');
  assert.doesNotMatch(table, /user_id/);
  assert.match(table, /CONSTRAINT pia_music_generations_client UNIQUE \(account_id, client_id\)/);
  assert.match(table, /source IN \('suno', 'local'\)/);
  assert.match(table, /'queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled'/);
  assert.doesNotMatch(table, /audio_url/, 'links live only in the tracks table');
  const tracks = /CREATE TABLE IF NOT EXISTS pia_server\.music_generation_tracks \(([\s\S]*?)\n {4}\);/.exec(ddl)?.[1];
  assert.match(tracks, /generation_id uuid NOT NULL REFERENCES pia_server\.music_generations\(id\) ON DELETE CASCADE/);
  assert.match(tracks, /audio_url text/);
  assert.match(ddl, /pia_music_generations_suno_account\s+FOREIGN KEY \(suno_account_id\) REFERENCES pia_server\.suno_accounts\(id\) ON DELETE SET NULL/);
  assert.ok(ddl.indexOf('pia_music_generations_suno_account') > ddl.indexOf('pia_suno_connect_attempts_expiry'),
    'FK comes after the suno_connect_attempts block');
  assert.doesNotMatch(ddl, /TODO\(T2\)/);
  assert.ok(ddl.indexOf('music_generations (') > ddl.indexOf('pia_server.suno_connect_attempts ('), 'after the suno_* tables');
});

test('local payload validation: required fields, limits, suno rejected and audio_url refused', () => {
  const ok = validateLocalGeneration(local({ provider: 'gemini', duration: 30, count: 2, tracks: [{ n: 1, extra: false }, { n: 2 }] }));
  assert.equal(ok.provider, 'gemini');
  assert.equal(ok.state, 'completed');
  assert.equal(ok.instrumental, false);
  assert.deepEqual(ok.tracks.map((track) => track.extra), [false, false]);
  assert.equal(validateLocalGeneration(local()).provider, 'local');
  const code = (body) => { try { validateLocalGeneration(body); } catch (error) { return error.musicCode; } return null; };
  assert.equal(code(local({ source: 'suno' })), 'music_source_not_allowed');
  assert.equal(code(local({ source: 'other' })), 'invalid_source');
  assert.equal(code({ ...local(), source: undefined }), 'invalid_source');
  assert.equal(code(local({ client_id: 'nope' })), 'invalid_client_id');
  assert.equal(code(local({ prompt: '   ' })), 'invalid_prompt');
  assert.equal(code(local({ prompt: 'x'.repeat(4001) })), 'invalid_prompt');
  assert.equal(code(local({ provider: 'suno_mcp' })), 'invalid_provider');
  assert.equal(code(local({ provider: 'Bad Provider' })), 'invalid_provider');
  assert.equal(code(local({ duration: 0 })), 'invalid_duration');
  assert.equal(code(local({ duration: 1.5 })), 'invalid_duration');
  assert.equal(code(local({ count: 11 })), 'invalid_count');
  assert.equal(code(local({ instrumental: 'yes' })), 'invalid_instrumental');
  assert.equal(code(local({ state: 'running' })), 'invalid_state', 'local is recorded only when finished');
  assert.equal(code(local({ code: 'Bad Code!' })), 'invalid_code');
  assert.equal(code(local({ created: 'ontem' })), 'invalid_created');
  assert.equal(code(local({ created: new Date(Date.now() - 40 * 86400000).toISOString() })), 'invalid_created');
  assert.equal(code(local({ audio_url: null })), 'audio_url_not_allowed');
  assert.equal(code(local({ tracks: [{ n: 1, audio_url: 'file:///x.mp3' }] })), 'audio_url_not_allowed');
  assert.equal(code(local({ tracks: [{ n: 1 }, { n: 1 }] })), 'invalid_tracks');
  assert.equal(code(local({ tracks: 'x' })), 'invalid_tracks');
  assert.equal(code([]), 'invalid_body');
});

test('cursor and limit parsing reject anything malformed', () => {
  const row = { active: false, created_key: '2026-11-17T23:00:00.123456Z', id: randomUUID() };
  assert.deepEqual(decodeCursor(encodeCursor(row)), { active: false, created: row.created_key, id: row.id });
  const bad = [
    '', 'not base64!', Buffer.from('null').toString('base64url'), Buffer.from('{"a":1}').toString('base64url'),
    Buffer.from(JSON.stringify({ a: true, c: '2026-11-17', i: randomUUID() })).toString('base64url'),
    Buffer.from(JSON.stringify({ a: true, c: row.created_key, i: "x' OR 1=1" })).toString('base64url'),
    'A'.repeat(300),
  ];
  for (const cursor of bad) assert.throws(() => decodeCursor(cursor), (error) => error.musicCode === 'invalid_cursor');
  assert.equal(parseLimit(null), MAX_PAGE);
  assert.equal(parseLimit('7'), 7);
  for (const limit of ['0', '101', '-1', 'abc', '1e2']) {
    assert.throws(() => parseLimit(limit), (error) => error.musicCode === 'invalid_limit');
  }
});

test('public item is a whitelist: no audio_url anywhere, suno_account null without account', () => {
  const device = randomUUID();
  const row = {
    id: randomUUID(), client_id: randomUUID(), source: 'suno', provider: 'suno_mcp', device_id: device,
    suno_account_id: randomUUID(), suno_account_name: null, prompt: 'p', lyrics: null, count: 1, duration: 60,
    state: 'completed', code: null, created: new Date(), audio_url: 'https://cdn.suno.test/a.mp3?token=x',
    tracks: [{ n: 1, title: 't', duration: 60, extra: false, audio_url: 'https://cdn.suno.test/a.mp3' }],
  };
  const item = publicItem(row, device);
  assert.doesNotMatch(JSON.stringify(item), /audio_url|cdn\.suno/);
  assert.equal(item.from_this_device, true);
  assert.deepEqual(item.suno_account, { id: row.suno_account_id, name: null });
  assert.equal(publicItem({ ...row, suno_account_id: null }, randomUUID()).suno_account, null);
  assert.equal(publicItem({ ...row, device_id: null }, device).from_this_device, false);
  assert.deepEqual(Object.keys(item), ['id', 'client_id', 'source', 'provider', 'device_id', 'from_this_device',
    'suno_account', 'prompt', 'lyrics', 'count', 'duration', 'state', 'code', 'created', 'tracks']);
});

test('route: auth, methods, suno source and malformed ids are answered before touching the database', async (t) => {
  const query = t.mock.method(pool, 'query', async () => { throw new Error('no database in this test'); });
  const api = await serve(new Map([['tok', { id: '1', device_id: randomUUID() }]]));
  try {
    assert.deepEqual(await api.call('GET', '/device/music/generations'), {
      status: 401, body: { error: 'Pareamento inválido.', code: 'device_unauthorized' }, text: '{"error":"Pareamento inválido.","code":"device_unauthorized"}',
    });
    assert.equal((await api.call('GET', '/device/music/generations', { token: 'wrong' })).status, 401);
    assert.equal((await api.call('DELETE', `/device/music/generations/${randomUUID()}`)).status, 401);
    assert.equal((await api.call('PUT', '/device/music/generations', { token: 'tok' })).body.code, 'method_not_allowed');
    const suno = await api.call('POST', '/device/music/generations', { token: 'tok', body: local({ source: 'suno' }) });
    assert.deepEqual([suno.status, suno.body.code], [400, 'music_source_not_allowed']);
    const raw = await api.call('POST', '/device/music/generations', { token: 'tok' });
    assert.deepEqual([raw.status, raw.body.code], [400, 'invalid_body']);
    for (const id of ['nope', '%E0%A4%A', `${randomUUID()}x`]) {
      const res = await api.call('DELETE', `/device/music/generations/${id}`, { token: 'tok' });
      assert.deepEqual([res.status, res.body.code], [404, 'music_generation_not_found']);
    }
    const badCursor = await api.call('GET', '/device/music/generations?cursor=zzz', { token: 'tok' });
    assert.deepEqual([badCursor.status, badCursor.body.code], [400, 'invalid_cursor']);
    const badLimit = await api.call('GET', '/device/music/generations?limit=500', { token: 'tok' });
    assert.deepEqual([badLimit.status, badLimit.body.code], [400, 'invalid_limit']);
    assert.equal(query.mock.callCount(), 0);
  } finally {
    await api.close();
  }
});

test('route: every query is scoped by the authenticated account_id', async (t) => {
  const device = { id: '42', device_id: randomUUID() };
  const seen = [];
  t.mock.method(pool, 'query', async (sql, params) => {
    seen.push({ sql: String(sql), params });
    return { rows: [], rowCount: 0 };
  });
  const api = await serve(new Map([['tok', device]]));
  try {
    assert.deepEqual((await api.call('GET', '/device/music/generations', { token: 'tok' })).body, { items: [], next_cursor: null });
    assert.equal((await api.call('DELETE', `/device/music/generations/${randomUUID()}`, { token: 'tok' })).status, 404);
    for (const { sql, params } of seen) {
      assert.match(sql, /account_id=\$1/);
      assert.equal(params[0], '42');
    }
  } finally {
    await api.close();
  }
});

// ---------------------------------------------------------------- Postgres real (PIA_TEST_PG=1 + PG*)
// O CI não tem banco: estes testes ficam pulados lá. Localmente: um Postgres descartável e
// PIA_TEST_PG=1 PGHOST=... PGPORT=... PGUSER=... PGDATABASE=... npm test

async function fixture() {
  await migrate();
  const account = async () => (await pool.query(
    "INSERT INTO pia_server.accounts(email) VALUES('music-' || $1 || '@example.invalid') RETURNING id", [randomUUID()])).rows[0].id;
  const device = async (accountId) => {
    const id = randomUUID();
    await pool.query('INSERT INTO pia_server.devices(id,account_id,name,digest) VALUES($1,$2,$3,$4)', [id, accountId, 'PC', randomUUID()]);
    return { id: accountId, device_id: id };
  };
  const a = await account();
  const b = await account();
  const devices = new Map([['a1', await device(a)], ['a2', await device(a)], ['b1', await device(b)]]);
  return { a, b, devices, api: await serve(devices) };
}

async function sunoAccountFor(accountId, label = 'Ana') {
  const id = randomUUID();
  await pool.query(`INSERT INTO pia_server.suno_accounts(id,account_id,suno_subject,suno_email,suno_name,label,client_id,ciphertext)
    VALUES($1,$2,$3,'ana@suno.test','Ana Suno',$4,'client','sealed')`, [id, accountId, 'sub-' + id, label]);
  return id;
}

async function insertSuno(accountId, deviceId, { state = 'completed', created = 'now()', sunoAccount } = {}) {
  if (sunoAccount === undefined) sunoAccount = await sunoAccountFor(accountId);
  const id = randomUUID();
  await pool.query(`INSERT INTO pia_server.music_generations(id,account_id,client_id,source,provider,suno_account_id,job_id,
    device_id,prompt,lyrics,count,duration,state,created) VALUES($1,$2,$3,'suno','suno_mcp',$4,$5,$6,'suno prompt','letra',1,60,$7,${created})`,
  [id, accountId, randomUUID(), sunoAccount, randomUUID(), deviceId, state]);
  await pool.query(`INSERT INTO pia_server.music_generation_tracks(generation_id,n,title,duration,extra,audio_url)
    VALUES($1,1,'A',60,false,'https://cdn.suno.test/1.mp3?sig=secret'),($1,2,'B',58,true,'https://cdn.suno.test/2.mp3?sig=secret')`, [id]);
  return id;
}

test('POST local creates (201) once and replays the same record (200) per account', { skip: !realDb }, async () => {
  const { api, a } = await fixture();
  try {
    const body = local({ provider: 'local', lyrics: 'la la', title: 'Samba', duration: 30, count: 2, instrumental: true,
      tracks: [{ n: 1, title: 'Samba 1', duration: 30 }, { n: 2, title: 'Samba 2', duration: 29 }] });
    const first = await api.call('POST', '/device/music/generations', { token: 'a1', body });
    assert.equal(first.status, 201);
    assert.equal(first.body.source, 'local');
    assert.equal(first.body.state, 'completed');
    assert.equal(first.body.from_this_device, true);
    assert.equal(first.body.suno_account, null);
    assert.deepEqual(first.body.tracks, [{ n: 1, title: 'Samba 1', duration: 30, extra: false }, { n: 2, title: 'Samba 2', duration: 29, extra: false }]);
    const again = await api.call('POST', '/device/music/generations', { token: 'a2', body: { ...body, prompt: 'outro' } });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
    assert.equal(again.body.prompt, 'samba lento', 'replay returns the original record');
    assert.equal(again.body.from_this_device, false, 'seen from the second PC');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM pia_server.music_generations WHERE account_id=$1', [a]);
    assert.equal(rows[0].n, 1);
    const { rows: tracks } = await pool.query('SELECT count(*)::int AS n FROM pia_server.music_generation_tracks WHERE generation_id=$1', [first.body.id]);
    assert.equal(tracks[0].n, 2, 'replay did not duplicate tracks');
    const otherAccount = await api.call('POST', '/device/music/generations', { token: 'b1', body });
    assert.equal(otherAccount.status, 201, 'client_id is unique per account, not global');
    assert.notEqual(otherAccount.body.id, first.body.id);
    const backdated = local({ created: new Date(Date.now() - 2 * 86400000).toISOString() });
    assert.equal((await api.call('POST', '/device/music/generations', { token: 'a1', body: backdated })).body.created, backdated.created);
  } finally {
    await api.close();
  }
});

test('GET lists all PCs of the account, active first then newest, never audio_url, isolated per account', { skip: !realDb }, async () => {
  const { api, a, b, devices } = await fixture();
  try {
    const a1 = devices.get('a1').device_id;
    const a2 = devices.get('a2').device_id;
    const old = await insertSuno(a, a1, { created: "now() - interval '3 days'" });
    const running = await insertSuno(a, a2, { state: 'running', created: "now() - interval '5 days'" });
    const queued = await insertSuno(a, a1, { state: 'queued', created: "now() - interval '1 day'" });
    const fresh = (await api.call('POST', '/device/music/generations', { token: 'a2', body: local() })).body.id;
    await insertSuno(b, devices.get('b1').device_id);
    const res = await api.call('GET', '/device/music/generations', { token: 'a1' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((item) => item.id), [queued, running, fresh, old]);
    assert.equal(res.body.next_cursor, null);
    assert.deepEqual(res.body.items.map((item) => item.from_this_device), [true, false, false, true]);
    assert.doesNotMatch(res.text, /audio_url|cdn\.suno|sig=secret/);
    const suno = res.body.items.find((item) => item.id === old);
    assert.deepEqual(suno.tracks, [{ n: 1, title: 'A', duration: 60, extra: false }, { n: 2, title: 'B', duration: 58, extra: true }]);
    assert.equal(suno.suno_account.name, 'Ana', 'name comes from the suno_accounts label');
    assert.match(suno.suno_account.id, /^[0-9a-f-]{36}$/);
    assert.equal(res.body.items.find((item) => item.id === fresh).suno_account, null, 'local item has no Suno account');
    const other = await api.call('GET', '/device/music/generations', { token: 'b1' });
    assert.equal(other.body.items.length, 1);
    assert.ok(other.body.items.every((item) => ![queued, running, fresh, old].includes(item.id)));
  } finally {
    await api.close();
  }
});

test('GET paginates >100 items with a stable cursor; forged cursors never cross accounts', { skip: !realDb }, async () => {
  const { api, a, b, devices } = await fixture();
  try {
    const values = [];
    for (let i = 0; i < 230; i += 1) {
      // timestamps repetidos de propósito: o id desempata
      values.push(`('${randomUUID()}',${a},'${randomUUID()}','local','local','${devices.get('a1').device_id}','p${i}',
        '${i % 5 === 0 ? 'running' : 'completed'}',now() - interval '${Math.floor(i / 3)} minutes')`);
    }
    await pool.query(`INSERT INTO pia_server.music_generations(id,account_id,client_id,source,provider,device_id,prompt,state,created)
      VALUES ${values.join(',')}`);
    const bItem = await insertSuno(b, devices.get('b1').device_id, { created: "now() - interval '10 minutes'" });
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const res = await api.call('GET', `/device/music/generations${cursor ? `?cursor=${cursor}` : ''}`, { token: 'a2' });
      assert.equal(res.status, 200);
      assert.ok(res.body.items.length <= 100);
      seen.push(...res.body.items);
      cursor = res.body.next_cursor;
      pages += 1;
    } while (cursor);
    assert.equal(pages, 3);
    assert.equal(seen.length, 230);
    assert.equal(new Set(seen.map((item) => item.id)).size, 230, 'no duplicates across pages');
    const firstDone = seen.findIndex((item) => item.state !== 'running');
    assert.equal(firstDone, 46, 'all 46 running items come first');
    assert.ok(seen.slice(firstDone).every((item) => item.state !== 'running'));
    for (let i = 1; i < seen.length; i += 1) {
      const [prev, cur] = [seen[i - 1], seen[i]];
      if ((prev.state === 'running') === (cur.state === 'running')) assert.ok(prev.created >= cur.created);
    }
    const small = await api.call('GET', '/device/music/generations?limit=7', { token: 'a1' });
    assert.equal(small.body.items.length, 7);
    const next = await api.call('GET', `/device/music/generations?limit=7&cursor=${small.body.next_cursor}`, { token: 'a1' });
    assert.deepEqual(next.body.items.map((item) => item.id), seen.slice(7, 14).map((item) => item.id));

    const { rows: [target] } = await pool.query(`SELECT id,(state IN ('queued','running')) AS active,
      to_char(created AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_key
      FROM pia_server.music_generations WHERE id=$1`, [bItem]);
    const forged = encodeCursor({ ...target, created_key: '2999-01-01T00:00:00.000000Z', id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
    const fromB = await api.call('GET', `/device/music/generations?cursor=${forged}`, { token: 'a1' });
    assert.equal(fromB.status, 200);
    assert.ok(fromB.body.items.every((item) => item.id !== bItem), 'account B item never shows up for account A');
    const bCursor = encodeCursor(target);
    const crafted = await api.call('GET', `/device/music/generations?cursor=${bCursor}`, { token: 'a1' });
    assert.ok(crafted.body.items.every((item) => item.id !== bItem));
    assert.equal((await api.call('GET', '/device/music/generations?cursor=bad!', { token: 'a1' })).status, 400);
  } finally {
    await api.close();
  }
});

test('suno_account join: with account, without account and SET NULL when the Suno account is deleted', { skip: !realDb }, async () => {
  const { api, a, devices } = await fixture();
  try {
    const device = devices.get('a1').device_id;
    const sunoAccount = await sunoAccountFor(a, 'Estúdio');
    const linked = await insertSuno(a, device, { sunoAccount });
    const orphan = await insertSuno(a, device, { sunoAccount: null });
    await assert.rejects(insertSuno(a, device, { sunoAccount: randomUUID() }), /pia_music_generations_suno_account/);
    const find = async (id) => (await api.call('GET', '/device/music/generations', { token: 'a1' })).body.items.find((item) => item.id === id);
    assert.deepEqual((await find(linked)).suno_account, { id: sunoAccount, name: 'Estúdio' });
    assert.equal((await find(orphan)).suno_account, null);
    await pool.query('DELETE FROM pia_server.suno_accounts WHERE id=$1', [sunoAccount]);
    const { rows: [row] } = await pool.query('SELECT suno_account_id FROM pia_server.music_generations WHERE id=$1', [linked]);
    assert.equal(row.suno_account_id, null, 'ON DELETE SET NULL');
    const after = await find(linked);
    assert.equal(after.suno_account, null);
    assert.equal(after.tracks.length, 2, 'history item and tracks survive the disconnect');
  } finally {
    await api.close();
  }
});

test('DELETE is a hard delete with cascade, works from another PC, 404 for other accounts and repeats, 409 while active', { skip: !realDb }, async () => {
  const { api, a, b, devices } = await fixture();
  try {
    const done = await insertSuno(a, devices.get('a1').device_id);
    const active = await insertSuno(a, devices.get('a1').device_id, { state: 'running' });
    const foreign = await insertSuno(b, devices.get('b1').device_id);
    const fromOtherAccount = await api.call('DELETE', `/device/music/generations/${done}`, { token: 'b1' });
    assert.deepEqual([fromOtherAccount.status, fromOtherAccount.body.code], [404, 'music_generation_not_found']);
    const deleted = await api.call('DELETE', `/device/music/generations/${done}`, { token: 'a2' });
    assert.deepEqual([deleted.status, deleted.body], [200, { ok: true }], 'another PC of the same account may delete');
    const { rows: gone } = await pool.query('SELECT 1 FROM pia_server.music_generations WHERE id=$1', [done]);
    assert.equal(gone.length, 0);
    const { rows: tracks } = await pool.query('SELECT 1 FROM pia_server.music_generation_tracks WHERE generation_id=$1', [done]);
    assert.equal(tracks.length, 0, 'tracks (and links) removed in cascade');
    assert.equal((await api.call('DELETE', `/device/music/generations/${done}`, { token: 'a1' })).status, 404, 'repeat');
    const busy = await api.call('DELETE', `/device/music/generations/${active}`, { token: 'a1' });
    assert.deepEqual([busy.status, busy.body.code], [409, 'music_generation_active']);
    assert.equal((await pool.query('SELECT 1 FROM pia_server.music_generations WHERE id=$1', [foreign])).rows.length, 1);
    const list = await api.call('GET', '/device/music/generations', { token: 'a1' });
    assert.deepEqual(list.body.items.map((item) => item.id), [active], 'gone for every PC');
    const local = (await api.call('POST', '/device/music/generations', { token: 'a1', body: { source: 'local', client_id: randomUUID(), prompt: 'x', tracks: [{ n: 1 }] } })).body;
    assert.equal((await api.call('DELETE', `/device/music/generations/${local.id}`, { token: 'a1' })).status, 200);
  } finally {
    await api.close();
  }
});

test('database enforces unique client_id per account, no Suno ids on local rows and valid states', { skip: !realDb }, async () => {
  const { api, a } = await fixture();
  try {
    const insert = (clientId, { jobId = null, state = 'completed' } = {}) => pool.query(`INSERT INTO pia_server.music_generations(
      id,account_id,client_id,source,provider,prompt,state,job_id) VALUES($1,$2,$3,'local','local','p',$4,$5)`,
    [randomUUID(), a, clientId, state, jobId]);
    const clientId = randomUUID();
    await insert(clientId);
    await assert.rejects(insert(clientId), /pia_music_generations_client/);
    await assert.rejects(insert(randomUUID(), { jobId: randomUUID() }), /pia_music_generations_local/);
    await assert.rejects(insert(randomUUID(), { state: 'pending' }), /pia_music_generations_state/);
  } finally {
    await api.close();
  }
});

test.after(async () => {
  if (realDb) await pool.end();
});
