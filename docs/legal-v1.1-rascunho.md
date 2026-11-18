# Rascunho da v1.1 das páginas legais: trechos da feature 0001 retirados da v1.0

> Arquivo de trabalho. **Não é lido pelo código, pelo gate nem servido.** Decisão do Diogo (requisitos v2.7, seção 0.1, CA27): a v1.0 sai sem a feature 0001 (integração Suno, histórico de prompts, letras e links, tabelas `suno_*`, `music_generations` e `music_generation_tracks`, callback do Suno). Estes trechos voltam numa v1.1, junto com a F2-09, depois do merge da 0001 na develop e da conferência contra o schema final.
>
> Ao montar a v1.1: criar `privacidade-v1.1.html`/`termos-v1.1.html`, o conjunto `JURIDICO['1.1']` (com `revisado:false` nos trechos abaixo) e as entradas em `versoes.js`; ajustar o CA27 em `test/legal.test.js`.

## Trechos HTML retirados da Política (textos exatos da versão de trabalho, commit e0b4cca do backup)

### Seção 3, Dados coletados, "Conteúdo do usuário guardado no servidor"

```html
<li>Prompts, letras, links de música do Suno e o histórico de gerações de música, incluindo as gerações locais e do Gemini, das quais guardamos só metadados.</li>
```

### Seção 3, "Credenciais de integrações" (texto com Suno; a v1.0 termina em "Discord e Taverns")

```html
<li>Credenciais e tokens das integrações que você conecta: Google, Microsoft, Object Storage (S3), Discord, Taverns e Suno. Eles são guardados cifrados.</li>
```

Requisitos 6.1 (para conferir na v1.1): dados da conta Suno guardados pela 0001 são identificador, e-mail e nome no Suno, tokens OAuth cifrados e escopos (`suno_accounts`, `suno_connect_attempts`).

### Seção 4, Finalidades (texto com geração de música no servidor)

```html
<li><strong>Prestar o serviço:</strong> login, sincronização do perfil, gravação no Discord, Secretária, geração de música, computadores pareados e MCP.</li>
```

### Seção 6, Compartilhamento

```html
<li><strong>Suno:</strong> conta conectada e geração de música.</li>
```

### Seção 7, Transferência internacional (texto com Suno)

```html
<p>Google, Microsoft, Discord, Suno e Groq tratam dados fora do Brasil. Ao usar essas integrações, seus dados podem ser transferidos para outros países.</p>
```

### Seção 8, Retenção

```html
<li>Excluir um item do histórico apaga do servidor o prompt, a letra e os links daquele item. <strong>Excluir um item do histórico não apaga a cópia no Drive nem os metadados de mídia.</strong></li>
<li>Links de música do Suno podem expirar.</li>
```

### Seção 10, Direitos do titular, controles no app (texto com histórico e Suno)

```html
<p><strong>Controles disponíveis no app:</strong> excluir um item do histórico de músicas, desconectar a conta Suno e os demais conectores, revogar computadores pareados e tokens MCP, e sair da conta.</p>
```

## Trechos HTML retirados dos Termos

### Seção 4, Uso aceitável

```html
<li>violar os termos do Google, do Suno, do Discord ou de outros terceiros conectados.</li>
```

### Seção 5, Conteúdo do usuário e licença (texto anterior)

```html
<li>Você continua dono do seu conteúdo: prompts, letras, chats e gravações.</li>
```

### Seção 6, Conteúdo gerado por IA (o token saiu; a v1.0 usa uma frase sem Suno e sem trecho jurídico)

```html
<li>{{DIREITOS_MUSICAS_SUNO}}</li>
```

## Integração com o callback do Suno (F2-09, v1.1)

- Acrescentar `legalFooter()` ao `sunoCallbackPage` (`src/suno_auth.js` da branch da 0001) e conferir o CA13 para o callback do Suno.

## Chaves jurídicas retiradas da v1.0 (textos exatos)

### `TREINAMENTO_MICROSOFT_SUNO` (redação do PO, requisitos v2.6, P11, dependia de confirmação do Diogo)

> Dados obtidos da sua conta Microsoft (e-mails, agenda e arquivos via Microsoft Graph) não são usados para treinar modelos. Prompts, letras e músicas que você gera, inclusive pelo Suno, podem ser usados para treinamento. Dados da sua conta Suno (identificador, e-mail, nome e tokens) não são usados.

Na v1.0 a chave virou `TREINAMENTO_MICROSOFT`, com o texto: "Dados obtidos da sua conta Microsoft (e-mails, agenda e arquivos via Microsoft Graph) não são usados para treinar modelos. Conversas, prompts e músicas que você gera ou envia à PIA podem ser usados para treinamento."

Redações anteriores da mesma chave, para histórico:
- F2-01 (DevBackend, assunto "conteúdo de Microsoft e Suno no treinamento"): "Conteúdo obtido pelas integrações com a Microsoft e com o Suno segue os termos de cada provedor e só é usado em treinamento quando esses termos permitirem."
- F2-02 (versão de trabalho): "Dados obtidos por meio das contas Microsoft e Suno conectadas só são usados em treinamento quando os termos desses provedores permitirem."

### `DIREITOS_MUSICAS_SUNO` (P11, direitos das músicas do Suno)

- F2-01 (DevBackend, assunto "direitos das músicas do Suno"): "Direitos e limites sobre músicas geradas pelo Suno, pelo Gemini e por outros provedores seguem os termos de cada provedor."
- F2-02 (versão de trabalho, assunto "direitos sobre músicas geradas pelo Suno e outros provedores"): "Os direitos de uso das músicas geradas pelo Suno, pelo Gemini ou por outros provedores seguem os termos e o plano que você tem em cada provedor. A PIA não concede direitos sobre essas músicas."
