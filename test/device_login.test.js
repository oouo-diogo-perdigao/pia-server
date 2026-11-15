import assert from 'node:assert/strict';
import test from 'node:test';
import { approveDeviceLogin, beginDeviceLogin, pollDeviceLogin } from '../src/device_login.js';
import { pool } from '../src/db.js';
import { hash } from '../src/state.js';

test('device login requires browser approval and its original proof, then issues one device', async (t) => {
  const verifier = 'A'.repeat(43);
  const { id, code } = beginDeviceLogin({ challenge: hash(verifier), name: 'Fixture desktop' });
  assert.match(code, /^\d{6}$/);
  assert.deepEqual(await pollDeviceLogin({ id, verifier }), { status: 'pending' });
  approveDeviceLogin(id, { id: '7' });
  assert.throws(() => approveDeviceLogin(id, { id: '8' }), /autorizado/);
  await assert.rejects(pollDeviceLogin({ id, verifier: 'B'.repeat(43) }), /inválido/);
  const query = t.mock.method(pool, 'query', async (_, params) => {
    assert.equal(params[1], '7');
    assert.equal(params[2], 'Fixture desktop');
  });
  const result = await pollDeviceLogin({ id, verifier });
  assert.equal(result.status, 'authorized');
  assert.equal(query.mock.calls[0].arguments[1][3], hash(result.token));
  assert.deepEqual(await pollDeviceLogin({ id, verifier }), { status: 'expired' });
  assert.equal(query.mock.callCount(), 1);
});
