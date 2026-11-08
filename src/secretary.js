import { access } from './drive.js';
import { pool } from './db.js';

const INTERVAL = 60_000;
const checks = new Map();

export async function preferences(account) {
  const { rows: [value] } = await pool.query(
    'SELECT mail,calendar,lead_minutes,last_error FROM pia_server.secretary WHERE account_id=$1', [account.id]);
  return value || { mail: false, calendar: false, lead_minutes: 10 };
}

export async function configure(account, data) {
  if (typeof data.mail !== 'boolean' || typeof data.calendar !== 'boolean' ||
      !Number.isInteger(data.lead_minutes) || data.lead_minutes < 1 || data.lead_minutes > 1440)
    throw new Error('Configure as fontes e um aviso entre 1 e 1440 minutos.');
  if ((data.mail || data.calendar) && !account.drive_refresh) throw new Error('Autorize o Google primeiro.');
  await pool.query(`
    INSERT INTO pia_server.secretary(account_id,mail,calendar,lead_minutes) VALUES($1,$2,$3,$4)
    ON CONFLICT(account_id) DO UPDATE SET mail=EXCLUDED.mail,calendar=EXCLUDED.calendar,
      lead_minutes=EXCLUDED.lead_minutes, last_error=NULL,
      mail_since=CASE WHEN NOT pia_server.secretary.mail AND EXCLUDED.mail THEN now() ELSE pia_server.secretary.mail_since END
  `, [account.id, data.mail, data.calendar, data.lead_minutes]);
  return { ok: true };
}

async function get(url, headers) {
  const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('Google respondeu HTTP ' + response.status + '.');
  return response.json();
}

async function notice(id, key, title, text, url) {
  await pool.query(`
    INSERT INTO pia_server.notices(account_id,event_key,title,text,url) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(account_id,event_key) DO NOTHING
  `, [id, key, title, String(text).slice(0, 1200), url]);
}

async function pollMail(account, headers, now) {
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
  const since = Math.floor(new Date(account.mail_since).getTime() / 1000);
  let pageToken;
  do {
    const query = new URLSearchParams({ q: 'in:inbox after:' + since, maxResults: '50' });
    if (pageToken) query.set('pageToken', pageToken);
    const page = await get(base + '?' + query, headers);
    for (const item of page.messages || []) {
      const key = 'gmail:' + item.id;
      const { rowCount } = await pool.query('SELECT 1 FROM pia_server.notices WHERE account_id=$1 AND event_key=$2', [account.id, key]);
      if (rowCount) continue;
      const message = await get(base + '/' + encodeURIComponent(item.id) +
        '?format=metadata&metadataHeaders=Subject&metadataHeaders=From', headers);
      const fields = new Map((message.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
      await notice(account.id, key, 'Novo e-mail', (fields.get('subject') || 'Sem assunto') +
        (fields.get('from') ? ' — ' + fields.get('from') : ''),
      'https://mail.google.com/mail/?authuser=' + encodeURIComponent(account.email) + '#all/' + encodeURIComponent(item.id));
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  // Overlap for delayed Gmail indexing. Deduplication uses the permanent message ID.
  await pool.query('UPDATE pia_server.secretary SET mail_since=GREATEST(mail_since,$2) WHERE account_id=$1',
    [account.id, new Date(now.getTime() - 600000)]);
}

async function pollCalendar(account, headers, now) {
  const query = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime',
    timeMin: now.toISOString(), timeMax: new Date(now.getTime() + account.lead_minutes * 60000).toISOString() });
  const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  let pageToken;
  do {
    if (pageToken) query.set('pageToken', pageToken);
    const page = await get(base + '?' + query, headers);
    for (const event of page.items || []) {
      const start = event.start?.dateTime;
      if (!start || event.status === 'cancelled' || new Date(start) < now) continue;
      const link = /^https:\/\/calendar\.google\.com\//.test(event.htmlLink || '') ? event.htmlLink : null;
      await notice(account.id, 'calendar:' + event.id + ':' + start, 'Compromisso próximo',
        (event.summary || 'Compromisso') + ' · ' + start, link);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
}

export async function monitor() {
  const { rows } = await pool.query(`
    SELECT a.id,a.email,a.drive_refresh,s.mail,s.calendar,s.lead_minutes,s.mail_since
    FROM pia_server.accounts a JOIN pia_server.secretary s ON s.account_id=a.id
    WHERE a.drive_refresh IS NOT NULL AND (s.mail OR s.calendar)
  `);
  for (const account of rows) {
    if ((checks.get(account.id) || 0) > Date.now()) continue;
    checks.set(account.id, Infinity);
    void (async () => {
      try {
        const headers = await access(account);
        const now = new Date();
        const results = await Promise.allSettled([
          account.mail && pollMail(account, headers, now),
          account.calendar && pollCalendar(account, headers, now),
        ]);
        const error = results.some((result) => result.status === 'rejected') ?
          'Uma fonte do Google não pôde ser consultada. Confira as permissões de Gmail e Agenda.' : null;
        await pool.query('UPDATE pia_server.secretary SET last_error=$2 WHERE account_id=$1', [account.id, error]);
      } catch {
        await pool.query('UPDATE pia_server.secretary SET last_error=$2 WHERE account_id=$1',
          [account.id, 'A autorização do Google precisa ser renovada.']);
      } finally { checks.set(account.id, Date.now() + INTERVAL); }
    })().catch(() => console.error('Falha ao atualizar a Secretária.'));
  }
}

export async function pendingNotices(device) {
  const { rows } = await pool.query(`
    SELECT n.id,n.title,n.text,n.url FROM pia_server.notices n
    WHERE n.account_id=$1 AND NOT EXISTS (
      SELECT 1 FROM pia_server.notice_delivery d WHERE d.device_id=$2 AND d.notice_id=n.id
    ) ORDER BY n.id LIMIT 50
  `, [device.id, device.device_id]);
  return rows;
}

export async function acknowledge(device, ids) {
  if (!Array.isArray(ids) || ids.length > 50 || ids.some((id) => typeof id !== 'string' || !/^\d{1,18}$/.test(id)))
    throw new Error('Avisos inválidos.');
  await pool.query(`
    INSERT INTO pia_server.notice_delivery(device_id,notice_id)
    SELECT $2,n.id FROM pia_server.notices n WHERE n.account_id=$1 AND n.id=ANY($3::bigint[])
    ON CONFLICT DO NOTHING
  `, [device.id, device.device_id, ids]);
  return { ok: true };
}
