import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

process.env.PIA_ENCRYPTION_KEY ||= '11'.repeat(32);
process.env.PIA_ADMIN_EMAIL ||= 'admin@example.invalid';
const { migrate, pool } = await import('../src/db.js');
const { lockSunoTables } = await import('./fixtures/pg_suno_lock.js');

test('migration creates suno_accounts with N Suno accounts per PIA account and a unique Suno identity', async (t) => {
  const statements = [];
  t.mock.method(pool, 'query', async (sql) => {
    statements.push(String(sql));
    return { rows: [{ name: 'pia_server' }], rowCount: 0 };
  });
  await migrate();
  const ddl = statements.join('\n');
  const table = /CREATE TABLE IF NOT EXISTS pia_server\.suno_accounts \(([\s\S]*?)\n {4}\);/.exec(ddl)?.[1];
  assert.ok(table, 'suno_accounts table');
  assert.match(table, /id uuid PRIMARY KEY/);
  assert.match(table, /account_id bigint NOT NULL REFERENCES pia_server\.accounts\(id\) ON DELETE CASCADE/);
  assert.match(table, /suno_subject text NOT NULL CONSTRAINT pia_suno_accounts_subject UNIQUE/);
  assert.match(table, /suno_email text, suno_name text/);
  assert.match(table, /label text NOT NULL/);
  assert.doesNotMatch(table, /UNIQUE\s*\(\s*account_id/, 'a PIA account may own several Suno accounts');
  assert.match(ddl, /CREATE INDEX IF NOT EXISTS pia_suno_accounts_account ON pia_server\.suno_accounts\(account_id, created\)/);
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS pia_server\.suno_oauth_clients/);
  const attempts = /CREATE TABLE IF NOT EXISTS pia_server\.suno_connect_attempts \(([\s\S]*?)\n {4}\);/.exec(ddl)?.[1];
  assert.ok(attempts, 'suno_connect_attempts table');
  assert.match(attempts, /account_id bigint NOT NULL REFERENCES pia_server\.accounts\(id\) ON DELETE CASCADE/);
  assert.match(attempts, /state_digest text NOT NULL CONSTRAINT pia_suno_connect_attempts_state UNIQUE/);
  assert.match(attempts, /status text NOT NULL DEFAULT 'pending' CHECK \(status IN \('pending', 'connected', 'failed'\)\)/);
  assert.match(attempts, /expires timestamptz NOT NULL/);
  assert.match(attempts, /suno_account_id uuid REFERENCES pia_server\.suno_accounts\(id\) ON DELETE SET NULL/);
  assert.match(attempts, /replace_account_id uuid REFERENCES pia_server\.suno_accounts\(id\) ON DELETE SET NULL/);
});

// Opcional: com um Postgres descartável (PIA_TEST_PG=1 e variáveis PG*), valida a
// DDL de verdade. Fica pulado no CI, que não tem banco.
test('suno_accounts constraints on a real Postgres', { skip: process.env.PIA_TEST_PG !== '1' }, async () => {
  // Dentro do mesmo advisory lock das suítes suno_*: dois `npm test` simultâneos no mesmo
  // Postgres davam "deadlock detected" no migrate() concorrente.
  const unlock = await lockSunoTables(pool);
  try {
    await migrate();
    await migrate();
    const { rows: [owner] } = await pool.query("INSERT INTO pia_server.accounts(email) VALUES('suno-a-' || $1 || '@example.invalid') RETURNING id", [randomUUID()]);
    const { rows: [other] } = await pool.query("INSERT INTO pia_server.accounts(email) VALUES('suno-b-' || $1 || '@example.invalid') RETURNING id", [randomUUID()]);
    const insert = (user, subject, label = 'Suno') => pool.query(`INSERT INTO pia_server.suno_accounts(id,account_id,suno_subject,suno_email,suno_name,label,client_id,ciphertext)
      VALUES($1,$2,$3,'fake@suno.test','Fake',$4,'client','sealed')`, [randomUUID(), user, subject, label]);
    const subject = 'sub-' + randomUUID();
    await insert(owner.id, subject);
    await insert(owner.id, subject + '-2', 'Suno 2');
    await assert.rejects(insert(other.id, subject), (error) => error.code === '23505' && error.constraint === 'pia_suno_accounts_subject');
    await assert.rejects(insert(owner.id, 'sub-' + randomUUID(), ''), (error) => error.code === '23514');
    await assert.rejects(pool.query(`INSERT INTO pia_server.suno_accounts(id,account_id,suno_subject,label,client_id)
      VALUES($1,$2,$3,'Suno','client')`, [randomUUID(), owner.id, 'sub-' + randomUUID()]), (error) => error.code === '23514');
    await pool.query(`INSERT INTO pia_server.suno_accounts(id,account_id,suno_subject,label,client_id,state)
      VALUES($1,$2,$3,'Suno','client','refresh_failed')`, [randomUUID(), owner.id, 'sub-' + randomUUID()]);
    const { rows: [{ count }] } = await pool.query('SELECT count(*)::int AS count FROM pia_server.suno_accounts WHERE account_id=$1', [owner.id]);
    assert.equal(count, 3);
    const { rows: [account] } = await pool.query('SELECT id FROM pia_server.suno_accounts WHERE suno_subject=$1', [subject]);
    const attempt = (status, accountId = null) => pool.query(`INSERT INTO pia_server.suno_connect_attempts(id,account_id,state_digest,verifier,client_id,
      replace_account_id,status,suno_account_id,expires) VALUES($1,$2,$3,'sealed','client',$4,$5,$4,now() + interval '600 seconds') RETURNING id`,
    [randomUUID(), owner.id, 'digest-' + randomUUID(), accountId, status]);
    const { rows: [done] } = await attempt('connected', account.id);
    await assert.rejects(attempt('expired'), (error) => error.code === '23514');
    await pool.query('DELETE FROM pia_server.suno_accounts WHERE id=$1', [account.id]);
    const { rows: [kept] } = await pool.query('SELECT suno_account_id,replace_account_id FROM pia_server.suno_connect_attempts WHERE id=$1', [done.id]);
    assert.deepEqual(kept, { suno_account_id: null, replace_account_id: null });
    await pool.query('DELETE FROM pia_server.accounts WHERE id = ANY($1)', [[owner.id, other.id]]);
    const { rows: [{ left }] } = await pool.query('SELECT count(*)::int AS left FROM pia_server.suno_accounts WHERE account_id = ANY($1)', [[owner.id, other.id]]);
    assert.equal(left, 0);
    const { rows: [{ orphans }] } = await pool.query('SELECT count(*)::int AS orphans FROM pia_server.suno_connect_attempts WHERE account_id = ANY($1)', [[owner.id, other.id]]);
    assert.equal(orphans, 0);
  } finally {
    try { await unlock(); } finally { await pool.end(); }
  }
});
