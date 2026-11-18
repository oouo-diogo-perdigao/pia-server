# Changelog

## Unreleased

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

## v0.2.1 - 2026-11-15

### Added
- Rota pública `GET /oauth/callback` com exibição do código de autorização copiável (Clipboard API com fallback `execCommand`), tratamento de `error`/parâmetros ausentes/excessivos, escape HTML contra XSS e headers `Cache-Control: no-store` e `Referrer-Policy: no-referrer`.

## 2026-11-15

### Added
- Header de resposta `X-PIA-Protocol: 1` em `/device/*`, `/mcp` e `/health`, para identificação da versão do contrato com o cliente PIA.
