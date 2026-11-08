import { accountSession } from './db.js';

export async function issueMcpToken(accountId, days = 30) {
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650))
    throw new Error('Escolha de 1 a 3650 dias ou sem expiração.');
  return accountSession(accountId, 'mcp', days === null ? null : days * 24);
}
