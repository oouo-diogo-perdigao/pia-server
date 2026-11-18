// Manifesto de versões das páginas legais (plano técnico, T01 e seção 3.4).
//
// Cada documento lista suas versões em ordem crescente. A versão atual (/privacidade, /termos) é a
// ÚLTIMA PUBLICADA (vigencia preenchida); se nenhuma estiver publicada, é a última em rascunho.
// Uma versão nova em rascunho (ex.: 1.1 com vigencia null) não substitui a publicada até o release.
// Toda versão PUBLICADA também é servida congelada em /privacidade/vX.Y e /termos/vX.Y (e o alias
// com barra final), a partir de src/legal/conteudo/<documento>-vX.Y.html, que nunca muda depois de
// publicado. Versão em rascunho não tem /vX.Y (404 legal); veja-a com npm run legal:preview.
//
//   versao:      'X.Y' (RN05: X para mudança relevante de finalidade ou dado).
//   vigencia:    'AAAA-MM-DD' ou null. Preenchida só no commit "release legal vX.Y" com a data
//                planejada do deploy; nunca a data dinâmica do servidor.
//   atualizacao: 'AAAA-MM-DD' ou null, mesma regra.
//   resumo:      texto simples para a tabela "Histórico de versões".
//   juridico:    chave do conjunto de trechos em src/legal/juridico.js usado por esta versão.
//   sha256:      hash do HTML congelado (renderizado com ORIGEM_SNAPSHOT), obrigatório quando
//                vigencia está preenchida. Preenchido no commit de release com o valor que o teste
//                de test/legal.test.js informa; o teste falha se o HTML publicado mudar depois.
//
// Só versões com vigencia preenchida são "publicadas" e ganham a rota /vX.Y. Uma versão em
// rascunho só aparece como atual (/privacidade, /termos) e /vX.Y dela responde o 404 legal.
//
// Data null liga o modo rascunho e aparece como "[PREENCHER NO RELEASE: ...]".

export const VERSOES = Object.freeze({
  privacidade: Object.freeze([
    Object.freeze({ versao: '1.0', vigencia: null, atualizacao: null, resumo: 'Primeira versão.', juridico: '1.0', sha256: null }),
  ]),
  termos: Object.freeze([
    Object.freeze({ versao: '1.0', vigencia: null, atualizacao: null, resumo: 'Primeira versão.', juridico: '1.0', sha256: null }),
  ]),
});
