import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pool } from './db.js';
import { hash } from './state.js';
import { uploadRecording } from './drive.js';

const actions = ['camera', 'screenshot'];
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const imageLimit = 12 * 1024 * 1024;

export async function pair(account, name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) throw new Error('Informe o nome do computador.');
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  await pool.query('INSERT INTO pia_server.devices(id,account_id,name,digest) VALUES($1,$2,$3,$4)',
    [id, account.id, name.trim(), hash(token)]);
  return { id, token };
}

export async function devices(account) {
  const { rows } = await pool.query(`SELECT id,name,capabilities,
    COALESCE(last_seen > now() - interval '30 seconds',false) AS online
    FROM pia_server.devices WHERE account_id=$1 ORDER BY name,id`, [account.id]);
  return rows;
}

export async function revoke(account, id) {
  if (!uuid.test(id || '')) throw new Error('Dispositivo inválido.');
  await pool.query('DELETE FROM pia_server.devices WHERE account_id=$1 AND id=$2', [account.id, id]);
  return { ok: true };
}

export async function authenticateDevice(header) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header || '')?.[1];
  if (!token) return null;
  const { rows } = await pool.query(`SELECT d.id AS device_id,a.* FROM pia_server.devices d
    JOIN pia_server.accounts a ON a.id=d.account_id WHERE d.digest=$1`, [hash(token)]);
  return rows[0] || null;
}

export async function enqueue(account, id, action) {
  if (!uuid.test(id || '') || !actions.includes(action)) throw new Error('Computador ou ação inválida.');
  if (!account.drive_refresh || !account.folder_id) throw new Error('Crie a pasta da PIA no Drive primeiro.');
  const job = randomUUID();
  const { rowCount } = await pool.query(`
    INSERT INTO pia_server.device_jobs(id,device_id,action,expires)
    SELECT $3,d.id,$4,now()+interval '90 seconds' FROM pia_server.devices d
    WHERE d.account_id=$1 AND d.id=$2 AND d.last_seen>now()-interval '30 seconds' AND $4=ANY(d.capabilities)
      AND NOT EXISTS (SELECT 1 FROM pia_server.device_jobs j WHERE j.device_id=d.id
        AND j.status IN ('queued','running','uploading') AND j.expires>now())
  `, [account.id, id, job, action]);
  if (!rowCount) throw new Error('Computador offline, ocupado ou sem permissão local para essa ação.');
  return { job, status: 'queued' };
}

export async function jobStatus(account, id) {
  if (!uuid.test(id || '')) throw new Error('Job inválido.');
  const { rows: [job] } = await pool.query(`
    SELECT j.id,j.action,j.status,j.expires,j.result FROM pia_server.device_jobs j
    JOIN pia_server.devices d ON d.id=j.device_id WHERE d.account_id=$1 AND j.id=$2
  `, [account.id, id]);
  if (!job) throw new Error('Job não encontrado.');
  if (job.expires < new Date() && ['queued','running','uploading'].includes(job.status))
    return { ...job, status: 'expired' };
  return job;
}

export async function poll(account, capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length > actions.length ||
      capabilities.some((action) => !actions.includes(action))) throw new Error('Capacidades inválidas.');
  await pool.query('UPDATE pia_server.devices SET last_seen=now(),capabilities=$2 WHERE id=$1', [account.device_id, capabilities]);
  const { rows: [job] } = await pool.query(`
    UPDATE pia_server.device_jobs SET status='running',expires=now()+interval '2 minutes'
    WHERE id=(SELECT id FROM pia_server.device_jobs WHERE device_id=$1 AND status='queued'
      AND action=ANY($2::text[]) AND expires>now() ORDER BY created LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING id,action
  `, [account.device_id, capabilities]);
  return { job: job || null };
}

export async function complete(account, data) {
  if (!uuid.test(data.job || '')) throw new Error('Job inválido.');
  const { rows: [job] } = await pool.query(`
    UPDATE pia_server.device_jobs SET status='uploading',expires=now()+interval '3 minutes'
    WHERE id=$1 AND device_id=$2 AND status='running' AND expires>now() RETURNING action
  `, [data.job, account.device_id]);
  if (!job) throw new Error('Job encerrado ou indisponível.');
  let dir, status = 'failed', result = { error: 'O computador não concluiu a ação.' };
  try {
    if (data.failed === true) return { ok: true };
    if (typeof data.png !== 'string') throw new Error('Imagem ausente.');
    const bytes = Buffer.from(data.png, 'base64');
    if (bytes.length > imageLimit || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
      throw new Error('Imagem inválida ou acima de 12 MiB.');
    dir = await mkdtemp(join(tmpdir(), 'pia-artifact-'));
    const name = 'pia-' + job.action + '-' + data.job + '.png';
    const file = join(dir, name);
    await writeFile(file, bytes, { mode: 0o600 });
    const meta = { name, folderId: account.folder_id, startedAt: new Date().toISOString(), mime: 'image/png' };
    await uploadRecording(account, file, meta, () => {});
    status = 'done';
    result = { url: 'https://drive.google.com/open?id=' + encodeURIComponent(meta.driveId) };
    return { ok: true };
  } catch {
    result = { error: 'Não foi possível guardar o PNG no Google Drive.' };
    return { ok: false };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
    await pool.query('UPDATE pia_server.device_jobs SET status=$2,result=$3 WHERE id=$1', [data.job, status, result]);
  }
}
