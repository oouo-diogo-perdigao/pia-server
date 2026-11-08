import assert from 'node:assert/strict';
import test from 'node:test';
import { recordingCommands, registerRecordingCommands, visibleRecordings, wave } from '../src/recording_commands.js';

test('registers recording commands without replacing commands like /link', async () => {
  const requests = [];
  await registerRecordingCommands({ application: { id: '100000000000000001' },
    rest: { post: async (route, { body }) => requests.push({ route, body }) } });
  assert.deepEqual(requests.map(({ body }) => body.name),
    ['join', 'stop', 'recordings', 'voice-test', 'info', 'bless', 'unbless', 'autorecord', 'bot-profile']);
  assert.ok(requests.every(({ route }) => route === '/applications/100000000000000001/commands'));
  assert.deepEqual(recordingCommands.find(({ name }) => name === 'autorecord').options.map(({ name }) => name),
    ['on', 'off', 'view', 'prune']);
});

test('recording history is isolated by Discord server and participation', () => {
  const item = (guildId, requester, tracks, startedAt) => ({ meta: { guildId, requester, tracks, startedAt } });
  const a = item('guild', 'me', [], '2026-01-01');
  const b = item('guild', 'other', ['me'], '2026-02-01');
  const c = item('guild', 'other', ['other'], '2026-03-01');
  const d = item('different', 'me', ['me'], '2026-04-01');
  assert.deepEqual(visibleRecordings([a, b, c, d], 'guild', 'me', false), [b, a]);
  assert.deepEqual(visibleRecordings([a, b, c, d], 'guild', 'me', true), [c, b, a]);
});

test('voice sample is a 48 kHz mono PCM WAV', () => {
  const payload = Buffer.from([1, 2, 3, 4]);
  const file = wave([payload]);
  assert.equal(file.toString('ascii', 0, 4), 'RIFF');
  assert.equal(file.readUInt32LE(4), file.length - 8);
  assert.equal(file.readUInt16LE(22), 1);
  assert.equal(file.readUInt32LE(24), 48000);
  assert.equal(file.readUInt32LE(40), payload.length);
  assert.deepEqual(file.subarray(44), payload);
});

test('updates server-scoped bless schema already installed by the previous release', async () => {
  const requests = [];
  await registerRecordingCommands({
    application: { id: '100000000000000001' },
    guilds: { cache: new Map([['guild', { id: '100000000000000002' }]]) },
    rest: { get: async () => [{ name: 'bless' }, { name: 'link' }],
      post: async (route, { body }) => requests.push({ route, body }) },
  });
  const local = requests.filter(({ route }) => route.includes('/guilds/'));
  assert.deepEqual(local.map(({ body }) => body.name), ['bless']);
  assert.equal(local[0].body.options[0].name, 'code');
  assert.equal(local[0].body.contexts, undefined);
});
