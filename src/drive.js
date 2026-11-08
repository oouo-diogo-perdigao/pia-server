import { createReadStream, statSync } from 'node:fs';
import { unseal } from './db.js';

const FILES = 'https://www.googleapis.com/drive/v3/files';

export async function googleToken(params) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '', ...params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('A autorização Google precisa ser renovada.');
  return response.json();
}

async function access(account) {
  if (!account.drive_refresh) throw new Error('Conecte o Google Drive da conta.');
  const token = await googleToken({ grant_type: 'refresh_token', refresh_token: unseal(account.drive_refresh) });
  return { Authorization: 'Bearer ' + token.access_token };
}

async function driveJSON(response) {
  if (!response.ok) throw new Error('Google Drive retornou HTTP ' + response.status + '.');
  return response.json();
}

export async function createFolder(account) {
  const headers = await access(account);
  const response = await fetch(FILES + '?fields=id,name,webViewLink', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'PIA Server - Gravações', mimeType: 'application/vnd.google-apps.folder' }),
    signal: AbortSignal.timeout(20000),
  });
  return driveJSON(response);
}

export async function uploadRecording(account, file, meta, persist) {
  const headers = await access(account);
  const length = statSync(file).size;
  const mime = meta.mime || 'application/zip';
  if (!meta.driveId) {
    const result = await driveJSON(await fetch(FILES + '/generateIds?count=1&space=drive', {
      headers, signal: AbortSignal.timeout(15000),
    }));
    meta.driveId = result.ids[0];
    persist();
  }
  const existing = await fetch(FILES + '/' + encodeURIComponent(meta.driveId) +
    '?fields=id,name,size,trashed,parents', { headers, signal: AbortSignal.timeout(15000) });
  if (existing.ok) {
    const result = await existing.json();
    if (!result.trashed && result.name === meta.name && Number(result.size) === length &&
        result.parents?.includes(meta.folderId)) return;
    throw new Error('O Drive já tem um arquivo diferente para esta gravação.');
  }
  if (existing.status !== 404) await driveJSON(existing);
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json',
      'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(length) },
    body: JSON.stringify({ id: meta.driveId, name: meta.name, mimeType: mime, parents: [meta.folderId], createdTime: meta.startedAt }),
    redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!start.ok) await driveJSON(start);
  const url = new URL(start.headers.get('location'));
  if (url.origin !== 'https://www.googleapis.com' || url.pathname !== '/upload/drive/v3/files')
    throw new Error('Endereço de upload inválido.');
  const result = await driveJSON(await fetch(url, {
    method: 'PUT', body: createReadStream(file), duplex: 'half', redirect: 'error',
    headers: { 'Content-Type': mime, 'Content-Length': String(length) },
    signal: AbortSignal.timeout(20 * 60 * 1000),
  }));
  if (result.id !== meta.driveId || Number(result.size) !== length) throw new Error('Upload não confirmado.');
}
