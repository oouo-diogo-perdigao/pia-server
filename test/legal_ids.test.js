// Ids das seções da v1.0 congelados (decisão do TechLead): viram URLs compartilháveis
// (/privacidade#retencao) e não podem mudar entre versões. A lista vem dos fragmentos v1.0 do
// DevFullstack Time 2 (branch time2-feature-0002-fullstack, fe2d57c, igual à branch da tarefa em
// 6a623da), mais os ids gerados pelo layout de src/legal.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { legalFiles } from '../src/legal.js';

const SECOES_V1_0 = {
  privacidade: [
    'quem-somos', 'escopo', 'dados-coletados', 'finalidades', 'bases-legais', 'compartilhamento',
    'transferencia-internacional', 'retencao', 'seguranca', 'direitos-do-titular', 'cookies', 'menores',
    'mudancas', 'contato',
  ],
  termos: [
    'aceitacao', 'descricao-do-servico', 'conta-e-elegibilidade', 'uso-aceitavel', 'conteudo-e-licenca',
    'conteudo-gerado-por-ia', 'isencao-de-garantias', 'limitacao-de-responsabilidade',
    'disponibilidade-e-perda-de-dados', 'suspensao-e-encerramento', 'mudancas-nos-termos', 'lei-e-foro', 'contato',
  ],
};
const GERADOS = ['conteudo', 'em-resumo', 'sumario', 'sumario-t', 'historico-de-versoes'];
const h2Ids = (html) => [...html.matchAll(/<h2 id="([^"]+)"/g)].map(([, id]) => id);

test('fragmentos v1.0 mantêm os ids de seção congelados, na ordem', () => {
  for (const [documento, ids] of Object.entries(SECOES_V1_0)) {
    const fragmento = readFileSync(new URL(`../src/legal/conteudo/${documento}-v1.0.html`, import.meta.url), 'utf8');
    assert.deepEqual(h2Ids(fragmento), ids, documento);
  }
});

test('páginas renderizadas têm os ids congelados mais os gerados pelo layout, e o sumário aponta para eles', () => {
  const paginas = new Map(legalFiles('https://pia.travelrpg.com'));
  for (const [documento, ids] of Object.entries(SECOES_V1_0)) {
    const html = paginas.get('/' + documento)[1];
    assert.deepEqual(h2Ids(html), ['em-resumo', 'sumario-t', ...ids, 'historico-de-versoes'], documento);
    const todos = [...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
    for (const id of [...GERADOS, ...ids]) assert.ok(todos.includes(id), `${documento}#${id}`);
    assert.equal(new Set(todos).size, todos.length, 'ids únicos');
    const ancoras = [...html.matchAll(/<nav class="legal-sumario"[\s\S]*?<\/nav>/g)][0][0].match(/href="#([^"]+)"/g)
      .map((a) => a.slice(7, -1));
    assert.deepEqual(ancoras, ['em-resumo', ...ids, 'historico-de-versoes']);
  }
});
