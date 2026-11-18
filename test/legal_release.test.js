import assert from 'node:assert/strict';
import test from 'node:test';
import { DOCUMENTOS, hashDocumento, legalFiles, pendencias, versoesAlteradas } from '../src/legal.js';

// Gate de release das páginas legais (RN07, CA11, plano técnico 3.5). Usa o motor da F2-01 (src/legal.js).
// Com PIA_LEGAL_RELEASE=1 (CI em push para main e tags v*), falha se:
//  - pendencias() não estiver vazia (trecho jurídico com revisado:false ou data null em versoes.js);
//  - alguma página servida estiver em modo rascunho;
//  - o HTML servido tiver "[", TODO, XXX, lorem ou example.invalid;
//  - uma versão publicada tiver HTML diferente do sha256 do manifesto (versoesAlteradas()).
// Sem a variável, valida o próprio gate com fixtures e lista as pendências como diagnóstico.

const RELEASE = process.env.PIA_LEGAL_RELEASE === '1';
const PROIBIDOS = [['colchete', /\[/], ['TODO', /TODO/], ['XXX', /XXX/], ['lorem', /lorem/i], ['example.invalid', /example\.invalid/i]];

function problemasDoRelease(fontes) {
  const problemas = pendencias(fontes).map((p) => (p.tipo === 'juridico'
    ? `juridico.js ${p.conjunto}/${p.chave} (${p.pendencia} ${p.assunto}) com revisado:false`
    : `versoes.js ${p.documento} v${p.versao}: ${p.campo} nula`));
  for (const [caminho, [, html, headers]] of legalFiles('https://pia.travelrpg.com', fontes)) {
    if (headers['X-Robots-Tag'] === 'noindex' || headers['Cache-Control'] !== 'public, max-age=3600') problemas.push(`${caminho}: servido em modo rascunho`);
    for (const [rotulo, padrao] of PROIBIDOS) if (padrao.test(html)) problemas.push(`${caminho}: contém ${rotulo}`);
  }
  for (const v of versoesAlteradas(fontes)) problemas.push(`${v.documento} v${v.versao}: HTML publicado diferente do sha256 do manifesto`);
  return problemas;
}

const conteudoFixture = '<!-- legal:resumo --><ul><li>Gratuito.</li><li>Sem garantias.</li><li>Treinamento.</li></ul><!-- /legal:resumo -->' +
  '<h2 id="contato">Contato</h2><p>{{CONTROLADOR_NOME}}, {{CONTATO_EMAIL}}</p><p>{{TRECHO}}</p>';

function fixture({ revisado = true, datas = true, conteudo = conteudoFixture } = {}) {
  const item = { versao: '1.0', vigencia: datas ? '2026-12-01' : null, atualizacao: datas ? '2026-12-01' : null, resumo: 'Primeira versão.', juridico: '1.0', sha256: null };
  const base = {
    dados: { CONTROLADOR_NOME: 'Controlador de teste', CONTATO_EMAIL: 'contato@pia.example' },
    juridico: { '1.0': { TRECHO: { texto: 'Trecho aprovado.', revisado, pendencia: 'P10', assunto: 'teste' } } },
    versoes: { privacidade: [{ ...item }], termos: [{ ...item }] },
    conteudo: () => conteudo,
  };
  if (datas) {
    // Versão publicada leva o sha256 do HTML congelado (mecanismo da F2-01).
    for (const documento of Object.keys(DOCUMENTOS)) base.versoes[documento][0].sha256 = hashDocumento(documento, '1.0', base);
  }
  return base;
}

test('gate passa com fixture final (revisado, datas, sha256 e sem placeholder)', () => {
  assert.deepEqual(problemasDoRelease(fixture()), []);
});

test('gate falha com rascunho: revisado:false, datas nulas e colchete no texto', () => {
  const problemas = problemasDoRelease(fixture({ revisado: false, datas: false }));
  for (const esperado of [/revisado:false/, /vigencia nula/, /atualizacao nula/, /modo rascunho/, /colchete/]) {
    assert.ok(problemas.some((p) => esperado.test(p)), `esperava problema ${esperado}:\n${problemas.join('\n')}`);
  }
  const comTodo = problemasDoRelease(fixture({ conteudo: conteudoFixture + '<p>TODO lorem</p>' }));
  assert.ok(comTodo.some((p) => /TODO/.test(p)) && comTodo.some((p) => /lorem/.test(p)));
});

test('gate de release: páginas legais prontas para publicar (PIA_LEGAL_RELEASE=1)', (t) => {
  const problemas = problemasDoRelease();
  if (!RELEASE) {
    t.diagnostic(`modo rascunho: ${problemas.length} pendência(s) bloqueariam o release`);
    for (const p of problemas) t.diagnostic(p);
    t.skip('defina PIA_LEGAL_RELEASE=1 para aplicar o gate');
    return;
  }
  assert.deepEqual(problemas, [], `release legal bloqueado:\n- ${problemas.join('\n- ')}`);
});
