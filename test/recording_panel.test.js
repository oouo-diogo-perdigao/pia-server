import assert from 'node:assert/strict';
import test from 'node:test';
import { editableRecording, recordingPanel } from '../src/recording_panel.js';

const startedAt = '2026-11-08T22:00:00.000Z';
const editUntil = '2026-11-08T23:30:00.000Z';
const meta = {
  id: 'a'.repeat(36), channelId: '100000000000000001', startedAt, requester: '100000000000000002',
  members: { '100000000000000002': { joinedAt: startedAt } },
};
test('live panel identifies the starter, participants and measured voice latency', () => {
  const result = recordingPanel({ ...meta, state: 'recording' }, { udp: 24, ws: 18 });
  assert.match(result.embeds[0].fields.find(field => field.name === 'Latência').value, /Voz: 24 ms/);
  assert.match(result.embeds[0].fields.find(field => field.name.startsWith('Participantes')).value, /entrou <t:/);
  assert.equal(result.components[0].components[0].label, 'Parar gravação');
});
test('closing panel expires at the exact deadline while keeping the duration and stopper', () => {
  const done = { ...meta, state: 'queued', editUntil, durationMs: 3600000, stoppedBy: { label: 'Autorecord' } };
  const end = Date.parse(editUntil);
  assert.equal(editableRecording(done, end - 1), true);
  const expired = recordingPanel(done, null, end);
  assert.equal(expired.embeds[0].fields.find(field => field.name === 'Duração total').value, '01:00:00');
  assert.equal(expired.embeds[0].fields.find(field => field.name === 'Encerrada por').value, 'Autorecord');
  assert.ok(expired.components[0].components.every(button => button.disabled));
});
