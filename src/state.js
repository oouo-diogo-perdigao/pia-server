import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const root = resolve(process.env.PIA_DATA || 'data');
export const snowflake = /^[0-9]{17,20}$/;

export function read(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function save(path, value) {
  const temp = path + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}

export const hash = (token) => createHash('sha256').update(token).digest('hex');

export function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length > 40) throw new Error('Informe até 40 regras.');
  const used = new Set();
  return rules.map((rule) => {
    const { guildId, channelId, noticeChannelId, minPeople, triggerUsers, emptySeconds } = rule || {};
    if (![guildId, channelId, noticeChannelId].every((id) => typeof id === 'string' && snowflake.test(id)))
      throw new Error('IDs do servidor, canal de voz e canal de aviso são obrigatórios.');
    if (used.has(channelId)) throw new Error('Use apenas uma regra por canal de voz.');
    used.add(channelId);
    if (!Number.isInteger(minPeople) || minPeople < 1 || minPeople > 99 ||
        !Number.isInteger(emptySeconds) || emptySeconds < 5 || emptySeconds > 1800 ||
        !Array.isArray(triggerUsers) || triggerUsers.length > 99 ||
        triggerUsers.some((id) => typeof id !== 'string' || !snowflake.test(id)))
      throw new Error('Regra inválida. Mínimo 1 a 99 pessoas, espera 5 a 1800 segundos e IDs válidos.');
    return { guildId, channelId, noticeChannelId, minPeople, triggerUsers: [...new Set(triggerUsers)], emptySeconds };
  });
}
