import { readdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { recordingTracks } from './recording_format.js';
import { read, root, snowflake } from './state.js';

const TEMP_PREFIXES = ['pia-media-', 'pia-artifact-']; // src/media.js e src/devices.js (mkdtemp)
const UUID = /^[0-9a-f-]{36}$/;

const list = async (dir) => { try { return await readdir(dir, { withFileTypes: true }); } catch { return []; } };
const safeName = (name) => typeof name === 'string' && name !== '' && basename(name) === name && name !== '..' && name !== '.';

// Limpeza de restos no boot. Loga só contagens (nunca caminhos) e nunca lança.
// - Mídia: diretórios tmpdir()/pia-media-* e tmpdir()/pia-artifact-*. No boot não há
//   upload ativo, então todos são órfãos. Isso supõe uma instância só por tmpdir.
// - Gravações do Discord (src/queue.js, <dataDir>/<conta>/<uuid>/): apaga *.partial.zip
//   (o zip é refeito do zero) e, só em gravação já 'uploaded', os arquivos que o
//   unlink pós-upload deveria ter apagado. Pendente/retry (a fila) nunca é tocada.
export async function cleanupOrphanTemp({ tmpDir = tmpdir(), dataDir = root, log = console.log } = {}) {
  const counts = { media: 0, partial: 0, uploaded: 0, errors: 0 };
  const remove = async (path, key, dir = false) => {
    try {
      if (dir) await rm(path, { recursive: true, force: true });
      else await unlink(path);
      counts[key] += 1;
    } catch (error) { if (error?.code !== 'ENOENT') counts.errors += 1; }
  };
  try {
    for (const entry of await list(tmpDir))
      if (entry.isDirectory() && TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) await remove(join(tmpDir, entry.name), 'media', true);
    for (const account of await list(dataDir)) {
      if (!account.isDirectory()) continue;
      for (const recording of await list(join(dataDir, account.name))) {
        if (!recording.isDirectory() || !UUID.test(recording.name)) continue;
        const dir = join(dataDir, account.name, recording.name);
        let meta = null;
        try { meta = read(join(dir, 'recording.json'), null); } catch { counts.errors += 1; }
        if (!meta || meta.state === 'recording') continue; // sem metadado ou gravando: não é nosso
        for (const file of await list(dir))
          if (file.isFile() && file.name.endsWith('.partial.zip')) await remove(join(dir, file.name), 'partial');
        if (meta.state !== 'uploaded') continue;
        const files = [safeName(meta.name) && !meta.name.endsWith('.partial.zip') ? meta.name : null, 'pia.aup'];
        for (const { id, filename } of recordingTracks({ ...meta, tracks: Array.isArray(meta.tracks) ? meta.tracks : [] })) {
          if (snowflake.test(id)) files.push(id + '.pcm');
          if (safeName(filename)) files.push(join('pia_data', filename));
        }
        for (const file of files.filter(Boolean)) await remove(join(dir, file), 'uploaded');
      }
    }
  } catch { counts.errors += 1; }
  try {
    log(`Limpeza de temporários: ${counts.media} dir(s) de mídia, ${counts.partial} zip(s) parcial(is), ` +
      `${counts.uploaded} arquivo(s) de gravação enviada, ${counts.errors} erro(s).`);
  } catch { /* log nunca derruba o boot */ }
  return counts;
}
