## Resumo

<!-- O que muda e por quê. -->

## Testes

- [ ] `npm test` passa
- [ ] Testes novos ou ajustados para o comportamento alterado

## Checklist de privacidade (RN02)

- [ ] Esta PR **não** cria nem altera dado pessoal guardado, terceiro, integração, cookie, log ou finalidade de uso
- [ ] Ou: a Política de Privacidade foi atualizada nesta PR (ou já foi publicada antes do deploy) cobrindo a mudança

## Se a PR altera os textos legais (`src/legal/`)

- [ ] Nova versão em arquivo novo `*-vX.Y.html`; nenhuma versão publicada foi editada
- [ ] Entrada nova em `src/legal/versoes.js` com versão e resumo (CA22)
- [ ] `CHANGELOG.md` atualizado
- [ ] Trechos que dependem do Advogado estão em `src/legal/juridico.js` com `revisado:false`
- [ ] Sem colchetes, `TODO`, `XXX`, `lorem` ou `example.invalid` no texto final (CA11)
- [ ] Se for release: datas preenchidas, todos os `revisado:true`, parecer favorável do Advogado sobre esta versão (CA25) e `PIA_LEGAL_RELEASE=1 npm test` passando
