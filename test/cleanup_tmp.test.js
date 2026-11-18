import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { cleanupOrphanTemp } = await import('../src/cleanup_tmp.js');
const { recordingTracks } = await import('../src/recording_format.js');

const sandbox = mkdtempSync(join(tmpdir(), 'pia-cleanup-test-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const T1 = '123456789012345678';
const T2 = '223456789012345678';

function setup() {
  const base = mkdtempSync(join(sandbox, 'case-'));
  const tmp = join(base, 'tmp');
  const data = join(base, 'data');
  mkdirSync(tmp, { recursive: true });
  for (const name of ['pia-media-a1', 'pia-artifact-b2']) {
    mkdirSync(join(tmp, name));
    writeFileSync(join(tmp, name, 'blob.bin'), 'x');
  }
  mkdirSync(join(tmp, 'outro-app-1'));
  writeFileSync(join(tmp, 'pia-media-arquivo-solto'), 'não é diretório');
  const recording = (state, extra = {}) => {
    const dir = join(data, '7', randomUUID());
    mkdirSync(join(dir, 'pia_data'), { recursive: true });
    const meta = { id: randomUUID(), state, name: 'Guild-20261117-voz.aup.zip', tracks: [T1, T2], usernames: { [T1]: 'ana' }, ...extra };
    writeFileSync(join(dir, 'recording.json'), JSON.stringify(meta));
    for (const id of meta.tracks) writeFileSync(join(dir, id + '.pcm'), 'pcm');
    for (const { filename } of recordingTracks(meta)) writeFileSync(join(dir, 'pia_data', filename), 'flac');
    writeFileSync(join(dir, meta.name), 'zip');
    writeFileSync(join(dir, meta.name + '.partial.zip'), 'parcial');
    writeFileSync(join(dir, 'pia.aup'), 'aup');
    writeFileSync(join(dir, 'pia-session.json'), '{}');
    return { dir, meta };
  };
  return { tmp, data, recording };
}
const files = (dir) => readdirSync(dir, { recursive: true }).map(String).sort();

test('removes only orphans: media temp dirs, partial zips and leftovers of uploaded recordings', async () => {
  const { tmp, data, recording } = setup();
  const uploaded = recording('uploaded');
  const queued = recording('queued');
  const retry = recording('queued', { attempts: 3, retryAt: Date.now() + 60000, lastError: 'x' });
  const live = recording('recording');
  const queuedBefore = files(queued.dir);
  const retryBefore = files(retry.dir);
  const liveBefore = files(live.dir);
  const logs = [];
  const counts = await cleanupOrphanTemp({ tmpDir: tmp, dataDir: data, log: (line) => logs.push(line) });

  assert.deepEqual(readdirSync(tmp).sort(), ['outro-app-1', 'pia-media-arquivo-solto'], 'só os diretórios pia-media-*/pia-artifact-* somem');
  assert.deepEqual(files(uploaded.dir), ['pia-session.json', 'pia_data', 'recording.json'], 'enviada: restos apagados, metadado mantido');
  const without = (list) => list.filter((name) => !name.endsWith('.partial.zip'));
  assert.deepEqual(files(queued.dir), without(queuedBefore), 'pendente: só o zip parcial sai');
  assert.deepEqual(files(retry.dir), without(retryBefore), 'retry: só o zip parcial sai');
  assert.ok(existsSync(join(retry.dir, retry.meta.name)) && existsSync(join(retry.dir, T1 + '.pcm')), 'arquivos da fila intactos');
  assert.deepEqual(files(live.dir), liveBefore, 'gravação em andamento não é tocada');
  assert.deepEqual(counts, { media: 2, partial: 3, uploaded: 6, errors: 0 });
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes(tmp) && !logs[0].includes(data) && !/[\\/]/.test(logs[0]), 'log só com contagens');
  const again = await cleanupOrphanTemp({ tmpDir: tmp, dataDir: data, log: () => {} });
  assert.deepEqual(again, { media: 0, partial: 0, uploaded: 0, errors: 0 }, 'idempotente');
});

test('unsafe names in recording.json never escape the recording dir', async () => {
  const { tmp, data, recording } = setup();
  const outside = join(data, '7', 'fora.txt');
  mkdirSync(join(data, '7'), { recursive: true });
  writeFileSync(outside, 'manter');
  const { dir } = recording('uploaded', { name: '../fora.txt', tracks: ['../../x', T1], usernames: { [T1]: '../../fora' } });
  await cleanupOrphanTemp({ tmpDir: tmp, dataDir: data, log: () => {} });
  assert.ok(existsSync(outside));
  assert.ok(!existsSync(join(dir, T1 + '.pcm')));
});

test('never throws: missing dirs, corrupt recording.json and a throwing logger', async () => {
  const { tmp, data, recording } = setup();
  const { dir } = recording('queued');
  writeFileSync(join(dir, 'recording.json'), '{corrompido');
  const counts = await cleanupOrphanTemp({ tmpDir: tmp, dataDir: data, log: () => { throw new Error('log'); } });
  assert.equal(counts.errors, 1);
  assert.ok(existsSync(join(dir, T1 + '.pcm')), 'sem metadado legível nada é apagado');
  const missing = await cleanupOrphanTemp({ tmpDir: join(sandbox, 'nao-existe'), dataDir: join(sandbox, 'nem-este'), log: () => {} });
  assert.deepEqual(missing, { media: 0, partial: 0, uploaded: 0, errors: 0 });
  await assert.doesNotReject(cleanupOrphanTemp({ tmpDir: 42, dataDir: null, log: null }));
});
