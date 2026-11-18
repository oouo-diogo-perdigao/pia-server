// Preview local das páginas legais, sem banco nem variáveis PG*/GOOGLE_* (só importa src/legal.js).
//   npm run legal:preview                      serve em http://127.0.0.1:8790 (LEGAL_PREVIEW_PORT muda a porta)
//   npm run legal:preview -- --out /tmp/legal  grava os HTML em uma pasta e sai
// Além das rotas reais (/privacidade, /termos, /vX.Y publicadas, aliases e 404 legal), o preview
// serve TODAS as versões do manifesto, inclusive em rascunho, em /preview/<documento>/vX.Y.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DOCUMENTOS, legalFiles, renderDocumento } from '../src/legal.js';
import { VERSOES } from '../src/legal/versoes.js';
import { publicResponse, sendPublic } from '../src/public_files.js';

const HTML = 'text/html; charset=utf-8';
const web = (name) => new URL(`../web/${name}`, import.meta.url);

export function previewFiles(origin) {
  const files = new Map(legalFiles(origin));
  for (const [name, type] of [['legal.css', 'text/css; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'], ['pia.svg', 'image/svg+xml']]) {
    if (existsSync(web(name))) files.set('/' + name, [type, readFileSync(web(name))]);
  }
  const links = [];
  for (const documento of Object.keys(DOCUMENTOS)) {
    links.push(`<li><a href="/${documento}">/${documento}</a> (atual)</li>`);
    for (const { versao, vigencia } of VERSOES[documento]) {
      const path = `/preview/${documento}/v${versao}`;
      const page = renderDocumento(documento, versao, origin);
      files.set(path, [HTML, page.html, { 'Cache-Control': 'no-store' }]);
      links.push(`<li><a href="${path}">${path}</a> (${vigencia ? 'publicada' : 'rascunho'}${page.rascunho ? ', com pendências' : ''})</li>`);
    }
  }
  files.set('/', [HTML, '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Preview legal</title>' +
    '<h1>Preview das páginas legais</h1><ul>' + links.join('') + '</ul></html>']);
  return files;
}

const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const port = Number(process.env.LEGAL_PREVIEW_PORT || 8790);
const origin = `http://127.0.0.1:${port}`;
const files = previewFiles(origin);

if (out) {
  mkdirSync(out, { recursive: true });
  for (const [path, [type, data]] of files) {
    if (!type.startsWith('text/html')) continue;
    const name = path === '/' ? 'index.html' : path.slice(1).replaceAll('/', '_') + '.html';
    writeFileSync(join(out, name), data);
  }
  console.log(`Páginas legais gravadas em ${out}.`);
} else {
  createServer((req, res) => {
    const response = publicResponse(req.method, new URL(req.url, origin).pathname, files);
    if (response) return sendPublic(res, response);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Não encontrado.');
  }).listen(port, '127.0.0.1', () => console.log(`Preview legal em ${origin}/`));
}
