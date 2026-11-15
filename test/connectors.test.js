import assert from 'node:assert/strict';
import test from 'node:test';
import { partitionConnectors, splitProfile } from '../src/connectors.js';

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
