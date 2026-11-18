import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DOCUMENTOS, escapeHtml, formatarData, legalFiles, legalFooter,
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
  assert.match(html, /<td><a href="\/privacidade\/v1\.0">1\.0<\/a><\/td><td>01\/12\/2026<\/td><td>05\/12\/2026<\/td><td>Primeira versão\.<\/td>/);
  assert.match(html, /<a href="\/">Voltar à PIA<\/a>/);
  assert.match(html, /Veja também: <a href="\/termos">Termos de Serviço<\/a>/);
  assert.doesNotMatch(html, /<script/i);
  const termos = renderDocumento('termos', '1.0', ORIGIN, fontes()).html;
  assert.match(termos, /<link rel="canonical" href="https:\/\/pia\.example\/termos\/v1\.0">/);
  assert.match(termos, /Veja também: <a href="\/privacidade">Política de Privacidade<\/a>/);
});

test('sumário usa o texto puro e escapado dos títulos; trecho jurídico é texto puro', () => {
  const extra = fontes({ conteudo: fragmento('<h2 id="a-e-b">A <em>&amp;</em> &lt;B&gt;</h2>') });
  extra.juridico['1.0'].TRECHO.texto = 'Escreva para <a href="mailto:x@y">x@y</a>.';
  const { html } = renderDocumento('privacidade', undefined, ORIGIN, extra);
  assert.match(html, /<li><a href="#a-e-b">A &amp; &lt;B&gt;<\/a><\/li>/);
  assert.match(html, /<h2 id="a-e-b">A <em>&amp;<\/em> &lt;B&gt;<\/h2>/, 'corpo mantém o HTML do fragmento');
  assert.match(html, /Escreva para &lt;a href=&quot;mailto:x@y&quot;&gt;x@y&lt;\/a&gt;\./);
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
  assert.match(rodape, /<a href="\/privacidade">Política de Privacidade<\/a> · <a href="\/termos">Termos de Serviço<\/a>/);
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
    assert.ok(externos.every((url) => url === 'https://developers.google.com/terms/api-services-user-data-policy'), externos.join(', '));
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
    /Não guardamos logs de acesso com endereço IP/,
  ]) assert.match(secao, termo);
  assert.doesNotMatch(secao, /podem registrar logs/);
  const retencao = secaoDe(paginaReal('privacidade'), 'retencao');
  assert.match(retencao, /Não garantimos a retenção nem a disponibilidade dos dados/);
  assert.match(retencao, /A PIA Server não guarda arquivos de áudio nem de imagem/);
  assert.match(retencao, /podem não ser removíveis/);
});

test('F2-02: finalidades e licença citam voz do Discord e MP3 no treinamento, e Microsoft fora (RN03a)', () => {
  const finalidades = secaoDe(paginaReal('privacidade'), 'finalidades');
  assert.match(finalidades, /gravações de voz do Discord \(também as de terceiros\) e as músicas geradas em MP3/);
  assert.match(finalidades, /Dados obtidos da sua conta Microsoft \(e-mails, agenda e arquivos via Microsoft Graph\) não são usados para treinar modelos\. Conversas, prompts e músicas que você gera ou envia à PIA podem ser usados para treinamento\./);
  assert.match(finalidades, /Credenciais e tokens nunca são usados em treinamento/);
  const licenca = secaoDe(paginaReal('termos'), 'conteudo-e-licenca');
  assert.match(licenca, /licença gratuita, não exclusiva, mundial/);
  assert.match(licenca, /gravações de voz do Discord, inclusive as vozes de outros participantes do canal, e as músicas geradas em MP3/);
});

test('F2-02: compartilhamento, Limited Use e transferência internacional (CA07, CA09)', () => {
  const html = paginaReal('privacidade');
  const comp = secaoDe(html, 'compartilhamento');
  for (const t of ['Google', 'Microsoft', 'Discord', 'Taverns', 'Gemini', 'Groq', 'hospedagem']) assert.match(comp, new RegExp(t));
  assert.match(comp, /Não vendemos dados pessoais/);
  assert.match(comp, /Google API Services User Data Policy/);
  assert.match(comp, /Limited Use/);
  assert.match(comp, /não são usados para treinar modelos de IA generalizados/);
  assert.match(comp, /não são obtidos pela leitura do seu Google Drive por meio das APIs do Google/);
  assert.match(html, /<a href="https:\/\/developers\.google\.com\/terms\/api-services-user-data-policy" rel="noreferrer">/);
  const transf = secaoDe(html, 'transferencia-internacional');
  assert.match(transf, /principalmente no Brasil/);
  assert.match(transf, /art\. 33/);
  assert.match(textoVisivel(paginaReal('termos')), /Limited Use/);
});

test('F2-02: direitos do titular com art. 18, e-mail, prazo, opt-out e ANPD, sem exclusão automática (CA08, RN08)', () => {
  const secao = secaoDe(paginaReal('privacidade'), 'direitos-do-titular');
  assert.match(secao, /art\. 18 da LGPD/);
  for (const d of [/acesso/, /correção/, /anonimização, bloqueio ou eliminação/, /portabilidade/, /compartilhamos/, /revogação do consentimento/, /oposição/]) assert.match(secao, d);
  assert.match(secao, /contato@travelrpg\.com/);
  assert.match(secao, /Respondemos aos pedidos em até 15 dias, contados do recebimento\./);
  assert.match(secao, /com o assunto 'Opt-out de treinamento', a partir do e-mail da sua conta/);
  assert.match(secao, /Basta enviar um e-mail para contato@travelrpg\.com/);
  assert.match(secao, /informando o servidor, o canal e a data aproximada da gravação/);
  assert.match(secao, /ANPD/);
  assert.match(secao, /feitas manualmente/);
  assert.doesNotMatch(paginaReal('privacidade'), /exclusão automática/i);
});

test('F2-02: controlador, DPO, cifragem honesta, cookies e sem CPF (6.1 itens 1, 9, 11)', () => {
  const texto = textoVisivel(paginaReal('privacidade'));
  assert.match(texto, /controlador e responsável .* Diogo Passos Perdigão Britto/);
  assert.match(texto, /Encarregado \(DPO\): Diogo Passos Perdigão Britto, pelo contato@travelrpg\.com/);
  assert.match(texto, /O próprio controlador atua como encarregado/);
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
});

test('F2-02: Discord no treinamento e idade mínima de 18 anos nos dois documentos (CA21)', () => {
  assert.match(textoVisivel(paginaReal('privacidade')), /gravações de voz, inclusive as vozes de terceiros, podem ser usadas para treinamento de modelos/);
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
  for (const arquivo of ['../src/legal.js', '../src/legal/dados.js', '../src/legal/juridico.js', '../src/legal/versoes.js']) {
    assert.doesNotMatch(readFileSync(new URL(arquivo, import.meta.url), 'utf8'), /suno/i, arquivo);
  }
});

test('F2-02: trechos jurídicos da v1.0 em revisão, com as redações exatas do PO', () => {
  const v1 = JURIDICO['1.0'];
  for (const chave of ['ENCARREGADO', 'SALVAGUARDAS_TRANSFERENCIA', 'ORIGEM_TREINAMENTO_MIDIA', 'TREINAMENTO_MICROSOFT', 'LOGS_ACESSO', 'OPT_OUT_TREINAMENTO', 'PRAZO_RESPOSTA_TITULAR']) {
    assert.ok(v1[chave], `chave ausente: ${chave}`);
    assert.equal(v1[chave].revisado, false, `${chave} segue com revisado:false até o parecer`);
  }
  assert.equal(v1.DIREITOS_MUSICAS_SUNO, undefined);
  assert.equal(v1.TREINAMENTO_MICROSOFT_SUNO, undefined);
  assert.equal(v1.TREINAMENTO_MICROSOFT.texto, 'Dados obtidos da sua conta Microsoft (e-mails, agenda e arquivos via Microsoft Graph) não são usados para treinar modelos. Conversas, prompts e músicas que você gera ou envia à PIA podem ser usados para treinamento.');
  assert.equal(v1.PRAZO_RESPOSTA_TITULAR.texto, 'Respondemos aos pedidos em até 15 dias, contados do recebimento.');
  assert.match(v1.OPT_OUT_TREINAMENTO.texto, /^Você pode pedir, a qualquer momento, que seus dados deixem de ser usados para treinar modelos\. Basta enviar um e-mail para \{\{CONTATO_EMAIL\}\} com o assunto 'Opt-out de treinamento'/);
  assert.match(v1.LOGS_ACESSO.texto, /^Não guardamos logs de acesso com endereço IP\./);
  for (const trecho of Object.values(v1)) assert.doesNotMatch(trecho.texto + trecho.assunto, /[[\]<>]/, 'texto puro, sem colchetes nem HTML');
});
