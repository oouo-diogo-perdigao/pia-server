import { randomBytes } from 'node:crypto';
import { pool } from './db.js';
import { hash } from './state.js';

const validToken = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

export async function requestGuildLink(botAccount, guild, user) {
  const token = randomBytes(32).toString('base64url');
  await pool.query('DELETE FROM pia_server.discord_link_requests WHERE expires <= now()');
  await pool.query(`INSERT INTO pia_server.discord_link_requests
    (digest, guild_id, discord_user, bot_account_id, expires)
    VALUES ($1,$2,$3,$4,now() + interval '15 minutes')`, [hash(token), guild, user, botAccount]);
  return token;
}

export async function browserClaim(token, account) {
  if (!validToken(token)) throw new Error('Link inválido ou expirado.');
  const code = randomBytes(12).toString('hex');
  const { rowCount } = await pool.query(`UPDATE pia_server.discord_link_requests
    SET account_id=$2, confirmation=$3 WHERE digest=$1 AND expires > now()
    AND (account_id IS NULL OR account_id=$2)`, [hash(token), account, hash(code)]);
  if (!rowCount) throw new Error('Link inválido, expirado ou já aberto por outra conta.');
  return code;
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

export async function finishGuildLink(botAccount, guild, user, code) {
  if (typeof code !== 'string' || !/^[a-f0-9]{24}$/.test(code)) throw new Error('Código de vínculo inválido.');
  const { rows } = await changeGuildLink(guild, (db) => db.query(`
    WITH claim AS (
      DELETE FROM pia_server.discord_link_requests
      WHERE confirmation=$1 AND guild_id=$2 AND discord_user=$3 AND bot_account_id=$4
        AND account_id IS NOT NULL AND expires > now()
      RETURNING guild_id, bot_account_id, account_id, discord_user
    )
    INSERT INTO pia_server.discord_guild_links(guild_id,bot_account_id,account_id,linked_by)
    SELECT guild_id,bot_account_id,account_id,discord_user FROM claim
    ON CONFLICT(guild_id) DO NOTHING RETURNING guild_id`, [hash(code), guild, user, botAccount]));
  if (!rows.length) throw new Error('Código expirado, de outro usuário ou servidor já vinculado. Use /unbless antes de trocar a conta.');
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
