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

Entre com Google e emita um token MCP no painel. Configure no Codex a URL `https://pia.travelrpg.com/mcp` e passe o token via variável de ambiente Bearer. O token expira após 30 dias e pode ser revogado pelo painel. O MCP consulta o estado do gravador e pode solicitar câmera ou tela a um computador escolhido. Gere um token em **Computadores pareados**, informe-o no conector **PIA Server** do desktop e habilite as permissões locais desejadas. O resultado fica na pasta privada da PIA no Drive.

## Escopo desta versão

No painel web, habilite Gmail ou Agenda na seção **Secretária**. Ela consulta as fontes a cada minuto e mantém os avisos no PostgreSQL. Cada computador pareado com a recepção de avisos habilitada recebe os pendentes e aplica suas próprias preferências de notificação.

Configurações, segredos e conversas ficam em revisões criptografadas no PostgreSQL. Use **Perfil compartilhado** no conector desktop para enviar ou carregar o perfil. A sincronização exige confirmação explícita e rejeita alterações sobre uma revisão desatualizada. Credenciais de pareamento e preferências de notificação ficam no computador.

O painel web é a interface administrativa. A captura do Discord, a fila e o envio de gravações rodam no servidor. As capturas solicitadas pelo MCP são executadas no desktop pareado. A geração musical permanece local. A cópia das músicas para o Drive e o processamento de sessões no servidor ainda não estão disponíveis.
