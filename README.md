# PIA Server

Serviço da PIA para gravar sessões de voz do Discord continuamente e entregar as faixas ao Podcast Automation pelo Google Drive. O painel web funciona em computadores e celulares. As regras e contas ficam no schema `pia_server` do PostgreSQL.

## Instalar

1. Prepare um usuário PostgreSQL dedicado com acesso de conexão e permissão de criar tabelas no schema `pia_server`. O aplicativo cria as tabelas no primeiro início.
2. Copie `.env.example` para `.env`, restrinja o acesso ao arquivo e configure o PostgreSQL, o domínio, o e-mail administrador e uma chave aleatória gerada com `openssl rand -hex 32`. Guarde a chave com o backup do PostgreSQL.
3. Crie um cliente OAuth Google do tipo **Aplicativo da Web**, habilite as APIs Drive, Gmail e Google Calendar e cadastre `https://SEU-DOMINIO/auth/google/callback` como redirecionamento. Configure `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no servidor. Gmail e Agenda usam escopos de leitura.
4. Execute `docker compose up -d`. A porta do exemplo fica em loopback. Configure seu proxy HTTPS para apontar ao serviço. No Traefik com as redes `proxy-publico` e `postgres`, use `docker compose -f compose.yaml -f compose.traefik.yaml up -d` e ajuste o host no arquivo de override.
5. Confira `/health`. Entre no painel com o e-mail administrador autorizado. O administrador pode autorizar outras contas Google e cada conta tem seu próprio bot, regras, fila e pasta no Drive.

A automação no GitHub executa os testes e publica imagens Linux amd64 e arm64
em `ghcr.io/oouo-diogo-perdigao/pia-server`. Cada push em `main` atualiza a tag
`main` de produção. Cada push em `develop` atualiza a tag `develop` de staging.
O Watchtower no servidor consulta o registro a cada cinco minutos e recria o
contêiner quando a tag do ambiente aponta para uma imagem nova. Mantenha o
`PIA_IMAGE` de cada ambiente apontando para sua tag no registry privado.

No desenvolvimento, execute `npm ci` e `npm test`. Para construir uma imagem
local, execute `docker build -t pia-server:local .`.

## Implantar staging

O staging usa a imagem publicada por `develop`, com projeto Compose, rota
Traefik, volume e banco PostgreSQL próprios. Começa com o banco vazio.

1. Em uma sessão administrativa do `psql`, crie o papel e o banco no PostgreSQL
   acessível pela rede Docker `postgres`. Use uma senha exclusiva para o papel.

   ```sql
   CREATE ROLE pia_server_stg LOGIN;
   \password pia_server_stg
   CREATE DATABASE pia_server_stg OWNER pia_server_stg;
   REVOKE CONNECT ON DATABASE pia_server_stg FROM PUBLIC;
   ```

2. No host do Traefik, copie `.env.stg.example` para `.env.stg`, restrinja o
   acesso ao arquivo e configure `PGPASSWORD`, `PIA_ADMIN_EMAIL` e uma chave
   exclusiva gerada com `openssl rand -hex 32`.
3. Configure um cliente OAuth Google de staging com a URI
   `https://pia-stg.travelrpg.com/auth/google/callback`. Preencha as credenciais
   desse cliente em `.env.stg`. Para testar as integrações, use um bot Discord
   e uma pasta no Drive dedicados ao staging.
4. Aponte o DNS de `pia-stg.travelrpg.com` ao mesmo ingresso público do Traefik.
   Com Docker Compose 2.24.4 ou posterior, execute:

   ```sh
   docker compose --env-file .env.stg -p pia-server-stg -f compose.yaml -f compose.stg.yaml up -d
   curl -fsS https://pia-stg.travelrpg.com/health
   ```

5. Entre no painel de staging com a conta administradora configurada.

## Configurar gravação

1. Instale um bot próprio no servidor Discord e dê acesso ao canal de voz e ao canal de aviso. O bot precisa de **Ver canal**, **Conectar** e **Enviar mensagens** no local correspondente.
2. No painel autenticado, informe o token do bot e crie a pasta de gravações no Drive.
3. Adicione uma regra com os IDs do servidor, canal de voz e canal de aviso. A gravação aguarda o número mínimo de participantes humanos. Se `triggerUsers` tiver IDs, a entrada de um deles deve disparar a regra. A gravação anuncia o início e termina depois do tempo configurado com o canal vazio, após seis horas ou pelo botão de parada.
4. No Podcast Automation, selecione a pasta criada no Drive. Para identificar participantes, use os IDs Discord como chaves em `nomes_reais`.

Cada gravação é um ZIP com faixas FLAC individuais alinhadas ao relógio de recepção e um manifesto de origem. O servidor retenta falhas sem descartar a gravação antes da confirmação do Drive. Rode uma sessão curta com duas pessoas antes de usar o gravador em produção. O recebimento de áudio depende da biblioteca de voz Discord e do protocolo DAVE.

## Páginas legais

A Política de Privacidade e os Termos de Serviço são servidos sem login em `/privacidade` e `/termos`, com links montados a partir de `PIA_PUBLIC_URL`. O módulo `src/legal.js` monta as páginas a partir dos fragmentos `src/legal/conteudo/*-vX.Y.html`, dos dados públicos em `src/legal/dados.js`, dos trechos jurídicos versionados em `src/legal/juridico.js` e do manifesto `src/legal/versoes.js`. Uma versão publicada nunca é editada: cada mudança cria um arquivo e uma versão novos. Enquanto houver trecho com `revisado:false` ou data nula, a página fica em modo rascunho e o gate de release (`PIA_LEGAL_RELEASE=1 npm test`) falha. O CI liga o gate em push para `main` e em tags `v*`. Veja `docs/legal.md`.

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

## Contas Suno (servidor)

A PIA Server conecta contas Suno por OAuth e guarda os tokens só no servidor,
na tabela `pia_server.suno_accounts`, selados com `PIA_ENCRYPTION_KEY`. Os tokens
nunca vão para os computadores pareados nem passam pelo cadastro de conectores.
Uma conta PIA pode ter várias contas Suno, e cada conta Suno (identificada pelo
id de usuário que o Suno informa) pertence a uma única conta PIA.

O cliente OAuth é registrado por DCR com o redirect
`https://pia.travelrpg.com/auth/connectors/suno` (ou `PIA_PUBLIC_URL` +
`/auth/connectors/suno`). O access token é renovado com lock por conta quando
faltam menos de 60 s ou quando o Suno responde 401; o refresh token rotacionado
é gravado na mesma transação. Um `invalid_grant` marca a conta como
`refresh_failed` e as rotas respondem `suno_credential_expired`.

Rotas do computador pareado (Bearer do dispositivo, mesmo 401 das outras `/device/*`):

| Rota | Resposta |
|---|---|
| `POST /device/suno/connect` `{replace_account_id?}` | `{url, attempt_id, expires_in: 600}` |
| `GET /device/suno/connect/:attempt_id` | `{state: pending\|connected\|failed\|expired, account_id?, code?}` |
| `GET /auth/connectors/suno?code&state` | callback público do OAuth (página HTML) |
| `GET /device/suno/status` | `{accounts: [{id, label, email, name, credential_state, available, expires_at, scopes}], default_account_id, active_job, settings}` |
| `PATCH /device/suno/accounts/:id` `{label}` | a conta no formato de `accounts[]` (apelido com trim, 1 a 80 caracteres; senão `400 bad_request`) |
| `DELETE /device/suno/accounts/:id` | `{ok: true}` (apaga o registro e os tokens; sem revogação remota) |

`credential_state` de cada conta: `configured` (token válido), `unavailable`
(token vencido ou perto de vencer e o refresh falhou por 5xx, timeout ou rede;
os tokens são mantidos e um job recebe `suno_unavailable`) ou `refresh_failed`
(`invalid_grant`/401 no refresh; reconectar, e um job recebe
`suno_credential_expired`). Reconectar a mesma conta mantém o apelido.

Erros das rotas Suno saem como `{error, code}`; uma tentativa de connect
inexistente responde `404 suno_connect_not_found`. `GET /device/account` anuncia
`capabilities: ["suno:3"]`. Segredos `mcp:*` de perfis sincronizados são
descartados pelo servidor, porque pertencem a cada computador.

### Cliente MCP do Suno

`src/suno_mcp.js` fala com `https://api.suno.com/mcp` por Streamable HTTP
(`initialize` com `Mcp-Session-Id`, `notifications/initialized`, novo
`initialize` quando a sessão expira, respostas JSON ou SSE e timeout por
`AbortSignal`). As tools de geração, status, conta e créditos são descobertas no
`tools/list` por nome e por schema, porque o schema real só sai do spike.
`src/suno_client.js` liga o cliente ao token de cada conta Suno: um 401 do Suno
renova o token uma vez e repete só aquela requisição. A geração faz um único
`tools/call` (nunca repetido depois de enviado) e acompanha clips pendentes pela
tool de status, sem prazo total: o intervalo começa em 5 s e dobra até 60 s
enquanto nada muda, e volta a 5 s quando um clip fica pronto. Só falhas
transitórias do polling fazem backoff e nova tentativa, sem limite: rede,
timeout de uma requisição, 5xx, 408 e 429 (ou `isError` com texto de rate
limit). Erro permanente encerra o polling: 402 (ou texto de créditos) vira
`suno_no_credits`; erro de protocolo (JSON-RPC inválido ou com `error`, resposta
ilegível, `isError` genérico) ou outro 4xx vira `suno_unavailable`. Um 401
continua renovando o token e repetindo a consulta; se repetir, vira
`suno_credential_expired`. Em todos os casos as faixas já prontas vêm em
`partial`, e o job guarda essas faixas (com `extra` quando cabe). Fora isso, a
geração termina quando todos os clips chegam a um estado final ou quando é
cancelada. Os erros saem
com o `code` do contrato: `suno_credential_expired` e `suno_no_credits` (400),
`suno_timeout` (só o timeout de uma requisição, como o `tools/call` inicial) e
`suno_unavailable` (502). Uma conta em
`unavailable` recebe `suno_unavailable`. Nenhum token, corpo de resposta do Suno
ou `audio_url` assinada vai para log ou mensagem de erro, e o servidor guarda só
o link do Suno, nunca uma cópia do áudio.

Para o spike, um admin logado na web pode listar as tools de uma conta Suno
conectada à própria conta PIA com `POST /api/admin/suno/spike`
`{"suno_account_id": "…"}`. A resposta traz nomes, descrições e schemas, sem
tokens, e não gera música.

### Jobs de geração do Suno

| Rota | Entrada | Resposta |
|---|---|---|
| `POST /device/suno/jobs` | `{prompt, lyrics?, duration? (10–180), count? (1–10, padrão 1), instrumental?, client_job_id (uuid), suno_account_id?}` | `202` com o job (`state: "queued"`). Repetir o mesmo `client_job_id` devolve `200` com o job original |
| `GET /device/suno/jobs/:id` | — | o job |
| `POST /device/suno/jobs/:id/cancel` | — | o job (normalmente já `cancelled`) |

O job tem este formato: `{job_id, generation_id, client_job_id, state, completed, total, extra_ready,
ready_text, error, code, suno_account: {id, name}, device_id, from_this_device,
created, tracks: [{n, title, duration, extra}]}`. Com a conta Suno apagada,
`suno_account` vira `{id: null, name}` com o nome guardado na criação. Os estados possíveis são `queued`,
`running`, `completed`, `failed`, `interrupted` e `cancelled`. O `audio_url`, o
prompt e a letra nunca vão no job. O áudio sai pelo download abaixo.

Recusas antes de criar o job:
- `suno_not_connected` quando não há conta Suno;
- `400 suno_account_required` quando há duas ou mais contas válidas e nenhuma
  foi escolhida;
- `404 suno_account_not_found` para uma conta de outra conta PIA;
- `suno_credential_expired` (`refresh_failed`) e `502 suno_unavailable`
  (`unavailable`);
- `409 suno_job_active` quando já há um job ativo na conta PIA, em qualquer PC;
- `400 bad_request` para entrada inválida.

Um id de job inexistente ou de outra conta responde `404 suno_job_not_found`.

O job é o próprio item de `music_generations` (`source: "suno"`, `provider:
"suno_mcp"`, `suno_account_id`, `job_id`, `client_id = client_job_id`), e as
faixas ficam em `music_generation_tracks` com o `audio_url` do Suno, guardado só
no servidor. O servidor nunca guarda o áudio. O worker roda no próprio processo:
faz `ceil(N/2)` gerações em sequência e para no primeiro clip que falhar, sem
chamada extra. Toda faixa pronta é guardada, inclusive a 2ª da última chamada
de um N ímpar e a extra pronta numa falha parcial (`extra: true`).

Cancelar aborta a espera, mantém as faixas prontas e não começa outro
`tools/call`. No boot, os jobs `queued` ou `running` viram `interrupted` e nunca
repetem o `tools/call`. O `active_job` do `GET /device/suno/status` traz `{job_id,
generation_id, client_job_id, state, suno_account_id, completed, total,
extra_ready, device_id, from_this_device}` ou `null`.

### Download do áudio de uma faixa Suno

`GET /device/music/generations/:id/tracks/:n/audio` faz proxy em streaming puro
do `audio_url` guardado no servidor: Suno → limitador → resposta, via
`stream.pipeline`. Nada vai para disco (sem tmpdir nem arquivo parcial) e o
arquivo nunca é juntado em memória; o limite de 100 MiB é contado chunk a chunk.
No banco ficam só o link (`audio_url`) e o `suno_account_name`. O link (ou a
query dele) nunca aparece em headers, erros ou logs. Qualquer PC pareado da mesma
conta PIA pode baixar (o que vale é a conta, não o PC de origem).

| Situação | Resposta |
|---|---|
| sucesso | `200` com o corpo do áudio; repassa `Content-Type` e `Content-Length`, mais `Cache-Control: no-store` e `X-Content-Type-Options: nosniff` |
| `Range: bytes=a-b` simples | repassado ao Suno; `206` com `Content-Range`. Outros formatos de Range são ignorados (`200` inteiro); Range fora do arquivo → `416 bad_request` |
| PC não pareado | `401 {"error":"Pareamento inválido."}` |
| geração de outra conta, inexistente ou id malformado | `404 music_generation_not_found` |
| faixa inexistente ou geração local (sem link do Suno) | `404 suno_track_not_found` |
| Suno respondeu 401/403/404/410 | `410 suno_track_unavailable` ("Esta música não está mais disponível no Suno.") |
| Suno 5xx ou falha de rede/DNS | `502 suno_unavailable` |
| timeout (headers ou ociosidade), 408/504 | `502 suno_timeout` |
| `Content-Length` acima de 100 MiB | `502 suno_track_too_large` (sem baixar o corpo) |
| destino inseguro, mais de 3 redirects, `Content-Type` que não é áudio | `502 download_failed` |

Depois que os headers saíram, qualquer falha (corpo truncado, passou de 100 MiB
sem `Content-Length`, timeout de ociosidade) derruba a conexão, e o cliente vê o
corpo incompleto. Se o cliente desconectar, o download no Suno é abortado.

Regras do download seguro (`sunoAudio` em `src/suno_audio.js`):
- só `https://`, sem usuário/senha na URL;
- até 3 redirects (301/302/303/307/308), cada salto revalidado;
- IPs privados, loopback, link-local, multicast e reservados (v4, v6 e
  IPv4-mapped) são bloqueados depois da resolução DNS, e também em IP literal;
- timeout de 30 s para os headers e de 30 s de ociosidade no corpo;
- `Content-Type` precisa ser `audio/*` ou `application/octet-stream`
  (`text/html` é recusado).

Nos testes, `sunoAudio.allowLoopbackForTests = true` aceita `http://` apenas
para destino loopback, e `sunoAudio.lookup` troca o DNS.

## Histórico de gerações de música

O servidor guarda o histórico de músicas da conta PIA (RN13, RN14, RN25/CA24) na
tabela `pia_server.music_generations`, com Suno e gerações locais juntas
(`source`: `suno`|`local`; `provider`: `suno_mcp`, `local`, `gemini`…), e as
faixas em `pia_server.music_generation_tracks`. O link de áudio do Suno
(`audio_url`) fica só no servidor e nunca vai ao computador; geração local
nunca tem link nem arquivo no servidor.

| Rota | Resposta |
|---|---|
| `POST /device/music/generations` `{source: "local", client_id, prompt, provider?, lyrics?, title?, duration?, instrumental?, count?, state?, code?, created?, tracks?: [{n, title?, duration?, extra?}]}` | `201` com o item; repetir o mesmo `client_id` devolve `200` com o registro original. `source: "suno"` → `400 music_source_not_allowed`; `audio_url` → `400 audio_url_not_allowed` |
| `GET /device/music/generations?limit=100&cursor=` | `{items: [{id, client_id, source, provider, device_id, from_this_device, suno_account: {id, name}\|null, prompt, lyrics, count, duration, state, code, created, tracks: [{n, title, duration, extra}]}], next_cursor}`. Todos os PCs da conta; ativos (`queued`/`running`) primeiro, depois do mais novo ao mais antigo |
| `DELETE /device/music/generations/:id` | `{ok: true}`. Exclusão definitiva do registro, do prompt, da letra e das faixas, feita por qualquer PC da conta. `404 music_generation_not_found` para id de outra conta ou já apagado; `409 music_generation_active` com job em andamento |

O `name` da conta Suno é `label`, depois `suno_name`, depois `suno_email` e, por
último, `suno_account_name`: o nome guardado em `music_generations` quando o job
foi criado. Com a conta Suno apagada (`suno_account_id` vira `NULL`), o item e o
job continuam mostrando `suno_account: {id: null, name}`.
O cursor é opaco e só posiciona a página dentro da conta do computador; um
cursor malformado responde `400 invalid_cursor`. Erros saem como `{error, code}`.

## Limpeza de temporários no boot

No boot, `cleanupOrphanTemp()` (`src/cleanup_tmp.js`) apaga os diretórios
órfãos `pia-media-*` e `pia-artifact-*` do tmpdir (no boot não há upload ativo;
isso supõe uma instância só). Nas gravações do Discord, apaga os `*.partial.zip`
e, só nas gravações já `uploaded`, os arquivos que o unlink depois do envio não
conseguiu apagar (zip, `pia.aup`, `.pcm` e `pia_data/*.flac`). Gravações
pendentes, em retry ou em andamento ficam intactas (são a fila); o
`recording.json` e o `pia-session.json` ficam sempre. O log traz só contagens, e
qualquer erro é ignorado sem derrubar o boot.

## Comandos de gravação no Discord

A PIA registra os comandos quando o bot conecta ao Discord. Use um bot instalado
no servidor com o escopo `applications.commands` e permissões para acessar o
canal de voz e enviar o aviso de gravação. Para gravar, configure a pasta de
destino no Drive pelo painel.

| Comando | Uso |
| --- | --- |
| `/join [channel]` | Grava o canal informado ou o canal de voz atual. Envia o aviso e entra na sala assim que a conexão estiver pronta. |
| `/stop` | Encerra a sessão. Disponível para quem iniciou ou para administradores. |
| `/recordings` | Lista sessões recentes do servidor. Participantes veem suas sessões e administradores veem todas. Links respeitam as permissões do Drive. |
| `/voice-test` | Entrega uma amostra de cinco segundos do próprio microfone em resposta privada, sem criar sessão nem enviar ao Drive. |
| `/info` | Mostra estatísticas das gravações visíveis para quem executou o comando. |
| `/bless`, `/unbless` | Vincula o servidor Discord à conta PIA autenticada ou remove o vínculo para futuras gravações. |
| `/autorecord on/off/view/prune` | Gerencia as mesmas regras do painel da PIA Server. `prune` remove regras de canais de voz ou de aviso que foram excluídos. |
| `/bot-profile set/remove` | Ajusta apelido, bio, avatar e banner do bot no servidor, ou restaura o perfil padrão. |

Em canais de palco sem chat, configure previamente o canal de aviso nas regras.
As operações de configuração são restritas a administradores do Discord.


Uma mesma comunidade Discord pode vincular mais de um bot. Cadastre cada
bot em **Conectores → Discord** no PIA Server e execute `/bless` pelo
bot correspondente. A PIA e a PIA Dark podem ser conectadas na mesma conta e
ter vínculos e permissões independentes. Cada bot grava uma sala por vez por
servidor. Dois bots podem gravar salas diferentes ao mesmo tempo.

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

O aviso de gravação no Discord se transforma em um painel atualizado com ID,
canal, horários de entrada e saída dos participantes e latência da conexão de
voz. O organizador ou um administrador pode parar a gravação. Participantes
podem adicionar notas, que são guardadas no ZIP e no projeto Audacity.

Ao encerrar, o painel mostra a duração e quem iniciou e encerrou a gravação.
O organizador ou um administrador tem 30 minutos para definir o nome e marcar
o fim da temporada. O ZIP vai imediatamente para a fila de envio. As alterações
são gravadas em um arquivo `*.aup.json` ao lado do ZIP. O Podcast Automation usa
o nome definido e inicia a próxima temporada na sessão seguinte do mesmo canal.

Use `/server-settings access-role add` e `remove` para autorizar cargos a iniciar
e parar gravações. Administradores também podem iniciar e parar. Quem iniciou
pode parar a própria gravação. O painel de uma gravação manual aparece no canal
do comando, com fallback para o canal de aviso. O Autorecord usa o canal de
aviso configurado.

A gravação avisa após cinco minutos sem áudio e termina após dez minutos de
silêncio. A captação de som reinicia a contagem. O campo legado `emptySeconds`
continua aceito nas regras, e o encerramento segue o tempo de silêncio.

A publica��o conecta ao WireGuard e usa os secrets WG_CONFIG_DEV, WG_CONFIG_PROD,
REGISTRY_USER e REGISTRY_PASSWORD. O registry � acess�vel pela VPN.
