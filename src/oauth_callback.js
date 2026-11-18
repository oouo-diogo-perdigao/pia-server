import { legalFooter } from './legal.js';

const MAX_QUERY_LENGTH = 4096;
const MAX_PARAM_COUNT = 20;
const MAX_CODE_LENGTH = 2048;
const MAX_STATE_LENGTH = 512;
const MAX_ERROR_LENGTH = 256;
const MAX_ERROR_DESCRIPTION_LENGTH = 512;

const SECURITY_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
});

const HTML_ESCAPE_MAP = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes untrusted text for safe insertion into HTML text and attributes.
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char]);
}

function page(status, title, content, includeScript = false) {
  const scriptTag = includeScript ? '<script src="/oauth-callback.js" defer></script>' : '';
  const body =
    '<!doctype html><html lang="pt-BR"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title>' +
    '<link rel="icon" href="/pia.svg">' +
    '<link rel="stylesheet" href="/style.css">' +
    '<link rel="stylesheet" href="/login.css">' +
    '<main class="pia-login"><section class="pia-login-card">' +
    '<img class="pia-login-logo" src="/pia.svg" alt="" width="64" height="64">' +
    '<h2>' + escapeHtml(title) + '</h2>' +
    content +
    legalFooter() +
    '</section></main>' +
    scriptTag +
    '</html>';
  return { status, headers: { ...SECURITY_HEADERS }, body };
}

function errorPage(title, message, detail = '') {
  const detailHtml = detail ? '<p><code>' + escapeHtml(detail) + '</code></p>' : '';
  return page(
    400,
    title,
    '<p>' + escapeHtml(message) + '</p>' +
      detailHtml +
      '<p>Volte à PIA e tente iniciar a autorização novamente.</p>',
  );
}

/**
 * Renders the public GET /oauth/callback response without logging secrets or redirecting.
 */
export function renderOAuthCallback(url) {
  const params = url.searchParams;
  if (url.search.length > MAX_QUERY_LENGTH || [...params].length > MAX_PARAM_COUNT) {
    return errorPage(
      'Parâmetros inválidos',
      'A resposta de autorização excedeu o tamanho permitido.',
    );
  }

  const error = (params.get('error') || '').trim();
  const errorDescription = (params.get('error_description') || '').trim();
  if (error) {
    if (error.length > MAX_ERROR_LENGTH || errorDescription.length > MAX_ERROR_DESCRIPTION_LENGTH) {
      return errorPage(
        'Erro na autorização',
        'O provedor retornou um erro acima do tamanho permitido.',
      );
    }
    const detail = errorDescription ? `${error}: ${errorDescription}` : error;
    return errorPage(
      'Autorização não concluída',
      'O provedor não concluiu a autorização solicitada.',
      detail,
    );
  }

  const code = (params.get('code') || '').trim();
  const state = (params.get('state') || '').trim();
  if (!code || !state) {
    return errorPage(
      'Parâmetros ausentes',
      'Faltam os parâmetros obrigatórios de autorização (code e state).',
    );
  }

  if (code.length > MAX_CODE_LENGTH || state.length > MAX_STATE_LENGTH) {
    return errorPage(
      'Parâmetros inválidos',
      'Os parâmetros de autorização excederam o tamanho permitido.',
    );
  }

  const content =
    '<p>Autorização recebida. Volte à PIA e cole o código abaixo para concluir a conexão.</p>' +
    '<label for="oauth-code">Código de autorização</label>' +
    '<input id="oauth-code" type="text" readonly value="' + escapeHtml(code) + '" aria-label="Código de autorização">' +
    '<p><button type="button" id="copy-code">Copiar código</button></p>' +
    '<p id="copy-status" role="status" aria-live="polite"></p>';

  return page(200, 'Autorização recebida', content, true);
}
