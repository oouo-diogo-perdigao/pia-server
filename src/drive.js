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

export async function access(account) {
  if (!account.drive_refresh) throw new Error('Conecte o Google Drive da conta.');
  const token = await googleToken({ grant_type: 'refresh_token', refresh_token: unseal(account.drive_refresh) });
  return { Authorization: 'Bearer ' + token.access_token };
}

async function driveJSON(response) {
  if (!response.ok) throw Object.assign(new Error('Google Drive retornou HTTP ' + response.status + '.'),
    { status: response.status });
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

async function recordingAccess(account, identity) {
  if (!identity || identity === 'server-google-primary') return access(account);
  const { accessToken } = await import('./connectors.js');
  const { token } = await accessToken(account, 'google', identity);
  return { Authorization: 'Bearer ' + token };
}

const folderMime = 'application/vnd.google-apps.folder';
const folderFields = 'id,name,mimeType,trashed,capabilities(canAddChildren)';
function checkedFolder(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('Pasta do Drive inválida.');
  return id;
}

async function folderInfo(headers, id, fields = folderFields) {
  const params = new URLSearchParams({ fields, supportsAllDrives: 'true' });
  const folder = await driveJSON(await fetch(FILES + '/' + checkedFolder(id) + '?' + params,
    { headers, signal: AbortSignal.timeout(15000) }));
  if (folder.mimeType !== folderMime || folder.trashed) throw new Error('Selecione uma pasta ativa no Drive.');
  return { id: folder.id, name: id === 'root' ? 'Meu Drive' : folder.name,
    writable: Boolean(folder.capabilities?.canAddChildren), parents: folder.parents };
}

export async function recordingFolderPath(account, identity, folder) {
  const headers = await recordingAccess(account, identity);
  const fields = 'id,name,mimeType,trashed,parents';
  let rootId;
  try { rootId = (await folderInfo(headers, 'root', fields)).id; }
  catch (error) { if (error.status !== 403 && error.status !== 404) throw error; }
  const path = [];
  const seen = new Set();
  let id = folder;
  while (id && !seen.has(id) && seen.size < 30) {
    if (id === rootId) return ['Meu Drive', ...path];
    seen.add(id);
    let entry;
    try { entry = await folderInfo(headers, id, fields); }
    catch (error) {
      if (!path.length || (error.status !== 403 && error.status !== 404)) throw error;
      // A drive.file grant may expose a child of My Drive while hiding root metadata.
      if (!rootId) {
        const name = path[0].replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const query = new URLSearchParams({
          q: "'root' in parents and trashed=false and name='" + name + "'",
          fields: 'nextPageToken,files(id,parents)', pageSize: '100',
        });
        for (let attempt = 0; attempt < 10; attempt++) {
          const page = await driveJSON(await fetch(FILES + '?' + query,
            { headers, signal: AbortSignal.timeout(15000) }));
          if (page.files.some((item) => item.parents?.includes(id))) return ['Meu Drive', ...path];
          if (!page.nextPageToken) break;
          query.set('pageToken', page.nextPageToken);
        }
      }
      return ['…', ...path];
    }
    path.unshift(entry.name);
    id = entry.parents?.[0];
  }
  return id ? ['…', ...path] : path;
}

export async function recordingFolders(account, { identity, folder = 'root', cursor }) {
  const headers = await recordingAccess(account, identity);
  let current;
  try { current = await folderInfo(headers, folder); }
  catch (error) {
    if (folder !== 'root' || error.status !== 404) throw error;
    // drive.file can list authorized children but cannot read the root itself.
    current = { id: 'root', name: 'Meu Drive', writable: false, canCreate: true };
  }
  const query = new URLSearchParams({
    q: "'" + checkedFolder(current.id) + "' in parents and trashed=false and mimeType='" + folderMime + "'",
    fields: 'nextPageToken,files(id,name)', orderBy: 'name_natural', pageSize: '100',
    supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
  });
  if (cursor) query.set('pageToken', cursor);
  const { files, nextPageToken } = await driveJSON(await fetch(FILES + '?' + query,
    { headers, signal: AbortSignal.timeout(15000) }));
  return { current, folders: files, cursor: nextPageToken || null };
}

export async function recordingDestination(account, { identity, folder, name }) {
  const headers = await recordingAccess(account, identity);
  const parent = folder === 'root' && name !== undefined ? { id: 'root', writable: true } :
    await folderInfo(headers, folder);
  if (!parent.writable) throw new Error('Esta conta não pode gravar nesta pasta.');
  if (name === undefined) return parent;
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('Informe um nome de pasta válido.');
  return driveJSON(await fetch(FILES + '?fields=id,name&supportsAllDrives=true', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name.trim(), mimeType: folderMime, ...(parent.id === 'root' ? {} : { parents: [parent.id] }) }),
    signal: AbortSignal.timeout(15000),
  }));
}

export async function uploadRecording(account, file, meta, persist) {
  const headers = await recordingAccess(account, meta.driveAccount);
  const length = statSync(file).size;
  const mime = meta.mime || 'application/zip';
  if (!meta.driveId) {
    const result = await driveJSON(await fetch(FILES + '/generateIds?count=1&space=drive', {
      headers, signal: AbortSignal.timeout(15000),
    }));
    meta.driveId = result.ids[0];
    await persist();
  }
  const existing = await fetch(FILES + '/' + encodeURIComponent(meta.driveId) +
    '?fields=id,name,size,trashed,parents&supportsAllDrives=true', { headers, signal: AbortSignal.timeout(15000) });
  if (existing.ok) {
    const result = await existing.json();
    if (!result.trashed && result.name === meta.name && Number(result.size) === length &&
        result.parents?.includes(meta.folderId)) return;
    throw new Error('O Drive já tem um arquivo diferente para esta gravação.');
  }
  if (existing.status !== 404) await driveJSON(existing);
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size&supportsAllDrives=true', {
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
    headers: { ...headers, 'Content-Type': mime, 'Content-Length': String(length) },
    signal: AbortSignal.timeout(20 * 60 * 1000),
  }));
  if (result.id !== meta.driveId || Number(result.size) !== length) throw new Error('Upload não confirmado.');
}
