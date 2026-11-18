import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { authorizationHtml, authorizationPage } from '../src/auth_page.js';
import { legalFiles, legalFooter } from '../src/legal.js';
import { renderOAuthCallback } from '../src/oauth_callback.js';
import { publicResponse, sendPublic } from '../src/public_files.js';

const LINKS = /<a href="\/privacidade">Política de Privacidade<\/a> · <a href="\/termos">Termos de Serviço<\/a>/;

function footerInsideCard(html) {
  assert.match(html, LINKS);
  const card = html.indexOf('<section class="pia-login-card">');
  const footer = html.indexOf('<footer class="legal-footer">');
  const end = html.indexOf('</section></main>');
  assert.ok(card >= 0 && card < footer && footer < end, 'rodapé legal dentro do card');
}

function fakeResponse() {
  return {
    status: 0, headers: {}, body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; return this; },
  };
}

test('/auth/device/:id: "Entrar na PIA" via authorizationPage tem o rodapé legal e mantém headers', () => {
  const res = fakeResponse();
  authorizationPage(res, 'Entrar na PIA', '<p>Confira o código.</p>');
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'same-origin' });
  assert.match(res.body, /^<!doctype html><html lang="pt-BR">/);
  assert.match(res.body, /<h2>Entrar na PIA<\/h2><p>Confira o código\.<\/p><footer class="legal-footer">/);
  footerInsideCard(res.body);
});

test('/discord/bless/:token: "Vincular Discord à PIA" via authorizationPage tem o rodapé legal', () => {
  const html = authorizationHtml('Vincular Discord à PIA', '<p>Servidor Discord: <strong>Mesa</strong></p>');
  assert.match(html, /<title>Vincular Discord à PIA<\/title>/);
  footerInsideCard(html);
});

test('index.js usa authorizationPage de src/auth_page.js nas duas rotas de autorização', () => {
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /import \{ authorizationPage \} from '\.\/auth_page\.js';/);
  assert.doesNotMatch(index, /function authorizationPage/);
  assert.match(index, /return authorizationPage\(res, 'Vincular Discord à PIA', content\);/);
  assert.match(index, /return authorizationPage\(res, 'Entrar na PIA', content\);/);
  assert.match(index, /\.\.\.legalFiles\(origin\),/);
});

test('/oauth/callback tem o rodapé legal no sucesso e nos erros', () => {
  for (const query of ['?code=abc&state=xyz', '?error=access_denied', '']) {
    const res = renderOAuthCallback(new URL(`https://pia.example/oauth/callback${query}`));
    footerInsideCard(res.body);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

test('legalFooter só usa links relativos (mesma origem do servidor configurado)', () => {
  assert.doesNotMatch(legalFooter(), /https?:/);
});

const files = new Map([
  ['/style.css', ['text/css; charset=utf-8', 'body{}']],
  ...legalFiles('https://pia.example'),
]);

test('publicResponse: arquivos existentes mantêm só o Content-Type; páginas legais levam seus headers', () => {
  assert.deepEqual(publicResponse('GET', '/style.css', files),
    { status: 200, headers: { 'Content-Type': 'text/css; charset=utf-8' }, body: 'body{}' });
  const legal = publicResponse('GET', '/privacidade', files);
  assert.equal(legal.status, 200);
  assert.equal(legal.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(legal.headers['Cache-Control'], 'no-store', 'rascunho enquanto houver pendências');
  assert.equal(legal.headers['X-Robots-Tag'], 'noindex');
  assert.match(legal.body, /<h1>Política de Privacidade<\/h1>/);
  assert.equal(publicResponse('HEAD', '/termos', files).body, null);
  assert.equal(publicResponse('HEAD', '/termos', files).status, 200);
  assert.equal(publicResponse('POST', '/termos', files), null);
  assert.equal(publicResponse('GET', '/api/status', files), null);
  assert.equal(publicResponse('GET', '/nada', files), null, '404 global continua JSON no roteador');
});

test('publicResponse: aliases 301 relativos e 404 HTML legal', () => {
  for (const [from, to] of [['/privacy', '/privacidade'], ['/privacidade/', '/privacidade'], ['/terms', '/termos'], ['/termos/', '/termos']]) {
    assert.deepEqual(publicResponse('GET', from, files), { status: 301, headers: { Location: to }, body: null });
    assert.equal(publicResponse('HEAD', from, files).status, 301);
  }
  const missing = publicResponse('GET', '/termos/v9.9', files);
  assert.equal(missing.status, 404);
  assert.match(missing.headers['Content-Type'], /text\/html/);
  assert.match(missing.body, /Página não encontrada/);
  assert.equal(publicResponse('HEAD', '/termos/v1.0', files).body, null, 'v1.0 em rascunho: 404 sem corpo no HEAD');
});

test('servidor HTTP: headers da entrada prevalecem sobre os globais, HEAD sem corpo, sem Set-Cookie', async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'");
    const response = publicResponse(req.method, url.pathname, files);
    if (response) return sendPublic(res, response);
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const final = new Map(legalFiles('https://pia.example', undefined).map(([p, [t, d]]) => [p, [t, d, { 'Cache-Control': 'public, max-age=3600' }]]));
    files.set('/termos-final-teste', final.get('/termos'));
    const cached = await fetch(base + '/termos-final-teste');
    assert.equal(cached.headers.get('cache-control'), 'public, max-age=3600');
    assert.equal(cached.headers.get('x-content-type-options'), 'nosniff');
    assert.match(cached.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    const get = await fetch(base + '/privacidade?x=1');
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(get.headers.get('set-cookie'), null);
    assert.match(await get.text(), /<html lang="pt-BR">/);
    const head = await fetch(base + '/privacidade', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    const redirect = await fetch(base + '/privacy?utm=1', { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/privacidade', 'query descartada');
  } finally {
    files.delete('/termos-final-teste');
    server.close();
  }
});
