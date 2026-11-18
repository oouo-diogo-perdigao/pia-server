/**
 * Páginas legais públicas da PIA Server: Política de Privacidade e Termos de Serviço (feature 0002).
 *
 * Módulo puro: só lê os fragmentos de src/legal/conteudo/ do disco quando legalFiles() é chamado
 * (no boot). Não usa rede, banco (db.js), OAuth (auth.js) nem a data do servidor. O origin chega
 * por parâmetro (o index.js passa o origin de PIA_PUBLIC_URL, de src/auth.js).
 *
 * ── Como escrever um fragmento (src/legal/conteudo/<documento>-vX.Y.html) ─────────────────────
 * O fragmento é só o corpo do documento; o layout (html, head, h1, datas, sumário, histórico,
 * rodapé e links) é gerado aqui. Regras, todas verificadas no boot e nos testes:
 *  0. Comentários <!-- … --> são removidos antes de renderizar (não use tokens neles).
 *  1. Exatamente um bloco "Em resumo", com 3 a 5 <li> (RN01):
 *       <!-- legal:resumo --><ul><li>…</li></ul><!-- /legal:resumo -->
 *  2. Cada seção é um <h2 id="slug">Título</h2> (id com a-z, 0-9 e hífen, único). O sumário com
 *     âncoras é montado a partir desses h2. Use h3 dentro das seções. Ids reservados: em-resumo,
 *     sumario, historico-de-versoes.
 *  3. Proibido (erro): <h1 (o h1 é único e gerado), <script e atributos on*=. Não use "[" no texto
 *     final: os colchetes são reservados aos selos e a marcadores de texto pendente, qualquer "["
 *     liga o modo rascunho e o gate de release (CA11) procura "[".
 *  4. Tokens no formato {{NOME}} (maiúsculas, dígitos e _). Token desconhecido, sem valor ou
 *     malformado (por exemplo {{nome}} ou "{{" solto) lança erro no boot e no teste.
 *     Os valores são escapados com escapeHtml; podem ir em texto e em atributos
 *     (ex.: <a href="mailto:{{CONTATO_EMAIL}}">{{CONTATO_EMAIL}}</a>).
 *
 * ── Tokens disponíveis ────────────────────────────────────────────────────────────────────────
 * Dados (src/legal/dados.js):
 *   {{CONTROLADOR_NOME}}   Diogo Passos Perdigão Britto
 *   {{CONTATO_EMAIL}}      contato@travelrpg.com
 *   {{ENCARREGADO_NOME}}   Diogo Passos Perdigão Britto (o controlador atua como DPO, P04)
 *   {{ENCARREGADO_EMAIL}}  contato@travelrpg.com
 *   {{FORO}}               comarca de Belo Horizonte/MG
 *   {{FORO_RESSALVA}}      ressalvado o foro do domicílio do consumidor quando a lei garantir
 *   {{DOMINIO_OFICIAL}}    travelrpg.com
 *   {{HOSPEDAGEM_TEXTO}}   principalmente no Brasil; alguns recursos podem estar em outras localidades
 *   {{IDADE_MINIMA}}       18
 * Gerados por página:
 *   {{ORIGEM}}             origin público (ex.: https://pia.travelrpg.com), de PIA_PUBLIC_URL
 *   {{URL_PRIVACIDADE}}    <origem>/privacidade
 *   {{URL_TERMOS}}         <origem>/termos
 *   {{VERSAO}}             versão desta página (ex.: 1.0)
 *   {{VIGENCIA}}           DD/MM/AAAA, ou selo [PREENCHER NO RELEASE: data de vigência]
 *   {{ATUALIZACAO}}        DD/MM/AAAA, ou selo [PREENCHER NO RELEASE: data de atualização]
 * Trechos jurídicos (src/legal/juridico.js) são TEXTO PURO: o texto é escapado e inserido sem HTML,
 * então e-mails e URLs dentro deles não viram link (um mailto: precisa ficar no fragmento, fora do
 * trecho, ex.: <p>{{OPT_OUT_TREINAMENTO}} <a href="mailto:{{CONTATO_EMAIL}}">…</a></p>). Com revisado:false
 * vêm precedidos do selo [EM REVISÃO JURÍDICA: <pendência> <assunto>]:
 *   {{BASE_LEGAL_TREINAMENTO}} {{CONSENTIMENTO_TERCEIROS_DISCORD}} {{LIMITACAO_CDC}}
 *   {{OPT_OUT_TREINAMENTO}} {{REMOCAO_DADOS_TREINADOS}} {{PRAZO_RESPOSTA_TITULAR}}
 *   {{TREINAMENTO_MICROSOFT_SUNO}} {{TREINAMENTO_MP3_GERADOS}} {{LOGS_ACESSO}}
 *   (DIREITOS_MUSICAS_SUNO e os trechos da feature 0001 ficam para a v1.1.)
 *   {{AVISO_GRAVACAO_DISCORD}} existe para o embed do bot (textoJuridico); as páginas não o usam.
 *   Use cada um como um bloco de frase, por exemplo: <p>{{LOGS_ACESSO}}</p>.
 *
 * ── Rascunho × final (T02, seção 3.2) ─────────────────────────────────────────────────────────
 * Uma página é rascunho se gerou algum selo (trecho com revisado:false ou data null) ou se o HTML
 * final ainda tem "[". Rascunho: faixa "RASCUNHO, não publicar", <meta name="robots"
 * content="noindex">, Cache-Control: no-store e X-Robots-Tag: noindex. Final: Cache-Control:
 * public, max-age=3600, sem noindex. CSP, nosniff e Referrer-Policy continuam vindo do index.js.
 *
 * ── Exportações ───────────────────────────────────────────────────────────────────────────────
 *   escapeHtml(valor)          escapa & < > " ' (mesmo contrato de src/oauth_callback.js).
 *   formatarData(iso)          'AAAA-MM-DD' → 'DD/MM/AAAA' (determinístico); null → null; erro se inválida.
 *   renderTokens(texto, valores) substitui {{NOME}} por valores[NOME] (já em HTML); erro se faltar.
 *   renderDocumento(documento, versao, origin, fontes?) → { html, rascunho, headers, pendencias }.
 *   legalFiles(origin, fontes?) → array de [caminho, [tipo, html, headers]] para espalhar no
 *                                mapa publicFiles: /privacidade, /termos (versão atual = última
 *                                publicada; sem nenhuma publicada, a última em rascunho) e /privacidade/vX.Y, /termos/vX.Y só das versões
 *                                publicadas (vigencia preenchida). /vX.Y em rascunho = 404 legal.
 *   legalRedirects             Map caminho → Location relativo canônico (301; a query é descartada).
 *   legalNotFound(caminho, fontes?) → { status: 404, headers, body } para /privacidade/* e /termos/*
 *                                desconhecidos; null para qualquer outro caminho.
 *   legalFooter({ ciencia })   rodapé HTML com links relativos para /privacidade e /termos;
 *                                ciencia:true acrescenta o texto de ciência do RF05.
 *   pendencias(fontes?)        lista de pendências ativas (trechos sem revisão e datas null).
 *   textoJuridico(chave, documento?) texto simples (sem HTML) de um trecho do conjunto da versão
 *                                atual do documento, com tokens de dados resolvidos e o selo
 *                                [EM REVISÃO JURÍDICA: ...] na frente se revisado:false. Para o Discord.
 *   hashDocumento(doc, versao) sha256 do HTML da versão renderizada com ORIGEM_SNAPSHOT.
 *   versoesAlteradas(fontes?)  versões publicadas cujo HTML não bate com o sha256 do manifesto.
 * Congelamento: trechos jurídicos são versionados (JURIDICO['1.0']) e cada versão do manifesto
 * aponta seu conjunto; versão publicada leva sha256 e o teste falha se o HTML dela mudar.
 * Preview local (sem banco nem variáveis PG* e GOOGLE_*), inclusive das versões em rascunho:
 *   npm run legal:preview   (http://127.0.0.1:8790; ou -- --out <pasta> para gravar os HTML)
 * "fontes" é opcional e serve aos testes: { dados, juridico, versoes, conteudo(documento, versao) }.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DADOS } from './legal/dados.js';
import { JURIDICO } from './legal/juridico.js';
import { VERSOES } from './legal/versoes.js';

const HTML = 'text/html; charset=utf-8';
const HEADERS_FINAL = Object.freeze({ 'Cache-Control': 'public, max-age=3600' });
const HEADERS_RASCUNHO = Object.freeze({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
const RESERVADOS = new Set(['em-resumo', 'sumario', 'historico-de-versoes']);
/** Origin fixo usado para calcular o hash das versões congeladas (independe de PIA_PUBLIC_URL). */
export const ORIGEM_SNAPSHOT = 'https://pia.travelrpg.com';

export const DOCUMENTOS = Object.freeze({
  privacidade: Object.freeze({
    titulo: 'Política de Privacidade',
    descricao: 'Política de Privacidade da PIA: quais dados são coletados, para que são usados, com quem são compartilhados e como exercer seus direitos.',
    outro: 'termos',
  }),
  termos: Object.freeze({
    titulo: 'Termos de Serviço',
    descricao: 'Termos de Serviço da PIA: regras de uso, isenção de garantias, limitação de responsabilidade e foro.',
    outro: 'privacidade',
  }),
});

const HTML_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapa texto não confiável para inserção em texto e atributos HTML. */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char]);
}

/** Converte 'AAAA-MM-DD' em 'DD/MM/AAAA' sem usar fuso nem a data do servidor. */
export function formatarData(iso) {
  if (iso === null || iso === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!match) throw new Error(`Data legal inválida: ${iso} (use AAAA-MM-DD).`);
  const [, ano, mes, dia] = match;
  const y = Number(ano), m = Number(mes), d = Number(dia);
  const diasNoMes = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > diasNoMes[m - 1]) throw new Error(`Data legal inexistente: ${iso}.`);
  return `${dia}/${mes}/${ano}`;
}

/**
 * Substitui cada {{NOME}} por valores[NOME], que já deve estar em HTML seguro.
 * Lança erro para token desconhecido, sem valor ou malformado.
 */
export function renderTokens(texto, valores, onde = 'texto legal') {
  const saida = String(texto).replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_, nome) => {
    if (!Object.hasOwn(valores, nome)) throw new Error(`Token desconhecido {{${nome}}} em ${onde}.`);
    const valor = valores[nome];
    if (valor === null || valor === undefined || valor === '') throw new Error(`Token {{${nome}}} sem valor em ${onde}.`);
    return valor;
  });
  if (saida.includes('{{') || saida.includes('}}')) throw new Error(`Token malformado em ${onde}.`);
  return saida;
}

const selo = (texto) => '<span class="legal-pendente">[' + escapeHtml(texto) + ']</span>';

function padrao() {
  return {
    dados: DADOS,
    juridico: JURIDICO,
    versoes: VERSOES,
    conteudo: (documento, versao) =>
      readFileSync(new URL(`./legal/conteudo/${documento}-v${versao}.html`, import.meta.url), 'utf8'),
  };
}

function fontesCom(fontes = {}) {
  const base = { ...padrao(), ...fontes };
  validarFontes(base);
  return base;
}

function validarFontes({ dados, juridico, versoes }) {
  for (const [nome, valor] of Object.entries(dados)) {
    if (typeof valor !== 'string' || !valor.trim()) throw new Error(`Dado legal ${nome} sem valor.`);
  }
  for (const [conjunto, trechos] of Object.entries(juridico)) {
    for (const [nome, item] of Object.entries(trechos)) {
      const onde = `Trecho jurídico ${conjunto}/${nome}`;
      if (Object.hasOwn(dados, nome)) throw new Error(`Chave ${nome} repetida em dados e juridico.`);
      if (typeof item?.texto !== 'string' || !item.texto.trim()) throw new Error(`${onde} sem texto.`);
      if (typeof item.revisado !== 'boolean') throw new Error(`${onde} sem revisado:true|false.`);
      if (!item.revisado && (!item.pendencia || !item.assunto)) throw new Error(`${onde} sem pendencia/assunto.`);
    }
  }
  for (const documento of Object.keys(DOCUMENTOS)) {
    const lista = versoes[documento];
    if (!Array.isArray(lista) || !lista.length) throw new Error(`Manifesto sem versões de ${documento}.`);
    let anterior = [-1, -1];
    for (const item of lista) {
      if (!/^\d+\.\d+$/.test(item.versao)) throw new Error(`Versão inválida de ${documento}: ${item.versao}.`);
      const atual = item.versao.split('.').map(Number);
      if (atual[0] < anterior[0] || (atual[0] === anterior[0] && atual[1] <= anterior[1])) {
        throw new Error(`Versões de ${documento} fora de ordem crescente: ${item.versao}.`);
      }
      anterior = atual;
      formatarData(item.vigencia);
      formatarData(item.atualizacao);
      if (typeof item.resumo !== 'string' || !item.resumo.trim()) throw new Error(`Versão ${item.versao} de ${documento} sem resumo.`);
      if (!Object.hasOwn(juridico, item.juridico)) throw new Error(`Versão ${item.versao} de ${documento} aponta conjunto jurídico inexistente: ${item.juridico}.`);
    }
  }
}

/** Publicada = vigência preenchida. Só versões publicadas têm rota /vX.Y. */
const publicada = (item) => item.vigencia !== null && item.vigencia !== undefined;

/**
 * Versão atual de um documento (a servida em /privacidade e /termos): a última publicada; se
 * nenhuma estiver publicada, a última do manifesto (rascunho, só nessas duas rotas).
 */
export function versaoAtual(lista) {
  return lista.filter(publicada).at(-1) || lista.at(-1);
}

function caminho(documento, versao) {
  return versao ? `/${documento}/v${versao}` : `/${documento}`;
}

/** Valores HTML (já escapados) de todos os tokens de uma página, registrando os selos emitidos. */
function valoresTokens(fontes, documento, item, origin, registro) {
  const valores = {};
  for (const [nome, valor] of Object.entries(fontes.dados)) valores[nome] = escapeHtml(valor);
  valores.ORIGEM = escapeHtml(origin);
  valores.URL_PRIVACIDADE = escapeHtml(origin + '/privacidade');
  valores.URL_TERMOS = escapeHtml(origin + '/termos');
  valores.VERSAO = escapeHtml(item.versao);
  valores.VIGENCIA = data(item.vigencia, 'data de vigência', documento, item, registro);
  valores.ATUALIZACAO = data(item.atualizacao, 'data de atualização', documento, item, registro);
  const dadosHtml = { ...valores };
  for (const [nome, trecho] of Object.entries(fontes.juridico[item.juridico])) {
    const texto = renderTokens(escapeHtml(trecho.texto), dadosHtml, `juridico.js (${item.juridico}/${nome})`);
    if (trecho.revisado) { valores[nome] = texto; continue; }
    // Um getter registra a pendência só quando o token é de fato usado na página.
    Object.defineProperty(valores, nome, {
      enumerable: true,
      get() {
        registro.add(`juridico:${nome}`);
        return selo(`EM REVISÃO JURÍDICA: ${trecho.pendencia} ${trecho.assunto}`) + ' ' + texto;
      },
    });
  }
  return valores;
}

function data(iso, rotulo, documento, item, registro) {
  const formatada = formatarData(iso);
  if (formatada) return formatada;
  registro.add(`data:${documento}:${item.versao}:${rotulo}`);
  return selo(`PREENCHER NO RELEASE: ${rotulo}`);
}

function separarResumo(fragmento, onde) {
  const blocos = fragmento.split('<!-- legal:resumo -->');
  if (blocos.length !== 2) throw new Error(`${onde}: use exatamente um bloco <!-- legal:resumo -->.`);
  const [antes, resto] = blocos;
  const partes = resto.split('<!-- /legal:resumo -->');
  if (partes.length !== 2) throw new Error(`${onde}: bloco "Em resumo" sem <!-- /legal:resumo -->.`);
  const [resumo, depois] = partes;
  const itens = (resumo.match(/<li\b/g) || []).length;
  if (itens < 3 || itens > 5) throw new Error(`${onde}: "Em resumo" precisa de 3 a 5 itens (tem ${itens}).`);
  return { resumo: resumo.trim(), corpo: (antes + depois).trim() };
}

const ENTIDADES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
const textoPuro = (html) => html.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTIDADES[e]).trim();

function secoes(corpo, onde) {
  const lista = [];
  const ids = new Set();
  for (const [, atributos, conteudo] of corpo.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/g)) {
    const id = /\bid="([a-z0-9-]+)"/.exec(atributos)?.[1];
    if (!id) throw new Error(`${onde}: todo <h2> precisa de id="slug" (a-z, 0-9, hífen).`);
    if (ids.has(id) || RESERVADOS.has(id)) throw new Error(`${onde}: id de seção repetido ou reservado: ${id}.`);
    ids.add(id);
    // Texto puro do título (sem tags, entidades decodificadas); escapado de novo no sumário.
    lista.push({ id, titulo: textoPuro(conteudo) });
  }
  if (!lista.length) throw new Error(`${onde}: nenhuma seção <h2 id="..."> encontrada.`);
  return lista;
}

function verificarFragmento(fragmento, onde) {
  if (/<h1\b/i.test(fragmento)) throw new Error(`${onde}: o fragmento não pode ter <h1> (é gerado pelo layout).`);
  if (/<script\b/i.test(fragmento)) throw new Error(`${onde}: o fragmento não pode ter <script>.`);
  if (/\son[a-z]+\s*=/i.test(fragmento)) throw new Error(`${onde}: o fragmento não pode ter atributos on*=.`);
}

function cabecaHtml({ titulo, descricao, canonical, rascunho, noindex = rascunho }) {
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(titulo) + ' · PIA</title>' +
    '<meta name="description" content="' + escapeHtml(descricao) + '">' +
    (canonical ? '<link rel="canonical" href="' + escapeHtml(canonical) + '">' : '') +
    (noindex ? '<meta name="robots" content="noindex">' : '') +
    '<link rel="icon" href="/pia.svg"><link rel="stylesheet" href="/legal.css"></head><body>' +
    (rascunho ? '<p class="legal-rascunho" role="note"><strong>RASCUNHO, não publicar.</strong> Este texto ainda tem pendências e não foi aprovado.</p>' : '');
}

/** Tabela de versões até a versão renderizada (a cópia congelada não cita versões posteriores). */
function historico(fontes, documento, ate, registro) {
  const lista = fontes.versoes[documento];
  const linhas = lista.slice(0, lista.indexOf(ate) + 1).map((item) =>
    '<tr><td>' + (publicada(item)
      ? '<a href="' + caminho(documento, item.versao) + '">' + escapeHtml(item.versao) + '</a>'
      : escapeHtml(item.versao)) + '</td>' +
    '<td>' + data(item.vigencia, 'data de vigência', documento, item, registro) + '</td>' +
    '<td>' + data(item.atualizacao, 'data de atualização', documento, item, registro) + '</td>' +
    '<td>' + escapeHtml(item.resumo) + '</td></tr>').join('');
  return '<section class="legal-historico" aria-labelledby="historico-de-versoes">' +
    '<h2 id="historico-de-versoes">Histórico de versões</h2>' +
    '<table><thead><tr><th scope="col">Versão</th><th scope="col">Vigente a partir de</th>' +
    '<th scope="col">Última atualização</th><th scope="col">Resumo da mudança</th></tr></thead>' +
    '<tbody>' + linhas + '</tbody></table></section>';
}

/**
 * Renderiza uma versão de um documento. Sem `versao`, usa a atual (versaoAtual: última publicada,
 * ou a última em rascunho se nada estiver publicado).
 * Retorna { html, rascunho, headers, pendencias } e lança erro em qualquer problema de conteúdo.
 */
export function renderDocumento(documento, versao, origin, fontes) {
  const meta = DOCUMENTOS[documento];
  if (!meta) throw new Error(`Documento legal desconhecido: ${documento}.`);
  const base = fontesCom(fontes);
  origin = new URL(origin).origin;
  const lista = base.versoes[documento];
  const item = versao ? lista.find((v) => v.versao === versao) : versaoAtual(lista);
  if (!item) throw new Error(`Versão ${versao} de ${documento} não existe no manifesto.`);
  const onde = `${documento}-v${item.versao}.html`;
  const registro = new Set();
  // Comentários HTML do fragmento não vão para a página (exceto os marcadores legal:resumo).
  const fragmento = base.conteudo(documento, item.versao).replace(/<!--(?!\s*\/?legal:)[\s\S]*?-->/g, '');
  verificarFragmento(fragmento, onde);
  const valores = valoresTokens(base, documento, item, origin, registro);
  const { resumo, corpo } = separarResumo(renderTokens(fragmento, valores, onde), onde);
  const lista_secoes = secoes(corpo, onde);
  const outro = DOCUMENTOS[meta.outro];
  const dados = base.dados;

  const sumario = '<nav class="legal-sumario" aria-labelledby="sumario"><h2 id="sumario">Sumário</h2><ol>' +
    [{ id: 'em-resumo', titulo: 'Em resumo' }, ...lista_secoes, { id: 'historico-de-versoes', titulo: 'Histórico de versões' }]
      .map(({ id, titulo }) => '<li><a href="#' + id + '">' + escapeHtml(titulo) + '</a></li>').join('') +
    '</ol></nav>';
  const conteudo =
    '<main class="legal"><header class="legal-cabecalho">' +
    '<p class="legal-voltar"><a href="/">Voltar à PIA</a></p>' +
    '<h1>' + escapeHtml(meta.titulo) + '</h1>' +
    '<p class="legal-datas">Versão ' + escapeHtml(item.versao) +
    ' · Vigente a partir de ' + valores.VIGENCIA + ' · Última atualização: ' + valores.ATUALIZACAO + '</p>' +
    '<p class="legal-outro">Veja também: <a href="/' + meta.outro + '">' + escapeHtml(outro.titulo) + '</a></p>' +
    '</header>' +
    '<section class="legal-resumo" aria-labelledby="em-resumo"><h2 id="em-resumo">Em resumo</h2>' + resumo + '</section>' +
    sumario +
    '<article class="legal-corpo">' + corpo + '</article>' +
    historico(base, documento, item, registro) +
    '<footer class="legal-rodape"><p>Controlador e contato: ' + escapeHtml(dados.CONTROLADOR_NOME) +
    ', <a href="mailto:' + escapeHtml(dados.CONTATO_EMAIL) + '">' + escapeHtml(dados.CONTATO_EMAIL) + '</a>.</p>' +
    '<p><a href="/privacidade">Política de Privacidade</a> · <a href="/termos">Termos de Serviço</a> · <a href="/">Voltar à PIA</a></p>' +
    '</footer></main></body></html>';
  const rascunho = registro.size > 0 || conteudo.replace(/<span class="legal-pendente">\[[^\]]*\]<\/span>/g, '').includes('[');
  const html = cabecaHtml({
    titulo: meta.titulo,
    descricao: meta.descricao,
    canonical: origin + caminho(documento, versao),
    rascunho,
  }) + conteudo;
  return {
    html,
    rascunho,
    headers: { ...(rascunho ? HEADERS_RASCUNHO : HEADERS_FINAL) },
    pendencias: [...registro],
  };
}

/** Entradas [caminho, [tipo, html, headers]] para o mapa publicFiles de src/index.js. */
export function legalFiles(origin, fontes) {
  const base = fontesCom(fontes);
  const entradas = [];
  for (const documento of Object.keys(DOCUMENTOS)) {
    const atual = renderDocumento(documento, undefined, origin, base);
    entradas.push([caminho(documento), [HTML, atual.html, atual.headers]]);
    for (const item of base.versoes[documento].filter(publicada)) {
      const pagina = renderDocumento(documento, item.versao, origin, base);
      entradas.push([caminho(documento, item.versao), [HTML, pagina.html, pagina.headers]]);
    }
  }
  return entradas;
}

function redirecionamentos(versoes) {
  const mapa = new Map([
    ['/privacy', '/privacidade'],
    ['/privacidade/', '/privacidade'],
    ['/terms', '/termos'],
    ['/termos/', '/termos'],
  ]);
  for (const documento of Object.keys(DOCUMENTOS)) {
    for (const { versao } of versoes[documento].filter(publicada)) {
      mapa.set(caminho(documento, versao) + '/', caminho(documento, versao));
    }
  }
  return mapa;
}

/** Aliases (301) para o caminho canônico relativo. A query string deve ser descartada pelo chamador. */
export const legalRedirects = redirecionamentos(VERSOES);

/** Mesmo mapa de legalRedirects, calculado a partir de outras fontes (testes e preview). */
export function redirecionamentosLegais(fontes) {
  return redirecionamentos(fontesCom(fontes).versoes);
}

/**
 * 404 em HTML para /privacidade/* e /termos/* desconhecidos (ex.: /termos/v9.9), com links para as
 * versões atuais. Retorna null para qualquer outro caminho (o 404 global continua JSON).
 * O caminho pedido não é ecoado na página.
 */
export function legalNotFound(path, fontes) {
  if (!/^\/(privacidade|termos)\/./.test(String(path))) return null;
  const base = fontesCom(fontes);
  const conhecidos = new Set([...redirecionamentos(base.versoes).keys()]);
  for (const documento of Object.keys(DOCUMENTOS)) {
    for (const { versao } of base.versoes[documento].filter(publicada)) conhecidos.add(caminho(documento, versao));
  }
  if (conhecidos.has(path)) return null;
  const links = Object.entries(DOCUMENTOS).map(([documento, meta]) => {
    const atual = versaoAtual(base.versoes[documento]).versao;
    return '<li><a href="/' + documento + '">' + escapeHtml(meta.titulo) + '</a> (versão atual, ' + escapeHtml(atual) + ')</li>';
  }).join('');
  const body = cabecaHtml({
    titulo: 'Página não encontrada',
    descricao: 'Página legal não encontrada na PIA.',
    canonical: null,
    rascunho: false,
    noindex: true,
  }) +
    '<main class="legal"><h1>Página não encontrada</h1>' +
    '<p>Esta versão ou página não existe. Consulte as versões atuais:</p><ul>' + links + '</ul>' +
    '<p><a href="/">Voltar à PIA</a></p></main></body></html>';
  return {
    status: 404,
    headers: { 'Content-Type': HTML, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    body,
  };
}

/**
 * Rodapé com os links para a Política e os Termos, para as páginas de autorização e de callback.
 * Com { ciencia: true }, inclui o texto de ciência do RF05 (telas de login).
 */
export function legalFooter({ ciencia = false } = {}) {
  return '<footer class="legal-footer">' +
    (ciencia ? '<p>Ao continuar, você concorda com os <a href="/termos">Termos de Serviço</a> e declara ter lido a <a href="/privacidade">Política de Privacidade</a>.</p>' : '') +
    '<p><a href="/privacidade">Política de Privacidade</a> · <a href="/termos">Termos de Serviço</a></p>' +
    '</footer>';
}

/**
 * Pendências ativas de todas as versões: trechos jurídicos com revisado:false e datas null.
 * Lista vazia significa que nada no manifesto e em juridico.js impede o release.
 */
export function pendencias(fontes) {
  const base = fontesCom(fontes);
  const lista = [];
  const usados = new Set(Object.values(base.versoes).flat().map((item) => item.juridico));
  for (const conjunto of usados) {
    for (const [chave, trecho] of Object.entries(base.juridico[conjunto])) {
      if (!trecho.revisado) lista.push({ tipo: 'juridico', conjunto, chave, pendencia: trecho.pendencia, assunto: trecho.assunto });
    }
  }
  for (const documento of Object.keys(DOCUMENTOS)) {
    for (const item of base.versoes[documento]) {
      for (const campo of ['vigencia', 'atualizacao']) {
        if (item[campo] === null || item[campo] === undefined) lista.push({ tipo: 'data', documento, versao: item.versao, campo });
      }
    }
  }
  return lista;
}

/** sha256 (hex) do HTML de uma versão, renderizado com ORIGEM_SNAPSHOT. */
export function hashDocumento(documento, versao, fontes) {
  return createHash('sha256').update(renderDocumento(documento, versao, ORIGEM_SNAPSHOT, fontes).html).digest('hex');
}

/**
 * Versões publicadas (vigencia preenchida) cujo HTML não bate com o sha256 do manifesto.
 * Lista vazia = todas as versões publicadas continuam congeladas. Texto novo exige versão nova.
 */
export function versoesAlteradas(fontes) {
  const base = fontesCom(fontes);
  const lista = [];
  for (const documento of Object.keys(DOCUMENTOS)) {
    for (const item of base.versoes[documento].filter(publicada)) {
      const atual = hashDocumento(documento, item.versao, base);
      if (item.sha256 !== atual) lista.push({ documento, versao: item.versao, esperado: item.sha256 ?? null, atual });
    }
  }
  return lista;
}

/**
 * Texto simples de um trecho jurídico do conjunto usado pela versão atual do documento, para uso
 * fora do HTML (ex.: embed do Discord). Tokens de dados são resolvidos sem escape HTML; com
 * revisado:false, o texto vem precedido do selo de rascunho.
 */
export function textoJuridico(chave, documento = 'privacidade', fontes) {
  const base = fontesCom(fontes);
  const lista = base.versoes[documento];
  if (!lista) throw new Error(`Documento legal desconhecido: ${documento}.`);
  const conjunto = versaoAtual(lista).juridico;
  const trecho = base.juridico[conjunto][chave];
  if (!trecho) throw new Error(`Trecho jurídico desconhecido: ${chave} (conjunto ${conjunto}).`);
  const texto = renderTokens(trecho.texto, base.dados, `juridico.js (${conjunto}/${chave})`);
  return trecho.revisado ? texto : `[EM REVISÃO JURÍDICA: ${trecho.pendencia} ${trecho.assunto}] ${texto}`;
}
