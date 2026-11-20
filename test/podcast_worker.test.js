import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPodcastWorker } from '../src/podcast_worker.js';

test('passes the recording request over stdin and consumes only structured worker stdout', async () => {
  const worker = createPodcastWorker({ command: process.execPath, args: ['-e', `
    let source = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { source += chunk; });
    process.stdin.on('end', () => {
      const data = JSON.parse(source);
      process.stderr.write('private fixture text');
      console.log(JSON.stringify({ event: 'stage', stage: 'Transcrever' }));
      console.log(JSON.stringify({ event: 'checkpoint' }));
      console.log(JSON.stringify({ event: 'result', result: { action: data.action, recordingId: data.recordingId } }));
    });
  `] });
  const stages = [];
  const result = await worker.prepare({ recordingId: 'fixture-1' }, (stage) => stages.push(stage));
  assert.deepEqual(result, { action: 'prepare', recordingId: 'fixture-1' });
  assert.deepEqual(stages, ['Transcrever']);
});
