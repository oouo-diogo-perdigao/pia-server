import { legalNotFound, legalRedirects } from './legal.js';

/**
 * Resposta das rotas públicas sem login: arquivos do mapa publicFiles, aliases legais (301) e o
 * 404 HTML de /privacidade/* e /termos/*. Aceita GET e HEAD (HEAD sem corpo). Retorna null quando
 * o caminho não é público, para o roteador seguir.
 *
 * Cada entrada de publicFiles é [type, data] ou [type, data, headers]. Os headers da entrada vão no
 * writeHead e prevalecem sobre os globais definidos com setHeader (ex.: Cache-Control); CSP,
 * nosniff e Referrer-Policy continuam vindo do roteador.
 */
export function publicResponse(method, path, files) {
  if (method !== 'GET' && method !== 'HEAD') return null;
  const head = method === 'HEAD';
  if (files.has(path)) {
    const [type, data, headers = {}] = files.get(path);
    return { status: 200, headers: { ...headers, 'Content-Type': type }, body: head ? null : data };
  }
  if (legalRedirects.has(path)) {
    return { status: 301, headers: { Location: legalRedirects.get(path) }, body: null };
  }
  const notFound = legalNotFound(path);
  if (notFound) return { ...notFound, body: head ? null : notFound.body };
  return null;
}

export function sendPublic(res, response) {
  res.writeHead(response.status, response.headers);
  return response.body === null ? res.end() : res.end(response.body);
}
