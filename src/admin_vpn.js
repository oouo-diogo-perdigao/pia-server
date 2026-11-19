import { BlockList, isIP } from 'node:net';

/**
 * Normaliza um endereço IP, removendo prefixo IPv4-mapped IPv6 (`::ffff:`).
 * Retorna `null` se o valor não for um IPv4 ou IPv6 sintaticamente válido.
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  const zoneIndex = value.indexOf('%');
  if (zoneIndex !== -1) value = value.slice(0, zoneIndex);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mapped) value = mapped[1];
  const family = isIP(value);
  if (family === 4) return value;
  if (family === 6) return value.toLowerCase();
  return null;
}

/**
 * Faz o parse de uma lista separada por vírgulas de CIDRs IPv4/IPv6 (ou IPs exatos)
 * para um `net.BlockList`. Entradas inválidas são ignoradas; retorna `count` de regras válidas.
 */
export function parseCidrList(raw) {
  const blockList = new BlockList();
  let count = 0;
  if (typeof raw !== 'string' || !raw.trim()) return { blockList, count };

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const slashIndex = trimmed.indexOf('/');
    if (slashIndex === -1) {
      const ip = normalizeIp(trimmed);
      if (!ip) continue;
      const type = isIP(ip) === 4 ? 'ipv4' : 'ipv6';
      blockList.addAddress(ip, type);
      count += 1;
      continue;
    }

    const ipPart = trimmed.slice(0, slashIndex).trim();
    const prefixPart = trimmed.slice(slashIndex + 1).trim();
    if (!/^\d+$/.test(prefixPart)) continue;
    const ip = normalizeIp(ipPart);
    if (!ip) continue;
    const family = isIP(ip);
    const prefix = Number(prefixPart);
    const maxPrefix = family === 4 ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) continue;
    blockList.addSubnet(ip, prefix, family === 4 ? 'ipv4' : 'ipv6');
    count += 1;
  }

  return { blockList, count };
}

function isIpInList(ip, parsed) {
  if (!ip || !parsed || parsed.count === 0) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  return parsed.blockList.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Extrai o IP real do cliente a partir da requisição HTTP.
 * Só aceita `X-Forwarded-For` (da direita para a esquerda) ou `X-Real-IP` quando
 * `req.socket.remoteAddress` pertence a `PIA_TRUSTED_PROXIES`.
 */
export function resolveClientIp(req, trustedProxiesRaw = process.env.PIA_TRUSTED_PROXIES) {
  const remoteIp = normalizeIp(req?.socket?.remoteAddress);
  if (!remoteIp) return null;

  const trustedProxies = parseCidrList(trustedProxiesRaw);
  if (!isIpInList(remoteIp, trustedProxies)) return remoteIp;

  const xffHeader = req?.headers?.['x-forwarded-for'];
  const xffRaw = Array.isArray(xffHeader) ? xffHeader.join(',') : xffHeader;
  if (typeof xffRaw === 'string' && xffRaw.trim() !== '') {
    const parts = xffRaw.split(',').map((part) => part.trim()).filter(Boolean);
    if (parts.length === 0) return remoteIp;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const ip = normalizeIp(parts[i]);
      if (!ip) return remoteIp;
      if (!isIpInList(ip, trustedProxies)) return ip;
    }
    return normalizeIp(parts[0]) || remoteIp;
  }

  const realHeader = req?.headers?.['x-real-ip'];
  const realRaw = Array.isArray(realHeader) ? realHeader[0] : realHeader;
  const realIp = normalizeIp(realRaw);
  if (realIp) return realIp;

  return remoteIp;
}

/**
 * Verifica se a requisição se origina de um CIDR autorizado em `PIA_ADMIN_VPN_CIDRS`.
 * Falha fechado: se `PIA_ADMIN_VPN_CIDRS` estiver vazia, ausente ou sem CIDRs válidos, retorna `false`.
 */
export function isAdminVpnAllowed(
  req,
  {
    vpnCidrs = process.env.PIA_ADMIN_VPN_CIDRS,
    trustedProxies = process.env.PIA_TRUSTED_PROXIES,
  } = {},
) {
  const allowedCidrs = parseCidrList(vpnCidrs);
  if (allowedCidrs.count === 0) return false;
  const clientIp = resolveClientIp(req, trustedProxies);
  if (!clientIp) return false;
  return isIpInList(clientIp, allowedCidrs);
}
