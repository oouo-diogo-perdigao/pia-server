import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareRecording } from '../src/queue.js';

test('reuses a prepared archive without uploading or changing the recording state', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pia-queue-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const id = '123456789012345678';
  const meta = { name: 'fixture.zip', state: 'queued', tracks: [id] };
  const archive = join(dir, meta.name);
  const statePath = join(dir, 'recording.json');
  const rawTrack = join(dir, id + '.pcm');
  writeFileSync(archive, 'prepared archive');
  writeFileSync(statePath, JSON.stringify(meta));
  writeFileSync(rawTrack, 'fixture track');

  const result = await prepareRecording({ id: 'fixture' }, { dir, meta });

  assert.equal(result.archive, archive);
  assert.ok(result.files.includes(rawTrack));
  assert.equal(readFileSync(archive, 'utf8'), 'prepared archive');
  assert.equal(readFileSync(rawTrack, 'utf8'), 'fixture track');
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), meta);
  assert.equal(meta.state, 'queued');
});
