import assert from 'node:assert/strict';
import test from 'node:test';
import { audacityProject, recordingName, recordingTracks } from '../src/recording_format.js';

test('Discord archive uses the server, local millisecond timestamp and portable room name', () => {
  assert.equal(recordingName('RPGs', 'Bate Papo', new Date('2026-11-08T21:13:39.235Z')),
    'RPGs20261108181339235-Bate-Papo.aup.zip');
  assert.equal(recordingName('Mesa', 'Sala/1', new Date('2026-11-09T01:00:00.001Z')),
    'Mesa20261108220000001-Sala-1.aup.zip');
});

test('Audacity project imports each named FLAC from pia_data at the common origin', () => {
  const a = '100000000000000001', b = '100000000000000002';
  const tracks = recordingTracks({ tracks: [a, b], usernames: { [a]: 'oouo01', [b]: 'Outro & voz' } });
  assert.deepEqual(tracks.map(({ filename }) => filename), ['oouo01.flac', 'Outro-voz.flac']);
  const project = audacityProject(tracks);
  assert.match(project, /projname="pia_data"/);
  assert.match(project, /<import filename="oouo01.flac" name="oouo01" offset="0"\/>/);
  assert.match(project, /name="Outro &amp; voz" offset="0"/);
  assert.equal(recordingTracks({ tracks: [a] })[0].filename, '1-' + a + '.flac');
});
