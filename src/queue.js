import { editWindowMs } from './recording_panel.js';
import { audacityProject, recordingTracks } from './recording_format.js';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, read, root, save, snowflake } from './state.js';
import { uploadRecording, uploadRecordingSidecar } from './drive.js';

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
    const end = Date.now();
    meta.endedAt = new Date(end).toISOString();
    meta.durationMs = Math.max(0, end - Date.parse(meta.startedAt));
    if (meta.panelMessageId) meta.editUntil = new Date(end + editWindowMs).toISOString();
    meta.stoppedBy = { label: 'Sistema' };
    meta.note = 'O serviço foi interrompido durante a gravação.';
    save(join(dir, 'recording.json'), meta);
  }
}

export function patchRecording(dir, fields) {
  const path = join(dir, 'recording.json');
  const current = read(path, {});
  save(path, { ...current, ...fields });
}

export function saveRecordingEdits(dir, meta) {
  patchRecording(dir, { sessionTitle: meta.sessionTitle, seasonEnd: meta.seasonEnd, metadataEdited: true });
}

function sidecarContent(meta) {
  return JSON.stringify({ version: 1, source: 'pia-server-discord', id: meta.id,
    guildId: meta.guildId, channelId: meta.channelId, startedAt: meta.startedAt,
    sessionTitle: meta.sessionTitle || '', seasonEnd: Boolean(meta.seasonEnd) }) + '\n';
}

export function needsSidecar(meta, now = Date.now()) {
  return meta.state === 'uploaded' && (meta.metadataEdited || meta.sessionTitle || meta.seasonEnd) &&
    meta.sidecarHash !== hash(sidecarContent(meta)) && (meta.sidecarRetryAt || 0) <= now;
}

export async function processRecordingSidecar(account, { dir, meta }) {
  const content = sidecarContent(meta);
  try {
    await uploadRecordingSidecar(account, meta, meta.name.replace(/\.zip$/i, '.json'), content,
      (sidecarId) => patchRecording(dir, { sidecarId }));
    patchRecording(dir, { sidecarHash: hash(content), sidecarRetryAt: null });
  } catch {
    patchRecording(dir, { sidecarRetryAt: Date.now() + 30000 });
    console.error('Falha ao enviar metadados da gravação; nova tentativa agendada.');
  }
}

export async function processRecording(account, { dir, meta }) {
  const persist = () => patchRecording(dir, { driveId: meta.driveId });
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
      const previous = recordings(account).map((item) => item.meta)
        .filter((item) => item.guildId === meta.guildId && item.channelId === meta.channelId &&
          item.startedAt < meta.startedAt && item.tracks.length && item.state !== 'recording')
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      writeFileSync(project, audacityProject(entries, meta.notes), { mode: 0o600 });
      writeFileSync(join(dir, 'pia-session.json'), JSON.stringify({
        version: 1, source: 'pia-server-discord', id: meta.id, startedAt: meta.startedAt,
        endedAt: meta.endedAt, channelId: meta.channelId, participants: meta.tracks, tracks: entries,
        durationMs: meta.durationMs, requester: meta.requester, stoppedBy: meta.stoppedBy,
        notes: meta.notes || [], metadataEditableUntil: meta.editUntil,
        previousRecordingName: previous?.name, startsSeason: Boolean(previous?.seasonEnd),
      }) + '\n', { mode: 0o600 });
      const temp = archive + '.partial.zip';
      if (existsSync(temp)) unlinkSync(temp);
      await run('zip', ['-0', '-r', temp, 'pia.aup', ...entries.map(({ filename }) => 'pia_data/' + filename), 'pia-session.json'], { cwd: dir, timeout: 30 * 60 * 1000 });
      renameSync(temp, archive);
    }
    await uploadRecording(account, archive, meta, persist);
    meta.state = 'uploaded';
    patchRecording(dir, { state: 'uploaded', retryAt: null, lastError: null });
    const files = [archive, project, ...entries.flatMap(({ id, filename }) => [join(dir, id + '.pcm'), join(tracks, filename)])];
    for (const file of files) {
      try { unlinkSync(file); } catch { /* Keep the confirmed upload state. */ }
    }
  } catch {
    if (meta.state === 'uploaded') return;
    meta.attempts = (meta.attempts || 0) + 1;
    meta.lastError = 'Falha ao preparar ou enviar ao Drive. Os arquivos locais foram preservados.';
    meta.retryAt = Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(meta.attempts - 1, 7));
    patchRecording(dir, { attempts: meta.attempts, lastError: meta.lastError, retryAt: meta.retryAt });
  }
}
