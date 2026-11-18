# Changelog

## Unreleased

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

### Changed
- `resolveSunoIdentity` usa o cliente MCP e a tool de conta descoberta (`get_account`, `account-me`, `get_profile`…).
- `withSunoToken` também reconhece `upstreamStatus: 401` nos erros do cliente MCP.
- `splitProfile` descarta segredos `mcp:*` dos perfis sincronizados.
- `credential_state` não tem mais `expired`: só `configured`, `unavailable` e `refresh_failed`.
- Tentativa de connect inexistente: code `suno_connect_not_found` (antes `not_found`).

## v0.2.1 - 2026-11-15

### Added
- Rota pública `GET /oauth/callback` com exibição do código de autorização copiável (Clipboard API com fallback `execCommand`), tratamento de `error`/parâmetros ausentes/excessivos, escape HTML contra XSS e headers `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.

## 2026-11-15

### Added
- Header de resposta `X-PIA-Protocol: 1` em `/device/*`, `/mcp` e `/health`, para identificação da versão do contrato com o cliente PIA.
