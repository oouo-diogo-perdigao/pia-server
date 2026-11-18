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
//                de test/legal_snapshot.test.js informa; o teste falha se o HTML publicado mudar depois.
//
// Só versões com vigencia preenchida são "publicadas" e ganham a rota /vX.Y. Uma versão em
// rascunho só aparece como atual (/privacidade, /termos) e /vX.Y dela responde o 404 legal.
//
// Data null liga o modo rascunho e aparece como "[PREENCHER NO RELEASE: ...]".

// Resumos da v1.1 para o "Histórico de versões" (release legal v1.1, 2026-11-18, só com o Suno).
// Parecer da v1.1, Op1 (seção 7), na Alternativa A do O1, mais a nota de que a v1.0 foi substituída antes de ir para a
// produção (O2 do parecer). A nota fica só no resumo da v1.1: o resumo da v1.0 aparece na cópia congelada /v1.0 e não
// pode mudar sem quebrar o sha256 dela.
const RESUMO_V1_1_SUNO = 'Conta Suno, histórico de gerações de música e o Suno como terceiro. Os dados da conta Suno e o histórico de gerações de música ficam fora do treinamento. A versão 1.0, aprovada em 17/11/2026, foi substituída por esta antes de ser publicada em produção.';
const RESUMO_V1_1 = RESUMO_V1_1_SUNO;
const RESUMO_V1_1_TERMOS = RESUMO_V1_1_SUNO;

export const VERSOES = Object.freeze({
  privacidade: Object.freeze([
    Object.freeze({ versao: '1.0', vigencia: '2026-11-17', atualizacao: '2026-11-17', resumo: 'Primeira versão.', juridico: '1.0', sha256: 'a2ff6c287715f4c54d38b7d8796a07a4422537505b559893ed97126a0fcec3ad' }),
    // v1.1 (feature 0004): release legal v1.1, parecer do Advogado sobre 3862937 (favorável com ressalvas).
    Object.freeze({ versao: '1.1', vigencia: '2026-11-18', atualizacao: '2026-11-18', resumo: RESUMO_V1_1, juridico: '1.1', sha256: '3cbf9340a46b5e747739522c275f73a9611c2831e3848ec4836e188f3ebb153e' }),
  ]),
  termos: Object.freeze([
    Object.freeze({ versao: '1.0', vigencia: '2026-11-17', atualizacao: '2026-11-17', resumo: 'Primeira versão.', juridico: '1.0', sha256: '9b9b7335fcd2ea0f138f36932c4b933f99e81a58bdb44c76bc4b862a013ce99f' }),
    Object.freeze({ versao: '1.1', vigencia: '2026-11-18', atualizacao: '2026-11-18', resumo: RESUMO_V1_1_TERMOS, juridico: '1.1', sha256: 'd1c0db237cabbda801fc49be04d4412f86d545c5aaa6a1e68cb61e72e6aa4f13' }),
  ]),
});
