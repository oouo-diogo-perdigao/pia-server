import { legalFooter } from './legal.js';

// Rodapé legal por estado da página (especificação de UX, seção 2.1):
//   'aceite' : formulário com ação de entrar/continuar (frase do RF05);
//   'links'  : página de resultado (sucesso, erro), só os links;
//   'nenhum' : sem rodapé (ex.: estado de espera).
const FOOTERS = Object.freeze({
  aceite: () => legalFooter({ ciencia: true }),
  links: () => legalFooter(),
  nenhum: () => '',
});

/**
 * HTML das páginas de autorização (login de computador e vínculo Discord), com o rodapé legal como
 * último elemento do card. O título é texto fixo do servidor; o conteúdo já chega montado e
 * escapado pelo chamador.
 */
export function authorizationHtml(title, content, footer = 'aceite') {
  if (!Object.hasOwn(FOOTERS, footer)) throw new Error('Rodapé legal inválido: ' + footer);
  return '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + title + '</title><link rel="icon" href="/pia.svg"><link rel="stylesheet" href="/style.css">' +
    '<link rel="stylesheet" href="/login.css"><main class="pia-login"><section class="pia-login-card">' +
    '<img class="pia-login-logo" src="/pia.svg" alt="" width="64" height="64"><h2>' + title + '</h2>' +
    content + FOOTERS[footer]() + '</section></main></html>';
}

export function authorizationPage(res, title, content, footer = 'aceite') {
  // Keep the Origin header on same-origin form submissions without sending
  // the authorization URL as a referrer to Google or other sites.
  const html = authorizationHtml(title, content, footer);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'same-origin' });
  return res.end(html);
}
