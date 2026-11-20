import assert from 'node:assert/strict';
import test from 'node:test';

process.env.PIA_ENCRYPTION_KEY ||= '0123456789abcdef'.repeat(4);

const {
  parseTavernsDestination,
  partitionConnectors,
  publicConnectors,
  removeConnector,
  runtime,
  saveConnector,
  splitProfile,
  testConnector,
} = await import('../src/connectors.js');
const { pool } = await import('../src/db.js');

const UUID_1 = '11111111-1111-4111-8111-111111111111';
const UUID_2 = '22222222-2222-4222-8222-222222222222';
const UUID_3 = '33333333-3333-4333-8333-333333333333';
const UUID_4 = '44444444-4444-4444-8444-444444444444';

function makeFakePool() {
  const accounts = new Map([
    [1, { id: 1, connectors_initialized: true, discord_token: null }],
    [2, { id: 2, connectors_initialized: true, discord_token: null }],
  ]);
  const rowsByAccount = new Map([
    [1, new Map()],
    [2, new Map()],
  ]);

  async function runQuery(sql, params = [], state = rowsByAccount) {
    if (sql.includes('SELECT a.connectors_initialized AS initialized,c.ciphertext')) {
      const accountId = params[0];
      const acc = accounts.get(accountId);
      const map = state.get(accountId) || new Map();
      if (map.size === 0) return { rows: [{ initialized: acc?.connectors_initialized ?? false, ciphertext: null }] };
      return { rows: [...map.values()].map((ciphertext) => ({ initialized: acc?.connectors_initialized ?? false, ciphertext })) };
    }
    if (sql.startsWith('DELETE FROM pia_server.connectors')) {
      const [accountId, keepTypes] = params;
      const map = state.get(accountId);
      if (map) {
        for (const type of [...map.keys()]) {
          if (!keepTypes.includes(type)) map.delete(type);
        }
      }
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO pia_server.connectors')) {
      const [accountId, type, ciphertext] = params;
      if (!state.has(accountId)) state.set(accountId, new Map());
      state.get(accountId).set(type, ciphertext);
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE pia_server.accounts SET connectors_initialized=true')) {
      const acc = accounts.get(params[0]);
      if (acc) acc.connectors_initialized = true;
      return { rows: [] };
    }
    return { rows: [] };
  }

  return {
    query: (sql, params) => runQuery(sql, params, rowsByAccount),
    connect: async () => {
      let staged = null;
      return {
        query: async (sql, params) => {
          if (sql === 'BEGIN') {
            staged = new Map([...rowsByAccount.entries()].map(([k, v]) => [k, new Map(v)]));
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            rowsByAccount.clear();
            for (const [k, v] of staged.entries()) rowsByAccount.set(k, v);
            staged = null;
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            staged = null;
            return { rows: [] };
          }
          return runQuery(sql, params, staged || rowsByAccount);
        },
        release: () => {},
      };
    },
  };
}

test('legacy profile migrates connector credentials without returning them to desktops', () => {
  const prefix = 'PIA-BACKUP-PLAIN-1\n';
  const taverns = 'setting:Connectors/taverns:TAVERNS_BOT_TOKEN';
  const legacy = {
    version: 1,
    settings: [['Connectors/taverns', 'TAVERNS_BOT_TOKEN', null, 'secret', taverns],
      ['general', 'PORT', '"8762"', 'int', null]],
    documents: [['Connectors/google', '{"accounts":[{"id":"old-account"}]}']],
    secrets: {
      [taverns]: 'tavbot_fixture', 'token:google:old-account': { refresh_token: 'fixture' },
      'storage:old-account': { access_key: 'fixture-key' }, 'setting:general:OPENAI_COMPAT_API_KEY': 'fixture-api',
    },
  };
  const original = { version: 1, backup: Buffer.from(prefix + JSON.stringify(legacy)).toString('base64'), chats: {} };
  const { state, snapshot } = splitProfile(original);
  assert.equal(state.settings['Connectors/taverns'].TAVERNS_BOT_TOKEN, 'tavbot_fixture');
  assert.equal(state.documents['Connectors/google'].accounts[0].id, 'old-account');
  assert.equal(state.secrets['token:google:old-account'].refresh_token, 'fixture');
  assert.equal(state.secrets['storage:old-account'].access_key, 'fixture-key');
  const cleaned = JSON.parse(Buffer.from(snapshot.backup, 'base64').toString().slice(prefix.length));
  assert.deepEqual(cleaned.settings, [legacy.settings[1]]);
  assert.deepEqual(cleaned.documents, []);
  assert.deepEqual(cleaned.secrets, { 'setting:general:OPENAI_COMPAT_API_KEY': 'fixture-api' });
  assert.deepEqual(splitProfile(snapshot).snapshot, snapshot);
});

test('splits the registry into encrypted-row payloads without mixing connector credentials', () => {
  const state = {
    settings: { 'Connectors/discord': { DISCORD_BOT_TOKEN: 'fixture-bot' } },
    documents: { 'Connectors/object_storage': { accounts: [{ id: 'r2' }, { id: 's3' }] } },
    secrets: { 'storage:r2': { secret_key: 'fixture-r2' }, 'storage:s3': { secret_key: 'fixture-s3' },
      'token:google:user': { refresh_token: 'fixture-google' } },
  };
  const parts = partitionConnectors(state);
  assert.deepEqual([...parts.keys()], ['google', 'object_storage', 'discord']);
  assert.deepEqual(parts.get('object_storage').secrets, {
    'storage:r2': state.secrets['storage:r2'], 'storage:s3': state.secrets['storage:s3'],
  });
  assert.deepEqual(parts.get('object_storage').settings, {});
  assert.deepEqual(parts.get('google').secrets, { 'token:google:user': state.secrets['token:google:user'] });
  assert.equal(parts.get('discord').settings['Connectors/discord'].DISCORD_BOT_TOKEN, 'fixture-bot');
});

test('parseTavernsDestination validates two UUIDs separated by slash and rejects empty or malformed input', () => {
  assert.deepEqual(parseTavernsDestination(` ${UUID_1}/${UUID_2} `), {
    tavernId: UUID_1,
    channelId: UUID_2,
    destination: `${UUID_1}/${UUID_2}`,
  });
  for (const invalid of ['', '   ', UUID_1, `${UUID_1}/bad`, `${UUID_1}/${UUID_2}/${UUID_3}`, null, 123]) {
    assert.throws(() => parseTavernsDestination(invalid), /ID da taverna\/ID do canal/);
  }
});

test('publicConnectors returns empty taverns.destination when absent and never leaks token', async (t) => {
  const fake = makeFakePool();
  t.mock.method(pool, 'query', fake.query);
  t.mock.method(pool, 'connect', fake.connect);

  const initial = await publicConnectors({ id: 1, email: 'a@example.com' });
  assert.deepEqual(initial.taverns, { configured: false, destination: '' });

  await saveConnector({ id: 1 }, { provider: 'taverns', token: 'tavbot_secret_fixture', destination: `${UUID_1}/${UUID_2}` });
  const after = await publicConnectors({ id: 1, email: 'a@example.com' });
  assert.deepEqual(after.taverns, { configured: true, destination: `${UUID_1}/${UUID_2}` });
  assert.equal(JSON.stringify(after).includes('tavbot_secret_fixture'), false);
});

test('saveConnector saves destination without token, preserves omitted destination, rejects empty/invalid, and isolates accounts', async (t) => {
  const fake = makeFakePool();
  t.mock.method(pool, 'query', fake.query);
  t.mock.method(pool, 'connect', fake.connect);

  // Save token first
  await saveConnector({ id: 1 }, { provider: 'taverns', token: 'tavbot_first_token' });
  // Save destination without token -> preserves token
  await saveConnector({ id: 1 }, { provider: 'taverns', destination: `${UUID_1}/${UUID_2}` });
  let pub1 = await publicConnectors({ id: 1, email: 'a@example.com' });
  assert.deepEqual(pub1.taverns, { configured: true, destination: `${UUID_1}/${UUID_2}` });

  // Update token omitting destination -> preserves destination
  await saveConnector({ id: 1 }, { provider: 'taverns', token: 'tavbot_second_token' });
  pub1 = await publicConnectors({ id: 1, email: 'a@example.com' });
  assert.deepEqual(pub1.taverns, { configured: true, destination: `${UUID_1}/${UUID_2}` });

  // Explicit empty or invalid destination throws and rolls back without clearing existing value
  await assert.rejects(() => saveConnector({ id: 1 }, { provider: 'taverns', destination: '' }), /ID da taverna\/ID do canal/);
  await assert.rejects(() => saveConnector({ id: 1 }, { provider: 'taverns', destination: 'invalid' }), /ID da taverna\/ID do canal/);
  pub1 = await publicConnectors({ id: 1, email: 'a@example.com' });
  assert.equal(pub1.taverns.destination, `${UUID_1}/${UUID_2}`);

  // Account 2 isolation + Discord regression
  await saveConnector({ id: 2 }, { provider: 'taverns', destination: `${UUID_3}/${UUID_4}` });
  await saveConnector({ id: 2 }, { provider: 'discord', channel: '123456789012345678' });
  const pub2 = await publicConnectors({ id: 2, email: 'b@example.com' });
  assert.deepEqual(pub2.taverns, { configured: false, destination: `${UUID_3}/${UUID_4}` });
  assert.equal(pub2.discord.channel, '123456789012345678');
  pub1 = await publicConnectors({ id: 1, email: 'a@example.com' });
  assert.equal(pub1.taverns.destination, `${UUID_1}/${UUID_2}`);
  assert.equal(pub1.discord.channel, '');
});

test('testConnector uses shared Taverns UUID parser and preserved token with mocked fetch', async (t) => {
  const fake = makeFakePool();
  t.mock.method(pool, 'query', fake.query);
  t.mock.method(pool, 'connect', fake.connect);

  await saveConnector({ id: 1 }, { provider: 'taverns', token: 'tavbot_mock_token' });
  await saveConnector({ id: 1 }, { provider: 'taverns', destination: `${UUID_1}/${UUID_2}` });

  let calledUrl = '';
  let calledAuth = '';
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calledUrl = url;
    calledAuth = init.headers.Authorization;
    return { ok: true, json: async () => ({ id: 'msg-123', status: 'SENT' }) };
  });

  const res = await testConnector({ id: 1 }, { provider: 'taverns', destination: `${UUID_1}/${UUID_2}` });
  assert.deepEqual(res, { id: 'msg-123' });
  assert.equal(calledUrl, `https://api.tav.gg/api/v1/taverns/${UUID_1}/channels/${UUID_2}/messages`);
  assert.equal(calledAuth, 'Bot tavbot_mock_token');
});

test('removeConnector for taverns removes only TAVERNS_BOT_TOKEN and preserves TAVERNS_DESTINATION while discord clears all', async (t) => {
  const fake = makeFakePool();
  t.mock.method(pool, 'query', fake.query);
  t.mock.method(pool, 'connect', fake.connect);

  await saveConnector({ id: 1 }, { provider: 'taverns', token: 'tavbot_initial', destination: `${UUID_1}/${UUID_2}` });
  await saveConnector({ id: 1 }, { provider: 'discord', channel: '123456789012345678' });

  let rt = await runtime({ id: 1 }, 'taverns');
  assert.equal(rt.settings.TAVERNS_DESTINATION, `${UUID_1}/${UUID_2}`);
  assert.equal(rt.settings.TAVERNS_BOT_TOKEN, 'tavbot_initial');

  await removeConnector({ id: 1 }, { provider: 'taverns' });
  const afterDisconnect = await publicConnectors({ id: 1, email: 'a@example.com' });
  assert.deepEqual(afterDisconnect.taverns, { configured: false, destination: `${UUID_1}/${UUID_2}` });
  rt = await runtime({ id: 1 }, 'taverns');
  assert.equal(rt.settings.TAVERNS_BOT_TOKEN, undefined);
  assert.equal(rt.settings.TAVERNS_DESTINATION, `${UUID_1}/${UUID_2}`);

  // Reconnect with new token preserves existing destination
  await saveConnector({ id: 1 }, { provider: 'taverns', token: 'tavbot_reconnected' });
  const afterReconnect = await publicConnectors({ id: 1, email: 'a@example.com' });
  assert.deepEqual(afterReconnect.taverns, { configured: true, destination: `${UUID_1}/${UUID_2}` });

  // Discord disconnect keeps clearing channel and settings
  await removeConnector({ id: 1 }, { provider: 'discord' });
  const afterDiscordDisconnect = await publicConnectors({ id: 1, email: 'a@example.com' });
  assert.equal(afterDiscordDisconnect.discord.channel, '');
  assert.equal(afterDiscordDisconnect.discord.configured, false);
});
