import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DOCUMENTOS, MICROTEXTOS, escapeHtml, formatarData, legalFiles, legalFooter,
  legalNotFound, legalRedirects, pendencias, redirecionamentosLegais, renderDocumento, renderTokens,
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
  assert.match(html, /Versão 1\.0 · Vigente a partir de 01\/12\/2026 · Última atualização: 05\/12\/2026/);
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
  assert.match(html, /<td><a href="\/privacidade\/v1\.0">1\.0<\/a> <span class="legal-current">atual<\/span><\/td><td>01\/12\/2026<\/td><td>Primeira versão\.<\/td>/);
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
  assert.match(atual, /Versão 1\.0 · Vigente a partir de 01\/12\/2026/);
  assert.match(atual, /<link rel="canonical" href="https:\/\/pia\.example\/privacidade">/);
  const [, v10] = entradas.get('/privacidade/v1.0');
  assert.match(v10, /<link rel="canonical" href="https:\/\/pia\.example\/privacidade\/v1\.0">/);
  assert.match(v10, /<td><a href="\/privacidade\/v1\.0">1\.0<\/a><\/td>/);
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
  assert.match(rascunho.html, /<a href="\/privacidade\/v1\.0">1\.0<\/a>[\s\S]*<td>1\.1<\/td>/, 'rascunho sem link no histórico');
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

test('conteúdo real do repositório renderiza em rascunho, com dados reais e todos os trechos jurídicos', () => {
  const entradas = new Map(legalFiles('https://pia.travelrpg.com'));
  assert.deepEqual([...entradas.keys()], ['/privacidade', '/termos'], 'nada publicado: só as atuais em rascunho');
  const privacidade = entradas.get('/privacidade')[1];
  const termos = entradas.get('/termos')[1];
  assert.match(privacidade, /<link rel="canonical" href="https:\/\/pia\.travelrpg\.com\/privacidade">/);
  assert.match(privacidade, /Diogo Passos Perdigão Britto/);
  assert.match(privacidade, /contato@travelrpg\.com/);
  assert.match(termos, /comarca de Belo Horizonte\/MG/);
  const ambos = privacidade + termos;
  for (const [chave, trecho] of Object.entries(JURIDICO['1.0'])) {
    assert.equal(trecho.revisado, false, `${chave} nasce com revisado:false`);
    if (chave === 'AVISO_GRAVACAO_DISCORD') continue; // só no embed do Discord (F2-10)
    assert.ok(ambos.includes(`[EM REVISÃO JURÍDICA: ${trecho.pendencia} ${trecho.assunto}]`), `${chave} usado em alguma página`);
  }
  for (const [, , headers] of entradas.values()) assert.equal(headers['Cache-Control'], 'no-store');
  for (const valor of Object.values(DADOS)) assert.equal(typeof valor, 'string');
  assert.ok(!/\d{3}\.\d{3}\.\d{3}-\d{2}/.test(ambos), 'sem CPF');
});

test('legalRedirects mapeia aliases e barra final para o caminho canônico relativo', () => {
  assert.equal(legalRedirects.get('/privacy'), '/privacidade');
  assert.equal(legalRedirects.get('/privacidade/'), '/privacidade');
  assert.equal(legalRedirects.get('/terms'), '/termos');
  assert.equal(legalRedirects.get('/termos/'), '/termos');
  assert.equal(legalRedirects.has('/privacidade/v1.0/'), false, 'v1.0 ainda não publicada');
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
  assert.equal(legalNotFound('/termos/v1.0').status, 404, 'v1.0 em rascunho não tem rota própria');
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
  const lista = pendencias();
  const juridicos = lista.filter((p) => p.tipo === 'juridico').map((p) => p.chave);
  assert.deepEqual(juridicos, Object.keys(JURIDICO['1.0']));
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
  assert.equal(saida, '2');
});
