# Páginas legais: Política de Privacidade e Termos de Serviço

Feature 0002. As páginas são públicas, sem login, em `/privacidade` e `/termos` (por exemplo `https://pia.travelrpg.com/privacidade`). Os links são montados a partir de `PIA_PUBLIC_URL`; não há domínio fixo no código.

> **Estado atual:** v1.1 da Política e dos Termos publicada em 18/11/2026 (release legal v1.1, vigência e atualização 2026-11-18), com o parecer do Advogado sobre `3862937` (favorável com ressalvas) e os textos literais aplicados em `64a9fb0` e `f606f48` (O1 na Alternativa A, decisão do Diogo). Os trechos de `JURIDICO['1.1']` estão `revisado:true`, `pendencias()` está vazio e o `sha256` das duas páginas v1.1 está em `versoes.js` (privacidade `3cbf9340…`, termos `d1c0db23…`). `/privacidade` e `/termos` servem a v1.1; a v1.0 continua em `/privacidade/v1.0` e `/termos/v1.0`, com o mesmo `sha256`.
>
> **A v1.0 não chegou à produção:** foi aprovada e congelada em 17/11/2026 (release legal v1.0, `5ffd664`), mas nenhum deploy de produção a levou, e ela foi substituída pela v1.1 antes de ser publicada em produção (O2 do parecer da v1.1). A entrada da v1.0 em `versoes.js` (datas `2026-11-17` e `sha256`) não muda, porque a cópia congelada depende dela. O registro está no resumo da v1.1 no "Histórico de versões" e no `CHANGELOG.md`. Ficou fora desta release o R7 (aviso no momento da conexão do Suno): não há tela antes do login no servidor, e ele vira follow-up no app desktop.
>
> **Histórico:** v1.0 da Política e dos Termos aprovada em 17/11/2026 (vigência e atualização 2026-11-17), com parecer final favorável (com ressalvas) do Advogado sobre `59a1a82` e as correções obrigatórias F.4 aplicadas em `3f1cccf`. Os 16 trechos de `JURIDICO['1.0']` estão `revisado:true`, `pendencias()` está vazio e o `sha256` das duas páginas está em `versoes.js` (privacidade `a2ff6c28…`, termos `9b9b7335…`). A v1.0 está congelada: texto novo exige versão nova.
>
> **v1.1 (feature 0004, publicada em 18/11/2026; o texto abaixo descreve o estado de rascunho anterior ao release):** acrescenta a feature 0001 (Suno) sobre o texto final da v1.0, em `privacidade-v1.1.html`, `termos-v1.1.html` e `JURIDICO['1.1']`, com `vigencia`, `atualizacao` e `sha256` nulos em `versoes.js`. Só aparece em `npm run legal:preview` (sem rota `/v1.1`; `/privacidade` e `/termos` continuam na v1.0). Conferência contra o código e divergências com o rascunho: `docs/legal-v1.1-conferencia.md`. Os ajustes do parecer da feature 0003 (avisos sobre provedores de IA, Groq) ficam para uma v1.2, junto com a 0003.
>
> O parecer é de uma IA e não substitui a revisão de advogado inscrito na OAB. Nenhuma versão vai para produção sem parecer favorável sobre a mesma versão X.Y (RN09, CA25).

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
| `src/legal/conteudo/privacidade-v1.1.html`, `termos-v1.1.html` | Fragmentos da v1.1 (rascunho, com o Suno) | 0004 |
| `docs/legal-v1.1-conferencia.md` | Cada afirmação nova da v1.1 com o arquivo:linha do código, divergências rascunho x código e o que os requisitos pedem a mais | 0004 |

## Formato do fragmento (resumo do contrato de `src/legal.js`)

- Só o corpo. O `<h1>`, as datas, o sumário, o "Histórico de versões" e o rodapé vêm do layout.
- Exatamente um bloco `<!-- legal:resumo --><ul>…</ul><!-- /legal:resumo -->`, com 3 a 5 `<li>` (RN01).
- Cada seção começa com `<h2 id="slug">N. Título</h2>` (slug com a-z, 0-9 e hífen, único). Ids reservados: `em-resumo`, `sumario`, `historico-de-versoes`. Use `h3` dentro das seções.
- `<h1`, `<script` e atributos `on*=` dão erro. Qualquer `[` liga o modo rascunho. Comentários são removidos antes de renderizar.
- Links externos só como `<a href>` normal (hoje, apenas a Google API Services User Data Policy). Nada de CSS, JS ou imagens externas.
- Tokens `{{NOME}}`: de dados (`CONTROLADOR_NOME`, `CONTATO_EMAIL`, `ENCARREGADO_NOME`, `ENCARREGADO_EMAIL`, `FORO`, `FORO_RESSALVA`, `DOMINIO_OFICIAL`, `HOSPEDAGEM_TEXTO`, `IDADE_MINIMA`), gerados (`ORIGEM`, `URL_PRIVACIDADE`, `URL_TERMOS`, `VERSAO`, `VIGENCIA`, `ATUALIZACAO`) e jurídicos (chaves do conjunto da versão). Token desconhecido ou vazio é erro.
- Um trecho jurídico é texto puro (sem HTML), pode usar tokens de dados e gerados (por exemplo `{{CONTATO_EMAIL}}`), mas não outro token jurídico. Use cada um como bloco de frase: `<p>{{LOGS_ACESSO}}</p>`.

### Trechos jurídicos da v1.0 (`JURIDICO['1.0']`, todos `revisado:true` desde o release de 17/11/2026)

Redações do **parecer jurídico sobre `f1338f7`** (`/workspace/techlead-time2/feature-0002/parecer-juridico.md`, seção 4, Caminho A), copiadas literalmente, e dos Adendos 2 (23h40: 4.3, 4.8, 5.3, 5.9, seção 7 e última frase da 4.9) e 3 (23h45: 4.2, 4.13 e 4.14) de 17/11/2026. O Adendo 1 da 4.8 foi substituído pelo Adendo 2. O parecer final sobre `59a1a82` foi favorável e, com as correções F.4 aplicadas literalmente, todas passaram a `revisado:true` no commit "release legal v1.0" (RN09, CA25).

| Chave | Pendência | Redação | Onde aparece |
|---|---|---|---|
| `ENCARREGADO` | P04 | 4.1 (sem a dispensa de pequeno porte) | Política, 1 |
| `CONSENTIMENTO_TERCEIROS_DISCORD` | P11 | 4.2, com a terceira frase do Adendo 3 (nenhuma gravação de voz no treinamento) | Política, 3 |
| `LOGS_ACESSO` | T04 | Redação do Adendo 2 do parecer (4.3, frase neutra, sem prazo). Prazo e rotação pendentes (P14, obrigatório) | Política, 3 (base legal na 5, menções na 4, 8 e 9) |
| `TREINAMENTO_MP3_GERADOS` | P11 | 4.4, Caminho A (voz e MP3 fora do treinamento) | Política, 4; Termos, "Em resumo" e 5 |
| `TREINAMENTO_MICROSOFT` | P11 | 4.5 (exclui dados derivados do Google e da Microsoft nas conversas) | Política, 4 |
| `BASE_LEGAL_TREINAMENTO` | P10 | 4.6 (legítimo interesse com opt-out para conversas e prompts) | Política, 5 |
| `ORIGEM_TREINAMENTO_MIDIA` | P11 | 4.7 ("criar, treinar ou melhorar modelos") | Política, 6 |
| `SALVAGUARDAS_TRANSFERENCIA` | P05 | Adendo 2, 4.8 nova, com a primeira frase do Adendo 4 ("guardados no servidor e no banco de dados da PIA"): sem país, com a transcrição de voz (Gemini e Groq) e a frase do CrowdSec do Adendo 4 antes da frase do contato (CrowdSec ligado, decisão do Diogo) | Política, 7 |
| `REMOCAO_DADOS_TREINADOS` | P10 | 4.9, com a última frase do Adendo 2 (F.2): "Nesse caso, não usamos esses modelos para identificar você." | Política, 8 |
| `EXCLUSAO_CONTA_PRAZO` | P10 | Adendo 2, 5.3, 2º item da Retenção (prazo de 15 dias, confirmado pelo Diogo) | Política, 8 |
| `PROVEDORES_LLM` | P10 | Adendo 4, 5.9, que substitui a do Adendo 2 e não promete que os provedores não treinam (o rótulo e a lista "Gemini, Groq ou Ollama local." ficam no HTML) | Política, 6 |
| `PRAZO_RESPOSTA_TITULAR` | P10 | 4.10 | Política, 10 |
| `OPT_OUT_TREINAMENTO` | P10 | 4.11, com a última frase do Adendo 3 (4.13 do adendo: terceiros pedem informações, acesso ou eliminação da gravação) | Política, 10 |
| `DIREITOS_MUSICAS_GERADAS` | P11 | 4.12, aprovado sem ajuste (redação do PO) | Termos, 6 |
| `LIMITACAO_CDC` | P10 | 4.13 | Termos, 8 |
| `AVISO_GRAVACAO_DISCORD` | P11 | 4.14, texto final do Adendo 3 ("As vozes gravadas não são usadas para treinar modelos.") | Só no embed do bot (`src/recording_panel.js`, `trainingNotice()` via `textoJuridico()`); não aparece nas páginas |

### Ajustes do parecer no HTML fixo

- **5.1 e 5.2 (obrigatórios):** "Em resumo", Dados coletados, Finalidades, Uso aceitável e licença só falam de conteúdos de texto no treinamento; voz, MP3 e terceiros ficam fora.
- **5.2, 4º item:** "Você declara ter os direitos sobre o que envia e se compromete a avisar os participantes antes de gravar."
- **5.3 (obrigatório):** o que é apagado e o que não é na exclusão da conta, sem a frase dos backups do banco (não existe backup). Também a troca de "enquanto forem úteis…" pelo texto recomendado.
- **5.4:** "Agência Nacional de Proteção de Dados (ANPD)".
- **5.5:** menores e vozes gravadas no Discord excluídos e nunca usados em treinamento.
- **5.6:** aviso de 15 dias e recusa ou revogação, na Política 13 e nos Termos 11.
- **5.9:** link da [Google Workspace User Data and Developer Policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy) na seção Limited Use (URL oficial conferida com HTTP 200). A frase "criar, treinar ou melhorar modelos" vem da 4.7.
- **Adendo 2, tabela D:** Política 4 (Segurança com registros de acesso com IP), 5 (item obrigatório de legítimo interesse e exercício regular de direitos para os registros de acesso), 9 (ferramenta automática de segurança) e runbook de exclusão de conta (`docs/runbooks/exclusao-de-conta.md`, seção 4, item 5, e modelo de resposta).
- **Adendo 2, 5.3:** Retenção com os seis itens, nesta ordem, antes dos três itens fixos e de `{{REMOCAO_DADOS_TREINADOS}}`. O 2º item (prazo de 15 dias, confirmado pelo Diogo) é o trecho jurídico `EXCLUSAO_CONTA_PRAZO`, `revisado:true` desde o release legal v1.0.
- **Adendo 4, 5.9:** a frase "Esses provedores podem usar os dados conforme os próprios termos." foi trocada pelo trecho `PROVEDORES_LLM` com o texto final do Adendo 4 (`revisado:true` desde o release legal v1.0). O parágrafo da Limited Use e os links do Google ficam como estavam.
- **Adendo 4, seção 7 (substitui a do Adendo 2):** `HOSPEDAGEM_TEXTO` final em `src/legal/dados.js` (servidor e banco no Brasil, decisão do Diogo) e 2º parágrafo fixo final, com o CrowdSec entre os provedores. Sem "principalmente no Brasil". A frase renderizada fica "A hospedagem da PIA Server fica no Brasil, onde ficam o servidor e o banco de dados…".
- **Parecer final sobre `59a1a82` (favorável com ressalvas):** F.4 (obrigatórias): linha fixa da seção 6 ("…generalizados pela PIA. O que o provedor de IA escolhido por você faz…"), última frase de `ORIGEM_TREINAMENTO_MIDIA` e primeira de `TREINAMENTO_MICROSOFT` com o compromisso da PIA. F.5 (recomendadas): chave e conta do usuário em `PROVEDORES_LLM`, "Os detalhes estão logo abaixo." na seção 7, uma frase só sobre menores na seção 12, Microsoft na seção 5 dos Termos, "podem não ser removíveis" no 6º item da Retenção, runbook sem backups e sem a pendência de prazo. No commit "release legal v1.0" (17/11/2026) os 16 trechos passaram a `revisado:true`.
- **Não entram na v1.0:** 5.7 (aviso de 30 dias antes de encerrar o serviço, decisão do Diogo) e 5.8 (caixa de aceite no primeiro login).

### Decisões do Diogo sobre o parecer (17/11/2026)

- **Caminho A:** voz e MP3 fora do treinamento, com as redações A. O Caminho B (4.15) exigiria versão nova (RN05) e os pré-requisitos técnicos do parecer.
- **Terceiros do Discord** fora do treinamento por padrão (4.2 e 4.14).
- **Encarregado:** o Diogo, pelo e-mail de contato, sem invocar a dispensa de pequeno porte (4.1).
- **Backups do banco:** não existem; a frase dos 30 dias da 5.3 foi retirada.
- **Endereço:** não é publicado, só o e-mail. Nenhum trecho do parecer aplicado cita endereço.
- **Transferência internacional (4.8):** redação do Adendo 2, com os ajustes do Adendo 4: os dados pessoais guardados no servidor e no banco ficam no Brasil; imagens e áudios, inclusive gravações de voz, podem ficar ou ser tratados fora; sem citar país (CA28).
- **Logs de acesso (T04, requisitos v3.1, 0.0, item 1):** a PIA guarda IP no access log do Traefik e no CrowdSec; frase neutra, sem prazo (decisão do CEO, Adendo 2).
- **Base legal (4.6):** legítimo interesse com opt-out para conversas e prompts.
- **Remoção de dados treinados (4.9):** só o compromisso de não usar os modelos para identificar o titular (v3.1, 0.0, item 3; Adendo 2, F.2).
- **5.7:** não entra.

### Aguardando decisão

- **Risco residual da Limited Use do Google (parecer final, F.7):** MÉDIO-ALTO (antes ALTO), porque a chave do Gemini é do próprio usuário. Aceito expressamente pelo Diogo em 17/11/2026 para publicar a v1.0. Mitigação em andamento: aviso no app sobre o provedor de IA gratuito (feature 0003, Time 1).

- **Prazo e rotação dos registros de acesso (P14, Adendo 2, B e E.1, obrigatório, risco aceito pelo CEO):** o access log do Traefik e o histórico do CrowdSec estão sem prazo e sem rotação; a frase "pelo tempo necessário" só atende provisoriamente ao art. 9º, II. O parecer recomenda rotação com 6 meses como referência (o número não vai para o texto público, CA28).
- **CrowdSec (Adendo 4, recomendado):** conferir se os termos ou o acordo de tratamento de dados da CrowdSec oferecem cláusulas-padrão da ANPD (Resolução CD/ANPD nº 19/2024) ou garantias equivalentes. IPs bloqueados ficam sem prazo (decisão do Diogo), com o mesmo risco registrado para os logs.
- **Base legal/LIA (4.6):** confirmação do Diogo.

## Escopo da v1.1 (rascunho)

- Parte de `JURIDICO['1.0']` e do HTML v1.0 publicados. Os trechos que não mudam são os mesmos objetos aprovados (`revisado:true`); os novos ou alterados usam o helper `rascunho()` (`revisado:false`): `DADOS_CONTA_SUNO`, `HISTORICO_GERACOES`, `AUDIO_SUNO`, `DESCONEXAO_SUNO`, `TREINAMENTO_CONTA_SUNO`, `SALVAGUARDAS_TRANSFERENCIA` (Suno na 4.8) e `DIREITOS_MUSICAS_GERADAS` (Suno nos Termos).
- O HTML fixo segue os textos do rascunho (`docs/legal-v1.1-rascunho.md`), conciliados com a v1.0: seção 7 sem país, "Termos de Serviço", RN11, CA28 e Caminho A.
- CA27: continua valendo para a v1.0 e passa a exigir o Suno e o histórico de gerações na v1.1 (`test/legal.test.js`). A v1.0 está protegida pelos `sha256` do release, repetidos em `test/legal_snapshot.test.js`.
- Até o release legal v1.1, `PIA_LEGAL_RELEASE=1 npm test` falhava de propósito (os 7 trechos acima e as 4 datas nulas). Desde 18/11/2026 ele passa, e os testes do conteúdo real esperam a v1.1 publicada (`/privacidade/v1.1` e `/termos/v1.1` com 200, a atual igual à v1.1, `sha256` da v1.1 repetido em `test/legal_snapshot.test.js`).
- O callback do Suno (`/auth/connectors/suno`) tem o rodapé com os links desde `a218e75` (O13, DevBackend); até o release da v1.1 esses links servem a v1.0, que não cita o Suno.
- Pendências da v1.1: RN05 (dado novo pediria 2.0?); aviso de 15 dias da seção 13; as duas partes do `DIREITOS_MUSICAS_SUNO` do F2-02 que não entraram. Detalhes na conferência.

### Parecer da v1.1 (18/11/2026)

- Favorável com ressalvas; textos literais aplicados (R1 a R6, DV2 e O1 na Alternativa A, decisão do Diogo). Detalhes em `docs/legal-v1.1-conferencia.md`, seção 2a.
- **R7 pendente:** o aviso "Conectar sua conta Suno" vai "no app, antes de abrir o login do Suno". O pia-server não tem essa tela (só o callback, depois do login); cabe ao app desktop (`pia`).
- **R8 (Recomendado):** reconferir os termos do Suno e a página do Suno MCP a cada 6 meses e antes de o MCP sair do beta. Próxima conferência: até 18/05/2027.
- **O2/O3:** sem deploy de produção com o Suno antes de a v1.1 valer; se já houve, publicar a v1.1 já e avisar quem conectou (texto no parecer, seção 6.3).

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
- Desde o release da v1.0, os testes do conteúdo real esperam o estado publicado (modo final, `/privacidade/v1.0` e `/termos/v1.0` com 200, `pendencias()` vazio, trechos `revisado:true`). O modo rascunho segue coberto com fontes sintéticas (`fontes()` em `test/legal.test.js`, `fixture()` em `test/legal_release.test.js`).
- No CI (`.github/workflows/container.yml`), a variável vale `1` em push para `main` e em tags `v*`. Em PRs e outras branches fica vazia. **Consequência esperada:** enquanto houver rascunho, um push para `main` falha no `npm test` e a imagem `:main` não é publicada. Por isso a 0002 só entra na develop depois do parecer (RN10, CA25).
- Local: `PIA_LEGAL_RELEASE=1 npm test`.

## Como lançar uma versão nova (X.Y)

1. **Nunca edite** um `*-vX.Y.html` nem um conjunto jurídico de uma versão publicada (o teste de hash falha). Crie `*-vX.Y+1.html` (ou `X+1.0` para mudança relevante de finalidade ou de dado, RN05).
2. Se o texto jurídico mudar, crie um conjunto novo em `juridico.js` (por exemplo `JURIDICO['1.1']`), com `revisado:false` nos trechos novos (use um helper próprio: o `trecho()` da v1.0 fixa `revisado:true`).
3. Acrescente a versão em `src/legal/versoes.js` com `resumo`, `juridico`, `vigencia`/`atualizacao` em `null` e `sha256: null`.
4. Ajuste `test/legal.test.js` se mudarem seções ou termos obrigatórios.
5. Registre em `CHANGELOG.md` ("Unreleased") e abra a PR com o checklist do template.
6. Depois do QA e do parecer favorável do Advogado sobre a mesma versão: commit "release legal vX.Y" com as datas (data planejada do deploy, nunca `new Date()`), todos os `revisado:true` e o `sha256` informado pelo teste de hash.
7. Rode `PIA_LEGAL_RELEASE=1 npm test`. Ele precisa passar.
8. PR para `main` e tag. Se o deploy atrasar, corrija a data (e o hash) antes da tag.
