import assert from 'node:assert/strict';
import test from 'node:test';
import { isAdminVpnAllowed, normalizeIp, parseCidrList, resolveClientIp } from '../src/admin_vpn.js';

function fakeReq({ remoteAddress, xff, xRealIp } = {}) {
  const headers = {};
  if (xff !== undefined) headers['x-forwarded-for'] = xff;
  if (xRealIp !== undefined) headers['x-real-ip'] = xRealIp;
  return { socket: { remoteAddress }, headers };
}

test('normalizeIp normalizes IPv4, IPv6, IPv4-mapped IPv6 and rejects invalid values', () => {
  assert.equal(normalizeIp(' 100.64.0.1 '), '100.64.0.1');
  assert.equal(normalizeIp('::ffff:100.64.0.1'), '100.64.0.1');
  assert.equal(normalizeIp('::FFFF:192.0.2.10'), '192.0.2.10');
  assert.equal(normalizeIp('FD7A:115C:A1E0::1'), 'fd7a:115c:a1e0::1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp(''), null);
  assert.equal(normalizeIp(null), null);
  assert.equal(normalizeIp('not-an-ip'), null);
});

test('parseCidrList parses valid IPv4/IPv6 CIDRs and ignores invalid entries', () => {
  const valid = parseCidrList('100.64.0.0/10, fd7a:115c:a1e0::/48, 127.0.0.1');
  assert.equal(valid.count, 3);
  assert.equal(valid.blockList.check('100.64.5.1', 'ipv4'), true);
  assert.equal(valid.blockList.check('fd7a:115c:a1e0::42', 'ipv6'), true);
  assert.equal(valid.blockList.check('127.0.0.1', 'ipv4'), true);

  const invalid = parseCidrList('100.64.0.0/33, fd7a::/129, bad/10, , nope');
  assert.equal(invalid.count, 0);
});

test('resolveClientIp ignores forwarded headers when socket is not a trusted proxy', () => {
  const req = fakeReq({
    remoteAddress: '203.0.113.50',
    xff: '100.64.0.5',
    xRealIp: '100.64.0.5',
  });
  assert.equal(resolveClientIp(req, '127.0.0.1/32,172.16.0.0/12'), '203.0.113.50');
});

test('resolveClientIp walks X-Forwarded-For right-to-left for trusted proxies and stops spoofing', () => {
  const trusted = '127.0.0.1/32,::1/128,172.16.0.0/12';

  // Spoofed left-most IPv4 behind external client
  assert.equal(
    resolveClientIp(fakeReq({ remoteAddress: '172.18.0.2', xff: '100.64.0.5, 203.0.113.50' }), trusted),
    '203.0.113.50',
  );

  // Multi-hop trusted proxies
  assert.equal(
    resolveClientIp(fakeReq({ remoteAddress: '127.0.0.1', xff: '100.64.0.5, 172.18.0.2' }), trusted),
    '100.64.0.5',
  );

  // IPv6 proxy chain
  assert.equal(
    resolveClientIp(fakeReq({ remoteAddress: '::1', xff: 'fd7a:115c:a1e0::10, ::1' }), trusted),
    'fd7a:115c:a1e0::10',
  );

  // Malformed XFF entry falls back safely to remoteIp
  assert.equal(
    resolveClientIp(fakeReq({ remoteAddress: '172.18.0.2', xff: '100.64.0.5, malformed' }), trusted),
    '172.18.0.2',
  );

  // X-Real-IP fallback when X-Forwarded-For is absent
  assert.equal(
    resolveClientIp(fakeReq({ remoteAddress: '172.18.0.2', xRealIp: '100.64.0.9' }), trusted),
    '100.64.0.9',
  );
});

test('isAdminVpnAllowed fails closed when PIA_ADMIN_VPN_CIDRS is missing or invalid', () => {
  const req = fakeReq({ remoteAddress: '127.0.0.1' });
  assert.equal(isAdminVpnAllowed(req, { vpnCidrs: '', trustedProxies: '127.0.0.1/32' }), false);
  assert.equal(isAdminVpnAllowed(req, { vpnCidrs: undefined, trustedProxies: '' }), false);
  assert.equal(isAdminVpnAllowed(req, { vpnCidrs: 'invalid-cidr,10.0.0.0/99', trustedProxies: '' }), false);
});

test('isAdminVpnAllowed validates IPv4, IPv6 and IPv4-mapped IPv6 against VPN CIDRs', () => {
  const vpnCidrs = '100.64.0.0/10,fd7a:115c:a1e0::/48';
  const trustedProxies = '127.0.0.1/32,::1/128,172.16.0.0/12';

  assert.equal(
    isAdminVpnAllowed(fakeReq({ remoteAddress: '172.18.0.2', xff: '100.64.12.34' }), { vpnCidrs, trustedProxies }),
    true,
  );
  assert.equal(
    isAdminVpnAllowed(fakeReq({ remoteAddress: '::ffff:100.64.12.34' }), { vpnCidrs, trustedProxies }),
    true,
  );
  assert.equal(
    isAdminVpnAllowed(fakeReq({ remoteAddress: '::1', xff: 'fd7a:115c:a1e0::99' }), { vpnCidrs, trustedProxies }),
    true,
  );
  assert.equal(
    isAdminVpnAllowed(fakeReq({ remoteAddress: '172.18.0.2', xff: '100.64.0.5, 198.51.100.10' }), { vpnCidrs, trustedProxies }),
    false,
  );
  assert.equal(
    isAdminVpnAllowed(fakeReq({ remoteAddress: '::1', xff: '2001:db8::1' }), { vpnCidrs, trustedProxies }),
    false,
  );
});
