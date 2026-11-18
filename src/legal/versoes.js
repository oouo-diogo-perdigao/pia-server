// Manifesto de versões das páginas legais (plano técnico, T01 e seção 3.4).
//
// Cada documento lista suas versões em ordem crescente; a última é a atual (/privacidade, /termos).
// Toda versão também é servida congelada em /privacidade/vX.Y e /termos/vX.Y, a partir do
// arquivo src/legal/conteudo/<documento>-vX.Y.html, que nunca muda depois de publicado.
//
//   versao:      'X.Y' (RN05: X para mudança relevante de finalidade ou dado).
//   vigencia:    'AAAA-MM-DD' ou null. Preenchida só no commit "release legal vX.Y" com a data
//                planejada do deploy; nunca a data dinâmica do servidor.
//   atualizacao: 'AAAA-MM-DD' ou null, mesma regra.
//   resumo:      texto simples para a tabela "Histórico de versões".
//
// Data null liga o modo rascunho e aparece como "[PREENCHER NO RELEASE: ...]".

export const VERSOES = Object.freeze({
  privacidade: Object.freeze([
    Object.freeze({ versao: '1.0', vigencia: null, atualizacao: null, resumo: 'Primeira versão.' }),
  ]),
  termos: Object.freeze([
    Object.freeze({ versao: '1.0', vigencia: null, atualizacao: null, resumo: 'Primeira versão.' }),
  ]),
});
