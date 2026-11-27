import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRules } from '../src/state.js';
import { EventEmitter } from 'node:events';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { DiscordRecorder, positionForFrame } from '../src/recorder.js';

test('tracks place later speakers and longer pauses on the session clock', () => {
  assert.equal(positionForFrame(0, 1020, 960), 48000);
  assert.equal(positionForFrame(48960, 1048, 960), 48960);
  assert.equal(positionForFrame(49920, 2020, 960), 96000);
});

test('voice rules require explicit channel IDs, bounded timing and unique channels', () => {
  const rule = { guildId: '111111111111111111', channelId: '222222222222222222',
    noticeChannelId: '333333333333333333', minPeople: 2, triggerUsers: [], emptySeconds: 30 };
  assert.deepEqual(validateRules([rule]), [rule]);
  assert.throws(() => validateRules([rule, rule]));
  assert.throws(() => validateRules([{ ...rule, minPeople: 0 }]));
  assert.throws(() => validateRules([{ ...rule, noticeChannelId: '' }]));
});

test('two bots can record different rooms in one guild and reserve each room only once', async () => {
  const bot = () => {
    const recorder = Object.create(DiscordRecorder.prototype);
    recorder.startRecording = async () => {
      const connection = new EventEmitter();
      connection.state = { status: VoiceConnectionStatus.Ready };
      return { connection };
    };
    return recorder;
  };
  const pia = bot();
  const dark = bot();
  const roomA = { id: 'room-a', guildId: 'guild' };
  const roomB = { id: 'room-b', guildId: 'guild' };
  const user = { id: 'player' };
  const first = pia.start({}, {}, roomA, user);
  await assert.rejects(dark.start({}, {}, roomA, user), /nesta sala/);
  const [sessionA, sessionB] = await Promise.all([first, dark.start({}, {}, roomB, user)]);
  sessionA.connection.emit(VoiceConnectionStatus.Destroyed);
  sessionB.connection.emit(VoiceConnectionStatus.Destroyed);
  const reused = await dark.start({}, {}, roomA, user);
  assert.ok(reused);
  reused.connection.emit(VoiceConnectionStatus.Destroyed);
});
