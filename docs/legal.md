# Páginas legais: Política de Privacidade e Termos de Serviço

Feature 0002. As páginas são públicas, sem login, em `/privacidade` e `/termos` (por exemplo `https://pia.travelrpg.com/privacidade`). Os links são montados a partir de `PIA_PUBLIC_URL`; não há domínio fixo no código.

> Os textos são um rascunho técnico e de produto e não substituem o parecer de um advogado. Nenhuma versão vai para produção sem parecer favorável sobre a mesma versão X.Y (RN09, CA25).

## Arquivos

| Arquivo | Conteúdo | Tarefa |
|---|---|---|
| `src/legal.js` | Motor: tokens, escape, layout, sumário, histórico, rascunho, rotas, `pendencias()`, `hashDocumento()`, `versoesAlteradas()`. O contrato do fragmento e a lista de tokens ficam no comentário do topo | F2-01 |
| `src/legal/dados.js` | Dados públicos aprovados (controlador, e-mail, encarregado, foro, domínio, hospedagem, idade mínima) | F2-01 |
| `src/legal/juridico.js` | Trechos que dependem do Advogado, versionados: `JURIDICO['1.0'] = { CHAVE: { texto, revisado, pendencia, assunto } }` | F2-01 e F2-02 |
| `src/legal/versoes.js` | Manifesto: `versao`, `vigencia`, `atualizacao` (AAAA-MM-DD ou `null`), `resumo`, `juridico` (conjunto) e `sha256` | F2-01 |
| `src/legal/conteudo/privacidade-v1.0.html` | Fragmento da Política: "Em resumo" e 14 seções | F2-02 |
| `src/legal/conteudo/termos-v1.0.html` | Fragmento dos Termos: "Em resumo" e 13 seções | F2-02 |
| `test/legal.test.js` | Motor (F2-01) e conteúdo da v1.0 (F2-02: seções, termos obrigatórios, CA27) | F2-01 e F2-02 |
| `test/legal_release.test.js` | Gate de release (RN07, CA11) | F2-06 |
| `docs/legal-v1.1-rascunho.md` | Trechos da feature 0001 retirados da v1.0, para a v1.1. Não é lido pelo código nem servido | F2-02 |

## Formato do fragmento (resumo do contrato de `src/legal.js`)

- Só o corpo. O `<h1>`, as datas, o sumário, o "Histórico de versões" e o rodapé vêm do layout.
- Exatamente um bloco `<!-- legal:resumo --><ul>…</ul><!-- /legal:resumo -->`, com 3 a 5 `<li>` (RN01).
- Cada seção começa com `<h2 id="slug">N. Título</h2>` (slug com a-z, 0-9 e hífen, único). Ids reservados: `em-resumo`, `sumario`, `historico-de-versoes`. Use `h3` dentro das seções.
- `<h1`, `<script` e atributos `on*=` dão erro. Qualquer `[` liga o modo rascunho. Comentários são removidos antes de renderizar.
- Links externos só como `<a href>` normal (hoje, apenas a Google API Services User Data Policy). Nada de CSS, JS ou imagens externas.
- Tokens `{{NOME}}`: de dados (`CONTROLADOR_NOME`, `CONTATO_EMAIL`, `ENCARREGADO_NOME`, `ENCARREGADO_EMAIL`, `FORO`, `FORO_RESSALVA`, `DOMINIO_OFICIAL`, `HOSPEDAGEM_TEXTO`, `IDADE_MINIMA`), gerados (`ORIGEM`, `URL_PRIVACIDADE`, `URL_TERMOS`, `VERSAO`, `VIGENCIA`, `ATUALIZACAO`) e jurídicos (chaves do conjunto da versão). Token desconhecido ou vazio é erro.
- Um trecho jurídico é texto puro (sem HTML), pode usar tokens de dados e gerados (por exemplo `{{CONTATO_EMAIL}}`), mas não outro token jurídico. Use cada um como bloco de frase: `<p>{{LOGS_ACESSO}}</p>`.

### Trechos jurídicos da v1.0 (`JURIDICO['1.0']`, todos `revisado:false`)

| Chave | Pendência | Onde aparece |
|---|---|---|
| `ENCARREGADO` | P04 | Política, 1 |
| `CONSENTIMENTO_TERCEIROS_DISCORD` | P11 | Política, 3 |
| `LOGS_ACESSO` | T04 | Política, 3: "Não guardamos logs de acesso com endereço IP" (v2.4/v2.5) |
| `TREINAMENTO_MICROSOFT` | P11 | Política, 4 (texto aprovado pelo Diogo; falta o parecer) |
| `BASE_LEGAL_TREINAMENTO` | P10 | Política, 5 |
| `ORIGEM_TREINAMENTO_MIDIA` | P11 | Política, 6 (voz e MP3 no treinamento frente à Limited Use) |
| `SALVAGUARDAS_TRANSFERENCIA` | P05 | Política, 7 |
| `REMOCAO_DADOS_TREINADOS` | P10 | Política, 8 |
| `PRAZO_RESPOSTA_TITULAR` | P10 | Política, 10 |
| `OPT_OUT_TREINAMENTO` | P10 | Política, 10 (redação da v2.6, com `{{CONTATO_EMAIL}}`) |
| `LIMITACAO_CDC` | P10 | Termos, 8 |

## Escopo da v1.0

A v1.0 sai sem a feature 0001 (requisitos v2.7): nenhuma página cita a integração de música da 0001 nem histórico de gerações (CA27, verificado em `test/legal.test.js` no HTML renderizado e nas fontes legais). Os trechos retirados ficam em `docs/legal-v1.1-rascunho.md` e entram numa v1.1, junto com a F2-09, depois do merge da 0001.

## Rascunho e gate de release

- Trecho com `revisado:false` aparece com o selo de revisão jurídica, e data nula com o selo de preenchimento no release. Os selos usam colchetes de propósito.
- Qualquer pendência ativa liga o modo rascunho: faixa "RASCUNHO, não publicar", `Cache-Control: no-store`, `X-Robots-Tag: noindex` e `/vX.Y` sem rota (só versões publicadas ganham `/vX.Y`).
- O gate (`test/legal_release.test.js`) usa `pendencias()`, `legalFiles()` e `versoesAlteradas()` de `src/legal.js` e só é aplicado com `PIA_LEGAL_RELEASE=1`. Ele falha se houver:
  - trecho jurídico com `revisado:false` ou data nula em `versoes.js`;
  - página servida em modo rascunho;
  - `[`, `TODO`, `XXX`, `lorem` ou `example.invalid` no HTML servido;
  - versão publicada com HTML diferente do `sha256` do manifesto.
- Sem a variável, `npm test` passa: o gate valida a si mesmo com fixtures (final passa, rascunho falha), lista as pendências atuais como diagnóstico (`ℹ`) e fica `skipped`.
- No CI (`.github/workflows/container.yml`), a variável vale `1` em push para `main` e em tags `v*`. Em PRs e outras branches fica vazia. **Consequência esperada:** enquanto houver rascunho, um push para `main` falha no `npm test` e a imagem `:main` não é publicada. Por isso a 0002 só entra na develop depois do parecer (RN10, CA25).
- Local: `PIA_LEGAL_RELEASE=1 npm test`.

## Como lançar uma versão nova (X.Y)

1. **Nunca edite** um `*-vX.Y.html` nem um conjunto jurídico de uma versão publicada (o teste de hash falha). Crie `*-vX.Y+1.html` (ou `X+1.0` para mudança relevante de finalidade ou de dado, RN05).
2. Se o texto jurídico mudar, crie um conjunto novo em `juridico.js` (por exemplo `JURIDICO['1.1']`), com `revisado:false` nos trechos novos.
3. Acrescente a versão em `src/legal/versoes.js` com `resumo`, `juridico`, `vigencia`/`atualizacao` em `null` e `sha256: null`.
4. Ajuste `test/legal.test.js` se mudarem seções ou termos obrigatórios.
5. Registre em `CHANGELOG.md` ("Unreleased") e abra a PR com o checklist do template.
6. Depois do QA e do parecer favorável do Advogado sobre a mesma versão: commit "release legal vX.Y" com as datas (data planejada do deploy, nunca `new Date()`), todos os `revisado:true` e o `sha256` informado pelo teste de hash.
7. Rode `PIA_LEGAL_RELEASE=1 npm test`. Ele precisa passar.
8. PR para `main` e tag. Se o deploy atrasar, corrija a data (e o hash) antes da tag.
