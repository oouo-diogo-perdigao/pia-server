import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { escapeHtml, renderOAuthCallback } from '../src/oauth_callback.js';

function call(query) {
  return renderOAuthCallback(new URL(`https://pia.example/oauth/callback${query}`));
}

test('oauth callback renders copyable code, honest copy and security headers on success', () => {
  const res = call('?code=auth-code-123&state=state-xyz');
  assert.equal(res.status, 200);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(res.headers['Content-Security-Policy'], /script-src 'self'/);
  assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(res.body, /id="oauth-code"[^>]*value="auth-code-123"/);
  assert.match(res.body, /id="copy-code"/);
  assert.match(res.body, /<script src="\/oauth-callback\.js" defer><\/script>/);
  assert.match(res.body, /Autorização recebida/i);
  assert.match(res.body, /cole o código/i);
  assert.doesNotMatch(res.body, /conta conectada/i);
});

test('oauth callback handles provider error and error_description safely', () => {
  const res = call('?error=access_denied&error_description=Permiss%C3%A3o+negada');
  assert.equal(res.status, 400);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
  assert.match(res.body, /Autorização não concluída/i);
  assert.match(res.body, /access_denied: Permissão negada/);
});

test('oauth callback rejects missing code or state', () => {
  for (const query of ['', '?code=only-code', '?state=only-state', '?code=%20%20&state=ok']) {
    const res = call(query);
    assert.equal(res.status, 400);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.equal(res.headers['Referrer-Policy'], 'no-referrer');
    assert.match(res.body, /Parâmetros ausentes/i);
  }
});

test('oauth callback rejects oversized or excessive query parameters', () => {
  const longCode = 'a'.repeat(2049);
  const resLongCode = call(`?code=${longCode}&state=ok`);
  assert.equal(resLongCode.status, 400);
  assert.doesNotMatch(resLongCode.body, /a{100}/);

  const manyParams = Array.from({ length: 21 }, (_, i) => `p${i}=1`).join('&');
  const resMany = call(`?code=ok&state=ok&${manyParams}`);
  assert.equal(resMany.status, 400);

  const longQuery = `?code=ok&state=${'s'.repeat(4100)}`;
  const resLongQuery = call(longQuery);
  assert.equal(resLongQuery.status, 400);

  const resLongError = call(`?error=${'e'.repeat(257)}`);
  assert.equal(resLongError.status, 400);
});

test('oauth callback escapes HTML/XSS payloads in code and error parameters', () => {
  const xssCode = '"><script>alert(1)</script><input value="';
  const resCode = call(`?code=${encodeURIComponent(xssCode)}&state=ok`);
  assert.equal(resCode.status, 200);
  assert.doesNotMatch(resCode.body, /<script>alert/);
  assert.match(resCode.body, /&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const xssErr = '<img src=x onerror=alert(1)>';
  const resErr = call(`?error=${encodeURIComponent(xssErr)}&error_description=${encodeURIComponent(xssErr)}`);
  assert.equal(resErr.status, 400);
  assert.doesNotMatch(resErr.body, /<img src=x/);
  assert.match(resErr.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('oauth callback client script supports Clipboard API with execCommand fallback', () => {
  const script = readFileSync(new URL('../web/oauth-callback.js', import.meta.url), 'utf8');
  assert.match(script, /navigator\.clipboard/);
  assert.match(script, /writeText/);
  assert.match(script, /execCommand\(['"]copy['"]\)/);
  assert.doesNotMatch(script, /https?:\/\//);
});
