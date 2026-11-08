import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pool } from './db.js';
import { uploadRecording } from './drive.js';

const formats = {
  'image/png': ['captura', 'png'], 'image/jpeg': ['captura', 'jpg'], 'image/bmp': ['captura', 'bmp'],
  'audio/mpeg': ['musica', 'mp3'], 'audio/wav': ['musica', 'wav'],
};
const active = new Set();

export async function receiveMedia(account, req) {
  if (!account.folder_id || !account.drive_refresh) throw new Error('Configure o Drive primeiro.');
  const id = req.headers['x-pia-media-id'];
  const mime = req.headers['content-type'];
  const length = Number(req.headers['content-length']);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id || '') ||
      !Object.hasOwn(formats, mime) || !Number.isSafeInteger(length) || length < 1 || length > 100 * 1024 * 1024)
    throw new Error('Arquivo de mídia inválido ou maior que 100 MiB.');
  const key = account.id + ':' + id;
  if (active.has(key)) throw new Error('Este arquivo já está sendo enviado.');
  active.add(key);
  let dir;
  try {
    await pool.query('INSERT INTO pia_server.media(account_id,id,mime,bytes) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [account.id, id, mime, length]);
    const { rows: [row] } = await pool.query('SELECT * FROM pia_server.media WHERE account_id=$1 AND id=$2', [account.id, id]);
    if (row.mime !== mime || Number(row.bytes) !== length) throw new Error('O arquivo mudou desde o primeiro envio.');
    const [category, extension] = formats[mime];
    const name = 'pia-' + category + '-' + id + '.' + extension;
    dir = await mkdtemp(join(tmpdir(), 'pia-media-'));
    const file = join(dir, name);
    let received = 0;
    const guard = new Transform({
      transform(chunk, _, callback) {
        received += chunk.length;
        if (received > length) callback(new Error('Arquivo acima do tamanho declarado.'));
        else callback(null, chunk);
      },
    });
    await pipeline(req, guard, createWriteStream(file, { mode: 0o600 }));
    if (received !== length) throw new Error('Envio incompleto.');
    const meta = { name, mime, startedAt: row.created.toISOString(), folderId: account.folder_id, driveId: row.drive_id };
    await uploadRecording(account, file, meta, () => pool.query(
      'UPDATE pia_server.media SET drive_id=$3 WHERE account_id=$1 AND id=$2', [account.id, id, meta.driveId],
    ));
    return { id: meta.driveId };
  } finally {
    active.delete(key);
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
