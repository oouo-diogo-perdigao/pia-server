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
  const footer = card.indexOf('<footer class="legal-footer">');
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

test('F2-05: login.css estiliza o rodapé legal do contrato (legalFooter) dentro do card', () => {
  assert.match(legalFooter({ ciencia: true }), /^<footer class="legal-footer">/);
  assert.match(login, /\.pia-login-card \.legal-footer \{/);
  assert.match(login, /\.pia-login-card \.legal-footer a \{[^}]*text-decoration: underline/);
  assert.match(login, /\.pia-login-card \.legal-footer a:focus-visible/);
});
