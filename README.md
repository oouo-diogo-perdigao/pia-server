# PIA Server

Serviço da PIA para gravar sessões de voz do Discord continuamente e entregar as faixas ao Podcast Automation pelo Google Drive. O painel web funciona em computadores e celulares. As regras e contas ficam no schema `pia_server` do PostgreSQL.

## Instalar

1. Prepare um usuário PostgreSQL dedicado com acesso de conexão e permissão de criar tabelas no schema `pia_server`. O aplicativo cria as tabelas no primeiro início.
2. Copie `.env.example` para `.env`, restrinja o acesso ao arquivo e configure o PostgreSQL, o domínio, o e-mail administrador e uma chave aleatória gerada com `openssl rand -hex 32`. Guarde a chave com o backup do PostgreSQL.
3. Crie um cliente OAuth Google do tipo **Aplicativo da Web**, habilite as APIs Drive, Gmail e Google Calendar e cadastre `https://SEU-DOMINIO/auth/google/callback` como redirecionamento. Configure `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no servidor. Gmail e Agenda usam escopos de leitura.
4. Execute `docker compose up -d`. A porta do exemplo fica em loopback. Configure seu proxy HTTPS para apontar ao serviço. No Traefik com as redes `proxy-publico` e `postgres`, use `docker compose -f compose.yaml -f compose.traefik.yaml up -d` e ajuste o host no arquivo de override.
5. Confira `/health`. Entre no painel com o e-mail administrador autorizado. O administrador pode autorizar outras contas Google e cada conta tem seu próprio bot, regras, fila e pasta no Drive.

A automação no GitHub constrói e envia imagens Linux amd64 e arm64 para `ghcr.io/oouo-diogo-perdigao/pia-server`. No desenvolvimento, execute `npm ci` e `npm test`. Para construir uma imagem local, execute `docker build -t pia-server:local .`.

## Configurar gravação

1. Instale um bot próprio no servidor Discord e dê acesso ao canal de voz e ao canal de aviso. O bot precisa de **Ver canal**, **Conectar** e **Enviar mensagens** no local correspondente.
2. No painel autenticado, informe o token do bot e crie a pasta de gravações no Drive.
3. Adicione uma regra com os IDs do servidor, canal de voz e canal de aviso. A gravação aguarda o número mínimo de participantes humanos. Se `triggerUsers` tiver IDs, a entrada de um deles deve disparar a regra. A gravação anuncia o início e termina depois do tempo configurado com o canal vazio, após seis horas ou pelo botão de parada.
4. No Podcast Automation, selecione a pasta criada no Drive. Para identificar participantes, use os IDs Discord como chaves em `nomes_reais`.

Cada gravação é um ZIP com faixas FLAC individuais alinhadas ao relógio de recepção e um manifesto de origem. O servidor retenta falhas sem descartar a gravação antes da confirmação do Drive. Rode uma sessão curta com duas pessoas antes de usar o gravador em produção. O recebimento de áudio depende da biblioteca de voz Discord e do protocolo DAVE.

## MCP

Entre com Google e emita um token MCP no painel. Configure no Codex a URL `https://pia.travelrpg.com/mcp` e passe o token via variável de ambiente Bearer. A validade padrão é de 30 dias. Escolha de 1 a 3.650 dias ou sem expiração. Todos os tokens MCP da conta podem ser revogados no painel, inclusive os sem vencimento. A API aceita `expiresInDays` inteiro ou `null` em `POST /api/mcp/token` e informa `expiresAt` na resposta. O MCP consulta o estado do gravador e pode solicitar câmera ou tela a um computador escolhido. Entre com Google na PIA desktop, confirme o código no navegador e habilite as permissões locais desejadas. A autorização expira em dez minutos e a sessão do computador pode ser revogada no painel. O resultado fica na pasta privada da PIA no Drive.

## Escopo desta versão

No painel web, habilite Gmail ou Agenda na seção **Secretária**. Ela consulta as fontes a cada minuto e mantém os avisos no PostgreSQL. Cada computador pareado com a recepção de avisos habilitada recebe os pendentes e aplica suas próprias preferências de notificação.

Configurações, segredos e conversas ficam em revisões criptografadas no PostgreSQL. Use **Perfil compartilhado** no conector desktop para enviar ou carregar o perfil. A sincronização exige confirmação explícita e rejeita alterações sobre uma revisão desatualizada. Credenciais de pareamento e preferências de notificação ficam no computador.

O painel web é a interface administrativa. A captura do Discord, a fila e o envio de gravações rodam no servidor. As capturas solicitadas pelo MCP são executadas no desktop pareado. O desktop também pode sincronizar arquivos de capturas e músicas salvas com o Drive, se essa opção estiver habilitada. A geração musical permanece local. O processamento de sessões no servidor ainda não está disponível.
## Conectores dos computadores pareados

A página **Conectores** gerencia Google, Microsoft, Object Storage, Discord e
Taverns. A PIA Server guarda os dados por usuário no PostgreSQL, criptografados
com `PIA_ENCRYPTION_KEY`. Na primeira consulta, o servidor migra os conectores do
último perfil recebido, se houver. A edição posterior do perfil não substitui o
cadastro. Os desktops pareados consultam esse cadastro pelo token do dispositivo.
Revogue o dispositivo no painel se ele deixar de ser seu.

O login Google do servidor usa a permissão `drive.file`. Para navegar por pastas
preexistentes de todo o Drive, use **Autorizar conta Google**, que solicita
o escopo `drive` no mesmo cliente OAuth do login. O projeto Google precisa
permitir esse escopo. Consulte [escopos do Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Para Microsoft, cadastre um cliente OAuth do tipo Web no Entra e adicione a URI
`https://pia.travelrpg.com/auth/connectors/microsoft` (ou o domínio da instalação).
Informe o ID e segredo do cliente em **Conectores / Microsoft**. Consulte
[URIs de redirecionamento](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri).

A autorização Google/Microsoft mantém o refresh token no servidor. Um desktop
pareado recebe tokens de acesso temporários para esses provedores. Quando um app
executa uma operação local com S3, Discord ou Taverns, usa a credencial do cadastro
em memória. O perfil sincronizado não inclui credenciais desses cinco conectores.

## Comandos de gravação no Discord

A PIA registra os comandos quando o bot conecta ao Discord. Use um bot instalado
no servidor com o escopo `applications.commands` e permissões para acessar o
canal de voz e enviar o aviso de gravação. Para gravar, configure a pasta de
destino no Drive pelo painel.

| Comando | Uso |
| --- | --- |
| `/join [channel]` | Grava o canal informado ou o canal de voz atual. Envia o aviso antes de começar. |
| `/stop` | Encerra a sessão. Disponível para quem iniciou ou para administradores. |
| `/recordings` | Lista sessões recentes do servidor. Participantes veem suas sessões e administradores veem todas. Links respeitam as permissões do Drive. |
| `/voice-test` | Entrega uma amostra de cinco segundos do próprio microfone em resposta privada, sem criar sessão nem enviar ao Drive. |
| `/info` | Mostra estatísticas das gravações visíveis para quem executou o comando. |
| `/bless`, `/unbless` | Vincula o servidor Discord à conta PIA autenticada ou remove o vínculo para futuras gravações. |
| `/autorecord on/off/view/prune` | Gerencia as mesmas regras do painel da PIA Server. `prune` remove regras de canais de voz ou de aviso que foram excluídos. |
| `/bot-profile set/remove` | Ajusta apelido, bio, avatar e banner do bot no servidor, ou restaura o perfil padrão. |

Em canais de palco sem chat, configure previamente o canal de aviso nas regras.
As operações de configuração são restritas a administradores do Discord.


O administrador executa `/bless` e abre **Confirmar na PIA Server**. A página
mostra o nome do servidor Discord e a conta Google que receberá as gravações.
O link privado é de uso único e expira em dez minutos. Para trocar de conta,
use `/unbless` e refaça o vínculo.

A pasta e as regras de gravação automática são as da conta vinculada. Depois
da atualização, cada servidor precisa concluir o novo `/bless` antes de
iniciar gravações manuais ou automáticas. `/unbless` impede novas gravações
até um novo vínculo. Sessões já iniciadas e seus uploads mantêm o destino original.

O PostgreSQL guarda uma linha criptografada por usuário e tipo de conector na
tabela `pia_server.connectors`, com chave `(account_id, type)`. Contas de storage
do mesmo usuário ficam na linha `object_storage`. A atualização reparte o cadastro
anterior automaticamente. No painel, a Access Key aparece ao selecionar a conta e
a Secret Key é carregada somente quando o usuário autenticado aciona o botão de olho.

A foto da conta Google aparece na navegação do painel e nos desktops pareados.
O primeiro login após a atualização autoriza a leitura do perfil. Se a conta não
tiver foto disponível, as interfaces mostram a inicial do e-mail.

No painel **Gravações**, use **Escolher pasta de gravações** para selecionar a
conta e navegar pelo Drive, ou criar uma pasta. Pastas existentes fora do alcance
da autorização do login ficam disponíveis ao adicionar uma conta com acesso ao
Drive em **Conectores / Google**. Sessões já iniciadas mantêm o destino original.

Os novos ZIPs seguem o modelo `RPGs20261108181339235-Bate-Papo.aup.zip`. A data
do nome usa o horário de São Paulo e tem precisão de milissegundos. Extraia o ZIP
e abra `pia.aup` com `pia_data` ao lado. As faixas FLAC são identificadas pelo
nome de usuário do Discord e mantêm o início sincronizado.
