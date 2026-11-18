// Trechos que dependem do parecer do Advogado (plano técnico, seção 3.3) ou de pendência do Diogo (T04).
// Cada chave vira um token {{CHAVE}} nos fragmentos de src/legal/conteudo/*.html.
//
// Formato de cada trecho:
//   texto:     texto simples (sem HTML; é escapado). Pode usar tokens de dados, como {{CONTATO_EMAIL}}.
//   revisado:  false até o parecer favorável. Com false, a página mostra o selo
//              "[EM REVISÃO JURÍDICA: <pendencia> <assunto>]" e entra em modo rascunho.
//   pendencia: identificador da pendência nos requisitos (P10, P11, T04).
//   assunto:   descrição curta usada no selo e em pendencias().
//
// Os trechos são versionados: JURIDICO['1.0'] é o conjunto usado pelas versões do manifesto
// (src/legal/versoes.js) que apontam juridico: '1.0'. Depois que uma versão é publicada (vigencia
// preenchida), o conjunto dela fica congelado: texto jurídico novo = conjunto novo (ex.: '1.1') e
// versão nova do documento. O teste de hash (test/legal.test.js) falha se uma versão publicada mudar.
// Antes da publicação, o parecer só altera este arquivo (texto e revisado:true); nenhuma rota muda.
// A redação inicial é a proposta do PO (requisitos v2.2, seções 6.1 e 6.2) e do plano técnico.

const trecho = (pendencia, assunto, texto) => Object.freeze({ texto, revisado: false, pendencia, assunto });

const V1_0 = Object.freeze({
  BASE_LEGAL_TREINAMENTO: trecho('P10', 'base legal do treinamento',
    'Para o treinamento de modelos e a melhoria do serviço, a base legal é o consentimento (art. 7º, inciso I) e/ou o legítimo interesse (art. 7º, inciso IX) da LGPD.'),
  CONSENTIMENTO_TERCEIROS_DISCORD: trecho('P11', 'consentimento de terceiros no Discord',
    'As gravações de voz do Discord, inclusive as de outros participantes do canal que não usam a PIA, são usadas para treinamento de modelos. O bot anuncia a gravação no canal, e quem grava deve informar os participantes.'),
  LIMITACAO_CDC: trecho('P10', 'limitação de responsabilidade frente ao CDC',
    'Nada nestes Termos afasta direitos que não podem ser renunciados, como os previstos no Código de Defesa do Consumidor e na LGPD.'),
  OPT_OUT_TREINAMENTO: trecho('P10', 'opt-out de treinamento',
    'Você pode revogar o consentimento ou se opor ao uso dos seus dados para treinamento escrevendo para {{CONTATO_EMAIL}}.'),
  REMOCAO_DADOS_TREINADOS: trecho('P10', 'remoção de dados já treinados',
    'Dados já usados em treinamento podem não ser removíveis do modelo treinado.'),
  PRAZO_RESPOSTA_TITULAR: trecho('P10', 'prazo de resposta ao titular',
    'Respondemos aos pedidos dos titulares em até 15 dias.'),
  TREINAMENTO_MICROSOFT_SUNO: trecho('P11', 'conteúdo de Microsoft e Suno no treinamento',
    'Conteúdo obtido pelas integrações com a Microsoft e com o Suno segue os termos de cada provedor e só é usado em treinamento quando esses termos permitirem.'),
  LOGS_ACESSO: trecho('T04', 'logs de acesso do proxy',
    'O servidor e o proxy de hospedagem podem registrar logs técnicos de acesso (como endereço IP, data, hora e caminho acessado) para segurança e diagnóstico.'),
});

export const JURIDICO = Object.freeze({ '1.0': V1_0 });
