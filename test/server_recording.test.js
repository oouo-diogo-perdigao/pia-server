import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServerRecordingRunner, isServerRecording } from '../src/server_recording.js';
import { voteRecordingPoll, POLL_DURATION_MS } from '../src/recording_poll.js';
import { read, save } from '../src/state.js';

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pia-pro-recording-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const path = join(dir, 'recording.json');
  const account = { id: '1', pro: true, server_processing: true };
  save(path, { id: 'recording-1', state: 'queued', sessionTitle: 'Nome inicial', sessionTitleBy: 'author' });
  const get = () => read(path, null);
  let time = Date.UTC(2026, 10, 19);
  const calls = [];
  const panels = { polls: new Map(), update: async () => {}, restorePoll: async () => {} };
  const runner = createServerRecordingRunner({
    worker: {
      prepare: async (_, progress) => {
        calls.push('prepare');
        await progress('Transcrever');
        return { statePath: 'state.json', artifactId: 'artifacts-1', suggestions: ['Sugestão'] };
      },
      publish: async (input) => {
        calls.push(['publish', input.winnerTitle, input.artifactId]);
        return { published: true, announcement: ['Campanha - S01E01 - Nome inicial'] };
      },
    },
    resolveConfig: async () => ({ missing: [], value: { campaign: 'Campanha' } }),
    prepareArchive: async () => ({ archive: 'fixture.zip' }),
    panelsFor: () => panels,
    announce: async (_, messages) => { calls.push(['announce', messages]); },
    now: () => time,
    ...overrides,
  });
  return { get, account, dir, calls, advance: (ms) => { time += ms; },
    run: () => runner.run(account, { dir, meta: get() }) };
}

test('prepares without publishing, waits for the original deadline and announces the persisted winner once', async (t) => {
  const job = fixture(t);
  await job.run();
  const opened = job.get();
  assert.equal(opened.processing.status, 'prepared');
  assert.equal(opened.poll.status, 'open');
  assert.deepEqual(opened.poll.options[0].voters, ['author']);
  assert.deepEqual(job.calls, ['prepare']);
  const clock = () => Date.parse(opened.poll.openedAt) + 1;
  await voteRecordingPoll(job.dir, { optionId: opened.poll.options[0].id, userId: 'author', now: clock });
  job.advance(POLL_DURATION_MS - 1);
  await job.run();
  assert.deepEqual(job.calls, ['prepare']);
  job.advance(1);
  await job.run();
  await job.run();
  assert.equal(job.get().poll.winner.label, 'Nome inicial');
  assert.deepEqual(job.get().publication, { status: 'published', announced: true });
  assert.deepEqual(job.calls, ['prepare', ['publish', 'Nome inicial', 'artifacts-1'],
    ['announce', ['Campanha - S01E01 - Nome inicial']]]);
});

test('records missing prerequisites and keeps Pro jobs out of the local queue after they start', async (t) => {
  const job = fixture(t, { resolveConfig: async () => ({ missing: ['bucket/Object Storage'] }) });
  assert.equal(isServerRecording({ pro: false, server_processing: true }, job.get()), false);
  assert.equal(isServerRecording(job.account, job.get()), true);
  await job.run();
  assert.deepEqual(job.get().processing, { status: 'failed', missingConfig: ['bucket/Object Storage'] });
  assert.equal(isServerRecording({ pro: false, server_processing: false }, job.get()), true);
  assert.equal(job.get().poll, undefined);
  assert.deepEqual(job.calls, []);
});
