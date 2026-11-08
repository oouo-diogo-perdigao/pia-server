import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';
import { hash } from './state.js';

export const pool = new pg.Pool({ max: 8, connectionTimeoutMillis: 5000 });
const key = Buffer.from(process.env.PIA_ENCRYPTION_KEY || '', 'hex');

export function seal(value) {
  if (!value) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function unseal(value) {
  if (!value) return '';
  const raw = Buffer.from(value, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  cipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString('utf8');
}

export async function migrate() {
  if (key.length !== 32) throw new Error('PIA_ENCRYPTION_KEY deve ter 64 caracteres hexadecimais.');
  const email = process.env.PIA_ADMIN_EMAIL?.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Configure PIA_ADMIN_EMAIL.');
  const { rows: [schema] } = await pool.query("SELECT to_regnamespace('pia_server') AS name");
  if (!schema.name) await pool.query('CREATE SCHEMA pia_server');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pia_server.accounts (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      email text NOT NULL UNIQUE, google_sub text UNIQUE, admin boolean NOT NULL DEFAULT false,
      drive_refresh text, discord_token text, discord_bot_id text UNIQUE,
      folder_id text, rules jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS pia_server.sessions (
      digest text PRIMARY KEY, account_id bigint NOT NULL REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      purpose text NOT NULL CHECK (purpose IN ('web', 'mcp')),
      expires timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pia_sessions_expiry ON pia_server.sessions(expires);
  `);
  await pool.query('INSERT INTO pia_server.accounts(email,admin) VALUES($1,true) ON CONFLICT(email) DO UPDATE SET admin=true', [email]);
}

export async function accountSession(id, purpose, hours) {
  const token = randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM pia_server.sessions WHERE expires <= now()');
  await pool.query('INSERT INTO pia_server.sessions VALUES($1,$2,$3,$4)', [
    hash(token), id, purpose, new Date(Date.now() + hours * 3600000),
  ]);
  return token;
}

export async function identify(token, purpose) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
  const { rows } = await pool.query(`
    SELECT a.* FROM pia_server.sessions s JOIN pia_server.accounts a ON a.id=s.account_id
    WHERE s.digest=$1 AND s.purpose=$2 AND s.expires>now()
  `, [hash(token), purpose]);
  return rows[0] || null;
}
