import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DOCUMENTOS, MICROTEXTOS, escapeHtml, formatarData, legalFiles, legalFooter,
  legalNotFound, legalRedirects, pendencias, redirecionamentosLegais, renderDocumento, renderTokens, textoJuridico,
} from '../src/legal.js';
import { escapeHtml as escapeOAuth } from '../src/oauth_callback.js';
import { DADOS } from '../src/legal/dados.js';
import { JURIDICO } from '../src/legal/juridico.js';
import { VERSOES } from '../src/legal/versoes.js';

const ORIGIN = 'https://pia.example';

const fragmento = (extra = '') =>
  '<!-- comentário interno -->' +
  '<!-- legal:resumo --><ul><li>Gratuito.</li><li>Sem garantias.</li><li>Treinamento.</li><li>Sem retenção.</li></ul><!-- /legal:resumo -->' +
  '<h2 id="contato">Contato</h2><p>{{CONTROLADOR_NOME}}, <a href="mailto:{{CONTATO_EMAIL}}">{{CONTATO_EMAIL}}</a></p>' +
  '<h2 id="foro">Foro</h2><p>{{FORO}}</p><p>{{TRECHO}}</p>' + extra;

function fontes({ revisado = true, datas = true, conteudo = fragmento(), versoes } = {}) {
  const item = (versao) => ({ versao, vigencia: datas ? '2026-12-01' : null, atualizacao: datas ? '2026-12-05' : null, resumo: 'Primeira versão.', juridico: '1.0' });
  return {
    dados: { CONTROLADOR_NOME: 'Fulana <Teste> & "Cia"', CONTATO_EMAIL: 'contato@pia.example', FORO: 'comarca X' },
    juridico: { '1.0': { TRECHO: { texto: 'Trecho para {{CONTATO_EMAIL}}.', revisado, pendencia: 'P10', assunto: 'base legal' } } },
    versoes: versoes || { privacidade: [item('1.0')], termos: [item('1.0')] },
    conteudo: typeof conteudo === 'function' ? conteudo : () => conteudo,
  };
}

test('renderTokens substitui tokens e falha em token desconhecido, vazio ou malformado', () => {
  assert.equal(renderTokens('Oi {{NOME}}!', { NOME: 'Ana' }), 'Oi Ana!');
  assert.throws(() => renderTokens('{{OUTRO}}', { NOME: 'Ana' }), /Token desconhecido \{\{OUTRO\}\}/);
  assert.throws(() => renderTokens('{{NOME}}', { NOME: '' }), /sem valor/);
  assert.throws(() => renderTokens('{{nome}}', { NOME: 'Ana' }), /malformado/);
  assert.throws(() => renderTokens('{{ NOME }}', { NOME: 'Ana' }), /malformado/);
  assert.throws(() => renderDocumento('privacidade', undefined, ORIGIN, fontes({ conteudo: fragmento('{{INEXISTENTE}}') })),
    /Token desconhecido \{\{INEXISTENTE\}\}/);
});

test('escapeHtml segue o contrato do oauth_callback e os dados são escapados na página', () => {
  const amostra = `<script>alert("x")</script> & 'y'`;
  assert.equal(escapeHtml(amostra), escapeOAuth(amostra));
  const { html } = renderDocumento('privacidade', undefined, ORIGIN, fontes());
  assert.match(html, /Fulana &lt;Teste&gt; &amp; &quot;Cia&quot;/);
  assert.doesNotMatch(html, /<Teste>/);
  assert.match(html, /Trecho para contato@pia\.example\./);
  assert.doesNotMatch(html, /\{\{|\}\}/);
  assert.doesNotMatch(html, /comentário interno/);
});

test('versão final: cache público, sem noindex, sem faixa nem selos', () => {
  for (const documento of Object.keys(DOCUMENTOS)) {
    const pagina = renderDocumento(documento, undefined, ORIGIN, fontes());
    assert.equal(pagina.rascunho, false);
    assert.deepEqual(pagina.headers, { 'Cache-Control': 'public, max-age=3600' });
    assert.deepEqual(pagina.pendencias, []);
    assert.doesNotMatch(pagina.html, /noindex|RASCUNHO|\[/);
  }
});

test('rascunho por trecho jurídico sem revisão: selo, faixa, no-store e noindex', () => {
  const pagina = renderDocumento('privacidade', undefined, ORIGIN, fontes({ revisado: false }));
  assert.equal(pagina.rascunho, true);
  assert.deepEqual(pagina.headers, { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  assert.deepEqual(pagina.pendencias, ['juridico:TRECHO']);
  assert.match(pagina.html, /<span class=\"legal-pendente\">\[EM REVISÃO JURÍDICA: P10 base legal\]<\/span> Trecho para contato@pia\.example\./);
  assert.match(pagina.html, /RASCUNHO, não publicar/);
  assert.match(pagina.html, /<meta name="robots" content="noindex">/);
});

test('textoJuridico (embed do Discord): selo de rascunho com revisado:false, texto puro com revisado:true', () => {
  assert.equal(textoJuridico('TRECHO', 'privacidade', fontes({ revisado: false })), '[EM REVISÃO JURÍDICA: P10 base legal] Trecho para contato@pia.example.');
  assert.equal(textoJuridico('TRECHO', 'privacidade', fontes()), 'Trecho para contato@pia.example.');
});

test('rascunho por data nula e por marcador com colchete no texto', () => {
  const semData = renderDocumento('termos', undefined, ORIGIN, fontes({ datas: false }));
  assert.equal(semData.rascunho, true);
  assert.match(semData.html, /Vigente a partir de <span class="legal-pendente">\[PREENCHER NO RELEASE: data de vigência\]<\/span>/);
  assert.match(semData.html, /Última atualização: <span class="legal-pendente">\[PREENCHER NO RELEASE: data de atualização\]/);
  const comColchete = renderDocumento('termos', undefined, ORIGIN, fontes({ conteudo: fragmento('<p>[TEXTO PENDENTE]</p>') }));
  assert.equal(comColchete.rascunho, true);
  assert.equal(comColchete.headers['X-Robots-Tag'], 'noindex');
});

test('datas em DD/MM/AAAA, determinísticas e validadas', () => {
  assert.equal(formatarData('2026-12-01'), '01/12/2026');
  assert.equal(formatarData('2028-02-29'), '29/02/2028');
  assert.equal(formatarData(null), null);
  assert.throws(() => formatarData('2026-02-29'), /inexistente/);
  assert.throws(() => formatarData('01/12/2026'), /inválida/);
  const { html } = renderDocumento('privacidade', undefined, ORIGIN, fontes());
  assert.match(html, /<p class="legal-datas">Vigente a partir de <time datetime="2026-12-01">01\/12\/2026<\/time> · Última atualização: <time datetime="2026-12-05">05\/12\/2026<\/time> · Versão <strong>1\.0<\/strong><\/p>/);
});

test('layout: lang, title, description, canonical, h1 único, sumário, resumo, histórico e links', () => {
  const { html } = renderDocumento('privacidade', undefined, ORIGIN + '/qualquer?x=1', fontes());
  assert.match(html, /^<!doctype html><html lang="pt-BR">/);
  assert.match(html, /<title>Política de Privacidade · PIA<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]+">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/pia\.example\/privacidade">/);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<h1>Política de Privacidade<\/h1>/);
  for (const id of ['em-resumo', 'contato', 'foro', 'historico-de-versoes']) {
    assert.match(html, new RegExp(`<a href="#${id}">`));
    assert.match(html, new RegExp(`<h2 id="${id}">`));
  }
  assert.match(html, /<h2 id="em-resumo">Em resumo<\/h2><ul><li>Gratuito/);
  assert.match(html, /<tr><th scope="row"><a href="\/privacidade\/v1\.0">1\.0<span [^>]*>, abrir cópia arquivada<\/span><\/a> <span class="legal-current">atual<\/span><\/th><td><time datetime="2026-12-01">01\/12\/2026<\/time><\/td><td>Primeira versão\.<\/td><\/tr>/);
  assert.match(html, /<a href="\/">Voltar à PIA<\/a>/);
  assert.match(html, /Leia também: <a href="\/termos">Termos de Serviço<\/a>\./);
  assert.doesNotMatch(html, /<script/i);
  const termos = renderDocumento('termos', '1.0', ORIGIN, fontes()).html;
  assert.match(termos, /<link rel="canonical" href="https:\/\/pia\.example\/termos\/v1\.0">/);
  assert.match(termos, /Leia também: <a href="\/privacidade">Política de Privacidade<\/a>\./);
});

test('sumário usa o texto puro e escapado dos títulos; trecho jurídico é texto puro', () => {
  const extra = fontes({ conteudo: fragmento('<h2 id="a-e-b">A <em>&amp;</em> &lt;B&gt;</h2>') });
  extra.juridico['1.0'].TRECHO.texto = 'Escreva para <a href="mailto:x@y">x@y</a>.';
  const { html } = renderDocumento('privacidade', undefined, ORIGIN, extra);
  assert.match(html, /<li><a href="#a-e-b">A &amp; &lt;B&gt;<\/a><\/li>/);
  assert.match(html, /<h2 id="a-e-b">A <em>&amp;<\/em> &lt;B&gt;<\/h2>/, 'corpo mantém o HTML do fragmento');
  assert.match(html, /Escreva para &lt;a href=&quot;mailto:x@y&quot;&gt;x@y&lt;\/a&gt;\./);
});

test('microtextos aprovados pelo PO (spec de UX, seção 5, item 7) aparecem exatamente', () => {
  assert.deepEqual({ ...MICROTEXTOS }, {
    EYEBROW: 'PIA · Documento legal',
    LEIA_TAMBEM: 'Leia também',
    NESTA_PAGINA: 'Nesta página',
    VOLTAR_AO_SUMARIO: 'Voltar ao sumário',
    PUBLICADA_EM: 'Publicada em',
    O_QUE_MUDOU: 'O que mudou',
    ATUAL: 'atual',
    FAIXA_RASCUNHO_ROTULO: 'RASCUNHO, não publicar',
    FAIXA_RASCUNHO_TEXTO: 'Este texto ainda não tem parecer jurídico e não é a versão oficial.',
    CIENCIA_ANTES: 'Ao continuar, você concorda com os ',
    CIENCIA_MEIO: ' e declara ter lido a ',
    PULAR_PARA_CONTEUDO: 'Pular para o conteúdo',
    ABRIR_COPIA_ARQUIVADA: ', abrir cópia arquivada',
    SELO_RASCUNHO: 'RASCUNHO',
    PREFIXO_TITULO_RASCUNHO: 'RASCUNHO · ',
    DOCUMENTOS_LEGAIS: 'Documentos legais',
    VOLTAR_A_PIA: 'Voltar à PIA',
  });
  const final = renderDocumento('privacidade', undefined, ORIGIN, fontes()).html;
  assert.ok(final.includes('<p class="legal-eyebrow">PIA · Documento legal</p><h1>Política de Privacidade</h1>'));
  assert.ok(final.includes('<p class="legal-outro">Leia também: <a href="/termos">Termos de Serviço</a>.</p>'));
  assert.ok(final.includes('<nav class="legal-sumario" id="sumario" aria-labelledby="sumario-t"><h2 id="sumario-t">Nesta página</h2>'));
  assert.ok(final.includes('<th scope="col">Versão</th><th scope="col">Publicada em</th><th scope="col">O que mudou</th>'));
  assert.ok(final.includes('<span class="legal-current">atual</span>'));
  assert.doesNotMatch(final, /Sumário|Veja também|Resumo da mudança|RASCUNHO/);
  const voltar = '<p class="legal-backtop"><a href="#sumario"><span aria-hidden="true">↑ </span>Voltar ao sumário</a></p>';
  assert.equal(final.split(voltar).length - 1, 3, 'fim de cada seção do fragmento (2) e do histórico (1)');
  assert.ok(final.includes(voltar + '<h2 id="foro">'), 'antes do h2 seguinte');
  const congelada = renderDocumento('privacidade', '1.0', ORIGIN, fontes()).html;
  assert.doesNotMatch(congelada, /legal-current|>atual</, 'cópia /vX.Y sem etiqueta atual (hash estável)');
  const rascunho = renderDocumento('privacidade', undefined, ORIGIN, fontes({ datas: false })).html;
  assert.ok(rascunho.includes('<p class="legal-rascunho" role="note"><strong>RASCUNHO, não publicar</strong> Este texto ainda não tem parecer jurídico e não é a versão oficial.</p>'));
  assert.ok(rascunho.includes('<td><span class="legal-pendente">[PREENCHER NO RELEASE: data]</span></td>'));
  assert.equal(legalFooter({ ciencia: true }),
    '<p class="pia-legal-footer pia-legal-footer--server">Ao continuar, você concorda com os <a href="/termos">Termos de Serviço</a> e declara ter lido a <a href="/privacidade">Política de Privacidade</a>.</p>');
  assert.throws(() => renderDocumento('privacidade', undefined, ORIGIN, fontes({ conteudo: fragmento('<h2 id="sumario-t">X</h2>') })), /reservado/);
});

test('acessibilidade e rascunho: skip link, legenda e texto ocultos, prefixo e selo só no rascunho', () => {
  const final = renderDocumento('termos', undefined, ORIGIN, fontes()).html;
  assert.ok(final.includes('<body><a class="skip-link" href="#conteudo">Pular para o conteúdo</a><header class="legal-header">'),
    'skip link é o 1º elemento e aponta para o main');
  const sr = 'class="sr-only" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0"';
  assert.ok(final.includes(`<table><caption ${sr}>Versões publicadas dos Termos de Serviço</caption><thead>`));
  assert.ok(renderDocumento('privacidade', undefined, ORIGIN, fontes()).html
    .includes(`<caption ${sr}>Versões publicadas da Política de Privacidade</caption>`));
  assert.ok(final.includes(`<a href="/termos/v1.0">1.0<span ${sr}>, abrir cópia arquivada</span></a>`));
  assert.ok(final.includes('<title>Termos de Serviço · PIA</title>'));
  assert.doesNotMatch(final, /RASCUNHO|legal-badge/, 'final sem prefixo nem selo');

  const rascunho = renderDocumento('termos', undefined, ORIGIN, fontes({ datas: false })).html;
  assert.ok(rascunho.includes('<title>RASCUNHO · Termos de Serviço · PIA</title>'));
  assert.ok(rascunho.includes('<p class="legal-datas"><span class="legal-badge">RASCUNHO</span> Vigente a partir de <span class="legal-pendente">[PREENCHER NO RELEASE: data de vigência]</span> · Última atualização: '));
  assert.equal((rascunho.match(/legal-badge/g) || []).length, 1);
  assert.doesNotMatch(rascunho, /<a href="\/termos\/v1\.0">/, 'versão em rascunho sem link (e sem texto de cópia arquivada)');
  assert.doesNotMatch(rascunho, /\u0000/, 'marcador interno substituído');
  const pendente = renderDocumento('termos', undefined, ORIGIN, fontes({ revisado: false })).html;
  assert.ok(pendente.includes('<title>RASCUNHO · '), 'trecho sem revisão também é rascunho');
  assert.ok(pendente.includes('<span class="legal-badge">RASCUNHO</span>'));
  const notFound = legalNotFound('/termos/v9.9').body;
  assert.ok(notFound.includes('<title>Página não encontrada · PIA</title>'));
  assert.ok(notFound.includes('<main class="legal" id="conteudo" tabindex="-1">'));
});

// Relatório de QA (D1 a D5) e spec de UX 1.1, 1.4, 1.7, 1.9 e 4.1/4.2.
const SECOES = { privacidade: 14, termos: 13 };
const focaveis = (html) => [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>/g)].map(([, href]) => href);
const NAV = '<nav class="legal-topnav" aria-label="Documentos legais"><ul>' +
  '<li><a href="/privacidade"%P>Política de Privacidade</a></li><li><a href="/termos"%T>Termos de Serviço</a></li>' +
  '<li><a href="/">Voltar à PIA</a></li></ul></nav>';
const nav = (atual) => NAV.replace('%P', atual === 'privacidade' ? ' aria-current="page"' : '')
  .replace('%T', atual === 'termos' ? ' aria-current="page"' : '');
const RODAPE = '<footer class="legal-rodape"><address>Controlador e contato: Fulana &lt;Teste&gt; &amp; &quot;Cia&quot;, ' +
  '<a href="mailto:contato@pia.example">contato@pia.example</a>.</address><p>';
const RODAPE_REAL = '<footer class="legal-rodape"><address>Controlador e contato: Diogo Passos Perdigão Britto, ' +
  '<a href="mailto:contato@travelrpg.com">contato@travelrpg.com</a>.</address><p>';

test('D1: header (banner) e footer (contentinfo) fora do main, barra com nav "Documentos legais", faixa dentro do header', () => {
  const final = renderDocumento('privacidade', undefined, ORIGIN, fontes()).html;
  const corpo = final.slice(final.indexOf('<body>'));
  assert.ok(corpo.startsWith('<body><a class="skip-link" href="#conteudo">Pular para o conteúdo</a><header class="legal-header">' +
    '<div class="legal-topbar"><p class="legal-brand"><img src="/pia.svg" alt="" width="28" height="28"> PIA <small>Server</small></p>' +
    nav('privacidade') + '</div></header><main class="legal" id="conteudo" tabindex="-1"><div class="legal-cabecalho">'));
  assert.ok(corpo.endsWith('</main>' + RODAPE + '<a href="/privacidade" aria-current="page">Política de Privacidade</a> · ' +
    '<a href="/termos">Termos de Serviço</a> · <a href="/">Voltar à PIA</a></p></footer></body></html>'));
  const main = corpo.slice(corpo.indexOf('<main'), corpo.indexOf('</main>'));
  assert.doesNotMatch(main, /<header|<footer|legal-voltar/, 'nada de header/footer dentro do main');
  for (const tag of ['header', 'footer', 'main', 'h1']) assert.equal(final.split('<' + tag).length, 2, 'um ' + tag);
  assert.equal(final.split('<nav').length, 3, 'duas navs: Documentos legais e Nesta página');
  assert.doesNotMatch(final, /legal-rascunho/, 'final sem faixa');

  const rascunho = renderDocumento('privacidade', undefined, ORIGIN, fontes({ datas: false })).html;
  assert.ok(rascunho.includes('<header class="legal-header"><p class="legal-rascunho" role="note"><strong>RASCUNHO, não publicar</strong> ' +
    'Este texto ainda não tem parecer jurídico e não é a versão oficial.</p><div class="legal-topbar">'), 'faixa = 1º filho do header');
  assert.equal(rascunho.split('legal-rascunho').length, 2);
});

test('D2: ordem de Tab da spec 4.1 nas páginas reais (skip, barra, Leia também, e-mail do resumo, sumário … rodapé)', () => {
  const paginas = new Map(legalFiles('https://pia.travelrpg.com'));
  for (const [documento, outro, resumo] of [['privacidade', 'termos', ['mailto:contato@travelrpg.com']], ['termos', 'privacidade', []]]) {
    const ordem = focaveis(paginas.get('/' + documento)[1]);
    const inicio = ['#conteudo', '/privacidade', '/termos', '/', '/' + outro, ...resumo, '#em-resumo'];
    assert.deepEqual(ordem.slice(0, inicio.length), inicio, documento);
    assert.equal(ordem.at(-1 - 3), 'mailto:contato@travelrpg.com', 'rodapé: e-mail');
    assert.deepEqual(ordem.slice(-3), ['/privacidade', '/termos', '/'], 'rodapé: Política, Termos, Voltar');
    assert.equal(ordem.indexOf('#historico-de-versoes'), inicio.length - 1 + 1 + SECOES[documento], 'sumário completo antes do corpo');
  }
  // Com uma versão publicada, o link da versão vem depois do corpo e antes do rodapé.
  const ordem = focaveis(renderDocumento('privacidade', undefined, ORIGIN, fontes()).html);
  assert.deepEqual(ordem.slice(-6), ['/privacidade/v1.0', '#sumario', 'mailto:contato@pia.example', '/privacidade', '/termos', '/']);
});

test('D3: datas em <time datetime> e metadados na ordem da spec (selo, vigência, atualização, versão), ainda num <p>', () => {
  const html = renderDocumento('termos', undefined, ORIGIN, fontes()).html;
  assert.ok(html.includes('<p class="legal-datas">Vigente a partir de <time datetime="2026-12-01">01/12/2026</time> · ' +
    'Última atualização: <time datetime="2026-12-05">05/12/2026</time> · Versão <strong>1.0</strong></p>'));
  assert.doesNotMatch(html, /legal-meta|<ul class="legal-datas/, 'metadados não viram lista na v1.0');
  const semData = renderDocumento('termos', undefined, ORIGIN, fontes({ datas: false })).html;
  assert.doesNotMatch(semData, /<time/, 'data nula vira selo, sem <time>');
});

test('D4: versão do histórico em <th scope="row">', () => {
  const html = renderDocumento('termos', undefined, ORIGIN, fontes()).html;
  const tbody = html.slice(html.indexOf('<tbody>'), html.indexOf('</tbody>'));
  assert.equal(tbody.split('<th scope="row">').length - 1, tbody.split('<tr>').length - 1);
  assert.match(tbody, /^<tbody><tr><th scope="row"><a href="\/termos\/v1\.0">1\.0<span [^>]*>, abrir cópia arquivada<\/span><\/a> <span class="legal-current">atual<\/span><\/th><td><time datetime="2026-12-01">01\/12\/2026<\/time><\/td><td>Primeira versão\.<\/td><\/tr>$/);
  assert.match(html, /<thead><tr><th scope="col">Versão<\/th><th scope="col">Publicada em<\/th><th scope="col">O que mudou<\/th><\/tr><\/thead>/);
});

test('D5: rodapé com <address> e aria-current="page" só no documento atual (barra e rodapé); cópia /vX.Y sem aria-current', () => {
  for (const documento of ['privacidade', 'termos']) {
    const html = renderDocumento(documento, undefined, ORIGIN, fontes()).html;
    const correntes = [...html.matchAll(/<a href="([^"]+)" aria-current="page">/g)].map(([, href]) => href);
    assert.deepEqual(correntes, ['/' + documento, '/' + documento], documento);
    assert.ok(html.includes(nav(documento)));
    assert.ok(html.includes(RODAPE));
    const congelada = renderDocumento(documento, '1.0', ORIGIN, fontes()).html;
    assert.doesNotMatch(congelada, /aria-current/, 'cópia congelada não muda quando sai versão nova');
    assert.ok(congelada.includes(nav(null)) && congelada.includes(RODAPE));
  }
});

test('404 legal: mesma estrutura de landmarks (header com a nav, main, footer com address), sem aria-current', () => {
  const body = legalNotFound('/termos/v9.9').body;
  const corpo = body.slice(body.indexOf('<body>'));
  assert.ok(corpo.startsWith('<body><a class="skip-link" href="#conteudo">Pular para o conteúdo</a><header class="legal-header"><div class="legal-topbar">'));
  assert.ok(corpo.includes('</p>' + nav(null) + '</div></header><main class="legal" id="conteudo" tabindex="-1"><h1>Página não encontrada</h1>'));
  assert.ok(corpo.includes('</main>' + RODAPE_REAL) && corpo.endsWith('</footer></body></html>'));
  assert.doesNotMatch(body, /aria-current|legal-rascunho|RASCUNHO/);
  assert.deepEqual(focaveis(body), ['#conteudo', '/privacidade', '/termos', '/', '/privacidade', '/termos', '/',
    'mailto:contato@travelrpg.com', '/privacidade', '/termos', '/']);
});

test('fragmento inválido falha no boot', () => {
  const casos = [
    [fragmento('<h1>Outro</h1>'), /<h1>/],
    [fragmento('<script>x</script>'), /<script>/],
    [fragmento('<a href="/" onclick="x()">a</a>'), /on\*=/],
    [fragmento('<h2>Sem id</h2>'), /precisa de id/],
    [fragmento('<h2 id="contato">De novo</h2>'), /repetido ou reservado/],
    [fragmento('<h2 id="sumario">Reservado</h2>'), /repetido ou reservado/],
    ['<h2 id="a">A</h2>', /exatamente um bloco/],
    ['<!-- legal:resumo --><ul><li>1</li><li>2</li></ul><!-- /legal:resumo --><h2 id="a">A</h2>', /3 a 5 itens/],
  ];
  for (const [conteudo, erro] of casos) {
    assert.throws(() => renderDocumento('privacidade', undefined, ORIGIN, fontes({ conteudo })), erro);
  }
  assert.throws(() => renderDocumento('outro', undefined, ORIGIN, fontes()), /desconhecido/);
  assert.throws(() => renderDocumento('privacidade', '9.9', ORIGIN, fontes()), /não existe/);
  const semConjunto = fontes();
  semConjunto.versoes.privacidade[0].juridico = '9.9';
  assert.throws(() => legalFiles(ORIGIN, semConjunto), /conjunto jurídico inexistente/);
});

test('versão atual = última publicada; v1.1 em rascunho não aparece nem tem /vX.Y (C1)', () => {
  const item = (versao, vigencia) => ({ versao, vigencia, atualizacao: vigencia, resumo: `Versão ${versao}.`, juridico: '1.0' });
  const versoes = { privacidade: [item('1.0', '2026-12-01'), item('1.1', null)], termos: [item('1.0', '2026-12-01')] };
  const conteudo = (documento, versao) => fragmento(`<p>texto ${documento} ${versao}</p>`);
  const extra = { ...fontes(), versoes, conteudo };
  const entradas = new Map(legalFiles(ORIGIN, extra));
  assert.deepEqual([...entradas.keys()], ['/privacidade', '/privacidade/v1.0', '/termos', '/termos/v1.0']);
  for (const [type, html, headers] of entradas.values()) {
    assert.equal(type, 'text/html; charset=utf-8');
    assert.equal(typeof html, 'string');
    assert.deepEqual(headers, { 'Cache-Control': 'public, max-age=3600' }, 'v1.0 publicada e final');
  }
  const [, atual] = entradas.get('/privacidade');
  assert.match(atual, /texto privacidade 1\.0/, '/privacidade serve a v1.0 publicada');
  assert.doesNotMatch(atual, /texto privacidade 1\.1|>1\.1</, 'v1.1 em rascunho não aparece na atual');
  assert.match(atual, /Vigente a partir de <time datetime="2026-12-01">01\/12\/2026<\/time> · Última atualização: [\s\S]*? · Versão <strong>1\.0<\/strong>/);
  assert.match(atual, /<link rel="canonical" href="https:\/\/pia\.example\/privacidade">/);
  const [, v10] = entradas.get('/privacidade/v1.0');
  assert.match(v10, /<link rel="canonical" href="https:\/\/pia\.example\/privacidade\/v1\.0">/);
  assert.match(v10, /<th scope="row"><a href="\/privacidade\/v1\.0">1\.0<span [^>]*>, abrir cópia arquivada<\/span><\/a><\/th>/);
  assert.equal(renderDocumento('privacidade', undefined, ORIGIN, extra).html, atual);

  const naoEncontrada = legalNotFound('/privacidade/v1.1', extra);
  assert.equal(naoEncontrada.status, 404, '/privacidade/v1.1 em rascunho: 404 legal');
  assert.match(naoEncontrada.body, /<a href="\/privacidade">Política de Privacidade<\/a> \(versão atual, 1\.0\)/, '404 lista a publicada atual');
  assert.equal(legalNotFound('/privacidade/v1.1/', extra).status, 404);
  assert.equal(legalNotFound('/privacidade/v1.0', extra), null);
  assert.equal(legalNotFound('/privacidade/v1.0/', extra), null, 'barra final da publicada é redirect');

  const redirects = redirecionamentosLegais(extra);
  assert.equal(redirects.get('/privacidade/v1.0/'), '/privacidade/v1.0');
  assert.equal(redirects.get('/termos/v1.0/'), '/termos/v1.0');
  assert.equal(redirects.has('/privacidade/v1.1/'), false, 'barra final só para publicadas');

  // A versão em rascunho só é renderizada explicitamente (preview).
  const rascunho = renderDocumento('privacidade', '1.1', ORIGIN, extra);
  assert.equal(rascunho.rascunho, true);
  assert.match(rascunho.html, /texto privacidade 1\.1/);
  assert.match(rascunho.html, /<a href="\/privacidade\/v1\.0">1\.0<span [^>]*>, abrir cópia arquivada<\/span><\/a>[\s\S]*<th scope="row">1\.1<\/th>/, 'rascunho sem link no histórico');
  assert.doesNotMatch(renderDocumento('privacidade', '1.0', ORIGIN, extra).html, /1\.1/, 'cópia congelada não cita versões posteriores');
});

test('sem nenhuma versão publicada, a atual é a última em rascunho e legalFiles tem 2 entradas (C1)', () => {
  const item = (versao) => ({ versao, vigencia: null, atualizacao: null, resumo: `Versão ${versao}.`, juridico: '1.0' });
  const versoes = { privacidade: [item('1.0'), item('1.1')], termos: [item('1.0')] };
  const extra = { ...fontes(), versoes, conteudo: (documento, versao) => fragmento(`<p>texto ${versao}</p>`) };
  const entradas = new Map(legalFiles(ORIGIN, extra));
  assert.deepEqual([...entradas.keys()], ['/privacidade', '/termos']);
  assert.match(entradas.get('/privacidade')[1], /texto 1\.1/, 'última em rascunho');
  assert.equal(entradas.get('/privacidade')[2]['X-Robots-Tag'], 'noindex');
  assert.equal(legalNotFound('/privacidade/v1.0', extra).status, 404);
  assert.match(legalNotFound('/privacidade/v1.0', extra).body, /\(versão atual, 1\.1\)/);
  assert.deepEqual([...redirecionamentosLegais(extra).keys()], ['/privacy', '/privacidade/', '/terms', '/termos/']);
  const item2 = (versao, vigencia) => ({ ...item(versao), vigencia });
  assert.throws(() => legalFiles(ORIGIN, { ...fontes(), versoes: { privacidade: [item2('1.1', null), item2('1.0', null)], termos: [item('1.0')] } }),
    /ordem crescente/);
});

test('conteúdo real do repositório renderiza publicado (v1.0 final), com dados reais e todos os trechos jurídicos', () => {
  const entradas = new Map(legalFiles('https://pia.travelrpg.com'));
  assert.deepEqual([...entradas.keys()], ['/privacidade', '/privacidade/v1.0', '/termos', '/termos/v1.0'], 'v1.0 publicada: atuais e cópias congeladas');
  const privacidade = entradas.get('/privacidade')[1];
  const termos = entradas.get('/termos')[1];
  assert.match(privacidade, /<link rel="canonical" href="https:\/\/pia\.travelrpg\.com\/privacidade">/);
  assert.match(privacidade, /Diogo Passos Perdigão Britto/);
  assert.match(privacidade, /contato@travelrpg\.com/);
  assert.match(termos, /comarca de Belo Horizonte\/MG/);
  const ambos = privacidade + termos;
  for (const [chave, trecho] of Object.entries(JURIDICO['1.0'])) {
    assert.equal(trecho.revisado, true, `${chave} aprovado no parecer final (release legal v1.0)`);
    if (chave === 'AVISO_GRAVACAO_DISCORD') continue; // só no embed do Discord (F2-10)
    assert.ok(ambos.includes(escapeHtml(renderTokens(trecho.texto, DADOS))), `${chave} usado em alguma página`);
  }
  const corpo = (html) => html.slice(html.indexOf('<h2 id="em-resumo">'), html.indexOf('<h2 id="historico-de-versoes"'));
  for (const documento of ['privacidade', 'termos']) {
    const atual = corpo(entradas.get(`/${documento}`)[1]);
    assert.ok(atual.length > 1000);
    assert.equal(atual, corpo(entradas.get(`/${documento}/v1.0`)[1]), `/${documento} serve o mesmo texto da cópia congelada v1.0`);
  }
  for (const [, html, headers] of entradas.values()) {
    assert.deepEqual(headers, { 'Cache-Control': 'public, max-age=3600' }, 'publicado: cache público, sem noindex');
    assert.doesNotMatch(html, /noindex|RASCUNHO|legal-pendente|\[/, 'sem selos nem faixa de rascunho');
  }
  for (const valor of Object.values(DADOS)) assert.equal(typeof valor, 'string');
  assert.ok(!/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(ambos), 'sem CPF');
});

test('legalRedirects mapeia aliases e barra final para o caminho canônico relativo', () => {
  assert.equal(legalRedirects.get('/privacy'), '/privacidade');
  assert.equal(legalRedirects.get('/privacidade/'), '/privacidade');
  assert.equal(legalRedirects.get('/terms'), '/termos');
  assert.equal(legalRedirects.get('/termos/'), '/termos');
  assert.equal(legalRedirects.get('/privacidade/v1.0/'), '/privacidade/v1.0', 'v1.0 publicada: barra final redireciona');
  assert.equal(legalRedirects.get('/termos/v1.0/'), '/termos/v1.0');
  assert.equal(legalRedirects.has('/privacidade/v1.1/'), false, 'versão inexistente não tem redirect');
  assert.equal(legalRedirects.has('/privacidade'), false);
  for (const destino of legalRedirects.values()) assert.match(destino, /^\/(privacidade|termos)(\/v\d+\.\d+)?$/);
});

test('legalNotFound devolve 404 HTML só para /privacidade/* e /termos/* desconhecidos', () => {
  const res = legalNotFound('/termos/v9.9');
  assert.equal(res.status, 404);
  assert.equal(res.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.match(res.body, /<html lang="pt-BR">/);
  assert.equal((res.body.match(/<meta name="robots" content="noindex">/g) || []).length, 1);
  assert.doesNotMatch(res.body, /rel="canonical"|RASCUNHO/);
  assert.equal(legalNotFound('/termos/v1.0'), null, 'v1.0 publicada tem rota própria (200 no legalFiles)');
  assert.equal(legalNotFound('/privacidade/v1.0'), null);
  assert.equal(legalNotFound('/termos/v1.0/'), null, 'barra final da publicada é redirect');
  assert.match(res.body, /\(versão atual, 1\.0\)/);
  assert.equal((res.body.match(/<h1\b/g) || []).length, 1);
  assert.match(res.body, /<a href="\/privacidade">Política de Privacidade<\/a>/);
  assert.match(res.body, /<a href="\/termos">Termos de Serviço<\/a>/);
  const xss = legalNotFound('/privacidade/<script>alert(1)</script>');
  assert.equal(xss.status, 404);
  assert.doesNotMatch(xss.body, /alert/);
  for (const caminho of ['/', '/api/x', '/privacidade', '/termos', '/privacidadex', '/privacy']) {
    assert.equal(legalNotFound(caminho), null, caminho);
  }
});

test('legalFooter tem os dois links relativos e o texto de ciência opcional', () => {
  const rodape = legalFooter();
  assert.match(rodape, /^<p class="pia-legal-footer pia-legal-footer--server pia-legal-footer--links"><a href="\/privacidade">Política de Privacidade<\/a> <a href="\/termos">Termos de Serviço<\/a><\/p>$/);
  assert.doesNotMatch(rodape, /Ao continuar/);
  assert.match(legalFooter({ ciencia: true }),
    /Ao continuar, você concorda com os <a href="\/termos">Termos de Serviço<\/a> e declara ter lido a <a href="\/privacidade">Política de Privacidade<\/a>\./);
});

test('pendencias lista trechos sem revisão e datas nulas', () => {
  // Feature 0004: as únicas pendências reais são as da v1.1 em rascunho (trechos novos ou alterados do conjunto '1.1'
  // e as datas nulas da 1.1). Nada da v1.0 publicada aparece.
  const reais = pendencias();
  assert.ok(reais.every((p) => (p.tipo === 'juridico' && p.conjunto === '1.1') || (p.tipo === 'data' && p.versao === '1.1')),
    JSON.stringify(reais));
  assert.deepEqual(reais.filter((p) => p.tipo === 'juridico').map((p) => p.chave),
    Object.entries(JURIDICO['1.1']).filter(([, t]) => !t.revisado).map(([chave]) => chave));
  assert.deepEqual(reais.filter((p) => p.tipo === 'data').map((p) => `${p.documento} ${p.versao} ${p.campo}`),
    ['privacidade 1.1 vigencia', 'privacidade 1.1 atualizacao', 'termos 1.1 vigencia', 'termos 1.1 atualizacao']);
  // Mesmo conteúdo real em estado de rascunho (fixture): todos os trechos e todas as datas aparecem.
  const juridicoRascunho = Object.fromEntries(Object.entries(JURIDICO).map(([conjunto, trechos]) =>
    [conjunto, Object.fromEntries(Object.entries(trechos).map(([chave, t]) => [chave, { ...t, revisado: false }]))]));
  const versoesRascunho = Object.fromEntries(Object.entries(VERSOES).map(([documento, lista]) =>
    [documento, lista.map((item) => ({ ...item, vigencia: null, atualizacao: null, sha256: null }))]));
  const lista = pendencias({ juridico: juridicoRascunho, versoes: versoesRascunho });
  const juridicos = lista.filter((p) => p.tipo === 'juridico').map((p) => p.chave);
  assert.deepEqual(juridicos, [...Object.keys(JURIDICO['1.0']), ...Object.keys(JURIDICO['1.1'])]);
  const datas = lista.filter((p) => p.tipo === 'data');
  const esperadas = Object.values(VERSOES).flat().length * 2;
  assert.equal(datas.length, esperadas);
  assert.deepEqual(pendencias(fontes()), []);
  assert.deepEqual(pendencias(fontes({ revisado: false, datas: false })).map((p) => p.tipo), ['juridico', 'data', 'data', 'data', 'data']);
});

function importsDe(arquivo, vistos = new Set()) {
  if (vistos.has(arquivo.href)) return vistos;
  vistos.add(arquivo.href);
  const fonte = readFileSync(arquivo, 'utf8');
  for (const [, alvo] of fonte.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (alvo?.startsWith('.')) importsDe(new URL(alvo, arquivo), vistos);
  }
  return vistos;
}

test('src/legal.js não importa db.js (nem auth.js), direta ou indiretamente (T05, CA19)', () => {
  const grafo = [...importsDe(new URL('../src/legal.js', import.meta.url))];
  assert.ok(grafo.some((href) => href.endsWith('/src/legal/dados.js')));
  assert.ok(!grafo.some((href) => /\/src\/(db|auth)\.js$/.test(href)), grafo.join('\n'));
  const env = { PATH: process.env.PATH };
  const script = "import('./src/legal.js').then((m) => { const f = m.legalFiles('https://pia.example'); process.stdout.write(String(f.length)); })";
  const saida = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('..', import.meta.url), env, encoding: 'utf8',
  });
  assert.equal(saida, '4', '/privacidade, /privacidade/v1.0, /termos e /termos/v1.0');
});

// ── F2-02: conteúdo da v1.0 (DevFullstack Time 2) ─────────────────────────────────────────────
// Presença das seções e dos termos obrigatórios (CA05 a CA10, CA21, CA27) no HTML renderizado
// pelo src/legal.js, com tokens de dados e trechos jurídicos já substituídos.

const fragmentoReal = (documento) =>
  readFileSync(new URL(`../src/legal/conteudo/${documento}-v1.0.html`, import.meta.url), 'utf8');
const paginaReal = (documento) => renderDocumento(documento, '1.0', 'https://pia.travelrpg.com').html;
// Texto visível sem tags e sem os selos de rascunho, para conferir frases.
const textoVisivel = (html) => html
  .replace(/<span class="legal-pendente">\[[^\]]*\]<\/span>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');
const secaoDe = (html, id) => {
  const inicio = html.indexOf(`<h2 id="${id}">`);
  assert.ok(inicio >= 0, `seção ${id} ausente`);
  const fim = html.indexOf('<h2 ', inicio + 1);
  return textoVisivel(html.slice(inicio, fim < 0 ? undefined : fim));
};

const SECOES_PRIVACIDADE = [
  ['quem-somos', '1. Quem somos, controlador e contato'],
  ['escopo', '2. Escopo'],
  ['dados-coletados', '3. Dados coletados'],
  ['finalidades', '4. Finalidades'],
  ['bases-legais', '5. Bases legais'],
  ['compartilhamento', '6. Compartilhamento e terceiros'],
  ['transferencia-internacional', '7. Transferência internacional'],
  ['retencao', '8. Retenção, sem garantia de hospedagem'],
  ['seguranca', '9. Segurança'],
  ['direitos-do-titular', '10. Direitos do titular'],
  ['cookies', '11. Cookies e armazenamento local'],
  ['menores', '12. Menores de idade'],
  ['mudancas', '13. Mudanças nesta Política'],
  ['contato', '14. Contato'],
];
const SECOES_TERMOS = [
  ['aceitacao', '1. Aceitação'],
  ['descricao-do-servico', '2. Descrição do serviço'],
  ['conta-e-elegibilidade', '3. Conta e elegibilidade'],
  ['uso-aceitavel', '4. Uso aceitável'],
  ['conteudo-e-licenca', '5. Conteúdo do usuário e licença'],
  ['conteudo-gerado-por-ia', '6. Conteúdo gerado por IA e serviços de terceiros'],
  ['isencao-de-garantias', '7. Isenção de garantias'],
  ['limitacao-de-responsabilidade', '8. Limitação de responsabilidade'],
  ['disponibilidade-e-perda-de-dados', '9. Disponibilidade e perda de dados'],
  ['suspensao-e-encerramento', '10. Suspensão e encerramento'],
  ['mudancas-nos-termos', '11. Mudanças nos Termos'],
  ['lei-e-foro', '12. Lei aplicável e foro'],
  ['contato', '13. Contato'],
];

function assertSecoes(documento, secoesEsperadas) {
  const ids = [...fragmentoReal(documento).matchAll(/<h2 id="([a-z0-9-]+)">([^<]*)<\/h2>/g)].map(([, id, titulo]) => [id, titulo]);
  assert.deepEqual(ids, secoesEsperadas, `seções de ${documento} fora da ordem, faltando ou com outro título`);
  const html = paginaReal(documento);
  for (const [id] of secoesEsperadas) assert.match(html, new RegExp(`<li><a href="#${id}">`), `sumário com âncora #${id}`);
}

test('F2-02: Política tem as 14 seções da 6.1, na ordem, no sumário (CA06)', () => {
  assertSecoes('privacidade', SECOES_PRIVACIDADE);
});

test('F2-02: Termos têm as 13 seções da 6.2, na ordem, no sumário (CA10)', () => {
  assertSecoes('termos', SECOES_TERMOS);
});

test('F2-02: fragmentos v1.0 sem marcador pendente, colchete, script ou recurso externo', () => {
  for (const documento of ['privacidade', 'termos']) {
    const bruto = fragmentoReal(documento).replace(/<!--(?!\s*\/?legal:)[\s\S]*?-->/g, '');
    assert.doesNotMatch(bruto, /\[|TEXTO PENDENTE|TODO|XXX|lorem|example\.invalid/i);
    assert.doesNotMatch(bruto, /<script|<style|<img|<link|<iframe|\son[a-z]+=/i);
    const externos = [...bruto.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]);
    const permitidos = ['https://developers.google.com/terms/api-services-user-data-policy', 'https://developers.google.com/workspace/workspace-api-user-data-developer-policy'];
    assert.ok(externos.every((url) => permitidos.includes(url)), externos.join(', '));
  }
});

test('F2-02: Em resumo traz as quatro premissas nos dois documentos (RN01, CA05)', () => {
  for (const documento of ['privacidade', 'termos']) {
    const html = paginaReal(documento);
    const bloco = html.slice(html.indexOf('<h2 id="em-resumo">'), html.indexOf('<nav class="legal-sumario"'));
    const resumo = textoVisivel(bloco);
    assert.match(resumo, /gratuita/);
    assert.match(resumo, /em desenvolvimento/);
    assert.match(resumo, /sem garantias/);
    assert.match(resumo, /treinar modelos de IA e melhorar o serviço/);
    assert.match(resumo, /retenção nem (a )?(de )?disponibilidade/);
  }
});

test('F2-02: Em resumo da Política exclui do treinamento os dados do Google e da Microsoft', () => {
  const html = paginaReal('privacidade');
  const resumo = textoVisivel(html.slice(html.indexOf('<h2 id="em-resumo">'), html.indexOf('<nav class="legal-sumario"')));
  assert.match(resumo, /Dados das APIs do Google e da sua conta Microsoft ficam de fora\./);
});

test('F2-02: dados coletados cobrem o CA06 da v1.0 e a mídia segue a RN11', () => {
  const secao = secaoDe(paginaReal('privacidade'), 'dados-coletados');
  for (const termo of [
    /Conversas \(chats\) sincronizadas/,
    /E-mail, identificador da conta Google e endereço da foto/,
    /Credenciais e tokens das integrações/,
    /Gmail e do seu Google Agenda/,
    /Gravações de voz do Discord/,
    /inclusive de outros participantes que não usam a PIA \(terceiros\)/,
    /computadores pareados/,
    /Cookies de sessão/,
    /músicas geradas no PC \(MP3\/WAV, pelo Gemini ou localmente\) e as capturas de tela salvas no PC são enviadas, por meio da PIA Server, para a pasta da PIA no seu Google Drive/,
    /A PIA Server não guarda o arquivo: ele fica numa pasta temporária só durante o envio e é apagado ao final/,
    /O servidor mantém apenas metadados/,
    /não garantimos que o envio aconteça nem que a cópia exista/,
    /A PIA guarda registros de acesso com o seu endereço IP/,
  ]) assert.match(secao, termo);
  const retencao = secaoDe(paginaReal('privacidade'), 'retencao');
  assert.match(retencao, /Não garantimos a retenção nem a disponibilidade dos dados/);
  assert.match(retencao, /A PIA Server não guarda arquivos de áudio nem de imagem/);
  assert.match(retencao, /podem não permitir a remoção individual desses dados/);
  // Adendo 2, 5.3 (obrigatório): seis itens, nesta ordem; o 2º (prazo de 15 dias, confirmado pelo Diogo) é o trecho EXCLUSAO_CONTA_PRAZO, revisado:true desde o release legal v1.0.
  const itens53 = ["Os dados da sua conta (perfil, conversas e configurações sincronizadas, conectores, computadores pareados, avisos da Secretária e metadados de mídia) ficam guardados enquanto a conta existir.", "Quando você pede a exclusão da conta pelo e-mail contato@travelrpg.com, apagamos esses dados do servidor, inclusive as gravações pendentes de envio, em até 15 dias contados do pedido. Não há cópia de segurança (backup) do banco de dados, então nenhuma cópia desses dados fica guardada depois da exclusão.", "Enquanto a conta existe, o servidor guarda apenas metadados das mídias enviadas ao seu Drive (identificador, tipo, tamanho, data e identificador do arquivo no Drive), para listar e localizar essas cópias. Esses metadados são apagados junto com a conta.", "As cópias na pasta da PIA no seu Google Drive e os dados guardados no seu computador não são apagados pela exclusão da conta: ficam com você, sob o seu controle e as regras da sua conta Google. Apague-os você mesmo, se quiser.", "Os registros de acesso com endereço IP e a lista de endereços bloqueados pela ferramenta de segurança (seção 3) não fazem parte da conta e não são apagados com ela. Eles são mantidos pelo tempo necessário para segurança e prevenção de abuso, com base no legítimo interesse do controlador.", "Dados que já tenham sido usados para treinar um modelo podem não ser removíveis desse modelo (veja o item sobre dados já treinados, abaixo)."];
  let pos = -1;
  for (const item of itens53) {
    const i = retencao.indexOf(item);
    assert.ok(i > pos, `5.3 fora de ordem ou ausente: ${item.slice(0, 60)}`);
    pos = i;
  }
  assert.ok(retencao.indexOf(itens53[5]) < retencao.indexOf('Não garantimos a retenção'), 'os três itens fixos e REMOCAO_DADOS_TREINADOS vêm depois');
  assert.equal(JURIDICO['1.0'].EXCLUSAO_CONTA_PRAZO.revisado, true, 'trecho jurídico aprovado no parecer final (release legal v1.0)');
  assert.ok(retencao.includes(renderTokens(JURIDICO['1.0'].EXCLUSAO_CONTA_PRAZO.texto, DADOS)), 'EXCLUSAO_CONTA_PRAZO sem selo na Retenção');
  assert.doesNotMatch(retencao, /pelo prazo da frase acima/);
  // Adendo 2, F.2: última frase da 4.9 só com o compromisso de não identificar o titular (v3.1, 0.0, item 3).
  assert.match(retencao, /Nesse caso, não usamos esses modelos para identificar você\. /);
  assert.doesNotMatch(retencao, /reproduzir intencionalmente|substituídos à medida/);
  assert.doesNotMatch(retencao, /enquanto forem úteis|Cópias de segurança do banco|30 dias/);
  // Adendo 2, tabela D: base legal dos registros de acesso (obrigatório) e menções em Finalidades e Segurança.
  assert.match(secaoDe(paginaReal('privacidade'), 'bases-legais'), new RegExp("legítimo interesse do controlador (inciso IX), para segurança, prevenção de abuso e diagnóstico de falhas, inclusive os registros de acesso com endereço IP, e exercício regular de direitos em processo judicial, administrativo ou arbitral (inciso VI), quando necessário;".replace(/[.*+?^${}()|\\[\]\\]/g, '\\$&')));
  assert.match(secaoDe(paginaReal('privacidade'), 'finalidades'), /inclusive com registros de acesso que contêm o seu endereço IP \(seção 3\)/);
  assert.match(secaoDe(paginaReal('privacidade'), 'seguranca'), /Os registros de acesso são analisados por uma ferramenta automática de segurança, que bloqueia endereços IP com comportamento abusivo\./);
});

test('F2-02: Caminho A do parecer: só texto no treinamento; voz, MP3 e terceiros fora (4.2, 4.4, 4.5, 5.1, 5.2)', () => {
  const html = paginaReal('privacidade');
  const finalidades = secaoDe(html, 'finalidades');
  assert.match(finalidades, /conversas, prompts e outros conteúdos de texto que você envia podem ser usados para treinar modelos e melhorar a PIA/);
  assert.match(finalidades, /Hoje a PIA não guarda cópia das músicas geradas \(MP3\/WAV\) nem das gravações de voz e, por isso, não as usa para treinar modelos\./);
  assert.match(finalidades, /exceto trechos de e-mails, eventos, arquivos ou outros conteúdos obtidos do Google ou da Microsoft que apareçam nessas conversas, que são excluídos antes de qualquer treinamento/);
  assert.match(finalidades, /Credenciais e tokens nunca são usados em treinamento/);
  const resumo = textoVisivel(html.slice(html.indexOf('<h2 id="em-resumo">'), html.indexOf('<nav class="legal-sumario"')));
  assert.match(resumo, /Seus dados de texto, como conversas e prompts, podem ser usados para treinar modelos de IA e melhorar o serviço ?\. Gravações de voz e músicas geradas não são usadas em treinamento hoje\./);
  const dados = secaoDe(html, 'dados-coletados');
  assert.match(dados, /As gravações de voz de todos os participantes, inclusive de pessoas que não usam a PIA \(terceiros\), servem apenas para entregar a gravação a quem a configurou, na pasta da PIA no Google Drive dessa pessoa\. Nenhuma gravação de voz é usada para treinar modelos de IA\./);
  // TREINAMENTO_MP3_GERADOS: uma vez na Política (Finalidades) e duas nos Termos (Em resumo e licença).
  const textoMp3 = escapeHtml(renderTokens(JURIDICO['1.0'].TREINAMENTO_MP3_GERADOS.texto, DADOS));
  assert.equal(html.split(textoMp3).length - 1, 1);
  const termos = paginaReal('termos');
  assert.equal(termos.split(textoMp3).length - 1, 2);
  assert.doesNotMatch(fragmentoReal('termos').replace(/\{\{[A-Z0-9_]+\}\}/g, ''), /MP3/, 'MP3 nos Termos só pelo token');
  const resumoTermos = textoVisivel(termos.slice(termos.indexOf('<h2 id="em-resumo">'), termos.indexOf('<nav class="legal-sumario"')));
  assert.match(resumoTermos, /seus conteúdos de texto, como conversas e prompts, podem ser usados para treinar modelos de IA e melhorar o serviço ?, e você pode pedir que deixem de ser usados\. Hoje a PIA não guarda cópia/);
  const licenca = secaoDe(termos, 'conteudo-e-licenca');
  assert.match(licenca, /licença gratuita, não exclusiva, mundial/);
  assert.match(licenca, /hospedar e processar esse conteúdo e usar conteúdos de texto no treinamento de modelos de IA e na melhoria do serviço ?\. Hoje a PIA não guarda cópia/);
  assert.match(licenca, /Você declara ter os direitos sobre o que envia e se compromete a avisar os participantes antes de gravar\./);
  assert.match(secaoDe(termos, 'uso-aceitavel'), /quem configura a gravação deve informar os participantes antes de começar e respeitar quem não quiser ser gravado;/);
  // Nada no texto renderizado pode dizer que voz, terceiros ou MP3 entram no treinamento.
  for (const pagina of [html, termos]) {
    const texto = textoVisivel(pagina);
    assert.doesNotMatch(texto, /vozes de terceiros, podem ser usadas para treinamento|também são usadas para treinamento|inclusive as gravações de voz do Discord \(também as de terceiros\)|Isso inclui as gravações de voz/);
    assert.doesNotMatch(texto, /músicas que você gera ou envia à PIA podem ser usados/);
    assert.ok(!texto.includes('Este canal está sendo gravado pela PIA'), 'AVISO_GRAVACAO_DISCORD é só do embed');
  }
});

test('F2-02: compartilhamento, Limited Use e transferência internacional (CA07, CA09)', () => {
  const html = paginaReal('privacidade');
  const comp = secaoDe(html, 'compartilhamento');
  for (const t of ['Google', 'Microsoft', 'Discord', 'Taverns', 'Gemini', 'Groq', 'hospedagem']) assert.match(comp, new RegExp(t));
  assert.match(comp, /Não vendemos dados pessoais/);
  assert.match(comp, /Google API Services User Data Policy/);
  assert.match(comp, /Limited Use/);
  // Adendo 4, 5.9: texto exato (rótulo e lista no HTML, o resto no trecho PROVEDORES_LLM, revisado:true desde o release legal v1.0) e sem a frase antiga.
  assert.ok(comp.includes("Provedores de LLM escolhidos por você: Gemini, Groq ou Ollama local. Quando o assistente lê o seu Gmail, Google Drive, Google Agenda ou dados da sua conta Microsoft para atender a um pedido seu, ele envia ao provedor de modelo de linguagem que você escolheu o conteúdo necessário para gerar a resposta. A chave de API e a conta no Gemini ou na Groq são suas: você as cria no site do provedor e as cadastra na PIA. A PIA não usa esse conteúdo para treinar os próprios modelos. O que o provedor faz com o conteúdo depende dos termos da conta que você usa nele, que são aceitos por você diretamente com esse provedor. Na camada gratuita do Gemini, por exemplo, o Google pode usar o conteúdo enviado para melhorar os produtos dele, inclusive com revisão humana. Pelos termos do próprio Google, isso não ocorre na camada paga, e o Ollama roda no seu próprio computador. Antes de usar a PIA com Gmail, Drive, Agenda ou Microsoft, confira os termos do provedor de IA escolhido. Se não quiser que esse conteúdo possa ser usado pelo provedor, use uma camada paga ou o Ollama local. Esse conteúdo não é guardado pela PIA além do histórico da conversa, que fica no seu computador e, se você usar o perfil compartilhado, é sincronizado de forma cifrada com a PIA Server."), '5.9 do Adendo 2');
  assert.doesNotMatch(comp, /Esses provedores podem usar os dados conforme os próprios termos/);
  // CA28 (Adendo 4): a 5.9 renderizada não promete que os provedores não treinam com o conteúdo.
  const item59 = comp.slice(comp.indexOf('Provedores de LLM escolhidos por você'), comp.indexOf('Provedores de LLM escolhidos por você') + 1500);
  assert.doesNotMatch(item59, /não permite que (ele |esse conteúdo )?seja usad|não permite que (o provedor|os provedores)|treinar modelos e não permite|apenas o necessário para gerar a resposta|provedores? não (usa|usam|treina|treinam)/i);
  assert.match(item59, /A PIA não usa esse conteúdo para treinar os próprios modelos\. O que o provedor faz com o conteúdo depende dos termos da conta que você usa nele/);
  assert.equal(JURIDICO['1.0'].PROVEDORES_LLM.revisado, true, 'PROVEDORES_LLM aprovado no parecer final');
  assert.match(comp, /não são usados para treinar modelos de IA generalizados/);
  // Parecer final, F.4.1: linha fixa da seção 6, com remissão ao item dos provedores de LLM, que vem antes dela na página.
  assert.ok(comp.includes('Dados obtidos pelas APIs do Google (Gmail, Agenda, Drive e perfil) não são usados para treinar modelos de IA generalizados pela PIA. O que o provedor de IA escolhido por você faz com o conteúdo enviado a ele está explicado no item sobre os provedores de LLM, acima.'), 'F.4.1');
  assert.ok(comp.indexOf('Provedores de LLM escolhidos por você') < comp.indexOf('está explicado no item sobre os provedores de LLM, acima'), 'item dos provedores de LLM fica acima');
  // CA28 (parecer final, F.4): nenhuma afirmação absoluta, na voz passiva, de que dados do Google ou da Microsoft não são usados para treinar.
  for (const nome of ['privacidade', 'termos']) {
    const texto = textoVisivel(paginaReal(nome));
    assert.doesNotMatch(texto, /Dados obtidos pelas APIs do Google, inclusive os derivados deles, não são usados|Dados obtidos da sua conta Microsoft \(e-mails, agenda e arquivos, via Microsoft Graph\) não são usados|modelos de IA generalizados\./, `F.4: ${nome}`);
  }
  assert.match(comp, /não são lidas de volta do Drive para treinar modelos/);
  // Parecer final, F.4.2: o compromisso é da PIA (sem voz passiva absoluta).
  assert.match(comp, /A PIA não usa dados obtidos pelas APIs do Google, inclusive os derivados deles, para criar, treinar ou melhorar modelos de IA\./);
  assert.match(html, /<a href="https:\/\/developers\.google\.com\/terms\/api-services-user-data-policy" rel="noreferrer">/);
  // Parecer 5.9: link da Google Workspace User Data and Developer Policy (URL oficial conferida com HTTP 200).
  assert.match(html, /<a href="https:\/\/developers\.google\.com\/workspace\/workspace-api-user-data-developer-policy" rel="noreferrer">Google Workspace User Data and Developer Policy<\/a>/);
  const transf = secaoDe(html, 'transferencia-internacional');
  // Adendo 4, seção 7: HOSPEDAGEM_TEXTO e 2º parágrafo finais (servidor e banco no Brasil; CrowdSec entre os provedores).
  assert.ok(transf.includes('A hospedagem da PIA Server fica no Brasil, onde ficam o servidor e o banco de dados com os dados pessoais da sua conta; a PIA não contrata armazenamento de mídia fora do país, e as mídias, como imagens e áudios, ficam no armazenamento que você conecta, que pode estar fora do Brasil.'), 'HOSPEDAGEM_TEXTO do Adendo 2');
  assert.ok(transf.includes("Os provedores de integração, de inteligência artificial e de segurança, como Google, Microsoft, Discord, Groq e CrowdSec, podem tratar dados no exterior. Os detalhes estão logo abaixo. Não há garantia de hospedagem, de retenção nem de disponibilidade dos dados (veja a seção Retenção)."), '2º parágrafo da seção 7 do Adendo 2');
  assert.doesNotMatch(transf, /principalmente no Brasil/);
  assert.match(transf, /art\. 33/);
  // Adendo 2 do parecer (4.8 nova): sem país, com a transcrição de voz e com a frase do CrowdSec do Adendo 4 antes da frase do contato (CrowdSec ligado, decisão do Diogo).
  assert.ok(transf.includes("Transferência internacional de dados. Os dados pessoais guardados no servidor e no banco de dados da PIA, como a sua conta, as conversas e configurações sincronizadas e os metadados, ficam no Brasil. Outros dados, como imagens e áudios, inclusive gravações de voz, que também são dados pessoais, podem ficar ou ser tratados fora do Brasil. Para que o serviço funcione, alguns dados passam por fornecedores que podem tratá-los no exterior. O Google faz o login, recebe as suas mídias no seu Google Drive e dá acesso ao Gmail e à Agenda quando você conecta essas integrações. A Microsoft dá acesso a e-mail, agenda e arquivos quando você conecta essa integração. O Gemini, do Google, e a Groq processam as mensagens e, quando você usa a transcrição de voz, o áudio a transcrever, por modelos de linguagem. O Discord transmite o áudio das chamadas de voz gravadas pelo bot. As mídias, como imagens e áudios, ficam na conta de armazenamento que você mesmo conecta, como o seu Google Drive ou o Object Storage que você configura, e podem estar fora do Brasil, conforme as regras desse provedor. A PIA não contrata armazenamento de mídia fora do país. Essas transferências acontecem porque são necessárias para prestar o serviço que você pediu, nos termos do art. 33, inciso IX, combinado com o art. 7º, inciso V, da LGPD. Cada fornecedor trata os dados conforme os próprios termos de uso e políticas de privacidade, publicados em seus sites. A ferramenta de segurança do servidor (CrowdSec) envia ao fornecedor dela, que pode tratá-los no exterior, os endereços IP que tentaram abusar do serviço, com a data, a hora e o tipo de ataque, para manter uma lista compartilhada de endereços maliciosos. Esse envio tem como base o legítimo interesse em proteger o serviço e segue as garantias previstas nos termos desse fornecedor. Se quiser saber mais sobre essas transferências, escreva para contato@travelrpg.com."), 'texto exato do Adendo 2 na seção 7');
  assert.ok(transf.includes('segue as garantias previstas nos termos desse fornecedor. Se quiser saber mais'), 'frase do CrowdSec do Adendo 4 antes do contato');
  assert.doesNotMatch(transf, /art\. 33, inciso II/);
  for (const pagina of [paginaReal('privacidade'), paginaReal('termos')]) {
    assert.doesNotMatch(textoVisivel(pagina), /nenhum dado pessoal sai do Brasil/i, 'adendo, observação 1');
  }
  assert.match(textoVisivel(paginaReal('termos')), /Limited Use/);
  // Adendo 3 (O9 do QA): nenhuma página renderizada traz a frase ambígua sobre as vozes de terceiros.
  for (const nome of ['privacidade', 'termos']) assert.doesNotMatch(textoVisivel(paginaReal(nome)), /vozes de quem não usa a PIA não são usadas/i);
  assert.doesNotMatch(JURIDICO['1.0'].AVISO_GRAVACAO_DISCORD.texto, /vozes de quem não usa a PIA não são usadas/i);
  // CA28: nenhuma página renderizada nega a guarda de IP, cita país dos fornecedores, prazo de 6 meses ou diz que nenhum dado sai do Brasil.
  for (const nome of ['privacidade', 'termos']) {
    const texto = textoVisivel(paginaReal(nome));
    assert.doesNotMatch(texto, /não guarda[^.]{0,120}\bIP\b|\bIP\b[^.]{0,120}não guarda/i, `CA28: ${nome} diz que não guarda IP`);
    assert.doesNotMatch(texto, /Estados Unidos|\bEUA\b|6 meses|seis meses|nenhum dado pessoal sai do Brasil/i, `CA28: ${nome}`);
  }
});

test('F2-02: direitos do titular com art. 18, e-mail, prazo, opt-out e ANPD, sem exclusão automática (CA08, RN08)', () => {
  const secao = secaoDe(paginaReal('privacidade'), 'direitos-do-titular');
  assert.match(secao, /art\. 18 da LGPD/);
  for (const d of [/acesso/, /correção/, /anonimização, bloqueio ou eliminação/, /portabilidade/, /compartilhamos/, /revogação do consentimento/, /oposição/]) assert.match(secao, d);
  assert.match(secao, /contato@travelrpg\.com/);
  assert.match(secao, /enviamos uma resposta simplificada imediatamente/);
  assert.match(secao, /Os demais pedidos são respondidos em até 15 dias contados do recebimento\./);
  assert.match(secao, /O atendimento é gratuito\./);
  assert.match(secao, /com o assunto 'Opt-out de treinamento', a partir do e-mail da sua conta/);
  assert.match(secao, /Basta enviar um e-mail para contato@travelrpg\.com/);
  assert.match(secao, /informando o servidor, o canal, a data aproximada da gravação e o seu nome de usuário no Discord/);
  assert.match(secao, /Agência Nacional de Proteção de Dados \(ANPD\)/);
  assert.doesNotMatch(secao, /Autoridade Nacional/);
  assert.match(secao, /feitas manualmente/);
  assert.doesNotMatch(paginaReal('privacidade'), /exclusão automática/i);
});

test('F2-02: controlador, DPO, cifragem honesta, cookies e sem CPF (6.1 itens 1, 9, 11)', () => {
  const texto = textoVisivel(paginaReal('privacidade'));
  assert.match(texto, /controlador e responsável .* Diogo Passos Perdigão Britto/);
  assert.match(texto, /Encarregado \(DPO\): Diogo Passos Perdigão Britto, pelo contato@travelrpg\.com/);
  assert.match(texto, /O encarregado atua como canal de comunicação entre o controlador, os titulares dos dados e a Agência Nacional de Proteção de Dados \(ANPD\)/);
  assert.doesNotMatch(texto, /pequeno porte|Resolução CD\/ANPD/, 'sem invocar a dispensa de pequeno porte (decisão do Diogo, parecer 4.1)');
  assert.match(texto, /A cifragem não é ponta a ponta/);
  assert.doesNotMatch(texto, /criptografia ponta a ponta/i);
  assert.match(texto, /__Host-pia_session/);
  assert.match(texto, /pia_oauth/);
  assert.doesNotMatch(texto, /CPF/);
});

test('F2-02: Termos com garantias, responsabilidade com ressalva, perda de dados, lei e foro (CA10)', () => {
  const texto = textoVisivel(paginaReal('termos'));
  assert.match(texto, /"no estado em que se encontra" e "conforme disponível"/);
  assert.match(texto, /não respondem por danos indiretos/);
  assert.match(texto, /Código de Defesa do Consumidor/);
  assert.match(texto, /Não há garantia de hospedagem, retenção, backup/);
  assert.match(texto, /lei brasileira/);
  assert.match(texto, /foro da comarca de Belo Horizonte\/MG, ressalvado o foro do domicílio do consumidor quando a lei garantir/);
  assert.match(texto, /por convite/);
  assert.match(texto, /quem configura a gravação deve informar os participantes/);
  assert.match(texto, /As limitações acima não se aplicam a danos causados por dolo ou culpa grave/);
  // Parecer 5.6 (mudanças). A 5.7 (aviso de 30 dias antes de encerrar o serviço) não entra, por decisão do Diogo.
  assert.doesNotMatch(secaoDe(paginaReal('termos'), 'suspensao-e-encerramento'), /30 dias/);
  for (const [documento, id] of [['privacidade', 'mudancas'], ['termos', 'mudancas-nos-termos']]) {
    const mudancas = secaoDe(paginaReal(documento), id);
    assert.match(mudancas, /são avisadas com antecedência mínima de 15 dias no app ou por e-mail\. Quando a mudança depender do seu consentimento, você poderá recusá-la ou revogá-lo\./);
    assert.doesNotMatch(mudancas, /Continuar usando a PIA depois da alteração/);
  }
});

test('F2-02: vozes do Discord fora do treinamento, menores e idade mínima de 18 anos (CA21 ajustado pelo parecer, 5.5)', () => {
  // CA21 previa voz no treinamento; o parecer (Caminho A, decidido pelo Diogo) inverte: terceiros e menores fora.
  // Parecer final, F.5.1: "logo abaixo" remete à 4.8, que vem logo depois do 2º parágrafo da seção 7.
  { const t7 = secaoDe(paginaReal('privacidade'), 'transferencia-internacional');
    const i = t7.indexOf('Os detalhes estão logo abaixo.');
    assert.ok(i >= 0 && t7.indexOf('Transferência internacional de dados.') > i); }
  // Parecer final, F.5.4: Termos, seção 5, com a Microsoft entre os dados fora do treino.
  assert.ok(secaoDe(paginaReal('termos'), 'conteudo-e-licenca').includes('Ficam de fora do treinamento os dados obtidos pelas APIs do Google (Gmail, Agenda, Drive e perfil), conforme a Google API Services User Data Policy (Limited Use), os dados da sua conta Microsoft e as suas credenciais e tokens. Veja a'));
  // Parecer final, F.5.5: Retenção, 6º item, sem afirmação absoluta.
  assert.doesNotMatch(secaoDe(paginaReal('privacidade'), 'retencao'), /não são removidos desse modelo/);
  // Parecer final, F.5.2: uma frase só sobre menores, sem repetição.
  assert.ok(secaoDe(paginaReal('privacidade'), 'menores').includes("Se identificarmos dados de crianças ou adolescentes, inclusive vozes gravadas no Discord, eles são excluídos do servidor e nunca usados em treinamento."));
  assert.doesNotMatch(secaoDe(paginaReal('privacidade'), 'menores'), /Se descobrirmos dados de menores/);
  for (const documento of ['privacidade', 'termos']) assert.match(textoVisivel(paginaReal(documento)), /18 anos/);
});

test('F2-02: v1.0 não cita Suno nem histórico de gerações, em lugar nenhum (CA27)', () => {
  for (const documento of ['privacidade', 'termos']) {
    const html = paginaReal(documento);
    assert.doesNotMatch(html, /suno/i, `${documento}: HTML renderizado cita Suno`);
    assert.doesNotMatch(html, /histórico de geraç/i, `${documento}: HTML renderizado cita histórico de gerações`);
  }
  for (const [chave, trecho] of Object.entries(JURIDICO['1.0'])) {
    assert.doesNotMatch(`${chave} ${trecho.assunto} ${trecho.texto}`, /suno|histórico de geraç/i, `juridico 1.0: ${chave}`);
  }
  for (const [chave, valor] of Object.entries(DADOS)) assert.doesNotMatch(`${chave} ${valor}`, /suno/i, `dados: ${chave}`);
  // Feature 0004: o Suno entra só na v1.1 (conjunto '1.1', fragmentos -v1.1 e entradas 1.1 do manifesto). O motor, os
  // dados, os fragmentos v1.0 e as entradas 1.0 do manifesto continuam sem ele.
  for (const arquivo of ['../src/legal.js', '../src/legal/dados.js', '../src/legal/conteudo/privacidade-v1.0.html', '../src/legal/conteudo/termos-v1.0.html']) {
    assert.doesNotMatch(readFileSync(new URL(arquivo, import.meta.url), 'utf8'), /suno/i, arquivo);
  }
  for (const [documento, lista] of Object.entries(VERSOES)) {
    for (const item of lista.filter((v) => v.versao === '1.0')) assert.doesNotMatch(JSON.stringify(item), /suno|histórico de geraç/i, `versoes ${documento} 1.0`);
  }
});

// CA27 invertido para a v1.1 (requisitos v2.7, 0.1, e roteiro de docs/legal-v1.1-rascunho.md): a v1.1 passa a EXIGIR
// o Suno e o histórico de gerações, sem quebrar as regras da v1.0 (RN11, CA28, Caminho A, "Termos de Serviço").
const paginaV11 = (documento) => renderDocumento(documento, '1.1', 'https://pia.travelrpg.com').html;
const fragmentoV11 = (documento) =>
  readFileSync(new URL(`../src/legal/conteudo/${documento}-v1.1.html`, import.meta.url), 'utf8');

test('F2-09/0004: v1.1 cita o Suno e o histórico de gerações nas seções do roteiro (CA27 da v1.1, CA06, CA07)', () => {
  const html = paginaV11('privacidade');
  const termos = paginaV11('termos');
  for (const pagina of [html, termos]) assert.match(textoVisivel(pagina), /Suno/);
  assert.match(textoVisivel(html), /histórico de gerações de música/);
  const dados = secaoDe(html, 'dados-coletados');
  // Parecer da v1.1, R2 (seção 2, item 2), literal.
  assert.ok(dados.includes('Histórico de gerações de música: o prompt, a letra, o título, a duração, o estado e as faixas de cada geração. Nas gerações pelo Suno, também o nome da conta Suno usada e os links das músicas no Suno, que ficam só no servidor. Nas gerações locais e pelo Gemini, não guardamos o áudio nem link.'));
  assert.ok(dados.includes('Credenciais e tokens das integrações que você conecta: Google, Microsoft, Object Storage (S3), Discord, Taverns e Suno. Eles são guardados cifrados.'));
  assert.ok(dados.includes('De cada conta Suno que você conecta: o identificador, o e-mail e o nome da conta no Suno, o apelido que você dá a ela, os escopos autorizados e os tokens de acesso, que são guardados cifrados.'));
  assert.doesNotMatch(dados, /das quais guardamos só metadados/, 'divergência D1: o código guarda prompt e letra das gerações locais');
  // DV2 (requisitos da 0004, CA-0406): a cópia de mídia para o Drive cita as músicas do Suno.
  assert.ok(dados.includes('as músicas geradas no PC (MP3/WAV, pelo Gemini, pelo Suno ou localmente)'));
  const finalidades = secaoDe(html, 'finalidades');
  assert.match(finalidades, /Secretária, geração de música, cópia de mídia para o Drive, computadores pareados e MCP\./);
  assert.match(finalidades, /A PIA não usa os dados da sua conta Suno \(identificador, e-mail, nome e tokens\) para treinar modelos\./);
  const comp = secaoDe(html, 'compartilhamento');
  // Parecer da v1.1, R1 (seção 4.4), literal.
  assert.ok(comp.includes('Suno: conta conectada e geração de música. O Suno recebe o prompt e a letra de cada música, as músicas ficam na sua biblioteca no Suno e usam os créditos do seu plano. Pelos termos do Suno, ele pode usar o que você envia para melhorar os próprios serviços e modelos de IA.'));
  const transf = secaoDe(html, 'transferencia-internacional');
  assert.ok(transf.includes('como Google, Microsoft, Discord, Suno, Groq e CrowdSec, podem tratar dados no exterior. Os detalhes estão logo abaixo.'));
  assert.ok(transf.includes('O Discord transmite o áudio das chamadas de voz gravadas pelo bot. O Suno recebe o prompt e a letra quando você gera músicas com a sua conta Suno conectada.'));
  assert.doesNotMatch(transf, /tratam dados fora do Brasil|Suno[^.]*fora do Brasil/, 'seção 7 sem afirmar que um provedor específico trata dados fora do Brasil');
  const retencao = secaoDe(html, 'retencao');
  for (const frase of [
    'conectores, contas Suno conectadas, histórico de gerações de música, computadores pareados',
    // Parecer da v1.1, R3 (seção 4.4) e R4 (seção 2, item 4), literais.
    'Excluir um item do histórico apaga do servidor o prompt, a letra e os links daquele item. Excluir um item do histórico não apaga a cópia no Drive, os metadados de mídia, os arquivos no seu computador nem a música na sua biblioteca no Suno.',
    'Desconectar uma conta Suno apaga do servidor os tokens e os dados dessa conta. Sem os tokens, a PIA deixa de conseguir usar essa conta, mas a autorização dada no próprio Suno não é revogada pela PIA: se quiser, revogue-a na sua conta Suno. O histórico de gerações continua na sua conta PIA, com o apelido, o nome ou o e-mail da conta Suno que foi usada, e você pode excluir cada item.',
    'Links de música do Suno podem expirar.',
    'O áudio das músicas do Suno não é guardado na PIA Server',
  ]) assert.ok(retencao.includes(frase), frase);
  assert.match(secaoDe(html, 'direitos-do-titular'), /excluir um item do histórico de músicas, desconectar a conta Suno e os demais conectores/);
  assert.match(secaoDe(termos, 'uso-aceitavel'), /violar os termos do Google, do Suno, do Discord/);
  const licenca = secaoDe(termos, 'conteudo-e-licenca');
  assert.match(licenca, /prompts, letras, chats, músicas geradas e gravações/);
  assert.match(licenca, /os dados da sua conta Microsoft, os dados da sua conta Suno e as suas credenciais e tokens/);
  const secao6 = secaoDe(termos, 'conteudo-gerado-por-ia');
  // Parecer da v1.1, R6 (seção 2, item 7) e R5 (seção 5), literais.
  assert.ok(secao6.includes('Os direitos e limites de uso das músicas geradas pelo Suno, pelo Gemini ou por outros provedores seguem os termos de cada provedor e o plano que você tem nele. No Suno, por exemplo, músicas feitas no plano gratuito só podem ser usadas para fins pessoais e não comerciais, conforme os termos do Suno. A PIA não concede direitos sobre essas músicas. Músicas geradas por modelos locais seguem as licenças desses modelos. Cabe a você verificar esses termos antes de usar as músicas, inclusive para fins comerciais.'));
  assert.ok(secao6.includes('A PIA não controla os serviços de terceiros e não responde pela disponibilidade, pela cobrança de créditos ou pelas mudanças deles. Gerar músicas pelo Suno consome os créditos do seu plano no Suno, conforme as regras dele.'));
});

test('F2-09/0004: v1.1 mantém as regras da v1.0 (RN11, CA28, Caminho A, Termos de Serviço, seções e ids)', () => {
  for (const documento of ['privacidade', 'termos']) {
    const texto = textoVisivel(paginaV11(documento));
    // CA28
    assert.doesNotMatch(texto, /não guarda[^.]{0,120}\bIP\b|\bIP\b[^.]{0,120}não guarda/i, `CA28: ${documento}`);
    assert.doesNotMatch(texto, /Estados Unidos|\bEUA\b|6 meses|seis meses|nenhum dado pessoal sai do Brasil/i, `CA28: ${documento}`);
    // RN11: nenhuma promessa de backup de áudio no servidor
    assert.doesNotMatch(texto, /(backup|cópia de segurança)[^.]{0,80}(áudio|músic|MP3)[^.]{0,80}(no servidor|na PIA Server)|PIA Server (guarda|mantém) (o |os )?(áudio|arquivos de áudio|MP3)/i, `RN11: ${documento}`);
    // Caminho A: músicas e voz fora do treinamento
    assert.doesNotMatch(texto, /músicas que você gera[^.]*podem ser usad|Prompts, letras e músicas que você gera/i, `Caminho A: ${documento}`);
    assert.match(texto, /Termos de Serviço/);
    assert.doesNotMatch(texto, /Termos de Uso/);
  }
  // Fragmentos v1.1: sem colchete legítimo, script ou recurso externo, com os mesmos ids de seção da v1.0.
  for (const documento of ['privacidade', 'termos']) {
    const bruto = fragmentoV11(documento).replace(/<!--(?!\s*\/?legal:)[\s\S]*?-->/g, '');
    assert.doesNotMatch(bruto, /\[|TEXTO PENDENTE|TODO|XXX|lorem|example\.invalid/i);
    assert.doesNotMatch(bruto, /<script|<style|<img|<link|<iframe|\son[a-z]+=/i);
    const ids = (f) => [...f.matchAll(/<h2 id="([a-z0-9-]+)">([^<]*)<\/h2>/g)].map(([, id, t]) => [id, t]);
    assert.deepEqual(ids(fragmentoV11(documento)), ids(fragmentoReal(documento)), `${documento}: mesmas seções da v1.0`);
  }
  // A v1.1 é rascunho: só aparece em renderDocumento(…, '1.1'); /privacidade e /termos continuam na v1.0.
  const entradas = new Map(legalFiles('https://pia.travelrpg.com'));
  assert.deepEqual([...entradas.keys()], ['/privacidade', '/privacidade/v1.0', '/termos', '/termos/v1.0']);
  for (const documento of ['privacidade', 'termos']) {
    const r = renderDocumento(documento, '1.1', 'https://pia.travelrpg.com');
    assert.equal(r.rascunho, true);
    assert.doesNotMatch(entradas.get('/' + documento)[1], /suno/i, 'a atual continua sendo a v1.0');
  }
});

// Parecer da v1.1 (feature 0004): trechos com texto literal aprovado (revisado:true). TREINAMENTO_CONTA_SUNO só passa com
// a Alternativa A do O1 (seção 3.3).
const APROVADOS_PARECER_V1_1 = ['AUDIO_SUNO', 'DADOS_CONTA_SUNO', 'DESCONEXAO_SUNO', 'DIREITOS_MUSICAS_GERADAS', 'HISTORICO_GERACOES', 'SALVAGUARDAS_TRANSFERENCIA'];

test('F2-09/0004: JURIDICO[1.1] = conjunto 1.0 final + trechos do parecer da v1.1, texto puro e só tokens de dados', () => {
  const v10 = JURIDICO['1.0'];
  const v11 = JURIDICO['1.1'];
  for (const [chave, trecho] of Object.entries(v11)) {
    const igual = v10[chave] && v10[chave].texto === trecho.texto;
    assert.equal(trecho.revisado, Boolean(igual) || APROVADOS_PARECER_V1_1.includes(chave), `${chave}: revisado:${trecho.revisado}, ${igual ? 'igual' : 'diferente'} da v1.0`);
    if (!trecho.revisado) assert.ok(trecho.pendencia && trecho.assunto, chave);
    assert.doesNotMatch(trecho.texto + trecho.assunto, /[[\]<>]/, `${chave}: texto puro, sem colchetes nem HTML`);
    assert.doesNotMatch(trecho.texto, /\{\{(?!CONTATO_EMAIL|CONTROLADOR_NOME|IDADE_MINIMA)[A-Z_]+\}\}/, `${chave}: só tokens de dados`);
  }
  for (const chave of Object.keys(v10)) assert.ok(Object.hasOwn(v11, chave), `${chave} continua no conjunto 1.1`);
  assert.deepEqual(Object.entries(v11).filter(([, t]) => !t.revisado).map(([c]) => c).sort(),
    ['TREINAMENTO_CONTA_SUNO']);
  // Textos aprovados no parecer da v1.1 (seção 2, itens 1, 3 e 6), sem mudança.
  assert.equal(v11.DADOS_CONTA_SUNO.texto, 'De cada conta Suno que você conecta: o identificador, o e-mail e o nome da conta no Suno, o apelido que você dá a ela, os escopos autorizados e os tokens de acesso, que são guardados cifrados.');
  assert.equal(v11.AUDIO_SUNO.texto, 'O áudio das músicas do Suno não é guardado na PIA Server: quando você baixa uma faixa, o servidor busca o áudio no Suno pelo link guardado no histórico e o repassa ao seu computador, sem gravar o arquivo.');
  assert.ok(v11.SALVAGUARDAS_TRANSFERENCIA.texto.includes('O Suno recebe o prompt e a letra quando você gera músicas com a sua conta Suno conectada.'));
  // Todos os trechos usados em alguma página da v1.1 (AVISO_GRAVACAO_DISCORD é só do embed).
  const ambos = paginaV11('privacidade') + paginaV11('termos');
  for (const [chave, trecho] of Object.entries(v11)) {
    if (chave === 'AVISO_GRAVACAO_DISCORD') continue;
    assert.ok(ambos.includes(escapeHtml(renderTokens(trecho.texto, DADOS))), `${chave} usado em alguma página da v1.1`);
  }
  assert.equal(v11.DIREITOS_MUSICAS_SUNO, undefined, 'a v1.1 reaproveita a chave DIREITOS_MUSICAS_GERADAS');
  assert.equal(v11.TREINAMENTO_MICROSOFT_SUNO, undefined, 'redação do rascunho superada pelo Caminho A');
});

test('F2-02: trechos jurídicos da v1.0 com as redações exatas do parecer (Caminho A) e revisado:true (release legal v1.0)', () => {
  const v1 = JURIDICO['1.0'];
  // Seção 4 do parecer jurídico sobre f1338f7, copiada literalmente (4.12 aprovado sem ajuste).
  const PARECER = {
      "ENCARREGADO": "O encarregado atua como canal de comunicação entre o controlador, os titulares dos dados e a Agência Nacional de Proteção de Dados (ANPD), recebendo pedidos, reclamações e comunicações pelo e-mail {{CONTATO_EMAIL}}.",
      "CONSENTIMENTO_TERCEIROS_DISCORD": "Enquanto a gravação está ativa, o bot avisa no canal que ela está acontecendo. Quem configura a gravação deve avisar os participantes antes de começar e respeitar quem não quiser ser gravado. As gravações de voz de todos os participantes, inclusive de pessoas que não usam a PIA (terceiros), servem apenas para entregar a gravação a quem a configurou, na pasta da PIA no Google Drive dessa pessoa. Nenhuma gravação de voz é usada para treinar modelos de IA. Pessoas gravadas podem pedir informações, acesso ou exclusão pelo e-mail {{CONTATO_EMAIL}}, informando o servidor, o canal, a data aproximada e o seu nome de usuário no Discord.",
      "TREINAMENTO_MP3_GERADOS": "Hoje a PIA não guarda cópia das músicas geradas (MP3/WAV) nem das gravações de voz e, por isso, não as usa para treinar modelos. Se isso mudar, publicaremos uma nova versão destes documentos antes, com aviso prévio.",
      "TREINAMENTO_MICROSOFT": "A PIA não usa dados obtidos da sua conta Microsoft (e-mails, agenda e arquivos, via Microsoft Graph) para treinar modelos. Conversas e prompts que você envia à PIA podem ser usados para treinamento, exceto trechos de e-mails, eventos, arquivos ou outros conteúdos obtidos do Google ou da Microsoft que apareçam nessas conversas, que são excluídos antes de qualquer treinamento.",
      "BASE_LEGAL_TREINAMENTO": "para treinar modelos de IA e melhorar o serviço com conversas, prompts e outros conteúdos de texto que você envia à PIA: legítimo interesse do controlador (inciso IX e art. 10), limitado aos dados necessários, com transparência e com o direito de pedir a qualquer momento que seus dados deixem de ser usados (seção Direitos do titular). Dados pessoais sensíveis, como dados de saúde, biométricos ou de crianças e adolescentes, não são usados em treinamento com base no legítimo interesse e, quando identificados, são retirados dos conjuntos de treinamento. Gravações de voz só poderão ser usadas em treinamento com o consentimento específico e destacado de cada pessoa gravada (art. 11, inciso I), pedido à parte, fora destes documentos;",
      "ORIGEM_TREINAMENTO_MIDIA": "Gravações de voz, músicas e capturas que a PIA envia ao seu Google Drive não são lidas de volta do Drive para treinar modelos, nem para qualquer outra finalidade além de prestar o serviço que você pediu. A PIA não usa dados obtidos pelas APIs do Google, inclusive os derivados deles, para criar, treinar ou melhorar modelos de IA.",
      "PROVEDORES_LLM": "Quando o assistente lê o seu Gmail, Google Drive, Google Agenda ou dados da sua conta Microsoft para atender a um pedido seu, ele envia ao provedor de modelo de linguagem que você escolheu o conteúdo necessário para gerar a resposta. A chave de API e a conta no Gemini ou na Groq são suas: você as cria no site do provedor e as cadastra na PIA. A PIA não usa esse conteúdo para treinar os próprios modelos. O que o provedor faz com o conteúdo depende dos termos da conta que você usa nele, que são aceitos por você diretamente com esse provedor. Na camada gratuita do Gemini, por exemplo, o Google pode usar o conteúdo enviado para melhorar os produtos dele, inclusive com revisão humana. Pelos termos do próprio Google, isso não ocorre na camada paga, e o Ollama roda no seu próprio computador. Antes de usar a PIA com Gmail, Drive, Agenda ou Microsoft, confira os termos do provedor de IA escolhido. Se não quiser que esse conteúdo possa ser usado pelo provedor, use uma camada paga ou o Ollama local. Esse conteúdo não é guardado pela PIA além do histórico da conversa, que fica no seu computador e, se você usar o perfil compartilhado, é sincronizado de forma cifrada com a PIA Server.",
      "EXCLUSAO_CONTA_PRAZO": "Quando você pede a exclusão da conta pelo e-mail {{CONTATO_EMAIL}}, apagamos esses dados do servidor, inclusive as gravações pendentes de envio, em até 15 dias contados do pedido. Não há cópia de segurança (backup) do banco de dados, então nenhuma cópia desses dados fica guardada depois da exclusão.",
      "SALVAGUARDAS_TRANSFERENCIA": "Transferência internacional de dados. Os dados pessoais guardados no servidor e no banco de dados da PIA, como a sua conta, as conversas e configurações sincronizadas e os metadados, ficam no Brasil. Outros dados, como imagens e áudios, inclusive gravações de voz, que também são dados pessoais, podem ficar ou ser tratados fora do Brasil. Para que o serviço funcione, alguns dados passam por fornecedores que podem tratá-los no exterior. O Google faz o login, recebe as suas mídias no seu Google Drive e dá acesso ao Gmail e à Agenda quando você conecta essas integrações. A Microsoft dá acesso a e-mail, agenda e arquivos quando você conecta essa integração. O Gemini, do Google, e a Groq processam as mensagens e, quando você usa a transcrição de voz, o áudio a transcrever, por modelos de linguagem. O Discord transmite o áudio das chamadas de voz gravadas pelo bot. As mídias, como imagens e áudios, ficam na conta de armazenamento que você mesmo conecta, como o seu Google Drive ou o Object Storage que você configura, e podem estar fora do Brasil, conforme as regras desse provedor. A PIA não contrata armazenamento de mídia fora do país. Essas transferências acontecem porque são necessárias para prestar o serviço que você pediu, nos termos do art. 33, inciso IX, combinado com o art. 7º, inciso V, da LGPD. Cada fornecedor trata os dados conforme os próprios termos de uso e políticas de privacidade, publicados em seus sites. A ferramenta de segurança do servidor (CrowdSec) envia ao fornecedor dela, que pode tratá-los no exterior, os endereços IP que tentaram abusar do serviço, com a data, a hora e o tipo de ataque, para manter uma lista compartilhada de endereços maliciosos. Esse envio tem como base o legítimo interesse em proteger o serviço e segue as garantias previstas nos termos desse fornecedor. Se quiser saber mais sobre essas transferências, escreva para {{CONTATO_EMAIL}}.",
      "REMOCAO_DADOS_TREINADOS": "Se você pedir a eliminação dos seus dados, eles também são retirados das cópias guardadas para treinamento e deixam de ser usados em novos treinamentos. Modelos que já foram treinados antes do pedido podem não permitir a remoção individual desses dados, no limite técnico do que é possível hoje (art. 16 da LGPD). Nesse caso, não usamos esses modelos para identificar você.",
      "PRAZO_RESPOSTA_TITULAR": "Se você pedir confirmação de que tratamos seus dados ou acesso a eles, enviamos uma resposta simplificada imediatamente, assim que confirmarmos que o pedido veio do e-mail da sua conta, ou, se preferir, uma declaração clara e completa, com a origem dos dados, os critérios usados e a finalidade, em até 15 dias contados do pedido. Os demais pedidos são respondidos em até 15 dias contados do recebimento. Se não for possível atender de imediato, informamos os motivos nesse prazo. O atendimento é gratuito.",
      "OPT_OUT_TREINAMENTO": "Você pode pedir, a qualquer momento e sem custo, que seus dados deixem de ser usados para treinar modelos. Basta enviar um e-mail para {{CONTATO_EMAIL}} com o assunto 'Opt-out de treinamento', a partir do e-mail da sua conta. Confirmamos o pedido em até 15 dias, e ele vale para todos os treinamentos feitos depois da confirmação. Treinamentos feitos antes do pedido continuam válidos, e dados já incorporados a modelos treinados podem não ser removíveis desses modelos. Se você quiser também que suas cópias guardadas para treinamento sejam apagadas, peça a eliminação no mesmo e-mail. Pessoas que não usam a PIA, mas foram gravadas em canais do Discord, podem pedir informações, acesso ou eliminação da gravação pelo mesmo e-mail, informando o servidor, o canal, a data aproximada da gravação e o seu nome de usuário no Discord, para que possamos localizá-la.",
      "LIMITACAO_CDC": "Nada nestes Termos afasta ou limita direitos que a lei não permite renunciar, inclusive os previstos no Código de Defesa do Consumidor e na LGPD. As limitações acima não se aplicam a danos causados por dolo ou culpa grave, nem à responsabilidade por tratamento de dados pessoais em desacordo com a LGPD. Se a relação com você for de consumo, valem integralmente as regras do Código de Defesa do Consumidor, inclusive o direito de propor ação no seu domicílio.",
      "AVISO_GRAVACAO_DISCORD": "Este canal está sendo gravado pela PIA. O áudio de cada participante vai para o Google Drive de quem configurou a gravação. As vozes gravadas não são usadas para treinar modelos. Se não quiser ser gravado, avise quem configurou a gravação ou saia do canal. Dúvidas e pedidos: {{CONTATO_EMAIL}}."
  };
  for (const [chave, texto] of Object.entries(PARECER)) {
    assert.equal(v1[chave].texto, texto, `${chave} difere do parecer`);
  }
  for (const [chave, trecho] of Object.entries(v1)) assert.equal(trecho.revisado, true, `${chave} aprovado no parecer final (release legal v1.0)`);
  assert.equal(Object.keys(v1).length, 16);
  // LOGS_ACESSO: redação 4.3 do Adendo 2 (frase neutra, sem prazo; prazo e rotação pendentes, P14).
  assert.match(v1.LOGS_ACESSO.texto, /A PIA guarda registros de acesso com o seu endereço IP/);
  assert.equal(v1.LOGS_ACESSO.texto, "A PIA guarda registros de acesso com o seu endereço IP. A cada acesso, o servidor registra o endereço IP e a porta de origem, a data e a hora, o método, o endereço da página acessada, o domínio, o código de resposta e dados técnicos da conexão segura (TLS). Uma ferramenta automática de segurança (CrowdSec) analisa esses registros para detectar e bloquear tentativas de abuso e guarda os endereços IP bloqueados. Usamos esses dados apenas para segurança, prevenção de abuso e diagnóstico de falhas, com base no legítimo interesse do controlador (art. 7º, inciso IX, da LGPD) e, quando necessário, para o exercício regular de direitos em processo judicial, administrativo ou arbitral (art. 7º, inciso VI), inclusive para atender ordem judicial ou pedido de autoridade competente. Esses registros são mantidos pelo tempo necessário para segurança e prevenção de abuso e não são usados para treinar modelos. O provedor de hospedagem e os serviços de terceiros que você usa com a PIA, como Google e Discord, também podem registrar o seu endereço IP, conforme as políticas de cada um.");
  assert.equal(v1.DIREITOS_MUSICAS_SUNO, undefined);
  assert.equal(v1.TREINAMENTO_MICROSOFT_SUNO, undefined);
  const direitosMusicas = 'Os direitos e limites de uso das músicas geradas pelo Gemini ou por outros provedores seguem os termos de cada provedor. Músicas geradas por modelos locais seguem as licenças desses modelos. Cabe a você verificar esses termos antes de usar as músicas, inclusive para fins comerciais.';
  assert.equal(v1.DIREITOS_MUSICAS_GERADAS.texto, direitosMusicas);
  const termos = paginaReal('termos');
  const secao6 = termos.slice(termos.indexOf('<h2 id="conteudo-gerado-por-ia">'), termos.indexOf('<h2 id="isencao-de-garantias">'));
  assert.ok(secao6.includes(direitosMusicas), 'texto exato na seção 6 dos Termos');
  assert.doesNotMatch(secao6, /legal-pendente|EM REVISÃO JURÍDICA/, 'sem selo depois do parecer final');
  for (const trecho of Object.values(v1)) assert.doesNotMatch(trecho.texto + trecho.assunto, /[[\]<>]/, 'texto puro, sem colchetes nem HTML');
  for (const trecho of Object.values(v1)) assert.doesNotMatch(trecho.texto, /\{\{(?!CONTATO_EMAIL|CONTROLADOR_NOME|IDADE_MINIMA)[A-Z_]+\}\}/, 'só tokens de dados');
});
