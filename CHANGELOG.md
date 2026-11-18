# Changelog

## Unreleased

### Added
- Contas Suno no servidor (T2): tabelas `suno_oauth_clients`, `suno_accounts` (N por conta PIA, `UNIQUE(suno_subject)`) e `suno_connect_attempts`; DCR com redirect `/auth/connectors/suno`; connect assíncrono (`POST /device/suno/connect`, `GET /device/suno/connect/:attempt_id`), callback público com PKCE S256 e `state` de uso único (600 s); `GET /device/suno/status` com `accounts[]`, `default_account_id` e `active_job`; `DELETE /device/suno/accounts/:id`.
- Refresh do token Suno com `SELECT … FOR UPDATE` por conta (preventivo a menos de 60 s e reativo no 401), rotação do refresh token e `invalid_grant` → `refresh_failed`/`suno_credential_expired`.
- `resolveSunoIdentity` isolada (ordem configurável: `get_account`, `initialize._meta['suno/account']`, `get_credits`, userinfo e claims do token) com falha `suno_identity_unavailable`; conta de outra conta PIA → `suno_account_taken`; `replace_account_id` com outra identidade → `suno_account_mismatch`.
- `code` nas respostas de erro das rotas Suno (lista branca também no handler geral) e `capabilities: ["suno:3"]` em `GET /device/account`.

- `PATCH /device/suno/accounts/:id` `{label}` para o apelido da conta Suno (RN07); reconectar a mesma conta mantém o apelido.
- `credential_state: "unavailable"` (refresh com 5xx/timeout; tokens mantidos, `available: false`) e `sunoCredentialRefusal()`/`sunoAccountStatus()` para a T4 (`unavailable` → `suno_unavailable`, `refresh_failed` → `suno_credential_expired`).

### Changed
- `splitProfile` descarta segredos `mcp:*` dos perfis sincronizados.
- `credential_state` não tem mais `expired`: só `configured`, `unavailable` e `refresh_failed`.
- Tentativa de connect inexistente: code `suno_connect_not_found` (antes `not_found`).

## v0.2.1 - 2026-11-15

### Added
- Rota pública `GET /oauth/callback` com exibição do código de autorização copiável (Clipboard API com fallback `execCommand`), tratamento de `error`/parâmetros ausentes/excessivos, escape HTML contra XSS e headers `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.

## 2026-11-15

### Added
- Header de resposta `X-PIA-Protocol: 1` em `/device/*`, `/mcp` e `/health`, para identificação da versão do contrato com o cliente PIA.
