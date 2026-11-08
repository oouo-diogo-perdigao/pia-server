import { randomBytes } from 'node:crypto';
import { pool } from './db.js';
import { hash } from './state.js';

const validToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

const confirmations = new Map();

export async function requestGuildLink(botAccount, guild, user, guildName, notify) {
  const token = randomBytes(32).toString('base64url');
  const digest = hash(token);
  await changeGuildLink(guild, async (db) => {
    const existing = await db.query('SELECT 1 FROM pia_server.discord_guild_links WHERE guild_id=$1', [guild]);
    if (existing.rowCount) throw new Error('Este servidor já está vinculado. Use /unbless para trocar a conta.');
    await db.query('DELETE FROM pia_server.discord_link_requests WHERE expires <= now()');
    await db.query(`INSERT INTO pia_server.discord_link_requests
      (digest,guild_id,discord_user,bot_account_id,guild_name,expires)
      VALUES ($1,$2,$3,$4,$5,now() + interval '10 minutes')`, [digest, guild, user, botAccount, guildName]);
  });
  confirmations.set(digest, notify);
  setTimeout(() => confirmations.delete(digest), 600000).unref();
  return token;
}

export async function guildLinkRequest(token) {
  if (!validToken(token)) throw new Error('Link inválido ou expirado. Execute /bless novamente.');
  const { rows: [request] } = await pool.query(`SELECT guild_id,guild_name FROM pia_server.discord_link_requests
    WHERE digest=$1 AND guild_name IS NOT NULL AND expires > now()`, [hash(token)]);
  if (!request) throw new Error('Link inválido ou expirado. Execute /bless novamente.');
  return request;
}

async function changeGuildLink(guild, change) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('pia-discord:' || $1, 0))", [guild]);
    const result = await change(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

export async function confirmGuildLink(token, accountId) {
  const { guild_id, guild_name } = await guildLinkRequest(token);
  const digest = hash(token);
  const { rowCount } = await changeGuildLink(guild_id, (db) => db.query(`
    WITH claim AS (
      DELETE FROM pia_server.discord_link_requests
      WHERE digest=$1 AND guild_id=$2 AND expires > now()
      RETURNING guild_id,bot_account_id,discord_user
    )
    INSERT INTO pia_server.discord_guild_links(guild_id,bot_account_id,account_id,linked_by)
    SELECT guild_id,bot_account_id,$3,discord_user FROM claim
    ON CONFLICT(guild_id) DO NOTHING`, [digest, guild_id, accountId]));
  if (!rowCount) throw new Error('Link já usado ou servidor já vinculado.');
  const notify = confirmations.get(digest);
  confirmations.delete(digest);
  if (notify) void Promise.resolve().then(notify).catch(() => {});
  return guild_name;
}

export async function unlinkGuild(botAccount, guild) {
  const { rows } = await changeGuildLink(guild, (db) => db.query(`
    WITH pending AS (DELETE FROM pia_server.discord_link_requests WHERE guild_id=$1 AND bot_account_id=$2)
    DELETE FROM pia_server.discord_guild_links WHERE guild_id=$1 AND bot_account_id=$2 RETURNING guild_id`, [guild, botAccount]));
  return rows.length > 0;
}

export async function guildAccount(botAccount, guild) {
  const { rows } = await pool.query(`SELECT a.* FROM pia_server.discord_guild_links l
    JOIN pia_server.accounts a ON a.id=l.account_id WHERE l.bot_account_id=$1 AND l.guild_id=$2`, [botAccount, guild]);
  return rows[0];
}
