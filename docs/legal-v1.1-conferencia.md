# Conferência da v1.1 das páginas legais contra o código da feature 0001 (Suno)

Feature 0004. Base: develop `738b3b2` (0001 e 0002 já mergeadas). Cada afirmação nova ou alterada da v1.1 aparece abaixo com o arquivo e a linha do código que a sustenta. As linhas são as de `a218e75` (topo de `origin/time2-feature-0004-legal-v1-1-suno`, com a O13 e a O11 do DevBackend). Só `src/suno_auth.js` mudou em relação à develop `738b3b2` (+1 linha a partir da 4). Nenhum código do Suno, nem `src/db.js`, nem as rotas `/device/*`, foi alterado nesta feature.

Escopo: a v1.1 trata **só do Suno**. Os ajustes do parecer da feature 0003 (avisos sobre provedores de IA, Groq) ficam para uma v1.2, junto com a 0003 (decisão do Diogo, 18/11/2026).

## 1. Afirmações da Política v1.1 e onde o código as sustenta

| # | Onde na Política v1.1 | Afirmação | Código |
|---|---|---|---|
| A1 | Seção 3, Credenciais | Tokens do Suno guardados cifrados | `src/suno_auth.js:182` (`ciphertext: seal(...)` com `access_token` e `refresh_token`); `src/db.js:8-13` (`seal`, AES-256-GCM); `src/db.js:133` (`ciphertext`) |
| A2 | Seção 3, Conta Suno (`DADOS_CONTA_SUNO`) | De cada conta Suno: identificador, e-mail e nome no Suno | `src/db.js:130-131` (`suno_subject`, `suno_email`, `suno_name`); `src/suno_auth.js:236`; `src/suno_identity.js:29-32` |
| A3 | idem | Mais de uma conta Suno por conta PIA ("de cada conta") | `src/suno_auth.js:8-9`; `src/db.js:127-138` (sem UNIQUE por `account_id`) |
| A4 | idem | O apelido que você dá à conta | `src/db.js:132` (`label`); `src/suno_auth.js:408-415` (`sunoRename`) |
| A5 | idem | Escopos autorizados | `src/db.js:133` (`scopes`); `src/suno_auth.js:184` |
| A6 | Seção 3, Conteúdo do usuário (`HISTORICO_GERACOES`) | Prompts, letras e links do Suno no histórico | `src/db.js:163` (`prompt`, `lyrics`, `title`); `src/db.js:190` (`audio_url`); `src/suno_jobs.js:64-67` |
| A7 | idem | Gerações locais e do Gemini: prompt, letra e metadados, sem áudio e sem link | `src/music_generations.js:130-131` (`prompt`, `lyrics`); `src/music_generations.js:89` (`audio_url_not_allowed`); `src/db.js:171` (local sem `suno_account_id`/`job_id`) |
| A8 | Seção 3 e 8 | O link do Suno fica só no servidor | `src/db.js:184-185` (comentário RN19); `src/music_generations.js:22`; `src/suno_jobs.js:126` |
| A9 | Seção 4, Finalidades | Geração de música como parte do serviço | `src/suno_jobs.js:8-22`; `src/index.js:212-233` |
| A10 | Seção 4 (`TREINAMENTO_CONTA_SUNO`) | A PIA não usa dados da conta Suno para treinar | Não há pipeline de treinamento no código (runbook, seção 4, item 4). Compromisso de política, não de código |
| A11 | Seção 6 | Suno: conta conectada e geração de música | `src/suno_auth.js:13-21` (OAuth no Suno); `src/suno_mcp.js:329-339` (geração) |
| A12 | Seção 7 e 4.8 (`SALVAGUARDAS_TRANSFERENCIA`) | O Suno recebe o prompt e a letra quando você gera músicas | `src/suno_jobs.js:331-332`; `src/suno_mcp.js:334` e `:337` |
| A13 | Seção 7 | Suno entre os provedores que "podem tratar dados no exterior", sem país | Decisão da v1.0 (Adendo 4, CA28). O código só mostra o host `studio-api-prod.suno.com` (`src/suno_auth.js:14-16`), sem país |
| A14 | Seção 8, 1º item | Contas Suno e histórico ficam guardados enquanto a conta existir | Sem rotina de expiração em `suno_accounts` nem em `music_generations` (`src/db.js:127-195`) |
| A15 | Seção 8, `EXCLUSAO_CONTA_PRAZO` (sem mudança) | A exclusão da conta apaga esses dados | `src/db.js:129`, `:141`, `:156` (`account_id ... ON DELETE CASCADE`); `src/db.js:187` (faixas em cascata pela geração) |
| A16 | Seção 8, exclusão de item | Apaga do servidor o prompt, a letra e os links do item | `src/music_generations.js:27-29` e `:262-276` (hard delete); `src/db.js:187` (`ON DELETE CASCADE` nas faixas, com `audio_url`) |
| A17 | idem | Não apaga a cópia no Drive nem os metadados de mídia | `src/music_generations.js:262-276` só toca em `music_generations` (a tabela `media`, `src/db.js:119-123`, não é referenciada) |
| A18 | Seção 8 (`DESCONEXAO_SUNO`) | Desconectar apaga os tokens e os dados da conta Suno | `src/suno_auth.js:417-420` e `:131-134` (`DELETE FROM pia_server.suno_accounts`) |
| A19 | idem | Não revoga o acesso no Suno | `src/suno_auth.js:418` ("Sem revogação remota até o spike") |
| A20 | idem | O histórico continua, com o apelido, o nome ou o e-mail da conta Suno usada | `src/db.js:177-178` (`ON DELETE SET NULL`); `src/db.js:193-195` (`suno_account_name`); `src/suno_jobs.js:67` (`COALESCE(label, suno_name, suno_email)`) |
| A21 | Seção 8 | Links de música do Suno podem expirar | `src/suno_audio.js:51` (410 "Esta música não está mais disponível no Suno.") |
| A22 | Seção 8 (`AUDIO_SUNO`) | O áudio do Suno não é guardado: o servidor busca pelo link e repassa ao computador, sem gravar | `src/suno_audio.js:10-14` e `:241` (`pipeline(upstreamRes, limiter, res)`); o módulo não importa `node:fs`; `src/suno_jobs.js:14-15` |
| A23 | Seção 9 (sem mudança) | Tokens de integrações cifrados com AES-256-GCM | A1. O histórico (prompt, letra, links) **não** é cifrado (`src/db.js:163`, `:190`), e a Política não diz que é |
| A24 | Seção 10 | Controles: excluir item do histórico, desconectar o Suno | `src/music_generations.js:27` (`DELETE /device/music/generations/:id`); `src/suno_auth.js:417` (`DELETE /device/suno/accounts/:id`) |
| T1 | Termos, seção 5 | Letras entre os conteúdos do usuário | A6 |
| T2 | Termos, seção 6 (`DIREITOS_MUSICAS_GERADAS`) | Suno entre os provedores cujos termos regem os direitos das músicas | Rascunho (`DIREITOS_MUSICAS_SUNO`); compromisso de texto |

### Outros pontos conferidos (sem texto novo)

- **Jobs:** o worker roda no próprio processo; no boot, jobs `queued`/`running` viram `interrupted` e nunca são refeitos (`src/suno_jobs.js:17-22`, `src/index.js:424`). Não guardam nada além de `music_generations`/`music_generation_tracks` (`src/suno_jobs.js:10-15`).
- **Proxy de áudio:** limite de 100 MiB e timeouts (`src/suno_audio.js:16-23`); qualquer PC pareado da mesma conta baixa (`src/suno_audio.js:13`). O link nunca vai em header, erro ou log (`src/suno_audio.js:14`).
- **Limpeza de temporários:** `cleanupOrphanTemp` (`src/cleanup_tmp.js:7` e `:19`, chamada em `src/index.js:426`) cobre só `pia-media-*`, `pia-artifact-*` e restos das gravações do Discord. O Suno não cria temporários (o proxy é stream), então não há o que limpar e o texto não muda.
- **`suno_connect_attempts`:** guarda `account_id`, `device_id`, um digest do `state`, o `verifier` do PKCE e o `client_id` (`src/db.js:139-149`). As tentativas vencidas há mais de 1 dia são apagadas só quando uma nova conexão começa (`src/suno_auth.js:94-95`); com a exclusão da conta saem em cascata (`src/db.js:141`). Ao desconectar, `suno_account_id` vira NULL (`src/db.js:147`). Não é citado na Política, por não ter dado do Suno além do vínculo.
- **`suno_oauth_clients`:** `redirect_uri` e `client_id` do registro dinâmico (`src/db.js:124-126`). Não é dado pessoal.
- **Exclusão da conta PIA (15 dias):** apaga `suno_accounts`, `suno_connect_attempts`, `music_generations` e `music_generation_tracks` (A15). Runbook atualizado (`docs/runbooks/exclusao-de-conta.md`).

## 2. Divergências rascunho x código

| # | Rascunho (`docs/legal-v1.1-rascunho.md`) | Código | O que a v1.1 faz |
|---|---|---|---|
| D1 | "…incluindo as gerações locais e do Gemini, **das quais guardamos só metadados**" | O servidor guarda **prompt e letra** das gerações locais (`src/music_generations.js:95-131`), além de título, provedor, duração, estado e faixas sem link | Segue o código: "das quais guardamos o prompt, a letra e metadados, sem o áudio e sem link" (`HISTORICO_GERACOES`, `revisado:false`) |
| D2 | Seção 7: "Google, Microsoft, Discord, Suno e Groq **tratam dados fora do Brasil**" | Não há país no código; a v1.0 decidiu não afirmar país (CA28, Adendo 4) | Segue a v1.0: o Suno entra na lista dos que "podem tratar dados no exterior" e na 4.8 |
| D3 | `TREINAMENTO_MICROSOFT_SUNO`: "Prompts, letras e **músicas** que você gera, inclusive pelo Suno, podem ser usados para treinamento" | Não há cópia das músicas no servidor (A22); o Caminho A tira MP3/voz do treino | Não usa a frase. Só entra a parte "dados da conta Suno fora", como `TREINAMENTO_CONTA_SUNO`, no padrão F.4 ("A PIA não usa…"). Letras já estão em "outros conteúdos de texto" |
| D4 | Rascunho não fala da desconexão além de "desconectar a conta Suno" | A desconexão não revoga no Suno e o histórico **guarda o apelido, o nome ou o e-mail** da conta Suno (`suno_account_name`) | Frase nova `DESCONEXAO_SUNO` (`revisado:false`) |
| D5 | Rascunho não diz o que acontece com o áudio do Suno | O áudio passa pelo servidor em stream até o PC, sem disco (A22). A frase da v1.0 "só passam pelo servidor… a caminho do Drive" não cobre esse caminho | Frase nova `AUDIO_SUNO` (`revisado:false`), sem mexer na frase da v1.0 (RN11) |
| D6 | Seção 4 do rascunho: "…Secretária, geração de música, computadores pareados e MCP" | A v1.0 final acrescentou "cópia de mídia para o Drive" | Junta os dois: "…Secretária, geração de música, cópia de mídia para o Drive, computadores pareados e MCP" |
| D7 | Termos, seção 5 do rascunho: "prompts, letras, chats e gravações" | A v1.0 final tem "prompts, chats, músicas geradas e gravações" | Junta: "prompts, letras, chats, músicas geradas e gravações" |
| D8 | `DIREITOS_MUSICAS_SUNO` (F2-02): "…seguem os termos **e o plano** que você tem em cada provedor. **A PIA não concede direitos sobre essas músicas.**" | — (texto) | Parte do texto aprovado da v1.0 (`DIREITOS_MUSICAS_GERADAS`) e só acrescenta "pelo Suno". As duas partes do F2-02 ficam como dúvida para o TechLead |
| D9 | F2-09: `legalFooter()` no `sunoCallbackPage` | Na develop `738b3b2` a página de callback do Suno não tinha rodapé legal | **Resolvida pelo DevBackend em `a218e75` (O13):** `src/suno_auth.js:4` importa `legalFooter` de `src/legal.js` e `src/suno_auth.js:436` põe `legalFooter()` (variante só com os links) dentro do card, em sucesso e erro (`:462-467`). Teste: `test/legal_links.test.js:80-91` ("/auth/connectors/suno: só os links no sucesso e nos erros"). Nada mudou no texto da v1.1 |

### Rodapé do callback do Suno x texto da v1.1 (O13)

- O rodapé do callback `/auth/connectors/suno` usa os links relativos `/privacidade` e `/termos` (`src/legal.js:533-540`, variante "links", sem a frase de aceite). **Até o release da v1.1, essas rotas servem a v1.0**, que por decisão do Diogo (CA27) não cita o Suno. Quem conecta o Suno nesse intervalo vê uma Política sem o Suno. Depois do release, os mesmos links passam a servir a v1.1 sem mudar código (`versaoAtual`, última publicada).
- A v1.1 **não menciona a página de conexão nem o fluxo OAuth** do Suno: fala só da "conta conectada" (seções 3 e 6) e da desconexão (seção 8). Não há frase incoerente com o rodapé, e nada foi alterado no texto.
- `test/legal_links.test.js` não precisou de ajuste para a v1.1: ele confere o HTML do rodapé, e não o conteúdo das páginas.

## 2a. Parecer da v1.1 (`/workspace/techlead-time2/feature-0004/parecer-juridico.md`, sobre `3862937`) e o que mudou

Parecer favorável com ressalvas. Decisão do Diogo: publicar com os textos do parecer, sem nova rodada, Alternativa A no O1. Todos os textos foram copiados literalmente.

| Item | Onde | O que mudou | Status no `JURIDICO['1.1']` |
|---|---|---|---|
| Seção 2, item 1 | `DADOS_CONTA_SUNO` | Texto mantido, aprovado | `trecho()` |
| Seção 2, item 3 | `AUDIO_SUNO` | Texto mantido, aprovado | `trecho()` |
| Seção 2, item 6 | `SALVAGUARDAS_TRANSFERENCIA` | Frase do Suno mantida, aprovada | `trecho()` |
| R2 (seção 2, item 2) | `HISTORICO_GERACOES` | Texto do parecer (com título, duração, estado, faixas e a conta Suno usada) | `trecho()` |
| R4 (seção 2, item 4) | `DESCONEXAO_SUNO` | Texto do parecer (efeito prático e "você pode excluir cada item") | `trecho()` |
| R6 (seção 2, item 7) | `DIREITOS_MUSICAS_GERADAS` | Texto do parecer (plano, plano gratuito do Suno, "A PIA não concede direitos"). Resolve a D8 | `trecho()` |
| R1 (seção 4.4) | Política, seção 6, HTML | Item do Suno com prompt e letra, biblioteca, créditos e o que os termos do Suno permitem | HTML |
| R3 (seção 4.4) | Política, seção 8, HTML | 2ª frase da exclusão de item com arquivos no computador e biblioteca no Suno. Cobre a DV4; o 409 fica só na mensagem da interface (decisão do Advogado) | HTML |
| R5 (seção 5) | Termos, seção 6, 3º item, HTML | Frase dos créditos do Suno ao fim do item | HTML |
| R7 (seção 6.1) | Aviso "Conectar sua conta Suno" | **Não aplicado no pia-server.** O parecer põe o aviso "no app, antes de abrir o login do Suno", com os botões "Cancelar · Continuar para o Suno". O pia-server não renderiza nenhuma tela antes do login: `sunoConnect()` (`src/suno_auth.js:196-212`) devolve a URL de autorização do Suno ao app, e a única página do Suno no servidor é o callback (`src/suno_auth.js:429-438`), mostrada **depois** do login. O aviso cabe no app desktop (repositório `pia`) ou numa tela nova no servidor, que exigiria mudar a lógica do fluxo | — |
| R8 (seção 4.1) | `docs/legal.md` | Reconferir termos e MCP do Suno periodicamente (prazo no doc; não entra nas páginas, CA28) | — |
| DV2 (requisitos 0004, CA-0406) | Política, seção 3, HTML | "pelo Gemini ou localmente" passa a "pelo Gemini, pelo Suno ou localmente" | HTML |
| O1, Alternativa A (seção 3.3) | `TREINAMENTO_CONTA_SUNO`, resumo da Política, Termos 5 | Commit separado (o último da branch) | `trecho()` no commit 2 |
| Op1 (seção 7) | Resumo do histórico de versões | Junto com o O1 (Alternativa A) | — |
| O2 e O3 | Processo de release | Ordem do release e, se já houve deploy com o Suno, e-mail a quem conectou. Com o TechLead | — |

## 3. O que os requisitos pedem a mais para a v1.1

Fonte: `/workspace/feature-0002-requisitos.md`, seção 0.1 (v1.1), 6.1, 6.2, CA06, CA07, CA13 e o F2-09 do plano técnico.

- **Aplicado:** histórico Suno (prompts, letras, links e metadados), conta Suno, Suno como terceiro, exclusão de item do histórico e o limite dela (não apaga Drive nem metadados), dados da conta Suno fora do treino, linha no histórico de versões, v1.0 congelada (RF07, RN05).
- **Não aplicado, conflita com o Caminho A:** a 0.1 diz "o treinamento com prompts, letras e músicas do Suno". Músicas ficam fora (`TREINAMENTO_MP3_GERADOS`). Precisa de correção no requisito pelo PO.
- **F2-09, `legalFooter()` no `sunoCallbackPage` (CA13 do callback do Suno):** resolvido pelo DevBackend em `a218e75` (D9). Fica de fora daqui só o rebase/bundle da `pia` e o CHANGELOG da F2-09 do lado da `pia`.
- **Processo (RN09):** a v1.1 passa de novo por QA, Advogado e homologação do PO antes do release.
- **RN05:** "X para mudança relevante de finalidade ou dado". A v1.1 traz dados novos (conta Suno, histórico). Pela letra da RN05 isso seria uma 2.0. Mantida 1.1 por pedido do TechLead e pela seção 0.1 dos requisitos; fica como dúvida.
- **Seção 13 da Política (aviso de 15 dias):** se a v1.1 for "mudança relevante", precisa de aviso com 15 dias de antecedência no app ou por e-mail. Decisão do Diogo/Advogado.
