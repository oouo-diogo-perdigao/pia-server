# Runbook: exclusão manual de conta (pedido do titular)

Procedimento manual para atender pedidos de exclusão de dados recebidos por **contato@travelrpg.com** (LGPD, art. 18). A PIA Server **não tem** rota de exclusão nem de exportação; a Política não promete exclusão automática (RN08). Base: plano técnico da feature 0002, T09.

> Quem executa: o operador do servidor (controlador). Não copie tokens, chaves nem valores do `.env` para tickets, e-mails ou logs.

## 0. Antes de começar

1. **Confirme a identidade do titular.** O pedido deve vir do mesmo e-mail da conta PIA (o e-mail Google cadastrado). Se vier de outro endereço, peça confirmação a partir do e-mail da conta antes de seguir.
2. **Registre o pedido** (data de recebimento, e-mail, o que foi pedido) no controle do controlador.
   - **Pendência:** onde fica esse registro e por quanto tempo é guardado não está definido.
   - **Pendência:** o prazo de resposta ao titular depende do parecer (`PRAZO_RESPOSTA_TITULAR` em `src/legal/juridico.js`, P10).
3. **Admin:** se o e-mail for o de `PIA_ADMIN_EMAIL`, **não** apague só a linha: a conta é recriada como admin a cada boot (`src/db.js`, `INSERT ... ON CONFLICT(email) DO UPDATE SET admin=true`). Troque antes o `PIA_ADMIN_EMAIL` no `.env` para outro e-mail e reinicie o contêiner, ou não atenda por este runbook.
4. **Bot Discord compartilhado:** `pia_server.discord_guild_links.bot_account_id` e `discord_link_requests.bot_account_id` referenciam a conta dona do bot com `ON DELETE CASCADE`. Se outras contas usam o bot desta conta em algum servidor Discord, os vínculos **dessas outras contas** também serão apagados. Confira no passo 1 do SQL e avise as contas afetadas.

## 1. Revogar acessos nos provedores (antes de apagar)

Apagar as linhas **não** revoga nada fora do servidor.

| Onde | O que fazer |
|---|---|
| Google (login, Drive, Gmail, Agenda) | Orientar o titular a remover o acesso da PIA em **Conta Google → Segurança → Apps de terceiros com acesso à conta**. O código não tem rotina de revogação remota. **Pendência:** decidir se o operador revoga o refresh token pelo endpoint de revogação do Google (exigiria decifrar `accounts.drive_refresh` e os conectores com `PIA_ENCRYPTION_KEY`; não há ferramenta para isso no repositório). |
| Microsoft (conector) | Orientar o titular a remover o app nas permissões da conta Microsoft. Sem revogação remota no código. |
| Discord (token do bot próprio) | O token do bot é do titular (`accounts.discord_token`, conector `discord`). Orientar a **regenerar o token** no Discord Developer Portal. |
| Taverns, Object Storage (S3/R2/compatível) | Credenciais do titular: orientar a revogar/rotacionar no provedor. |
| Suno (feature 0001, quando estiver na develop) | A desconexão faz `DELETE` sem revogação remota. Orientar o titular a revogar no Suno. **Fora da v1.0** das páginas legais; revisar este runbook na v1.1. |
| Sessões e tokens MCP, computadores | São apagados pelo cascade (`sessions`, `devices`). Opcionalmente, antes, revogar pelo painel. |

## 2. Apagar no PostgreSQL (uma transação)

Rode com o **usuário da aplicação** (`PGUSER` do `.env`) no banco `PGDATABASE`. O PostgreSQL não faz parte do `compose.yaml`; no deploy com Traefik ele está na rede `postgres`.

- **Pendência:** nome do contêiner/host do PostgreSQL e o comando exato de acesso na VPS não estão no repositório.

```sql
-- Substitua pelo e-mail da conta, em minúsculas (no psql, \set não aceita comentário na mesma linha)
\set email 'titular@exemplo'
BEGIN;
-- 1. Conferir a conta e anotar o id (usado no passo 3, arquivos em /data)
SELECT id, email, admin FROM pia_server.accounts WHERE email = :'email';
-- 2. Conferir se outras contas dependem do bot desta conta (ver seção 0, item 4)
SELECT guild_id, account_id FROM pia_server.discord_guild_links
 WHERE bot_account_id = (SELECT id FROM pia_server.accounts WHERE email = :'email')
   AND account_id <> (SELECT id FROM pia_server.accounts WHERE email = :'email');
-- 3. Apagar (ON DELETE CASCADE nas tabelas filhas)
DELETE FROM pia_server.accounts WHERE email = :'email' AND admin = false RETURNING id;
-- Confira: exatamente 1 linha. Se 0 ou mais de 1, ROLLBACK e investigue.
COMMIT;
```

O cascade apaga: `discord_guild_links`, `discord_link_requests`, `sessions`, `devices`, `device_jobs` (via `devices`), `secretary`, `notices`, `notice_delivery`, `profiles` (chats e configurações sincronizados), `connectors` e `media` (metadados). Na feature 0001 (quando entrar): `suno_accounts`, `suno_connect_attempts`, `music_generations` e `music_generation_tracks`.

## 3. Apagar arquivos no volume `/data`

Gravações pendentes e `recording.json` ficam em `/data/<id>/` (`PIA_DATA=/data` no `Dockerfile`, volume `pia-data` no `compose.yaml`; `src/queue.js`, `src/recorder.js`). O cascade não os apaga.

```sh
# <id> = id anotado no passo 2.1; confira o caminho antes de apagar
docker compose exec pia-server ls -la /data/<id>
docker compose exec pia-server rm -rf -- /data/<id>
```

Se houver uma gravação em andamento dessa conta, pare-a pelo Discord antes (ou aguarde o fim), senão a pasta é recriada.

Temporários: uploads em andamento usam `/tmp/pia-media-*` e `/tmp/pia-artifact-*`, apagados ao fim da requisição. Se o processo caiu no meio de um envio pode sobrar um arquivo órfão; ele some quando o contêiner é recriado (`docker compose up -d --force-recreate`).

## 4. O que NÃO é apagado (informar ao titular)

1. **Cópias no Google Drive do titular** (gravações, MP3/WAV, capturas de tela): pertencem a ele e ficam na pasta da PIA no Drive. Ele apaga se quiser.
2. **Dados locais no PC** (SQLite, cofre do sistema, `localStorage` da PIA desktop): o titular apaga ou desinstala.
3. **Backups manuais do PostgreSQL**, se existirem (o README recomenda guardar a chave com o backup). **Pendência:** se há backups, onde ficam e por quanto tempo; a linha apagada pode continuar neles até a rotação.
4. **Dados já usados em treinamento** podem não ser removíveis do modelo (`REMOCAO_DADOS_TREINADOS`, P10). Hoje não existe pipeline de treinamento no código (T10).
5. **Logs de acesso com IP:** o access log do Traefik e a lista de IPs bloqueados do CrowdSec não são apagados pela exclusão da conta. São mantidos pelo tempo necessário para segurança, hoje sem rotação (pendência P14). Informe isso ao titular se ele perguntar.

## 5. Depois da exclusão

- Um novo login com o mesmo e-mail **não** recria a conta: `finish` só atualiza contas existentes (`src/auth.js`, "Esta conta Google não está autorizada"). Voltar a usar exige novo convite do admin.
- Responder ao titular por **contato@travelrpg.com** confirmando: o que foi apagado no servidor (seção 2 e 3), o que ele precisa fazer nos provedores (seção 1) e o que permanece (seção 4).

Modelo de resposta (ajustar):

> Olá. Concluímos a exclusão da sua conta na PIA Server em DD/MM/AAAA: conta, sessões, computadores pareados, chats e configurações sincronizados, conectores, avisos da Secretária, metadados de mídia e gravações pendentes no servidor. Para revogar o acesso da PIA à sua conta Google, acesse as permissões da sua conta Google e remova a PIA; faça o mesmo nos demais serviços conectados. As cópias na pasta da PIA no seu Google Drive e os dados no seu computador não foram apagados e ficam sob seu controle. Dados já usados em treinamento de modelos podem não ser removíveis. Registros técnicos de acesso com endereço IP são mantidos pelo tempo necessário para segurança e prevenção de abuso.

## 6. Exportação (acesso e portabilidade)

Não há exportação no código. **Pendência:** definir o procedimento manual (consultas de leitura por `account_id`; `profiles` e `connectors` estão cifrados com a chave do servidor e exigiriam decifrar). Recomendação do plano: feature futura de exclusão e exportação self-service.
