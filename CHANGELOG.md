# Changelog

## Unreleased

### Added
- Textos v1.0 da Política de Privacidade e dos Termos de Serviço em `src/legal/conteudo/` (F2-02), no formato do módulo `src/legal.js` (F2-01): bloco "Em resumo", seções com `h2 id` e tokens `{{NOME}}`. Escopo da v1.0 sem a feature 0001 (requisitos v2.7, CA27); os trechos dela ficam em `docs/legal-v1.1-rascunho.md` para a v1.1.
- Trechos jurídicos da v1.0 em `src/legal/juridico.js` (`JURIDICO['1.0']`), todos com `revisado:false` até o parecer do Advogado, incluindo `ENCARREGADO`, `SALVAGUARDAS_TRANSFERENCIA`, `ORIGEM_TREINAMENTO_MIDIA` e `TREINAMENTO_MICROSOFT`. Ainda em rascunho: não publicar antes do parecer (RN09, CA25).
- Asserts de conteúdo da v1.0 em `test/legal.test.js` (14 seções da Política, 13 dos Termos, CA05 a CA10, CA21, CA27).
- Gate de release `test/legal_release.test.js`, sobre `pendencias()`, `legalFiles()` e `versoesAlteradas()` de `src/legal.js`, ligado por `PIA_LEGAL_RELEASE=1` no workflow `container.yml` em push para `main` e em tags `v*`.
- `docs/legal.md` (como lançar uma versão nova dos textos) e template de PR com o checklist da Política.

## v0.2.1 - 2026-11-15

### Added
- Rota pública `GET /oauth/callback` com exibição do código de autorização copiável (Clipboard API com fallback `execCommand`), tratamento de `error`/parâmetros ausentes/excessivos, escape HTML contra XSS e headers `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.

## 2026-11-15

### Added
- Header de resposta `X-PIA-Protocol: 1` em `/device/*`, `/mcp` e `/health`, para identificação da versão do contrato com o cliente PIA.
