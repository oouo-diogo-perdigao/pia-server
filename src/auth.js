import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { accountSession, pool, seal } from './db.js';
import { googleToken } from './drive.js';

export const origin = new URL(process.env.PIA_PUBLIC_URL || 'https://pia.travelrpg.com').origin;
const callback = origin + '/auth/google/callback';
const pending = new Map();

export const oauthReady = () => Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export function cookie(req, name) {
  return req.headers.cookie?.split(';').map((part) => part.trim()).find((part) =>
    part.startsWith(name + '='))?.slice(name.length + 1);
}

function setCookie(name, value, seconds) {
  return name + '=' + value + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + seconds;
}

export function begin(req, res, destination = '/') {
  if (!oauthReady()) { res.writeHead(503); res.end('Login Google ainda não configurado.'); return; }
  for (const [state, entry] of pending) if (entry.expires < Date.now()) pending.delete(state);
  if (pending.size >= 200) { res.writeHead(429); res.end(); return; }
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  pending.set(state, { verifier, destination, expires: Date.now() + 600000 });
  const query = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: callback, response_type: 'code',
    scope: 'openid profile email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline', prompt: 'consent select_account',
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + query,
    'Set-Cookie': setCookie('pia_oauth', state, 600) });
  res.end();
}

export function googlePicture(value) {
  const url = typeof value === 'string' && value.length <= 2048 ? URL.parse(value) : null;
  return url?.protocol === 'https:' && !url.port && !url.username && !url.password &&
    /^lh[0-9]+[.]googleusercontent[.]com$/.test(url.hostname) ? url.href : null;
}

export function accountProfile(account) {
  return { email: account.email, picture: googlePicture(account.google_picture) };
}

export async function finish(req, res, url) {
  const state = url.searchParams.get('state') || '';
  const saved = cookie(req, 'pia_oauth') || '';
  const entry = pending.get(state);
  if (!entry || entry.expires < Date.now() || state.length !== saved.length ||
      !timingSafeEqual(Buffer.from(state), Buffer.from(saved)) || !url.searchParams.get('code'))
    throw new Error('Autorização inválida ou expirada. Inicie o login novamente.');
  pending.delete(state);
  const token = await googleToken({ grant_type: 'authorization_code', redirect_uri: callback,
    code: url.searchParams.get('code'), code_verifier: entry.verifier });
  const profile = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: 'Bearer ' + token.access_token }, signal: AbortSignal.timeout(15000),
  });
  if (!profile.ok) throw new Error('Não foi possível verificar a conta Google.');
  const user = await profile.json();
  if (user.email_verified !== true || typeof user.email !== 'string' || typeof user.sub !== 'string')
    throw new Error('A conta Google precisa ter e-mail verificado.');
  const { rows } = await pool.query(`
    UPDATE pia_server.accounts SET google_sub=$2, drive_refresh=COALESCE($3,drive_refresh), google_picture=$4
    WHERE email=$1 AND (google_sub IS NULL OR google_sub=$2) RETURNING id
  `, [user.email.toLowerCase(), user.sub, seal(token.refresh_token), googlePicture(user.picture)]);
  if (!rows.length) throw new Error('Esta conta Google não está autorizada.');
  const { token: session } = await accountSession(rows[0].id, 'web', 24);
  res.writeHead(303, { Location: entry.destination, 'Set-Cookie': [
    setCookie('__Host-pia_session', session, 86400), setCookie('pia_oauth', '', 0),
  ] });
  res.end();
}
