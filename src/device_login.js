import { randomBytes, randomInt } from 'node:crypto';
import { pair } from './devices.js';
import { hash } from './state.js';

const pending = new Map();
const lifetime = 10 * 60 * 1000;
const identifier = /^[A-Za-z0-9_-]{43}$/;

export function beginDeviceLogin({ challenge, name }) {
  for (const [id, attempt] of pending) if (attempt.expires <= Date.now()) pending.delete(id);
  if (pending.size >= 300) throw new Error('Muitos logins pendentes. Tente novamente em alguns minutos.');
  if (typeof challenge !== 'string' || !/^[a-f0-9]{64}$/.test(challenge) ||
      typeof name !== 'string' || !name.trim() || name.trim().length > 60)
    throw new Error('Pedido de login do computador inválido.');
  const id = randomBytes(32).toString('base64url');
  const code = String(randomInt(100000, 1000000));
  pending.set(id, { challenge, name: name.trim(), code, expires: Date.now() + lifetime });
  return { id, code };
}

export function deviceLoginDetails(id) {
  const attempt = pending.get(id);
  if (!attempt || attempt.expires <= Date.now()) throw new Error('Login expirado. Inicie novamente na PIA local.');
  return attempt;
}

export function approveDeviceLogin(id, account) {
  const attempt = deviceLoginDetails(id);
  if (attempt.accountId) throw new Error('Este login já foi autorizado.');
  attempt.accountId = account.id;
}

export async function pollDeviceLogin({ id, verifier }) {
  const attempt = pending.get(id);
  if (!attempt || attempt.expires <= Date.now()) return { status: 'expired' };
  if (typeof verifier !== 'string' || !identifier.test(verifier) || hash(verifier) !== attempt.challenge)
    throw new Error('Pedido de login do computador inválido.');
  if (!attempt.accountId) return { status: 'pending' };
  if (attempt.redeeming) return { status: 'pending' };
  attempt.redeeming = true;
  try {
    const result = await pair({ id: attempt.accountId }, attempt.name);
    pending.delete(id);
    return { status: 'authorized', ...result };
  } finally { attempt.redeeming = false; }
}
