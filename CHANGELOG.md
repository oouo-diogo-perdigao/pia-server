# Changelog

## Unreleased

### Páginas legais v1.1 (rascunho, feature 0004)
- Política de Privacidade e Termos de Serviço v1.1 com a feature 0001 (Suno), sobre o texto final da v1.0: conta Suno, histórico de gerações de música, Suno como terceiro e na transferência internacional (sem país), exclusão de item do histórico, desconexão da conta Suno, links que expiram e áudio do Suno repassado sem ser guardado. Novos `privacidade-v1.1.html`, `termos-v1.1.html` e `JURIDICO['1.1']` (trechos novos ou alterados com `revisado:false`); entradas 1.1 em `versoes.js` com datas e `sha256` nulos. A v1.0 continua congelada em `/privacidade/v1.0` e `/termos/v1.0`, com o mesmo `sha256`.
- Conferência de cada afirmação contra o código e divergências com o rascunho em `docs/legal-v1.1-conferencia.md`; runbook de exclusão de conta com as tabelas do Suno.
- Testes: CA27 vale para a v1.0 e exige o Suno na v1.1; regras da v1.0 (RN11, CA28, Caminho A) conferidas na v1.1; `sha256` da v1.0 repetido no teste de snapshot; preview com a v1.1 em rascunho. `PIA_LEGAL_RELEASE=1 npm test` falha de propósito até o release da v1.1.

### Release legal v1.0 - 2026-11-17
- Política de Privacidade e Termos de Serviço v1.0 publicados: `vigencia` e `atualizacao` em 2026-11-17 e `sha256` do HTML congelado em `src/legal/versoes.js` (privacidade `a2ff6c287715…`, termos `9b9b7335fcd2…`). Os 16 trechos de `JURIDICO['1.0']` passam a `revisado:true` (parecer final do Advogado favorável sobre `59a1a82`, correções F.4 aplicadas em `3f1cccf`).
- As páginas saem do modo rascunho: sem selos, sem faixa, sem `noindex`, com `Cache-Control: public, max-age=3600`; `/privacidade/v1.0` e `/termos/v1.0` respondem 200 com a cópia congelada; o embed do Discord mostra o aviso 4.14 sem selo.
- Testes do conteúdo real adaptados ao estado publicado; o modo rascunho segue coberto com fontes sintéticas (incluindo `textoJuridico` com e sem revisão). `npm test` e `PIA_LEGAL_RELEASE=1 npm test` passam.

### Added
- Textos v1.0 da Política de Privacidade e dos Termos de Serviço em `src/legal/conteudo/` (F2-02), no formato do módulo `src/legal.js` (F2-01): bloco "Em resumo", seções com `h2 id` e tokens `{{NOME}}`. Escopo da v1.0 sem a feature 0001 (requisitos v2.7, CA27); os trechos dela ficam em `docs/legal-v1.1-rascunho.md` para a v1.1.
- Trechos jurídicos da v1.0 em `src/legal/juridico.js` (`JURIDICO['1.0']`), todos com `revisado:false` até o parecer do Advogado, incluindo `ENCARREGADO`, `SALVAGUARDAS_TRANSFERENCIA`, `ORIGEM_TREINAMENTO_MIDIA` e `TREINAMENTO_MICROSOFT` (antes `TREINAMENTO_MICROSOFT_SUNO`), `DIREITOS_MUSICAS_GERADAS` (Termos, seção 6), ao lado de `TREINAMENTO_MP3_GERADOS` (Política e Termos), `LOGS_ACESSO` e `AVISO_GRAVACAO_DISCORD` da F2-01/F2-10. Ainda em rascunho: não publicar antes do parecer (RN09, CA25).
- Asserts de conteúdo da v1.0 em `test/legal.test.js` (14 seções da Política, 13 dos Termos, CA05 a CA10, CA21, CA27).
- Gate de release `test/legal_release.test.js`, sobre `pendencias()`, `legalFiles()` e `versoesAlteradas()` de `src/legal.js`, ligado por `PIA_LEGAL_RELEASE=1` no workflow `container.yml` em push para `main` e em tags `v*`.
- `docs/legal.md` (como lançar uma versão nova dos textos) e template de PR com o checklist da Política.

### Changed
- Textos v1.0 ajustados ao parecer jurídico sobre `f1338f7` (Caminho A, decisões do Diogo): as redações da seção 4 e do adendo (nova 4.8) em `JURIDICO['1.0']`, e os ajustes 5.1 a 5.6 e 5.9 no HTML fixo. Só conteúdos de texto entram no treinamento; voz, MP3 e terceiros do Discord ficam fora. `LOGS_ACESSO` fica com o texto anterior até a decisão sobre o access log do Traefik (a 4.3 não foi aplicada). Também: encarregado sem a dispensa de pequeno porte, eliminação e retenção explicadas, "Agência Nacional de Proteção de Dados" e link da Google Workspace User Data and Developer Policy. 5.7 e 5.8 ficam fora da v1.0. Todos os trechos seguem com `revisado:false` até o parecer favorável.
- Embed "Gravação em andamento" do bot do Discord com o aviso da 4.14 (terceiros fora do treinamento e contato por e-mail).
- Adendo 2 do parecer: `LOGS_ACESSO` passa a dizer que a PIA guarda registros de acesso com IP (frase neutra, sem prazo), com a base legal na seção 5 e menções nas seções 4, 8 e 9; nova 4.8 sem país, com a transcrição de voz e com a frase do CrowdSec do Adendo 4 (ligado, decisão do Diogo); Retenção (5.3) com os seis itens e o prazo de 15 dias no novo trecho `EXCLUSAO_CONTA_PRAZO`; provedores de LLM (5.9, texto do Adendo 4, sem prometer que os provedores não treinam) no novo trecho `PROVEDORES_LLM`; seção 7 com `HOSPEDAGEM_TEXTO` e 2º parágrafo finais do Adendo 4 (servidor e banco no Brasil); última frase da 4.9 só com a não identificação; runbook de exclusão de conta atualizado. Asserts do CA28.
- Adendo 3 do parecer: `AVISO_GRAVACAO_DISCORD` (4.14), `CONSENTIMENTO_TERCEIROS_DISCORD` (4.2) e `OPT_OUT_TREINAMENTO` (4.13) sem a frase ambígua sobre as vozes de terceiros. Todos os trechos seguem `revisado:false`.
- Parecer final sobre `59a1a82` (favorável com ressalvas): correções obrigatórias F.4 (o compromisso de não treinar com dados do Google e da Microsoft é da PIA) e ajustes recomendados F.5 (chave e conta do usuário na 5.9, seção 7, seção 12, Microsoft nos Termos, Retenção e runbook). Trechos seguem `revisado:false`.

### Added
- Contas Suno no servidor (T2): tabelas `suno_oauth_clients`, `suno_accounts` (N por conta PIA, `UNIQUE(suno_subject)`) e `suno_connect_attempts`; DCR com redirect `/auth/connectors/suno`; connect assíncrono (`POST /device/suno/connect`, `GET /device/suno/connect/:attempt_id`), callback público com PKCE S256 e `state` de uso único (600 s); `GET /device/suno/status` com `accounts[]`, `default_account_id` e `active_job`; `DELETE /device/suno/accounts/:id`.
- Refresh do token Suno com `SELECT … FOR UPDATE` por conta (preventivo a menos de 60 s e reativo no 401), rotação do refresh token e `invalid_grant` → `refresh_failed`/`suno_credential_expired`.
- `resolveSunoIdentity` isolada (ordem configurável: `get_account`, `initialize._meta['suno/account']`, `get_credits`, userinfo e claims do token) com falha `suno_identity_unavailable`; conta de outra conta PIA → `suno_account_taken`; `replace_account_id` com outra identidade → `suno_account_mismatch`.
- `code` nas respostas de erro das rotas Suno (lista branca também no handler geral) e `capabilities: ["suno:3"]` em `GET /device/account`.
- Histórico de gerações de música da conta PIA (feature 0001, RN13/RN14/RN25/CA24): tabelas `pia_server.music_generations` (Suno e locais, `source` + `provider`, idempotência por `(account_id, client_id)`) e `pia_server.music_generation_tracks` (faixas; o `audio_url` do Suno fica só no servidor). `suno_account_id` → `suno_accounts(id) ON DELETE SET NULL`.
- `POST /device/music/generations`: registra uma geração local (Local/ACE-Step, Gemini…), idempotente por `client_id` (201 na criação, 200 na repetição com o mesmo registro). Recusa `source: "suno"` e qualquer `audio_url`.
- `GET /device/music/generations?limit=100&cursor=`: histórico de todos os PCs da conta, jobs ativos primeiro e depois do mais novo para o mais antigo, com `from_this_device`, `suno_account` (`{id, name}`, name = label → suno_name → suno_email), `tracks` e `next_cursor` opaco. O `audio_url` nunca vai ao device.
- `DELETE /device/music/generations/:id`: exclusão definitiva (registro, prompt, letra, faixas e links) por qualquer PC da conta; 404 para id de outra conta ou já apagado; 409 `music_generation_active` enquanto o job está em andamento.
- Erros dessas rotas saem como `4xx {error, code}`.

- `PATCH /device/suno/accounts/:id` `{label}` para o apelido da conta Suno (RN07); reconectar a mesma conta mantém o apelido.
- `credential_state: "unavailable"` (refresh com 5xx/timeout; tokens mantidos, `available: false`) e `sunoCredentialRefusal()`/`sunoAccountStatus()` para a T4 (`unavailable` → `suno_unavailable`, `refresh_failed` → `suno_credential_expired`).

- Cliente MCP do Suno (T3b, `src/suno_mcp.js` e `src/suno_client.js`): Streamable HTTP com `Mcp-Session-Id` e reinitialize, JSON e SSE, timeout por `AbortSignal`, descoberta tolerante das tools (geração, status, conta, créditos), mapeamento de argumentos pelo schema, polling de clips pendentes sem prazo total (backoff de 5 s a 60 s; falha transitória não encerra a geração) e tradução de erros (`suno_credential_expired`, `suno_no_credits`, `suno_timeout`, `suno_unavailable`) sem vazar tokens, corpos ou URLs assinadas.
- `POST /api/admin/suno/spike` (admin, sessão web): `tools/list` de uma conta Suno conectada, sem tokens.
- Jobs do Suno (T4, `src/suno_jobs.js`): `POST /device/suno/jobs` (idempotente por `client_job_id`, um job ativo por conta PIA, escolha da conta Suno), `GET /device/suno/jobs/:id` e `POST /device/suno/jobs/:id/cancel`. O worker roda no processo e faz `ceil(N/2)` chamadas, guardando todas as faixas prontas (extras com `extra: true`) em `music_generations`/`music_generation_tracks` com o link do Suno só no servidor; o cancelamento mantém as faixas prontas; no boot, os jobs ativos viram `interrupted` sem refazer `tools/call`; `active_job` aparece no status.
- Download do áudio (T5, `src/suno_audio.js`): `GET /device/music/generations/:id/tracks/:n/audio`, proxy em streaming do link do Suno para qualquer PC da mesma conta PIA, sem gravar em disco nem vazar o link. Tem `Range`/206, limite de 100 MiB (pelo `Content-Length` ou por contagem), só https, até 3 redirects revalidados, bloqueio de IP privado/loopback/link-local depois do DNS, timeouts, exigência de `Content-Type` de áudio e abort do upstream quando o cliente desconecta. Codes novos: `music_generation_not_found`, `suno_track_not_found`, `suno_track_unavailable` (410), `suno_track_too_large`, `download_failed`.
- Coluna `music_generations.suno_account_name` (migração idempotente `ADD COLUMN IF NOT EXISTS`), preenchida na criação do job com o nome da conta Suno escolhida. Histórico e job usam `COALESCE(label, suno_name, suno_email, suno_account_name)`; com a conta Suno apagada, `suno_account` sai como `{id: null, name}`.
- Limpeza de temporários no boot (`src/cleanup_tmp.js`, `cleanupOrphanTemp`): apaga diretórios órfãos `pia-media-*`/`pia-artifact-*` do tmpdir, `*.partial.zip` das gravações do Discord e os arquivos que sobraram de gravações já `uploaded`. Nunca toca em gravação pendente, em retry ou gravando; loga só contagens e nunca derruba o boot (supõe uma instância só).

### Changed
- `resolveSunoIdentity` usa o cliente MCP e a tool de conta descoberta (`get_account`, `account-me`, `get_profile`…).
- `withSunoToken` também reconhece `upstreamStatus: 401` nos erros do cliente MCP.
- `splitProfile` descarta segredos `mcp:*` dos perfis sincronizados.
- `credential_state` não tem mais `expired`: só `configured`, `unavailable` e `refresh_failed`.
- Tentativa de connect inexistente: code `suno_connect_not_found` (antes `not_found`).
- Polling da geração Suno: erro permanente encerra o polling, mantendo as faixas prontas em `partial` (402 → `suno_no_credits`; protocolo ou 4xx não transitório → `suno_unavailable`; 401 repetido depois do refresh → `suno_credential_expired`). Só rede, timeout, 5xx, 408 e 429 fazem backoff. `transientSunoError()` exportada; 429 e texto de rate limit agora são `detail: "rate_limited"` e outros 4xx `detail: "http_4xx"`.

## v0.2.1 - 2026-11-15

### Added
- Rota pública `GET /oauth/callback` com exibição do código de autorização copiável (Clipboard API com fallback `execCommand`), tratamento de `error`/parâmetros ausentes/excessivos, escape HTML contra XSS e headers `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.

## 2026-11-15

### Added
- Header de resposta `X-PIA-Protocol: 1` em `/device/*`, `/mcp` e `/health`, para identificação da versão do contrato com o cliente PIA.
