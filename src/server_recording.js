import { join } from 'node:path';
import { patchRecording } from './queue.js';
import { closeRecordingPoll, getPersistedPollWinner, openRecordingPoll } from './recording_poll.js';

export function isServerRecording(account, meta) {
  return Boolean(meta.processing ||
    (meta.state === 'queued' && (meta.processingMode === 'server' ||
      (meta.processingMode === undefined && account.pro && account.server_processing))));
}

export function createServerRecordingRunner({ worker, prepareArchive, resolveConfig, panelsFor, announce, now = Date.now }) {
  const active = new Set();

  async function run(account, { dir, meta }) {
    if (active.has(dir)) return;
    active.add(dir);
    try {
      const panels = panelsFor(meta);
      async function update(fields) {
        patchRecording(dir, fields);
        Object.assign(meta, fields);
        await panels?.update(meta);
      }

      if (!meta.poll) {
        if (meta.processing?.status === 'failed' || meta.processing?.status === 'skipped' || !panels) return;
        let prepared = meta.processing?.status === 'prepared' ? meta.processing : null;
        try {
          if (!prepared) {
            const config = await resolveConfig(account, meta);
            if (config.missing.length) {
              await update({ processing: { status: 'failed', missingConfig: config.missing } });
              return;
            }
            await update({ processing: { status: 'processing', stage: 'Preparar gravação' } });
            const { archive } = await prepareArchive(account, { dir, meta });
            prepared = await worker.prepare({
              recordingId: meta.id,
              archive,
              workDir: join(dir, 'podcast'),
              account: config.value,
              recordingMetadata: { sessionTitle: meta.sessionTitle, seasonEnd: meta.seasonEnd },
            },
              (stage) => update({ processing: { status: 'processing', stage } }));
            if (prepared.status === 'skipped') {
              await update({ processing: { status: 'skipped', stage: 'Gravação abaixo da duração mínima' } });
              return;
            }
            if (!prepared.statePath || !prepared.artifactId) throw new Error('Artefatos indisponíveis');
            if (!Array.isArray(prepared.suggestions) || !prepared.suggestions.some(
              (item) => typeof item === 'string' && item.trim(),
            )) throw new Error('Sem sugestões');
          }
        } catch {
          await update({ processing: { status: 'failed', error: 'Falha ao preparar os artefatos da gravação.' } });
          return;
        }

        await update({ processing: { status: 'prepared', statePath: prepared.statePath, artifactId: prepared.artifactId, suggestions: prepared.suggestions } });
        const opened = await openRecordingPoll(dir, { suggestions: prepared.suggestions, now });
        Object.assign(meta, opened.meta);
      }

      if (meta.poll.status === 'open') {
        if (Date.parse(meta.poll.endsAt) > now()) {
          await panels?.restorePoll(dir, { autoClose: false, refreshPanel: !panels?.polls.has(meta.id) });
          return;
        }
        const closed = await closeRecordingPoll(dir, { now });
        Object.assign(meta, closed.meta);
        await panels?.update(meta);
      }

      const winner = getPersistedPollWinner(dir);
      if (!winner || ['failed', 'published'].includes(meta.publication?.status)) return;
      await update({ publication: { status: 'publishing' } });
      let result;
      try {
        const config = await resolveConfig(account, meta);
        if (config.missing.length) throw new Error('Configuração indisponível');
        result = await worker.publish({
          recordingId: meta.id,
          statePath: meta.processing?.statePath,
          artifactId: meta.processing?.artifactId,
          winnerTitle: winner.label,
          account: config.value,
          publishDirect: true,
        });
        if (result.published !== true) throw new Error('Publicação não confirmada');
      } catch {
        await update({ publication: { status: 'failed' } });
        return;
      }

      // Persist confirmation before sending. After an interrupted announcement,
      // avoid duplicating a message whose delivery could already have succeeded.
      await update({ publication: { status: 'published', announced: false } });
      try {
        await announce(meta, result.announcement);
        await update({ publication: { status: 'published', announced: true } });
      } catch {
        // Retain the published state and the indication that delivery is uncertain.
      }
    } finally {
      active.delete(dir);
    }
  }

  return { run };
}
