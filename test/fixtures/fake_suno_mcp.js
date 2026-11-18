/**
 * Fake local do servidor MCP do Suno para os testes da pia-server (T3a).
 *
 * Porte em JS (só `node:http`, sem dependências) do mock Python do pia
 * `tests/fixtures/fake_suno_mcp.py`. Sobe um servidor JSON-RPC (MCP
 * streamable HTTP) em 127.0.0.1, porta efêmera, e responde `initialize`,
 * `notifications/initialized`, `tools/list`, `tools/call` (geração e
 * `get_credits`), `DELETE` de sessão e o GET do áudio fake em loopback.
 * Nunca faz chamada real ou paga ao Suno e não acessa a rede externa.
 *
 * Uso
 *
 *   import { startFakeSunoMcp } from './fixtures/fake_suno_mcp.js';
 *   const suno = await startFakeSunoMcp({ scenarios: ['success', '503'], requireSession: true });
 *   // suno.url           -> http://127.0.0.1:<porta>/mcp (endpoint JSON-RPC)
 *   // suno.audioBaseUrl  -> http://127.0.0.1:<porta>/audio
 *   // suno.token         -> bearer esperado (Authorization: Bearer <token>)
 *   // suno.requests      -> requisições recebidas (RecordedRequest[])
 *   // suno.generationCalls(), suno.rpcMethods(), suno.audioDownloads()
 *   // suno.clips(), suno.extraClips(), suno.connectionErrors
 *   // suno.setScenarios(['partial', '401']); suno.setAudioBehavior(clipId, '403')
 *   // suno.expireSessions(); suno.resetRecordings()
 *   await suno.close(); // fecha sockets, cancela esperas e libera a porta
 *   // Também funciona com `await using suno = await startFakeSunoMcp()`.
 *
 * Opções de startFakeSunoMcp(options) (todas opcionais)
 *   scenarios        string ou lista; aplicada a cada `tools/call` da tool de
 *                    geração, em ordem. Depois do fim, repete o último. Padrão
 *                    'success'. `scenario` é alias.
 *   token            bearer exigido (padrão DEFAULT_TOKEN). `null` desliga a checagem.
 *   timeoutDelayMs   espera do cenário `timeout` e do áudio `slow` (padrão 1500).
 *   requireSession   se true, `tools/list` e `tools/call` exigem o `Mcp-Session-Id`
 *                    devolvido pelo `initialize` (404 se faltar ou tiver expirado).
 *                    Padrão false, como no Python; o cliente da T3b deve testar com true.
 *   authOnInitialize se true (padrão), o `initialize` também exige o bearer.
 *   responseMode     'json' (padrão) ou 'sse'. Em 'sse', respostas JSON-RPC HTTP 200
 *                    saem como `text/event-stream` (`event: message` + `data:`).
 *   includeBase64    cada clip pronto também traz `audio_base64` + `format: 'mp3'`.
 *   leaky            `audio_url` assinada (?X-Amz-Signature=…&token=…) e bearer nas
 *                    mensagens de 401/5xx (CA10, para testes de redact).
 *   audioBehavior    comportamento de download padrão (ver abaixo); string, objeto ou
 *                    lista (um por clip, na ordem de criação).
 *   tools            catálogo explícito; se omitido, usa loadSunoToolsList().
 *   toolsListPath    caminho de um tools/list real (padrão test/fixtures/suno_mcp_tools_list.json,
 *                    usado só se existir e tiver tools; hoje não existe porque o schema real
 *                    ainda não foi capturado, ver o spike da T10).
 *   credits          valor de `get_credits` (padrão 42).
 *   account          identidade da conta Suno do bearer `token` (padrão DEFAULT_ACCOUNT).
 *                    Formato { id, email, label }: `id` é a identidade estável (o
 *                    `suno_subject` do ESCOPO v3), `email`/`label` são exibição. `null`
 *                    simula um Suno que não expõe identidade.
 *   accounts         mapa bearer → conta ({ [token]: account }), para uma instância
 *                    aceitar vários tokens, cada um de uma conta. Se informado, substitui
 *                    `token`/`account` (o `token` passa a ser o primeiro do mapa).
 *   clipsPerCall     clips por geração (padrão 2). Use 1 para `incomplete_batch`.
 *   requested        N pedido no job (opcional). Só serve para observabilidade: os clips
 *                    prontos além de N, contando todas as gerações, ficam marcados como extra em
 *                    clips()/extraClips(). Nunca vai na resposta MCP (o Suno real não sabe N).
 *
 * Cenários (por `tools/call` da tool de geração)
 *   success    HTTP 200, `clipsPerCall` clips prontos (`status: 'complete'`), cada um com
 *              `audio_url` em loopback.
 *   odd_extra  HTTP 200, igual a success na resposta: os 2 clips da última chamada de um
 *              N ímpar vêm prontos e com áudio baixável. O último clip da chamada fica
 *              marcado `extra: true` em clips()/extraClips() (RN10/§4.4: o extra é salvo).
 *              Ex. N=3: scenarios ['success', 'odd_extra'] → 2 chamadas, 4 clips com áudio,
 *              3 pedidos + 1 extra; splitRequestedAndExtra(batches, 3) dá o formato do §4.4.
 *   partial    HTTP 200, `clipsPerCall` clips, mas o último vem com `status: 'error'`,
 *              `audio_url: null` e `error: 'sem áudio'` (o GET do áudio dele dá 404).
 *   timeout    registra a chamada e espera `timeoutDelayMs` antes de responder (como
 *              success). O cliente deve estourar o próprio timeout (AbortSignal.timeout
 *              menor). close() cancela a espera; escrever num socket já abortado é ignorado.
 *   401        HTTP 401, JSON-RPC error -32001 'Unauthorized', `WWW-Authenticate: Bearer`.
 *   402        HTTP 402, JSON-RPC error 402 'Insufficient credits'.
 *   503 / 500  HTTP 5xx, JSON-RPC error -32000 'Suno unavailable'.
 *   Exemplo CA07 (N=3): ['partial', '503'] → o lote para no clip com falha, 1 tools/call.
 *
 * Identidade da conta Suno (ESCOPO v3)
 *   O mock Python não expõe identidade e o schema real ainda não foi capturado (spike da
 *   T10), então o lugar é uma suposição: o cliente da T3b deve isolar a leitura numa função.
 *   A conta do bearer da requisição aparece em três lugares:
 *     - tools/call `get_account` (tool nova no catálogo heurístico): { account: { id, email, label } }
 *     - tools/call `get_credits`: { credits, account }
 *     - initialize: result._meta['suno/account']
 *   Cada requisição gravada traz `accountId` (conta do bearer, ou null).
 *   - Duas contas diferentes: `accounts: { tokA: contaA, tokB: contaB }` numa instância
 *     (o mesmo endpoint MCP, como o Suno real), ou duas instâncias em paralelo, cada uma
 *     com o seu `account` (portas independentes).
 *   - Conta já ligada a outro PIA: dois bearers (dois OAuth de PIAs diferentes) que
 *     resolvem para a MESMA conta, ex. `accounts: { tokPia1: conta, tokPia2: conta }`;
 *     quem responde `suno_account_taken` (RN08) é a pia-server (UNIQUE no id).
 *   - setAccount(account, token?) troca a conta de um bearer em runtime (ex.: o usuário
 *     reconectou com outra conta Suno); addAccount(token, account) aceita mais um bearer.
 *   - O fake não implementa o OAuth (DCR/token/refresh); isso é o fake OAuth da T2.
 *
 * Download do áudio (`audioBehavior`, por clip; GET /audio/<clipId>.mp3)
 *   'ok'         200, FAKE_AUDIO_BYTES, audio/mpeg.
 *   403/404/500  status correspondente (número, string numérica ou { status }).
 *   'html'       200 com text/html.
 *   'large'      { mode: 'large', size } corpo em streaming (respeita backpressure).
 *   'redirect'   302 para { location } (padrão http://example.invalid/…), sem segui-lo.
 *   'truncated'  Content-Length maior que o corpo; a conexão é encerrada no meio.
 *   'slow'       { mode: 'slow', delayMs } espera antes do corpo.
 *
 * Conexões resetadas
 *   ECONNRESET, EPIPE e ECONNABORTED de clientes que desistem (timeout, abort, RST)
 *   são engolidos e anotados em `connectionErrors` (só o code), sem derrubar o mock
 *   nem gerar erro não tratado. Outros erros de socket também são anotados.
 *
 * Divergências do mock Python: API assíncrona (start/close com Promise) em vez de thread;
 * tempos em ms; opção `responseMode: 'sse'`; identidade da conta (`account`/`accounts`,
 * tool `get_account`, `account` no `get_credits`, `_meta` no initialize; o Python não tem); cenário novo `odd_extra` e as opções
 * `requested`/`extraClips()`/`audioDownloads()`; helper `splitRequestedAndExtra` (regra
 * RN10, o extra é salvo) ao lado do `takeNClips` original (que descarta).
 *
 * Observação: o `node --test` sem argumentos também carrega este arquivo (padrão
 * `test/**`); ele não tem efeito colateral no import e não registra testes.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

export const CLIPS_PER_CALL = 2;
export const DEFAULT_TOKEN = 'suno-test-token';
export const DEFAULT_ACCOUNT = Object.freeze({ id: 'suno-user-fake-1', email: 'fake1@suno.test', label: 'Fake Suno 1' });
export const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
export const DEFAULT_TIMEOUT_DELAY_MS = 1500;
export const DEFAULT_LARGE_AUDIO_SIZE = 256 * 1024;
export const STREAM_CHUNK_SIZE = 64 * 1024;
export const FAKE_AUDIO_BYTES = Buffer.concat([
  Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]),
  Buffer.from('fake-suno-mcp-audio'),
]);
export const FAKE_AUDIO_CONTENT_TYPE = 'audio/mpeg';
export const DEFAULT_REDIRECT_LOCATION = 'http://example.invalid/suno-audio.mp3';
export const HTML_AUDIO_BODY = Buffer.from('<html><body>not audio</body></html>');
export const TOOLS_LIST_FIXTURE_PATH = new URL('./suno_mcp_tools_list.json', import.meta.url);
export const GENERATION_TOOL_CANDIDATES = Object.freeze(['generate_music', 'create_song', 'suno_generate_custom_music']);
export const SCENARIOS = Object.freeze(['success', 'odd_extra', 'partial', 'timeout', '401', '402', '503', '500']);
export const RESET_ERROR_CODES = Object.freeze(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE']);

export const DEFAULT_TOOLS = Object.freeze([
  {
    name: 'generate_music',
    description: 'Gera música a partir de prompt de estilo, letra opcional e duração. Cada chamada devolve 2 clips.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        style: { type: 'string' },
        description: { type: 'string' },
        lyrics: { type: 'string' },
        lyric: { type: 'string' },
        instrumental: { type: 'boolean' },
        duration: { type: 'integer' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'get_account',
    description: 'Identidade da conta Suno autenticada (suposição do fake; confirmar no spike).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_credits',
    description: 'Consulta créditos disponíveis na conta Suno.',
    inputSchema: { type: 'object', properties: {} },
  },
]);

/**
 * Carrega um tools/list real ({ tools }, { result: { tools } } ou lista) se existir e
 * tiver tools; senão devolve o contrato heurístico. Retorna { tools, source }.
 */
export function loadSunoToolsList(path = TOOLS_LIST_FIXTURE_PATH) {
  if (path && existsSync(path)) {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    let tools = null;
    if (Array.isArray(data)) tools = data;
    else if (data && typeof data === 'object') tools = data.tools ?? data.result?.tools ?? null;
    if (Array.isArray(tools) && tools.length) return { tools, source: 't2-fixture' };
  }
  return { tools: structuredClone(DEFAULT_TOOLS), source: 'plano-heuristico' };
}

/** Escolhe a tool de geração com a mesma heurística do adapter (D2). */
export function pickGenerationTool(tools) {
  const names = (tools || []).map((tool) => String(tool?.name || ''));
  for (const candidate of GENERATION_TOOL_CANDIDATES) if (names.includes(candidate)) return candidate;
  for (const name of names) {
    const lowered = name.toLowerCase();
    if (/(generate|create)/.test(lowered) && /(song|music)/.test(lowered)) return name;
  }
  return 'generate_music';
}

/** Quantas gerações um job de N faixas precisa: ceil(N / clipsPerCall). */
export function generationCallsFor(n, clipsPerCall = CLIPS_PER_CALL) {
  return Math.ceil(Math.max(0, n) / Math.max(1, clipsPerCall));
}

/** Port fiel do take_n_clips do Python: empilha até N e descarta o excedente. */
export function takeNClips(batches, n) {
  return batches.flat().slice(0, Math.max(0, n));
}

/**
 * Regra RN10/§4.4: toda faixa baixável é salva. Devolve { tracks, extras } com cada
 * clip pronto marcado `extra: false|true`; `completed` conta os pedidos prontos (≤ N),
 * `extra_ready` os extras prontos. Clips sem áudio ficam de fora e não contam.
 */
export function splitRequestedAndExtra(batches, n) {
  const ready = batches.flat().filter((clip) => clip && clip.audio_url && clip.status !== 'error');
  const tracks = ready.slice(0, n).map((clip) => ({ ...clip, extra: false }));
  const extras = ready.slice(n).map((clip) => ({ ...clip, extra: true }));
  return { tracks, extras, completed: tracks.length, total: n, extra_ready: extras.length };
}

/** Extrai o JSON de content[].text (formato MCP) ou devolve o próprio result. */
export function parseToolResult(result) {
  if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      if (typeof part?.text !== 'string') continue;
      try {
        const parsed = JSON.parse(part.text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // texto que não é JSON: tenta o próximo
      }
    }
  }
  return result;
}

export function clipsFromResult(result) {
  const clips = parseToolResult(result)?.clips;
  return Array.isArray(clips) ? [...clips] : [];
}

/** Normaliza um comportamento de download para { mode, ... }. */
export function normalizeAudioBehavior(behavior) {
  if (behavior == null) return { mode: 'ok' };
  if (typeof behavior === 'number') return { mode: 'status', status: behavior };
  if (typeof behavior === 'string') {
    const text = behavior.trim();
    if (/^\d+$/.test(text)) return { mode: 'status', status: Number(text) };
    const aliases = { 'text/html': 'html', oversized: 'large' };
    return { mode: aliases[text] || text || 'ok' };
  }
  if (typeof behavior === 'object') {
    const mode = behavior.mode || ('status' in behavior ? 'status' : 'ok');
    return { ...behavior, mode: String(mode) };
  }
  return { mode: 'ok' };
}

function normalizeScenarios(scenarios) {
  if (scenarios == null) return ['success'];
  const list = (Array.isArray(scenarios) ? scenarios : [scenarios]).map(String).filter(Boolean);
  for (const name of list) {
    if (!SCENARIOS.includes(name)) throw new Error(`cenário desconhecido do fake Suno MCP: ${name}`);
  }
  return list.length ? list : ['success'];
}

function publicClip(clip) {
  return Object.fromEntries(Object.entries(clip).filter(([key]) => !key.startsWith('_')));
}

function parseRecordedJson(body) {
  if (!body.length) return null;
  return JSON.parse(body.toString('utf8'));
}

/** Sobe o fake e resolve quando a porta está aberta. */
export async function startFakeSunoMcp(options = {}) {
  const fake = new FakeSunoMcp(options);
  await fake.start();
  return fake;
}

export class FakeSunoMcp {
  constructor(options = {}) {
    this.host = options.host || '127.0.0.1';
    this._accounts = new Map();
    if (options.accounts && typeof options.accounts === 'object') {
      for (const [token, account] of Object.entries(options.accounts)) this._accounts.set(token, account ?? null);
      if (!this._accounts.size) throw new Error('accounts precisa de pelo menos um bearer');
      this.token = [...this._accounts.keys()][0];
    } else {
      this.token = options.token === undefined ? DEFAULT_TOKEN : options.token;
      if (this.token) this._accounts.set(this.token, options.account === undefined ? DEFAULT_ACCOUNT : options.account);
    }
    this._openAccount = options.account === undefined ? DEFAULT_ACCOUNT : options.account;
    this.timeoutDelayMs = options.timeoutDelayMs ?? DEFAULT_TIMEOUT_DELAY_MS;
    this.requireSession = Boolean(options.requireSession);
    this.authOnInitialize = options.authOnInitialize ?? true;
    this.responseMode = options.responseMode === 'sse' ? 'sse' : 'json';
    this.includeBase64 = Boolean(options.includeBase64);
    this.leaky = Boolean(options.leaky);
    this.credits = options.credits ?? 42;
    this.clipsPerCall = options.clipsPerCall ?? CLIPS_PER_CALL;
    this.requested = Number.isInteger(options.requested) ? options.requested : null;
    if (options.tools) {
      this.tools = options.tools;
      this.toolsListSource = 'explicit';
    } else {
      const loaded = loadSunoToolsList(options.toolsListPath);
      this.tools = loaded.tools;
      this.toolsListSource = loaded.source;
    }
    this.generationTool = pickGenerationTool(this.tools);
    this.requests = [];
    this.connectionErrors = [];
    this.sessionId = '';
    this._sessions = new Set();
    this._clips = new Map();
    this._clipOrder = 0;
    this._timers = new Set();
    this._sockets = new Set();
    this._server = null;
    this._closed = false;
    this.setScenarios(options.scenarios ?? options.scenario ?? 'success');
    this.setDefaultAudioBehavior(options.audioBehavior ?? 'ok');
  }

  // -- ciclo de vida ----------------------------------------------------

  get port() {
    if (!this._server) throw new Error('O fake do Suno MCP ainda não foi iniciado.');
    return this._server.address().port;
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  get url() {
    return `${this.baseUrl}/mcp`;
  }

  get audioBaseUrl() {
    return `${this.baseUrl}/audio`;
  }

  audioUrl(clipId, ext = 'mp3') {
    let url = `${this.audioBaseUrl}/${clipId}.${ext}`;
    if (this.leaky) url += `?X-Amz-Signature=fake-suno-signature&token=${this.token || DEFAULT_TOKEN}`;
    return url;
  }

  start() {
    if (this._server) return Promise.resolve(this);
    this._closed = false;
    const server = createServer((req, res) => this._handle(req, res));
    server.keepAliveTimeout = 1000;
    server.on('connection', (socket) => {
      this._sockets.add(socket);
      socket.on('error', (error) => this._noteConnectionError(error));
      socket.on('close', () => this._sockets.delete(socket));
    });
    server.on('clientError', (error, socket) => {
      this._noteConnectionError(error);
      if (socket.writable && !RESET_ERROR_CODES.includes(error.code)) {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      } else {
        socket.destroy();
      }
    });
    this._server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, this.host, () => {
        server.off('error', reject);
        resolve(this);
      });
    });
  }

  /** Cancela esperas pendentes, derruba as conexões e libera a porta. */
  async close() {
    const server = this._server;
    this._closed = true;
    for (const timer of this._timers) {
      clearTimeout(timer.handle);
      timer.resolve(false);
    }
    this._timers.clear();
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const socket of this._sockets) socket.destroy();
    });
    this._server = null;
  }

  async [Symbol.asyncDispose]() {
    await this.close();
  }

  // -- configuração em runtime -------------------------------------------

  /** Redefine a sequência de cenários e zera o contador de gerações. */
  setScenarios(scenarios) {
    this.scenarios = normalizeScenarios(scenarios);
    this._generationIndex = 0;
  }

  /** Troca a conta Suno de um bearer (padrão: `token`). Sem auth, troca a conta única. */
  setAccount(account, token = this.token) {
    if (!token) this._openAccount = account ?? null;
    else this._accounts.set(token, account ?? null);
  }

  /** Aceita mais um bearer, ligado a `account`. */
  addAccount(token, account) {
    if (!token) throw new Error('token obrigatório');
    this._accounts.set(token, account ?? null);
  }

  /** Conta de um bearer (ou a conta única quando a auth está desligada). */
  accountFor(token = this.token) {
    if (!this.token) return this._openAccount;
    return this._accounts.has(token) ? this._accounts.get(token) : null;
  }

  setScenario(scenario) {
    this.setScenarios(scenario);
  }

  /** Comportamento de download dos próximos clips (valor único ou lista por clip). */
  setDefaultAudioBehavior(behavior) {
    if (Array.isArray(behavior)) {
      this._audioBehaviorList = behavior.map(normalizeAudioBehavior);
      this._audioBehaviorDefault = { mode: 'ok' };
    } else {
      this._audioBehaviorList = [];
      this._audioBehaviorDefault = normalizeAudioBehavior(behavior);
    }
    this._audioBehaviorIndex = 0;
  }

  /** Altera o download de um clip já gerado. */
  setAudioBehavior(clipId, behavior) {
    const clip = this._clips.get(clipId);
    if (!clip) throw new Error(`clip desconhecido: ${clipId}`);
    clip._audioBehavior = normalizeAudioBehavior(behavior);
  }

  /** Invalida uma sessão (ou todas); com requireSession o próximo RPC recebe 404. */
  expireSessions(sessionId) {
    if (sessionId === undefined) this._sessions.clear();
    else this._sessions.delete(sessionId);
  }

  /** Limpa requisições, clips e contadores. */
  resetRecordings() {
    this.requests.length = 0;
    this.connectionErrors.length = 0;
    this._generationIndex = 0;
    this._clips.clear();
    this._clipOrder = 0;
    this._audioBehaviorIndex = 0;
  }

  nextScenario() {
    const index = Math.min(this._generationIndex, this.scenarios.length - 1);
    this._generationIndex += 1;
    return this.scenarios[index];
  }

  // -- observação ---------------------------------------------------------

  generationCalls() {
    return this.requests.filter((req) => req.jsonrpcMethod === 'tools/call' && req.toolName === this.generationTool);
  }

  rpcMethods() {
    return this.requests.map((req) => req.jsonrpcMethod).filter(Boolean);
  }

  /** GETs de áudio recebidos ({ clipId, status, ... }). */
  audioDownloads() {
    return this.requests.filter((req) => req.method === 'GET' && req.clipId);
  }

  /** Estado de todos os clips gerados, na ordem: { id, status, audio_url, extra, call, ... }. */
  clips() {
    return [...this._clips.values()].map((clip) => ({ ...publicClip(clip), extra: clip._extra, call: clip._call }));
  }

  extraClips() {
    return this.clips().filter((clip) => clip.extra);
  }

  // -- HTTP ----------------------------------------------------------------

  _noteConnectionError(error) {
    this.connectionErrors.push(error?.code || error?.message || String(error));
  }

  _wait(ms) {
    if (this._closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = { resolve };
      timer.handle = setTimeout(() => {
        this._timers.delete(timer);
        resolve(!this._closed);
      }, ms);
      this._timers.add(timer);
    });
  }

  _record(req, body, payload, status, extra = {}) {
    const params = payload && typeof payload.params === 'object' ? payload.params : null;
    const recorded = {
      method: req.method,
      path: new URL(req.url, 'http://fake.local').pathname,
      headers: { ...req.headers },
      body,
      json: () => parseRecordedJson(body),
      jsonrpcMethod: payload && typeof payload.method === 'string' ? payload.method : null,
      rpcId: payload ? (payload.id ?? null) : null,
      toolName: typeof params?.name === 'string' ? params.name : null,
      toolArguments: params?.arguments && typeof params.arguments === 'object' ? params.arguments : null,
      status,
      accountId: this._accountOf(req)?.id ?? null,
      ...extra,
    };
    this.requests.push(recorded);
    return recorded;
  }

  _canWrite(res) {
    return !this._closed && !res.destroyed && !res.writableEnded && !res.socket?.destroyed;
  }

  _send(res, status, body = Buffer.alloc(0), contentType = 'application/json', headers = {}, contentLength) {
    if (!this._canWrite(res)) return;
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const declared = contentLength ?? data.length;
    res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': String(declared), ...headers });
    if (declared > data.length) {
      // truncado: manda menos bytes que o declarado e corta a conexão
      res.write(data, () => res.destroy());
      return;
    }
    res.end(data);
  }

  _sendJson(res, status, payload, headers = {}) {
    if (this.responseMode === 'sse' && status === 200 && payload?.jsonrpc) {
      const event = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
      this._send(res, status, Buffer.from(event), 'text/event-stream', { 'Cache-Control': 'no-cache', ...headers });
      return;
    }
    this._send(res, status, Buffer.from(JSON.stringify(payload)), 'application/json', headers);
  }

  _rpcError(res, status, rpcId, code, message, headers = {}) {
    this._sendJson(res, status, { jsonrpc: '2.0', id: rpcId, error: { code, message } }, headers);
  }

  _errorMessage(kind) {
    const message = { unauthorized: 'Unauthorized', credits: 'Insufficient credits' }[kind] || 'Suno unavailable';
    return this.leaky && this.token ? `${message}: Bearer ${this.token}` : message;
  }

  _send401(res, rpcId) {
    this._rpcError(res, 401, rpcId, -32001, this._errorMessage('unauthorized'), { 'WWW-Authenticate': 'Bearer' });
  }

  _bearer(req) {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    return match ? match[1] : null;
  }

  _authorized(req) {
    return !this.token || this._accounts.has(this._bearer(req));
  }

  _accountOf(req) {
    if (!this.token) return this._openAccount;
    const bearer = this._bearer(req);
    return this._accounts.has(bearer) ? this._accounts.get(bearer) : null;
  }

  _validSession(req) {
    return !this.requireSession || this._sessions.has(req.headers['mcp-session-id'] || '');
  }

  _handle(req, res) {
    req.on('error', (error) => this._noteConnectionError(error));
    res.on('error', (error) => this._noteConnectionError(error));
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      Promise.resolve()
        .then(() => this._dispatch(req, res, body))
        .catch((error) => {
          this._noteConnectionError(error);
          if (this._canWrite(res) && !res.headersSent) this._sendJson(res, 500, { error: 'fake internal error' });
          else res.destroy();
        });
    });
  }

  async _dispatch(req, res, body) {
    const path = new URL(req.url, 'http://fake.local').pathname;
    if (req.method === 'GET') {
      if (path.startsWith('/audio/')) return this._handleAudio(req, res, path);
      this._record(req, body, null, 404);
      return this._sendJson(res, 404, { error: 'not found' });
    }
    if (req.method === 'DELETE') return this._handleDelete(req, res, body);
    if (req.method === 'POST') return this._handlePost(req, res, body);
    this._record(req, body, null, 405);
    return this._sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, POST, DELETE' });
  }

  _handleDelete(req, res, body) {
    const incoming = req.headers['mcp-session-id'] || '';
    if (!incoming) {
      this._record(req, body, null, 400);
      return this._sendJson(res, 400, { error: 'missing Mcp-Session-Id' });
    }
    this._sessions.delete(incoming);
    this._record(req, body, null, 204);
    if (this._canWrite(res)) res.writeHead(204).end();
  }

  async _handlePost(req, res, body) {
    let payload;
    try {
      payload = JSON.parse(body.toString('utf8') || 'null');
    } catch {
      this._record(req, body, null, 400);
      return this._rpcError(res, 400, null, -32700, 'Parse error');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      this._record(req, body, null, 400);
      return this._rpcError(res, 400, null, -32600, 'Invalid Request');
    }
    const method = String(payload.method || '');
    const rpcId = payload.id ?? null;

    if (method === 'initialize') {
      if (this.authOnInitialize && !this._authorized(req)) {
        this._record(req, body, payload, 401);
        return this._send401(res, rpcId);
      }
      const sessionId = randomUUID().replaceAll('-', '');
      this._sessions.add(sessionId);
      this.sessionId = sessionId;
      this._record(req, body, payload, 200);
      const result = {
        protocolVersion: DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'fake-suno-mcp', version: '0.1.0' },
        _meta: { 'suno/account': this._accountOf(req) },
      };
      return this._sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, result }, { 'Mcp-Session-Id': sessionId });
    }
    if (method === 'notifications/initialized') {
      this._record(req, body, payload, 202);
      if (this._canWrite(res)) res.writeHead(202, { 'Content-Length': '0' }).end();
      return;
    }
    if (!this._authorized(req)) {
      this._record(req, body, payload, 401);
      return this._send401(res, rpcId);
    }
    if ((method === 'tools/list' || method === 'tools/call') && !this._validSession(req)) {
      this._record(req, body, payload, 404);
      return this._rpcError(res, 404, rpcId, -32000, 'Session not found');
    }
    if (method === 'tools/list') {
      this._record(req, body, payload, 200);
      return this._sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, result: { tools: this.tools } });
    }
    if (method === 'tools/call') return this._handleToolsCall(req, res, body, payload, rpcId);
    this._record(req, body, payload, 200);
    return this._rpcError(res, 200, rpcId, -32601, `Method not found: ${method}`);
  }

  async _handleToolsCall(req, res, body, payload, rpcId) {
    const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
    const toolName = String(params.name || '');
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};

    if (toolName === 'get_credits' || toolName === 'get_account') {
      this._record(req, body, payload, 200);
      const account = this._accountOf(req);
      const data = toolName === 'get_credits' ? { credits: this.credits, account } : { account };
      const result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
      return this._sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, result });
    }
    if (toolName !== this.generationTool && !GENERATION_TOOL_CANDIDATES.includes(toolName)) {
      this._record(req, body, payload, 200);
      return this._rpcError(res, 200, rpcId, -32602, `Unknown tool: ${toolName}`);
    }

    const scenario = this.nextScenario();
    const call = this._generationIndex;
    if (scenario === '401') {
      this._record(req, body, payload, 401, { scenario });
      return this._send401(res, rpcId);
    }
    if (scenario === '402') {
      this._record(req, body, payload, 402, { scenario });
      return this._rpcError(res, 402, rpcId, 402, this._errorMessage('credits'));
    }
    if (scenario === '503' || scenario === '500') {
      const status = Number(scenario);
      this._record(req, body, payload, status, { scenario });
      return this._rpcError(res, status, rpcId, -32000, this._errorMessage('unavailable'));
    }
    if (scenario === 'timeout') {
      // registra antes de esperar: o cliente que já desistiu ainda vê a chamada
      this._record(req, body, payload, 200, { scenario });
      const finished = await this._wait(this.timeoutDelayMs);
      if (!finished || !this._canWrite(res)) return;
      const result = this._successResult(args, { call, partial: false, extraLast: false });
      return this._sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, result });
    }
    const result = this._successResult(args, {
      call,
      partial: scenario === 'partial',
      extraLast: scenario === 'odd_extra',
    });
    this._record(req, body, payload, 200, { scenario });
    return this._sendJson(res, 200, { jsonrpc: '2.0', id: rpcId, result });
  }

  _behaviorForNewClip() {
    if (this._audioBehaviorList.length) {
      const index = Math.min(this._audioBehaviorIndex, this._audioBehaviorList.length - 1);
      this._audioBehaviorIndex += 1;
      return { ...this._audioBehaviorList[index] };
    }
    return { ...this._audioBehaviorDefault };
  }

  _successResult(args, { call, partial, extraLast }) {
    const prompt = String(args.prompt || args.style || args.description || '');
    const count = Math.max(0, Math.trunc(this.clipsPerCall));
    const clips = [];
    for (let index = 0; index < count; index += 1) {
      const id = `clip-${randomBytes(5).toString('hex')}`;
      const failed = partial && index === count - 1;
      const clip = { id, title: prompt || `fake-suno-${index + 1}`, status: failed ? 'error' : 'complete', prompt };
      if (failed) {
        clip.audio_url = null;
        clip.error = 'sem áudio';
      } else {
        clip.audio_url = this.audioUrl(id);
        if (this.includeBase64) {
          clip.audio_base64 = FAKE_AUDIO_BYTES.toString('base64');
          clip.format = 'mp3';
        }
      }
      if (!failed) this._clipOrder += 1;
      clip._audioBehavior = this._behaviorForNewClip();
      clip._call = call;
      clip._extra = failed
        ? false
        : this.requested !== null
          ? this._clipOrder > this.requested
          : extraLast && index === count - 1;
      this._clips.set(id, clip);
      clips.push(publicClip(clip));
    }
    return { content: [{ type: 'text', text: JSON.stringify({ clips }) }] };
  }

  async _handleAudio(req, res, path) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const clipId = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
    const clip = this._clips.get(clipId);
    const empty = Buffer.alloc(0);
    if (!clip || !clip.audio_url) {
      this._record(req, empty, null, 404, { clipId });
      return this._sendJson(res, 404, { error: 'audio not found' });
    }
    const behavior = { ...(clip._audioBehavior || { mode: 'ok' }) };
    const extra = { clipId, extra: clip._extra, mode: behavior.mode };
    switch (behavior.mode) {
      case 'status': {
        const status = Number(behavior.status) || 404;
        this._record(req, empty, null, status, extra);
        return this._sendJson(res, status, { error: `audio http ${status}` });
      }
      case 'html': {
        this._record(req, empty, null, 200, extra);
        return this._send(res, 200, Buffer.from(behavior.body ?? HTML_AUDIO_BODY), 'text/html');
      }
      case 'redirect': {
        this._record(req, empty, null, 302, extra);
        return this._send(res, 302, empty, 'text/plain', { Location: behavior.location || DEFAULT_REDIRECT_LOCATION });
      }
      case 'truncated': {
        const partialBody = Buffer.from(behavior.body ?? FAKE_AUDIO_BYTES.subarray(0, 10));
        const declared = Number(behavior.contentLength ?? behavior.content_length) || partialBody.length + 1024;
        this._record(req, empty, null, 200, extra);
        return this._send(res, 200, partialBody, FAKE_AUDIO_CONTENT_TYPE, {}, declared);
      }
      case 'large': {
        this._record(req, empty, null, 200, extra);
        return this._stream(res, Number(behavior.size) || DEFAULT_LARGE_AUDIO_SIZE);
      }
      case 'slow': {
        this._record(req, empty, null, 200, extra);
        const delay = Number(behavior.delayMs ?? behavior.delay_ms) || this.timeoutDelayMs;
        if (!(await this._wait(delay))) return;
        return this._send(res, 200, FAKE_AUDIO_BYTES, FAKE_AUDIO_CONTENT_TYPE);
      }
      default:
        this._record(req, empty, null, 200, extra);
        return this._send(res, 200, FAKE_AUDIO_BYTES, FAKE_AUDIO_CONTENT_TYPE);
    }
  }

  /** Envia `size` bytes em chunks, respeitando backpressure, sem montar o corpo. */
  async _stream(res, size) {
    if (!this._canWrite(res)) return;
    res.writeHead(200, { 'Content-Type': FAKE_AUDIO_CONTENT_TYPE, 'Content-Length': String(size) });
    const chunk = Buffer.alloc(STREAM_CHUNK_SIZE, 0x53);
    let remaining = size;
    while (remaining > 0) {
      if (!this._canWrite(res)) return;
      const n = Math.min(STREAM_CHUNK_SIZE, remaining);
      remaining -= n;
      if (!res.write(chunk.subarray(0, n))) {
        await new Promise((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.on('drain', done);
          res.on('close', done);
        });
      }
    }
    if (this._canWrite(res)) res.end();
  }
}
