// Congelamento das versões publicadas (review C2 da F2-01).
// Cada versão com vigencia preenchida guarda em src/legal/versoes.js o sha256 do HTML renderizado com
// a origem fixa ORIGEM_SNAPSHOT. Se o HTML dessa versão mudar (conteúdo, dados.js, juridico.js,
// layout), este teste falha: texto novo = versão nova (RN05, RF07).
import assert from 'node:assert/strict';
import test from 'node:test';
import { ORIGEM_SNAPSHOT, hashDocumento, versoesAlteradas } from '../src/legal.js';
import { VERSOES } from '../src/legal/versoes.js';

test('manifesto real: toda versão publicada tem sha256 salvo e o HTML dela não mudou', () => {
  assert.equal(ORIGEM_SNAPSHOT, 'https://pia.travelrpg.com');
  for (const [documento, lista] of Object.entries(VERSOES)) {
    for (const { versao, vigencia, sha256 } of lista.filter((item) => item.vigencia)) {
      const atual = hashDocumento(documento, versao);
      assert.equal(sha256, atual,
        `${documento} v${versao} (vigente a partir de ${vigencia}) está publicada: no release, preencha ` +
        `sha256: '${atual}' em src/legal/versoes.js; se o texto mudou depois, crie uma versão nova.`);
    }
  }
  assert.deepEqual(versoesAlteradas(), []);
});

// Fontes de teste com uma versão publicada fictícia (privacidade 1.0) e uma em rascunho (termos 1.0).
const FRAGMENTO =
  '<!-- legal:resumo --><ul><li>Gratuito.</li><li>Sem garantias.</li><li>Treinamento.</li></ul><!-- /legal:resumo -->' +
  '<h2 id="contato">Contato</h2><p>{{CONTROLADOR_NOME}}, {{CONTATO_EMAIL}}</p><p>{{TRECHO}}</p>';

function fontes({ dados = {}, trecho = {}, conteudo = FRAGMENTO, sha256 = null, vigencia = '2026-12-01' } = {}) {
  return {
    dados: { CONTROLADOR_NOME: 'Controlador Fictício', CONTATO_EMAIL: 'contato@pia.example', ...dados },
    juridico: {
      '1.0': { TRECHO: { texto: 'Trecho revisado.', revisado: true, ...trecho } },
      '1.1': { TRECHO: { texto: 'Trecho de uma versão futura.', revisado: false, pendencia: 'P10', assunto: 'teste' } },
    },
    versoes: {
      privacidade: [{ versao: '1.0', vigencia, atualizacao: vigencia, resumo: 'Primeira.', juridico: '1.0', sha256 }],
      termos: [{ versao: '1.0', vigencia: null, atualizacao: null, resumo: 'Primeira.', juridico: '1.0', sha256: null }],
    },
    conteudo: () => conteudo,
  };
}

const SALVO = hashDocumento('privacidade', '1.0', fontes());

test('o hash é sha256 determinístico, com origem fixa', () => {
  assert.match(SALVO, /^[0-9a-f]{64}$/);
  assert.equal(hashDocumento('privacidade', '1.0', fontes()), SALVO);
  assert.deepEqual(versoesAlteradas(fontes({ sha256: SALVO })), [], 'termos em rascunho fica fora do congelamento');
});

test('versão publicada sem hash salvo falha', () => {
  assert.deepEqual(versoesAlteradas(fontes()), [{ documento: 'privacidade', versao: '1.0', esperado: null, atual: SALVO }]);
});

test('mudança em dados.js, juridico.js, conteúdo ou datas de uma versão publicada quebra o hash', () => {
  const casos = {
    'dados.js': fontes({ sha256: SALVO, dados: { CONTATO_EMAIL: 'outro@pia.example' } }),
    'juridico.js (texto)': fontes({ sha256: SALVO, trecho: { texto: 'Trecho alterado.' } }),
    'juridico.js (revisado)': fontes({ sha256: SALVO, trecho: { revisado: false, pendencia: 'P10', assunto: 'x' } }),
    'conteúdo': fontes({ sha256: SALVO, conteudo: FRAGMENTO + '<p>Parágrafo novo.</p>' }),
    'vigência': fontes({ sha256: SALVO, vigencia: '2026-12-02' }),
  };
  for (const [origem, alterada] of Object.entries(casos)) {
    const [falha] = versoesAlteradas(alterada);
    assert.ok(falha, `mudança em ${origem} deveria quebrar o congelamento`);
    assert.equal(falha.esperado, SALVO);
    assert.notEqual(falha.atual, SALVO);
  }
});

test('texto jurídico novo em outro conjunto (versão nova) não altera a versão publicada', () => {
  const comConjuntoNovo = fontes({ sha256: SALVO });
  comConjuntoNovo.juridico['1.1'] = { TRECHO: { texto: 'Redação nova do Advogado.', revisado: true } };
  assert.deepEqual(versoesAlteradas(comConjuntoNovo), []);
});
