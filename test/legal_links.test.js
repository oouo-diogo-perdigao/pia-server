import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { authorizationHtml, authorizationPage } from '../src/auth_page.js';
import { legalFiles, legalFooter } from '../src/legal.js';
import { renderOAuthCallback } from '../src/oauth_callback.js';
import { publicResponse, sendPublic } from '../src/public_files.js';

// Especificação de UX, seção 2.1: variante "aceite" (frase do RF05) e variante "links".
const ACEITE = '<p class="pia-legal-footer pia-legal-footer--server">Ao continuar, você concorda com os ' +
  '<a href="/termos">Termos de Serviço</a> e declara ter lido a <a href="/privacidade">Política de Privacidade</a>.</p>';
const LINKS = '<p class="pia-legal-footer pia-legal-footer--server pia-legal-footer--links">' +
  '<a href="/privacidade">Política de Privacidade</a> <a href="/termos">Termos de Serviço</a></p>';

/** Confere a variante esperada como ÚLTIMO elemento do card, sem target nem links absolutos. */
function rodape(html, esperado) {
  const fim = '</section></main>';
  if (esperado === null) {
    assert.doesNotMatch(html, /pia-legal-footer|\/privacidade|\/termos/, 'sem rodapé legal');
    return;
  }
  assert.ok(html.includes(esperado + fim), 'rodapé é o último elemento do .pia-login-card');
  assert.equal((html.match(/pia-legal-footer"|pia-legal-footer /g) || []).length, 1, 'um único rodapé');
  const footer = html.slice(html.indexOf('<p class="pia-legal-footer'), html.indexOf(fim));
  assert.doesNotMatch(footer, /target=|_blank|https?:/, 'mesma aba e links relativos');
}

function fakeResponse() {
  return {
    status: 0, headers: {}, body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; return this; },
  };
}

test('legalFooter: variante aceite (ciencia/aceite) e variante links, sem target=_blank', () => {
  assert.equal(legalFooter({ ciencia: true }), ACEITE);
  assert.equal(legalFooter({ aceite: true }), ACEITE);
  assert.equal(legalFooter(), LINKS);
  for (const html of [legalFooter(), legalFooter({ ciencia: true })]) {
    assert.doesNotMatch(html, /target=|_blank|https?:|·/);
  }
});

test('/auth/device/:id formulário "Entrar na PIA": rodapé aceite e headers mantidos', () => {
  const res = fakeResponse();
  authorizationPage(res, 'Entrar na PIA', '<p>Confira o código.</p><form method="post"><button>Autorizar computador</button></form>', 'aceite');
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'same-origin' });
  assert.match(res.body, /^<!doctype html><html lang="pt-BR">/);
  rodape(res.body, ACEITE);
  rodape(authorizationHtml('Entrar na PIA', '<p>x</p>'), ACEITE); // padrão = aceite
});

test('/auth/device/:id resultado "Computador autorizado": só os links', () => {
  rodape(authorizationHtml('Entrar na PIA', '<p>Computador autorizado. Você pode fechar esta aba e voltar à PIA.</p>', 'links'), LINKS);
});

test('/discord/bless/:token formulário e resultado: aceite e links', () => {
  rodape(authorizationHtml('Vincular Discord à PIA', '<form method="post"><button>Confirmar vínculo</button></form>', 'aceite'), ACEITE);
  rodape(authorizationHtml('Vincular Discord à PIA', '<p>Servidor <strong>Mesa</strong> abençoado e vinculado à sua conta PIA.</p>', 'links'), LINKS);
});

test('estado de espera ("Aguardando autorização…"): sem rodapé', () => {
  rodape(authorizationHtml('Entrar na PIA', '<p>Aguardando autorização…</p>', 'nenhum'), null);
  assert.throws(() => authorizationHtml('Entrar na PIA', '<p>x</p>', 'outro'), /Rodapé legal inválido/);
});

test('/oauth/callback: só os links no sucesso e nos erros', () => {
  for (const query of ['?code=abc&state=xyz', '?error=access_denied', '', `?code=${'a'.repeat(3000)}&state=s`]) {
    const res = renderOAuthCallback(new URL(`https://pia.example/oauth/callback${query}`));
    assert.ok(res.body.includes(LINKS + '</section></main>'), query);
    assert.doesNotMatch(res.body, /Ao continuar|target=/);
    assert.equal(res.headers['Cache-Control'], 'no-store');
  }
});

test('index.js: formulário (GET) com aceite e resultado (POST) com links nas duas rotas', () => {
  const index = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(index, /import \{ authorizationPage \} from '\.\/auth_page\.js';/);
  assert.doesNotMatch(index, /function authorizationPage/);
  for (const title of ['Vincular Discord à PIA', 'Entrar na PIA']) {
    assert.ok(index.includes(`return authorizationPage(res, '${title}', content, req.method === 'GET' ? 'aceite' : 'links');`), title);
  }
  assert.match(index, /\.\.\.legalFiles\(origin\),/);
  assert.doesNotMatch(index, /_blank/);
});

test('web/login.css tem o estilo do rodapé da spec: links sempre sublinhados e foco visível', () => {
  const css = readFileSync(new URL('../web/login.css', import.meta.url), 'utf8');
  assert.match(css, /\.pia-login-card \.pia-legal-footer \{/);
  assert.match(css, /\.pia-legal-footer a \{[^}]*text-decoration: underline;/);
  assert.match(css, /\.pia-legal-footer a:hover \{[^}]*text-decoration-thickness: 2px;/);
  assert.match(css, /\.pia-legal-footer a:focus-visible \{[^}]*outline: 2px solid #b6a2ff;/);
  assert.match(css, /\.pia-login-card \.pia-legal-footer--server \{ font-size: \.8667rem; \}/);
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
