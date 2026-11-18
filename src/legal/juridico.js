// Trechos que dependem do parecer do Advogado (plano técnico, seção 3.3) ou de pendência do Diogo (T04).
// Cada chave vira um token {{CHAVE}} nos fragmentos de src/legal/conteudo/*.html.
//
// Formato de cada trecho:
//   texto:     TEXTO PURO, sem HTML (é escapado; tags aparecem literais). E-mails e URLs não viram
//              link: o <a href="mailto:..."> fica no fragmento HTML, fora do trecho. Pode usar
//              tokens de dados, como {{CONTATO_EMAIL}}.
//   revisado:  false até o parecer favorável. Com false, a página mostra o selo
//              "[EM REVISÃO JURÍDICA: <pendencia> <assunto>]" e entra em modo rascunho.
//   pendencia: identificador da pendência nos requisitos (P04, P05, P10, P11, T04).
//   assunto:   descrição curta usada no selo e em pendencias().
//
// Os trechos são versionados: JURIDICO['1.0'] é o conjunto usado pelas versões do manifesto
// (src/legal/versoes.js) que apontam juridico: '1.0'. Depois que uma versão é publicada (vigencia
// preenchida), o conjunto dela fica congelado: texto jurídico novo = conjunto novo (ex.: '1.1') e
// versão nova do documento. O teste de hash (test/legal.test.js) falha se uma versão publicada mudar.
// Antes da publicação, o parecer só altera este arquivo (texto e revisado:true); nenhuma rota muda.
// Redação da v1.0: proposta do PO (requisitos v2.7, seções 6.1 e 6.2, redações da v2.6) aplicada na F2-02.
// A v1.0 não cita a feature 0001: os trechos dela estão em docs/legal-v1.1-rascunho.md (fora do código).

const trecho = (pendencia, assunto, texto) => Object.freeze({ texto, revisado: false, pendencia, assunto });

const V1_0 = Object.freeze({
  BASE_LEGAL_TREINAMENTO: trecho('P10', 'base legal do treinamento',
    'Para o treinamento de modelos de IA e a melhoria do serviço, a base legal é o consentimento do titular (art. 7º, inciso I) e/ou o legítimo interesse do controlador (art. 7º, inciso IX), conforme o caso.'),
  CONSENTIMENTO_TERCEIROS_DISCORD: trecho('P11', 'consentimento de terceiros no Discord',
    'O bot anuncia no canal que a gravação está em andamento. Quem configura a gravação deve informar os participantes de que as vozes são gravadas e podem ser usadas para treinamento de modelos. Quem não concordar deve sair do canal enquanto a gravação estiver ativa.'),
  LIMITACAO_CDC: trecho('P10', 'limitação de responsabilidade frente ao CDC',
    'Nada nestes Termos afasta ou limita direitos que a lei não permite renunciar, inclusive os previstos no Código de Defesa do Consumidor e na LGPD.'),
  OPT_OUT_TREINAMENTO: trecho('P10', 'opt-out de treinamento',
    "Você pode pedir, a qualquer momento, que seus dados deixem de ser usados para treinar modelos. Basta enviar um e-mail para {{CONTATO_EMAIL}} com o assunto 'Opt-out de treinamento', a partir do e-mail da sua conta. O pedido vale para novos treinamentos a partir da confirmação. Dados já incorporados a modelos treinados antes do pedido podem não ser removíveis desses modelos. Pessoas que não usam a PIA, mas foram gravadas em canais do Discord, podem fazer o mesmo pedido pelo mesmo e-mail, informando o servidor, o canal e a data aproximada da gravação."),
  REMOCAO_DADOS_TREINADOS: trecho('P10', 'remoção de dados já treinados',
    'Dados que já foram usados em treinamento podem não ser removíveis de um modelo já treinado.'),
  PRAZO_RESPOSTA_TITULAR: trecho('P10', 'prazo de resposta ao titular',
    'Respondemos aos pedidos em até 15 dias, contados do recebimento.'),
  TREINAMENTO_MICROSOFT: trecho('P11', 'dados da Microsoft no treinamento',
    'Dados obtidos da sua conta Microsoft (e-mails, agenda e arquivos via Microsoft Graph) não são usados para treinar modelos. Conversas, prompts e músicas que você gera ou envia à PIA podem ser usados para treinamento.'),
  // Requisitos v2.4/v2.5 (T04): o Diogo informa e o repositório confirma que não guardamos logs de
  // acesso com IP (o app não registra IP; não há access log do Traefik no repo).
  LOGS_ACESSO: trecho('T04', 'logs de acesso',
    'A PIA Server não guarda logs de acesso com endereço IP.'),
  // Requisitos v2.4 (RN03a): os MP3 gerados também entram no treinamento; a cópia durável fica no
  // Drive do usuário, e a leitura pela API do Google esbarra na Limited Use (RN03): parecer do Advogado.
  TREINAMENTO_MP3_GERADOS: trecho('P11', 'MP3 gerados no treinamento',
    'As músicas geradas (MP3) também são usadas para treinamento de modelos e melhoria do serviço.'),
  // F2-10 (RF10, CA26): aviso curto no embed "🔴 Gravação em andamento" do bot do Discord.
  // Fala só da gravação de voz, porque o embed trata da gravação. Não é usado nas páginas.
  AVISO_GRAVACAO_DISCORD: trecho('P11', 'aviso de gravação no Discord',
    'Esta gravação de voz, inclusive a dos demais participantes do canal, pode ser usada para treinar modelos e melhorar o serviço.'),
  // Termos, seção 6: redação aprovada pelo PO (v1.0, sem a feature 0001); aguarda o parecer do Advogado.
  DIREITOS_MUSICAS_GERADAS: trecho('P11', 'direito autoral das músicas geradas',
    'Os direitos e limites de uso das músicas geradas pelo Gemini ou por outros provedores seguem os termos de cada provedor. Músicas geradas por modelos locais seguem as licenças desses modelos. Cabe a você verificar esses termos antes de usar as músicas, inclusive para fins comerciais.'),
  ENCARREGADO: trecho('P04', 'encarregado exercido pelo controlador',
    'O próprio controlador atua como encarregado pelo tratamento de dados pessoais e atende os titulares pelo e-mail de contato, na forma permitida a agentes de tratamento de pequeno porte pela Resolução CD/ANPD nº 2/2022.'),
  SALVAGUARDAS_TRANSFERENCIA: trecho('P05', 'salvaguardas da transferência internacional',
    'Essas transferências acontecem para que o serviço funcione e seguem as hipóteses do art. 33 da LGPD, com os termos e as salvaguardas oferecidos por cada provedor.'),
  ORIGEM_TREINAMENTO_MIDIA: trecho('P11', 'origem da voz e dos MP3 usados em treinamento frente à Limited Use',
    'As gravações de voz e os MP3 gerados usados em treinamento não são obtidos pela leitura do seu Google Drive por meio das APIs do Google.'),
});

export const JURIDICO = Object.freeze({ '1.0': V1_0 });
