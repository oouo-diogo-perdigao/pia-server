import { legalFooter } from './legal.js';

/**
 * HTML das páginas de autorização (login de computador e vínculo Discord), com o rodapé legal
 * (Política de Privacidade e Termos de Serviço). O título é texto fixo do servidor; o conteúdo já
 * chega montado e escapado pelo chamador.
 */
export function authorizationHtml(title, content) {
  return '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + title + '</title><link rel="icon" href="/pia.svg"><link rel="stylesheet" href="/style.css">' +
    '<link rel="stylesheet" href="/login.css"><main class="pia-login"><section class="pia-login-card">' +
    '<img class="pia-login-logo" src="/pia.svg" alt="" width="64" height="64"><h2>' + title + '</h2>' +
    content + legalFooter() + '</section></main></html>';
}

export function authorizationPage(res, title, content) {
  // Keep the Origin header on same-origin form submissions without sending
  // the authorization URL as a referrer to Google or other sites.
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Referrer-Policy': 'same-origin' });
  return res.end(authorizationHtml(title, content));
}
