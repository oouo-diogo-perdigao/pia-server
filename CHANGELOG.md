# Changelog

## v0.2.1 - 2026-11-15

### Added
- Rota pública `GET /oauth/callback` com exibição do código de autorização copiável (Clipboard API com fallback `execCommand`), tratamento de `error`/parâmetros ausentes/excessivos, escape HTML contra XSS e headers `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.

## 2026-11-15

### Added
- Header de resposta `X-PIA-Protocol: 1` em `/device/*`, `/mcp` e `/health`, para identificação da versão do contrato com o cliente PIA.
