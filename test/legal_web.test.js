import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { legalFooter } from '../src/legal.js';
import { workspaceHtml } from '../src/workspace_ui.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const login = read('web/login.css');
const indexHtml = read('web/index.html');
const CIENCIA = 'Ao continuar, você concorda com os <a href="/termos">Termos de Serviço</a> e declara ter lido a <a href="/privacidade">Política de Privacidade</a>.';

function block(html, start, end) {
  const from = html.indexOf(start);
  assert.ok(from >= 0, 'não encontrei ' + start);
  const to = html.indexOf(end, from);
  assert.ok(to > from, 'não encontrei o fim de ' + start);
  return html.slice(from, to + end.length);
}

test('F2-05: card #login tem o rodapé legal com o texto do RF05 abaixo de "Continuar com Google"', () => {
  const card = block(indexHtml, '<main id="login"', '</main>');
  const google = card.indexOf('Continuar com Google');
  const footer = card.indexOf('<p class="pia-legal-footer pia-legal-footer--server">');
  assert.ok(google >= 0 && footer > google, 'rodapé depois do botão do Google');
  assert.ok(footer < card.indexOf('</section>'), 'rodapé dentro do card');
  assert.ok(card.includes(CIENCIA), 'texto de ciência do RF05 com os dois links');
  assert.doesNotMatch(card, /target="_blank"/);
});

test('F2-05: #account-menu tem links para /privacidade e /termos antes de "Sair"', () => {
  const menu = block(indexHtml, '<details id="account-menu">', '</details>');
  assert.match(menu, /<ul class="account-legal" aria-label="Documentos legais">/);
  assert.match(menu, /<a href="\/privacidade" class="account-link">\{\{icon:ShieldCheck\}\} Política de Privacidade<\/a>/);
  assert.match(menu, /<a href="\/termos" class="account-link">\{\{icon:FileText\}\} Termos de Serviço<\/a>/);
  assert.ok(menu.indexOf('/termos') < menu.indexOf('id="logout"'));
});

test('F2-05: o template renderiza os ícones dos links (decorativos) sem sobrar tokens', () => {
  const html = workspaceHtml(indexHtml);
  assert.doesNotMatch(html, /\{\{icon:/);
  const menu = block(html, '<details id="account-menu">', '</details>');
  const links = [...menu.matchAll(/<a href="\/(privacidade|termos)" class="account-link">(<svg[^>]*>)/g)];
  assert.equal(links.length, 2);
  for (const [, , svg] of links) assert.match(svg, /aria-hidden="true"/);
});

test('F2-05: #login usa o mesmo componente do legalFooter() e login.css tem um único conjunto de regras', () => {
  const card = block(indexHtml, '<main id="login"', '</main>');
  assert.ok(card.includes(legalFooter({ aceite: true })), '#login igual ao legalFooter({ aceite: true })');
  assert.doesNotMatch(login, /[^-]legal-footer/, 'sem regras duplicadas para .legal-footer');
  assert.match(login, /\.pia-login-card \.pia-legal-footer \{[^}]*font-size: \.8125rem/);
  assert.match(login, /\.pia-login-card \.pia-legal-footer--server \{ font-size: \.8667rem; \}/, '13 px com root de 15 px');
  assert.match(login, /\.pia-legal-footer a \{[^}]*text-decoration: underline/);
  assert.match(login, /\.pia-legal-footer a:focus-visible \{ outline: 2px solid #b6a2ff;/);
});

test('F2-05: links legais sempre sublinhados e foco #b6a2ff no login/autorização e #8f9eff no menu da conta (D6)', () => {
  const style = read('web/style.css');
  for (const [, selector, body] of login.matchAll(/([^{}]*pia-legal-footer[^{}]*)\{([^}]*)\}/g)) {
    assert.doesNotMatch(body, /text-decoration:\s*none/, selector.trim());
    if (/focus-visible/.test(selector)) assert.match(body, /outline: 2px solid #b6a2ff/);
  }
  assert.match(style, /\.account-link:focus-visible \{ outline: 2px solid #8f9eff;/);
  for (const html of [block(indexHtml, '<main id="login"', '</main>'), block(indexHtml, '<details id="account-menu">', '</details>')]) {
    assert.doesNotMatch(html, /target="_blank"/, 'no web os links abrem na mesma aba');
  }
});
