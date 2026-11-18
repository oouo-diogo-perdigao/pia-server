import assert from 'node:assert/strict';
import test from 'node:test';
import { editableRecording, recordingPanel, trainingNotice } from '../src/recording_panel.js';

import { silenceAction } from '../src/recorder.js';
import { hasRecordingRole } from '../src/discord_guild_links.js';

test('silence warns at five minutes and stops at ten minutes', () => {
  assert.equal(silenceAction(299999), 'wait');
  assert.equal(silenceAction(300000), 'warn');
  assert.equal(silenceAction(599999), 'warn');
  assert.equal(silenceAction(600000), 'stop');
});

test('recording roles support both gateway member representations', () => {
  assert.equal(hasRecordingRole({ member: { roles: ['role'] } }, ['role']), true);
  assert.equal(hasRecordingRole({ member: { roles: { cache: new Set(['role']) } } }, ['role']), true);
  assert.equal(hasRecordingRole({ member: { roles: ['unrelated'] } }, ['role']), false);
});

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

test('live panel announces the recording, keeps non-users out of training and links the privacy policy (RF10, CA26, parecer 4.14)', () => {
  const field = (result) => result.embeds[0].fields.find(({ name }) => name === 'Privacidade');
  const live = recordingPanel({ ...meta, state: 'recording' }, null, Date.now(), 'https://pia.travelrpg.com/qualquer');
  assert.equal(live.embeds[0].title, '🔴 Gravação em andamento');
  const notice = field(live).value;
  // Redação 4.14 do parecer jurídico (Caminho A): terceiros fora do treinamento; contato por e-mail.
  assert.match(notice, /Este canal está sendo gravado pela PIA\. O áudio de cada participante vai para o Google Drive de quem configurou a gravação\. As vozes gravadas não são usadas para treinar modelos\. Se não quiser ser gravado, avise quem configurou a gravação ou saia do canal\. Dúvidas e pedidos: contato@travelrpg\.com\./);
  assert.doesNotMatch(notice, /pode ser usada para treinar modelos/);
  // Adendo 3 (O9 do QA): sem a frase ambígua sobre as vozes de terceiros.
  assert.doesNotMatch(notice, /vozes de quem não usa a PIA não são usadas/i);
  assert.doesNotMatch(notice, /\{\{/, 'token de dados expandido no embed');
  assert.match(notice, /^\[EM REVISÃO JURÍDICA: P11 aviso de gravação no Discord\] /, 'rascunho visível até o parecer');
  assert.match(notice, /\nPolítica de Privacidade: https:\/\/pia\.travelrpg\.com\/privacidade$/);
  assert.doesNotMatch(notice, /MP3/);
  assert.ok(notice.length <= 1024, 'limite de campo do embed');
  assert.match(field(recordingPanel({ ...meta, state: 'recording' }, null, Date.now(), 'https://outro.example')).value,
    /https:\/\/outro\.example\/privacidade$/);
  assert.match(trainingNotice(), /\/privacidade$/);
  assert.equal(field(recordingPanel({ ...meta, state: 'queued', editUntil, durationMs: 1000 }, null, Date.parse(editUntil))), undefined,
    'painel encerrado não repete o aviso');
});
