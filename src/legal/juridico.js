// Trechos que dependem do parecer do Advogado (plano técnico, seção 3.3).
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
// Redação da v1.0: parecer jurídico sobre f1338f7 (seção 4, Caminho A), copiada literalmente; DIREITOS_MUSICAS_GERADAS
// foi aprovado sem ajuste (4.12). Todos seguem revisado:false até o parecer favorável sobre o texto ajustado.
// A v1.0 não cita a feature 0001: os trechos dela estão em docs/legal-v1.1-rascunho.md (fora do código).

const trecho = (pendencia, assunto, texto) => Object.freeze({ texto, revisado: false, pendencia, assunto });

const V1_0 = Object.freeze({
  BASE_LEGAL_TREINAMENTO: trecho('P10', 'base legal do treinamento',
    "para treinar modelos de IA e melhorar o serviço com conversas, prompts e outros conteúdos de texto que você envia à PIA: legítimo interesse do controlador (inciso IX e art. 10), limitado aos dados necessários, com transparência e com o direito de pedir a qualquer momento que seus dados deixem de ser usados (seção Direitos do titular). Dados pessoais sensíveis, como dados de saúde, biométricos ou de crianças e adolescentes, não são usados em treinamento com base no legítimo interesse e, quando identificados, são retirados dos conjuntos de treinamento. Gravações de voz só poderão ser usadas em treinamento com o consentimento específico e destacado de cada pessoa gravada (art. 11, inciso I), pedido à parte, fora destes documentos;"),
  CONSENTIMENTO_TERCEIROS_DISCORD: trecho('P11', 'terceiros gravados no Discord',
    "Enquanto a gravação está ativa, o bot avisa no canal que ela está acontecendo. Quem configura a gravação deve avisar os participantes antes de começar e respeitar quem não quiser ser gravado. As vozes de pessoas que não usam a PIA (terceiros) são gravadas apenas para entregar a gravação a quem a configurou, na pasta da PIA no Google Drive dessa pessoa, e não são usadas para treinar modelos de IA. Pessoas gravadas podem pedir informações, acesso ou exclusão pelo e-mail {{CONTATO_EMAIL}}, informando o servidor, o canal, a data aproximada e o seu nome de usuário no Discord."),
  LIMITACAO_CDC: trecho('P10', 'limitação de responsabilidade frente ao CDC',
    "Nada nestes Termos afasta ou limita direitos que a lei não permite renunciar, inclusive os previstos no Código de Defesa do Consumidor e na LGPD. As limitações acima não se aplicam a danos causados por dolo ou culpa grave, nem à responsabilidade por tratamento de dados pessoais em desacordo com a LGPD. Se a relação com você for de consumo, valem integralmente as regras do Código de Defesa do Consumidor, inclusive o direito de propor ação no seu domicílio."),
  OPT_OUT_TREINAMENTO: trecho('P10', 'opt-out de treinamento',
    "Você pode pedir, a qualquer momento e sem custo, que seus dados deixem de ser usados para treinar modelos. Basta enviar um e-mail para {{CONTATO_EMAIL}} com o assunto 'Opt-out de treinamento', a partir do e-mail da sua conta. Confirmamos o pedido em até 15 dias, e ele vale para todos os treinamentos feitos depois da confirmação. Treinamentos feitos antes do pedido continuam válidos, e dados já incorporados a modelos treinados podem não ser removíveis desses modelos. Se você quiser também que suas cópias guardadas para treinamento sejam apagadas, peça a eliminação no mesmo e-mail. Pessoas que não usam a PIA, mas foram gravadas em canais do Discord, podem fazer os mesmos pedidos pelo mesmo e-mail, informando o servidor, o canal, a data aproximada da gravação e o seu nome de usuário no Discord, para que possamos localizar a gravação."),
  REMOCAO_DADOS_TREINADOS: trecho('P10', 'remoção de dados já treinados',
    "Se você pedir a eliminação dos seus dados, eles também são retirados das cópias guardadas para treinamento e deixam de ser usados em novos treinamentos. Modelos que já foram treinados antes do pedido podem não permitir a remoção individual desses dados, no limite técnico do que é possível hoje (art. 16 da LGPD). Nesse caso, não usamos esses modelos para identificar você nem para reproduzir intencionalmente o seu conteúdo, e eles são substituídos à medida que novos modelos forem treinados sem os seus dados."),
  PRAZO_RESPOSTA_TITULAR: trecho('P10', 'prazo de resposta ao titular',
    "Se você pedir confirmação de que tratamos seus dados ou acesso a eles, enviamos uma resposta simplificada imediatamente, assim que confirmarmos que o pedido veio do e-mail da sua conta, ou, se preferir, uma declaração clara e completa, com a origem dos dados, os critérios usados e a finalidade, em até 15 dias contados do pedido. Os demais pedidos são respondidos em até 15 dias contados do recebimento. Se não for possível atender de imediato, informamos os motivos nesse prazo. O atendimento é gratuito."),
  TREINAMENTO_MICROSOFT: trecho('P11', 'dados da Microsoft no treinamento',
    "Dados obtidos da sua conta Microsoft (e-mails, agenda e arquivos, via Microsoft Graph) não são usados para treinar modelos. Conversas e prompts que você envia à PIA podem ser usados para treinamento, exceto trechos de e-mails, eventos, arquivos ou outros conteúdos obtidos do Google ou da Microsoft que apareçam nessas conversas, que são excluídos antes de qualquer treinamento."),
  // T04 resolvida pela v3.1 dos requisitos (0.0, item 1): a PIA guarda IP no access log do Traefik e no CrowdSec. Redação do Adendo 2 do parecer, frase neutra sem prazo. Prazo e rotação pendentes (P14).
  LOGS_ACESSO: trecho('T04', 'logs de acesso',
    "A PIA guarda registros de acesso com o seu endereço IP. A cada acesso, o servidor registra o endereço IP e a porta de origem, a data e a hora, o método, o endereço da página acessada, o domínio, o código de resposta e dados técnicos da conexão segura (TLS). Uma ferramenta automática de segurança (CrowdSec) analisa esses registros para detectar e bloquear tentativas de abuso e guarda os endereços IP bloqueados. Usamos esses dados apenas para segurança, prevenção de abuso e diagnóstico de falhas, com base no legítimo interesse do controlador (art. 7º, inciso IX, da LGPD) e, quando necessário, para o exercício regular de direitos em processo judicial, administrativo ou arbitral (art. 7º, inciso VI), inclusive para atender ordem judicial ou pedido de autoridade competente. Esses registros são mantidos pelo tempo necessário para segurança e prevenção de abuso e não são usados para treinar modelos. O provedor de hospedagem e os serviços de terceiros que você usa com a PIA, como Google e Discord, também podem registrar o seu endereço IP, conforme as políticas de cada um."),
  // Parecer jurídico (f1338f7), 4.4, Caminho A: hoje voz e MP3 não entram no treinamento (sem cópia própria;
  // ler o Drive viola a Limited Use). Mudar isso exige versão nova (Caminho B, 4.15), decisão do Diogo.
  TREINAMENTO_MP3_GERADOS: trecho('P11', 'voz e MP3 fora do treinamento',
    "Hoje a PIA não guarda cópia das músicas geradas (MP3/WAV) nem das gravações de voz e, por isso, não as usa para treinar modelos. Se isso mudar, publicaremos uma nova versão destes documentos antes, com aviso prévio."),
  // F2-10 (RF10, CA26): aviso no embed "🔴 Gravação em andamento" do bot (src/recording_panel.js, trainingNotice()).
  // Redação do parecer jurídico, 4.14. Não é usado nas páginas.
  AVISO_GRAVACAO_DISCORD: trecho('P11', 'aviso de gravação no Discord',
    "Este canal está sendo gravado pela PIA. O áudio de cada participante vai para o Google Drive de quem configurou a gravação. As vozes de quem não usa a PIA não são usadas para treinar modelos. Se não quiser ser gravado, avise quem configurou a gravação ou saia do canal. Dúvidas e pedidos: {{CONTATO_EMAIL}}."),
  // Termos, seção 6: redação aprovada pelo PO e pelo parecer jurídico sem ajuste (4.12). v1.0 sem a feature 0001.
  DIREITOS_MUSICAS_GERADAS: trecho('P11', 'direito autoral das músicas geradas',
    'Os direitos e limites de uso das músicas geradas pelo Gemini ou por outros provedores seguem os termos de cada provedor. Músicas geradas por modelos locais seguem as licenças desses modelos. Cabe a você verificar esses termos antes de usar as músicas, inclusive para fins comerciais.'),
  ENCARREGADO: trecho('P04', 'encarregado',
    "O encarregado atua como canal de comunicação entre o controlador, os titulares dos dados e a Agência Nacional de Proteção de Dados (ANPD), recebendo pedidos, reclamações e comunicações pelo e-mail {{CONTATO_EMAIL}}."),
  // Adendo do parecer (17/11/2026, 23h30): nova redação de 4.8, com dados pessoais no banco no Brasil e mídias
  // na conta de armazenamento do usuário, possivelmente fora do país.
  SALVAGUARDAS_TRANSFERENCIA: trecho('P05', 'salvaguardas da transferência internacional',
    "Transferência internacional de dados. O banco de dados da PIA, onde ficam guardados os seus dados pessoais, está no Brasil. Para que o serviço funcione, porém, alguns dados passam por fornecedores sediados nos Estados Unidos, que podem tratá-los em servidores nos Estados Unidos ou em outros países. O Google faz o login, recebe as suas mídias no seu Google Drive, dá acesso ao Gmail e à Agenda quando você conecta essas integrações e processa as mensagens pelo modelo de linguagem Gemini. A Microsoft dá acesso a e-mail, agenda e arquivos quando você conecta essa integração. A Groq processa as mensagens por modelo de linguagem. O Discord transmite o áudio das chamadas de voz gravadas pelo bot. As mídias geradas, como imagens e áudios, ficam na conta de armazenamento que você mesmo conecta, como o seu Google Drive, e podem estar fora do Brasil, conforme as regras desse provedor. A PIA não contrata armazenamento de mídia fora do país. Essas transferências acontecem porque são necessárias para prestar o serviço que você pediu, nos termos do art. 33, inciso IX, combinado com o art. 7º, inciso V, da LGPD. Cada fornecedor trata os dados conforme os próprios termos de uso e políticas de privacidade, publicados em seus sites. Se quiser saber mais sobre essas transferências, escreva para {{CONTATO_EMAIL}}."),
  ORIGEM_TREINAMENTO_MIDIA: trecho('P11', 'dados do Drive e das APIs do Google fora do treinamento',
    "Gravações de voz, músicas e capturas que a PIA envia ao seu Google Drive não são lidas de volta do Drive para treinar modelos, nem para qualquer outra finalidade além de prestar o serviço que você pediu. Dados obtidos pelas APIs do Google, inclusive os derivados deles, não são usados para criar, treinar ou melhorar modelos de IA."),
});

export const JURIDICO = Object.freeze({ '1.0': V1_0 });
