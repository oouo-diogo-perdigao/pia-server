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
    ALTER TABLE pia_server.accounts ADD COLUMN IF NOT EXISTS google_picture text;
    ALTER TABLE pia_server.accounts ADD COLUMN IF NOT EXISTS recording_folder_id text;
    ALTER TABLE pia_server.accounts ADD COLUMN IF NOT EXISTS recording_folder_name text;
    ALTER TABLE pia_server.accounts ADD COLUMN IF NOT EXISTS recording_drive_account text;
    CREATE TABLE IF NOT EXISTS pia_server.discord_guild_links (
      guild_id text PRIMARY KEY, bot_account_id bigint NOT NULL REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      account_id bigint NOT NULL REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      linked_by text NOT NULL
    );
    ALTER TABLE pia_server.discord_guild_links ADD COLUMN IF NOT EXISTS access_roles text[] NOT NULL DEFAULT ARRAY[]::text[];
    CREATE TABLE IF NOT EXISTS pia_server.discord_link_requests (
      digest text PRIMARY KEY, guild_id text NOT NULL, discord_user text NOT NULL,
      bot_account_id bigint NOT NULL REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      account_id bigint REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      confirmation text UNIQUE, expires timestamptz NOT NULL
    );
    ALTER TABLE pia_server.discord_link_requests ADD COLUMN IF NOT EXISTS guild_name text;
    CREATE TABLE IF NOT EXISTS pia_server.sessions (
      digest text PRIMARY KEY, account_id bigint NOT NULL REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      purpose text NOT NULL CHECK (purpose IN ('web', 'mcp')),
      expires timestamptz NOT NULL
    );
    ALTER TABLE pia_server.sessions ALTER COLUMN expires DROP NOT NULL;
    DO $sessions$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='pia_server.sessions'::regclass
        AND conname='pia_sessions_web_expiry_required') THEN
        ALTER TABLE pia_server.sessions ADD CONSTRAINT pia_sessions_web_expiry_required
          CHECK (purpose='mcp' OR expires IS NOT NULL);
      END IF;
    END;
    $sessions$;
    CREATE INDEX IF NOT EXISTS pia_sessions_expiry ON pia_server.sessions(expires);
    CREATE TABLE IF NOT EXISTS pia_server.devices (
      id uuid PRIMARY KEY, account_id bigint NOT NULL REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      name text NOT NULL, digest text NOT NULL UNIQUE, last_seen timestamptz, capabilities text[] NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS pia_server.device_jobs (
      id uuid PRIMARY KEY, device_id uuid NOT NULL REFERENCES pia_server.devices(id) ON DELETE CASCADE,
      action text NOT NULL, status text NOT NULL DEFAULT 'queued', created timestamptz NOT NULL DEFAULT now(),
      expires timestamptz NOT NULL, result jsonb
    );
    CREATE INDEX IF NOT EXISTS pia_device_jobs_poll ON pia_server.device_jobs(device_id,status,created);
    CREATE TABLE IF NOT EXISTS pia_server.secretary (
      account_id bigint PRIMARY KEY REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      mail boolean NOT NULL, calendar boolean NOT NULL, lead_minutes integer NOT NULL,
      mail_since timestamptz NOT NULL DEFAULT now(), last_error text
    );
    ALTER TABLE pia_server.secretary ADD COLUMN IF NOT EXISTS calendar_since timestamptz NOT NULL DEFAULT now();
    CREATE TABLE IF NOT EXISTS pia_server.notices (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      account_id bigint NOT NULL REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      event_key text NOT NULL, title text NOT NULL, text text NOT NULL, url text,
      created timestamptz NOT NULL DEFAULT now(), UNIQUE(account_id,event_key)
    );
    CREATE TABLE IF NOT EXISTS pia_server.notice_delivery (
      device_id uuid NOT NULL REFERENCES pia_server.devices(id) ON DELETE CASCADE,
      notice_id bigint NOT NULL REFERENCES pia_server.notices(id) ON DELETE CASCADE,
      PRIMARY KEY(device_id,notice_id)
    );
    CREATE TABLE IF NOT EXISTS pia_server.profiles (
      account_id bigint PRIMARY KEY REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      revision bigint NOT NULL DEFAULT 1, ciphertext text NOT NULL, updated timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE pia_server.accounts ADD COLUMN IF NOT EXISTS connectors_initialized boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS pia_server.connectors (
      account_id bigint NOT NULL REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      type text NOT NULL,
      ciphertext text NOT NULL,
      PRIMARY KEY (account_id,type)
    );
    DO $migration$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='pia_server'
        AND table_name='connectors' AND column_name='type') THEN
        ALTER TABLE pia_server.connectors ADD COLUMN type text NOT NULL DEFAULT 'legacy';
        ALTER TABLE pia_server.connectors DROP CONSTRAINT connectors_pkey;
        ALTER TABLE pia_server.connectors ADD PRIMARY KEY (account_id,type);
        ALTER TABLE pia_server.connectors ALTER COLUMN type DROP DEFAULT;
      END IF;
    END;
    $migration$;
    CREATE TABLE IF NOT EXISTS pia_server.media (
      account_id bigint NOT NULL REFERENCES pia_server.accounts(id) ON DELETE CASCADE,
      id uuid NOT NULL, mime text NOT NULL, bytes bigint NOT NULL, drive_id text,
      created timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,id)
    );
  `);
  await pool.query('INSERT INTO pia_server.accounts(email,admin) VALUES($1,true) ON CONFLICT(email) DO UPDATE SET admin=true', [email]);
}

export async function accountSession(id, purpose, hours) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = hours === null ? null : new Date(Date.now() + hours * 3600000);
  await pool.query('DELETE FROM pia_server.sessions WHERE expires <= now()');
  await pool.query('INSERT INTO pia_server.sessions VALUES($1,$2,$3,$4)', [
    hash(token), id, purpose, expiresAt,
  ]);
  return { token, expiresAt };
}

export async function identify(token, purpose) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token || '')) return null;
  const { rows } = await pool.query(`
    SELECT a.* FROM pia_server.sessions s JOIN pia_server.accounts a ON a.id=s.account_id
    WHERE s.digest=$1 AND s.purpose=$2 AND (s.expires IS NULL OR s.expires>now())
  `, [hash(token), purpose]);
  return rows[0] || null;
}
