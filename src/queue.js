import { audacityProject, recordingTracks } from './recording_format.js';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { read, root, save, snowflake } from './state.js';
import { uploadRecording } from './drive.js';

const run = promisify(execFile);
const UUID = /^[0-9a-f-]{36}$/;

export function recordings(account) {
  const base = join(root, String(account.id));
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((id) => UUID.test(id)).flatMap((id) => {
    const dir = join(base, id);
    const meta = read(join(dir, 'recording.json'), null);
    return meta ? [{ dir, meta }] : [];
  });
}

export function recover(account) {
  for (const { dir, meta } of recordings(account)) {
    if (meta.state !== 'recording') continue;
    meta.tracks = meta.tracks.filter((id) => snowflake.test(id) && existsSync(join(dir, id + '.pcm')) &&
      statSync(join(dir, id + '.pcm')).size >= 2);
    meta.state = meta.tracks.length ? 'queued' : 'empty';
    meta.endedAt = new Date().toISOString();
    meta.note = 'O serviço foi interrompido durante a gravação.';
    save(join(dir, 'recording.json'), meta);
  }
}

export async function processRecording(account, { dir, meta }) {
  const persist = () => save(join(dir, 'recording.json'), meta);
  const archive = join(dir, meta.name);
  const tracks = join(dir, 'pia_data');
  const project = join(dir, 'pia.aup');
  const entries = recordingTracks(meta);
  try {
    if (!existsSync(archive)) {
      mkdirSync(tracks, { recursive: true, mode: 0o700 });
      for (const { id, filename } of entries) {
        if (!snowflake.test(id)) throw new Error('Faixa inválida.');
        await run('ffmpeg', ['-v', 'error', '-y', '-f', 's16le', '-ar', '48000', '-ac', '1',
          '-i', join(dir, id + '.pcm'), '-c:a', 'flac', join(tracks, filename)],
        { timeout: 30 * 60 * 1000 });
      }
      writeFileSync(project, audacityProject(entries), { mode: 0o600 });
      writeFileSync(join(dir, 'pia-session.json'), JSON.stringify({
        version: 1, source: 'pia-server-discord', id: meta.id, startedAt: meta.startedAt,
        endedAt: meta.endedAt, channelId: meta.channelId, participants: meta.tracks, tracks: entries,
      }) + '\n', { mode: 0o600 });
      const temp = archive + '.partial.zip';
      if (existsSync(temp)) unlinkSync(temp);
      await run('zip', ['-0', '-r', temp, 'pia.aup', ...entries.map(({ filename }) => 'pia_data/' + filename), 'pia-session.json'], { cwd: dir, timeout: 30 * 60 * 1000 });
      renameSync(temp, archive);
    }
    await uploadRecording(account, archive, meta, persist);
    meta.state = 'uploaded';
    delete meta.retryAt;
    delete meta.lastError;
    persist();
    const files = [archive, project, ...entries.flatMap(({ id, filename }) => [join(dir, id + '.pcm'), join(tracks, filename)])];
    for (const file of files) {
      try { unlinkSync(file); } catch { /* Keep the confirmed upload state. */ }
    }
  } catch {
    if (meta.state === 'uploaded') return;
    meta.attempts = (meta.attempts || 0) + 1;
    meta.lastError = 'Falha ao preparar ou enviar ao Drive. Os arquivos locais foram preservados.';
    meta.retryAt = Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(meta.attempts - 1, 7));
    persist();
  }
}
