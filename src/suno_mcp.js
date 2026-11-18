import { SunoError, sunoMessages } from './suno_errors.js';

// Cliente MCP (Streamable HTTP) do Suno na pia-server (T3b). O schema real do
// https://api.suno.com/mcp ainda não foi capturado (spike T10), então a
// descoberta das tools e o mapeamento de argumentos são tolerantes e cobertos
// só por fakes. Nenhum token, corpo de resposta ou audio_url assinado vai para
// log ou mensagem de erro: os erros têm texto fixo e só o `code` do contrato.

export const sunoMcp = {
  url: 'https://api.suno.com/mcp',
  protocolVersion: '2025-11-25',
  requestTimeoutMs: 60000, // por requisição HTTP (initialize, tools/list, tools/call); o único timeout
  // Polling sem prazo total (contrato v3.2): backoff de 5 s a 60 s até o estado
  // terminal dos clips, o cancelamento ou a credencial expirada.
  pollMinMs: 5000,
  pollMaxMs: 60000,
  sleep: null, // (ms, signal) => Promise; injetável nos testes (padrão: setTimeout cancelável)
  generationTool: '', // nome forçado (vazio = descoberta)
};

export const GENERATION_TOOL_PREFERENCE = Object.freeze(['generate_music', 'create_song', 'suno_generate_custom_music',
  'generate_song', 'audio-create', 'create_music']);
export const STATUS_TOOL_PREFERENCE = Object.freeze(['get_song', 'get_clip', 'get_task', 'get_generation', 'get_music',
  'get_clips', 'clip-get', 'library-get']);
export const ACCOUNT_TOOL_PREFERENCE = Object.freeze(['get_account', 'account-me', 'account_me', 'get_profile', 'get_me',
  'whoami', 'me', 'get_user']);
export const CREDITS_TOOL_PREFERENCE = Object.freeze(['get_credits', 'account-usage', 'account_usage', 'get_usage',
  'credits', 'get_billing']);
const PROMPT_FIELDS = ['prompt', 'style', 'description', 'gpt_description_prompt', 'tags'];
const LYRICS_FIELDS = ['lyrics', 'lyric'];
const INSTRUMENTAL_FIELDS = ['instrumental', 'make_instrumental'];
const DURATION_FIELDS = ['duration', 'duration_seconds', 'length'];
const CLIP_ID_FIELDS = ['id', 'clip_id', 'song_id', 'task_id'];
const STATUS_ID_FIELDS = ['ids', 'clip_ids', 'id', 'clip_id', 'song_id', 'task_id'];
const FAILED_STATES = new Set(['error', 'failed', 'failure', 'cancelled', 'canceled']);
const AUTH_TEXT = /\bunauthori[sz]ed\b|\b(?:invalid|expired|revoked)[_ -]?(?:access[_ -]?|bearer[_ -]?)?token\b|\btoken[_ -]?(?:has[_ -]?)?(?:expired|invalid|revoked)\b|\bsign in\b/i;
const CREDIT_TEXT = /insufficient[_ ]credits?|no credits|out of credits|not enough credits|credits? (?:exhausted|insufficient)|payment required|insufficient[_ ]balance/i;

// ---------------------------------------------------------------------------
// Erros. `upstreamStatus` guarda o status HTTP do Suno (401 dispara o refresh
// reativo do withSunoToken); `partial` leva os clips já prontos.

export class SunoMcpError extends SunoError {
  constructor(code, message, { upstreamStatus = null, detail = null, status } = {}) {
    super(code, message, status ?? (code === 'suno_credential_expired' || code === 'suno_no_credits' ? 400 : 502));
    this.name = 'SunoMcpError';
    this.upstreamStatus = upstreamStatus;
    this.detail = detail; // 'http_5xx' | 'timeout' | 'network' | 'protocol' | 'session' | 'cancelled' | 'tool_error'
  }
}

export const sunoMcpMessages = {
  credits: 'Sua conta Suno não tem créditos suficientes.',
  timeout: 'O Suno não respondeu a tempo; a geração pode ter sido concluída lá.',
  protocol: 'O Suno respondeu num formato que a PIA não reconhece.',
  noTool: 'O servidor do Suno não expõe uma ferramenta de geração de música compatível.',
  cancelled: 'A espera foi cancelada. O Suno pode continuar a geração já enviada.',
};

const authError = () => new SunoMcpError('suno_credential_expired', sunoMessages.expired, { upstreamStatus: 401 });
const unavailableError = (detail, upstreamStatus = null) => new SunoMcpError('suno_unavailable', sunoMessages.unavailable, { detail, upstreamStatus });
const timeoutError = () => new SunoMcpError('suno_timeout', sunoMcpMessages.timeout, { detail: 'timeout' });
const protocolError = (message = sunoMcpMessages.protocol) => new SunoMcpError('suno_unavailable', message, { detail: 'protocol' });

// Tradução para os codes do contrato (sem nunca repassar texto do Suno).
export function translateSunoError(error, { signal } = {}) {
  if (error instanceof SunoError) return error;
  if (signal?.aborted && signal.reason?.name !== 'TimeoutError')
    return new SunoMcpError('suno_cancelled', sunoMcpMessages.cancelled, { detail: 'cancelled' });
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return timeoutError();
  return unavailableError('network');
}

function httpError(status) {
  if (status === 401) return authError();
  if (status === 402) return new SunoMcpError('suno_no_credits', sunoMcpMessages.credits, { upstreamStatus: 402 });
  if (status === 408 || status === 504) return Object.assign(timeoutError(), { upstreamStatus: status });
  return unavailableError(status >= 500 ? 'http_5xx' : 'protocol', status);
}

function rpcError(error, httpStatus) {
  const code = Number(error?.code);
  const message = typeof error?.message === 'string' ? error.message : '';
  if (code === 401 || code === -32001 || httpStatus === 401 || AUTH_TEXT.test(message) && code !== -32602) return authError();
  if (code === 402 || httpStatus === 402 || CREDIT_TEXT.test(message)) return httpError(402);
  if (httpStatus >= 500) return unavailableError('http_5xx', httpStatus);
  return protocolError();
}

// ---------------------------------------------------------------------------
// redact: para qualquer texto que possa ir a log (URLs perdem a query, Bearer,
// parâmetros de token/assinatura, X-Amz-* e segredos conhecidos).

const REDACTED = '[redacted]';
export function redactSuno(text, secrets = []) {
  try {
    let out = String(text ?? '');
    for (const secret of [...new Set(secrets.filter((item) => typeof item === 'string' && item.length >= 6))].sort((a, b) => b.length - a.length))
      out = out.split(secret).join(REDACTED);
    out = out.replace(/\b(https?:\/\/[^\s?#"'<>]+)\?[^\s#"'<>]*/gi, '$1?' + REDACTED);
    out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ' + REDACTED);
    out = out.replace(/\b((?:access_|refresh_|id_)?token|code|sig|signature|client_secret|x-amz-[a-z-]+)=([^&\s"'<>]+)/gi, '$1=' + REDACTED);
    return out.slice(0, 2000);
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Transporte JSON-RPC sobre Streamable HTTP, com Mcp-Session-Id e reinitialize
// quando a sessão expira (404 com sessão aberta).

async function readMessage(response, id) {
  const type = response.headers.get('content-type') || '';
  const text = await response.text();
  if (type.includes('text/event-stream')) {
    let found = null;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      try {
        const message = JSON.parse(data);
        if (message?.jsonrpc === '2.0' && (id === undefined || message.id === id) && ('result' in message || 'error' in message)) found = message;
      } catch { /* evento que não é JSON */ }
    }
    return found;
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// `token`: bearer fixo (ex.: identidade logo após a troca do code).
// `withToken`: (fn) => withSunoToken(account, sunoAccountId, fn). Cada requisição
// passa por ele: um 401 do Suno renova o token e repete só aquela requisição
// (com initialize novo); um segundo 401 vira suno_credential_expired.
export class SunoMcpClient {
  constructor({ token = '', withToken = null, url = sunoMcp.url, timeoutMs = sunoMcp.requestTimeoutMs, signal } = {}) {
    if (!token && !withToken) throw authError();
    this.token = token;
    this.withToken = withToken;
    this.url = url;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.session = '';
    this.nextId = 0;
    this.server = null;
    this._tools = null;
  }

  _signal(timeoutMs) {
    const signals = [AbortSignal.timeout(timeoutMs ?? this.timeoutMs)];
    if (this.signal) signals.push(this.signal);
    return AbortSignal.any(signals);
  }

  async _post(body, { timeoutMs } = {}) {
    const signal = this._signal(timeoutMs);
    const headers = { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': sunoMcp.protocolVersion };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    try {
      const response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal });
      return { response, message: body.id === undefined ? (await response.body?.cancel(), null) : await readMessage(response, body.id) };
    } catch (error) { throw translateSunoError(error, { signal: this.signal }); }
  }

  async _authorized(run) {
    if (!this.withToken) return run();
    const outcome = await this.withToken(async (token) => {
      if (token !== this.token) { this.token = token; this.server = null; this.session = ''; }
      try { return { value: await run() }; }
      catch (error) { if (error?.upstreamStatus === 401) return { status: 401 }; throw error; }
    });
    return outcome.value;
  }

  // initialize + notifications/initialized; devolve o result (serverInfo, _meta…).
  async initialize() { return this._authorized(() => this._initialize()); }

  async _initialize() {
    if (this.server) return this.server;
    this.session = '';
    const { response, message } = await this._post({ jsonrpc: '2.0', id: ++this.nextId, method: 'initialize', params: {
      protocolVersion: sunoMcp.protocolVersion, capabilities: {}, clientInfo: { name: 'pia-server', version: '0.1.0' } } });
    if (!response.ok) throw message?.error ? rpcError(message.error, response.status) : httpError(response.status);
    if (message?.error) throw rpcError(message.error, response.status);
    if (!message?.result || typeof message.result !== 'object') throw protocolError();
    this.session = response.headers.get('mcp-session-id') || '';
    this.server = message.result;
    const { response: note } = await this._post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    if (!note.ok && note.status !== 202) throw httpError(note.status);
    return this.server;
  }

  // Uma requisição JSON-RPC. Sessão expirada (404 com sessão) refaz o
  // initialize uma vez: o servidor não processou o pedido, então é seguro.
  async request(method, params, { timeoutMs } = {}) {
    return this._authorized(() => this._request(method, params, { timeoutMs }));
  }

  async _request(method, params, { timeoutMs } = {}) {
    for (let attempt = 0; ; attempt++) {
      await this._initialize();
      const { response, message } = await this._post({ jsonrpc: '2.0', id: ++this.nextId, method, params }, { timeoutMs });
      if (response.status === 404 && this.session && attempt === 0) { this.server = null; continue; }
      if (!response.ok) throw message?.error ? rpcError(message.error, response.status) : httpError(response.status);
      if (message?.error) throw rpcError(message.error, response.status);
      if (!message || !('result' in message)) throw protocolError();
      return message.result;
    }
  }

  async listTools({ refresh = false } = {}) {
    if (this._tools && !refresh) return this._tools;
    const tools = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      if (!Array.isArray(result?.tools)) throw protocolError();
      tools.push(...result.tools.filter((tool) => tool && typeof tool.name === 'string' && tool.name.trim()));
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
      if (!cursor) break;
    }
    this._tools = tools;
    return tools;
  }

  // tools/call -> objeto normalizado (structuredContent ou JSON do content[]).
  // Resultado com isError é classificado pelo texto, que nunca é repassado.
  async callTool(name, args = {}, { timeoutMs } = {}) {
    const result = await this.request('tools/call', { name, arguments: args }, { timeoutMs });
    if (result?.isError) {
      const text = toolErrorText(result);
      if (AUTH_TEXT.test(text)) throw authError();
      if (CREDIT_TEXT.test(text)) throw httpError(402);
      throw Object.assign(protocolError(), { detail: 'tool_error' });
    }
    return normalizeToolResult(result);
  }

  async close() {
    const session = this.session;
    this.session = '';
    this.server = null;
    if (!session) return;
    try {
      const response = await fetch(this.url, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: 'Bearer ' + this.token, 'Mcp-Session-Id': session } });
      await response.body?.cancel();
    } catch { /* a sessão expira sozinha */ }
  }
}

function toolErrorText(result) {
  const parts = (result?.content || []).filter((part) => typeof part?.text === 'string').map((part) => part.text);
  if (result?.structuredContent && typeof result.structuredContent === 'object') parts.push(JSON.stringify(result.structuredContent));
  return parts.join(' ').slice(0, 2000);
}

export function normalizeToolResult(result) {
  if (!result || typeof result !== 'object') return {};
  if (result.structuredContent && typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent))
    return { ...result.structuredContent };
  for (const part of Array.isArray(result.content) ? result.content : []) {
    if (typeof part?.text !== 'string') continue;
    try {
      const parsed = JSON.parse(part.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed) && parsed.some((item) => item && typeof item === 'object')) return { clips: parsed };
    } catch { /* texto livre */ }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Descoberta tolerante (por nome e por schema).

const properties = (tool) => {
  const props = tool?.inputSchema?.properties;
  return props && typeof props === 'object' ? props : {};
};
const required = (tool) => (Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : []);
const lower = (tool) => String(tool?.name || '').toLowerCase();
const byPreference = (tools, names) => {
  const map = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of names) if (map.has(name)) return map.get(name);
  return null;
};

export function discoverSunoTools(tools, { generationTool = sunoMcp.generationTool } = {}) {
  const list = Array.isArray(tools) ? tools.filter((tool) => tool && typeof tool.name === 'string') : [];
  let generation = null;
  if (generationTool) generation = list.find((tool) => tool.name === generationTool) || null;
  else {
    generation = byPreference(list, GENERATION_TOOL_PREFERENCE) ||
      list.find((tool) => /(generate|create)/.test(lower(tool)) && /(song|music|audio|track)/.test(lower(tool))) ||
      list.find((tool) => PROMPT_FIELDS.some((field) => field in properties(tool)) &&
        [...LYRICS_FIELDS, ...INSTRUMENTAL_FIELDS, ...DURATION_FIELDS].some((field) => field in properties(tool)));
  }
  const others = list.filter((tool) => tool !== generation);
  const status = byPreference(others, STATUS_TOOL_PREFERENCE) ||
    others.find((tool) => /(get|status|fetch|poll)/.test(lower(tool)) && /(clip|song|task|generation|music)/.test(lower(tool)) &&
      STATUS_ID_FIELDS.some((field) => field in properties(tool))) || null;
  const noArgs = (tool) => required(tool).length === 0;
  const account = byPreference(others, ACCOUNT_TOOL_PREFERENCE) ||
    others.find((tool) => noArgs(tool) && /(^|[-_])(account|profile|me|user|whoami)($|[-_])/.test(lower(tool)) &&
      !/(credit|usage|billing)/.test(lower(tool))) || null;
  const credits = byPreference(others, CREDITS_TOOL_PREFERENCE) ||
    others.find((tool) => noArgs(tool) && /(credit|usage|billing|balance)/.test(lower(tool))) || null;
  return { generation, status, account, credits };
}

// Mapeia prompt/letra/duração para os campos que a tool declara. Recusa antes
// de qualquer chamada paga se faltar campo de prompt ou um required.
export function mapGenerationArguments(tool, { prompt, lyrics = '', duration = null, instrumental } = {}) {
  const props = properties(tool);
  const args = {};
  const promptField = PROMPT_FIELDS.find((field) => field in props);
  if (!promptField || typeof prompt !== 'string' || !prompt.trim()) throw protocolError(sunoMcpMessages.noTool);
  args[promptField] = prompt.trim();
  const text = typeof lyrics === 'string' ? lyrics.trim() : '';
  const lyricsField = LYRICS_FIELDS.find((field) => field in props);
  if (text && lyricsField) args[lyricsField] = text;
  const instrumentalField = INSTRUMENTAL_FIELDS.find((field) => field in props);
  if (instrumentalField) args[instrumentalField] = typeof instrumental === 'boolean' ? instrumental : !text;
  const durationField = DURATION_FIELDS.find((field) => field in props);
  if (Number.isFinite(duration) && durationField) {
    const type = props[durationField]?.type;
    args[durationField] = type === 'integer' ? Math.round(duration) : duration;
  }
  if (required(tool).some((field) => !(field in args))) throw protocolError(sunoMcpMessages.noTool);
  return args;
}

// ---------------------------------------------------------------------------
// Clips.

export function extractClips(data) {
  for (const key of ['clips', 'songs', 'data', 'results', 'items', 'tracks']) {
    if (Array.isArray(data?.[key]) && data[key].length) return data[key].filter((item) => item && typeof item === 'object').map((item) => ({ ...item }));
  }
  if (data && typeof data === 'object' && ('audio_url' in data || CLIP_ID_FIELDS.some((field) => field in data))) return [{ ...data }];
  return [];
}

const clipId = (clip) => {
  for (const field of CLIP_ID_FIELDS) {
    const value = clip?.[field];
    if ((typeof value === 'string' || typeof value === 'number') && String(value).trim()) return String(value).trim();
  }
  return '';
};

function clipState(clip) {
  if (typeof clip.audio_url === 'string' && /^https?:\/\//i.test(clip.audio_url)) return 'ready';
  const status = String(clip.status || clip.state || '').toLowerCase();
  if (FAILED_STATES.has(status) || clip.error || !clipId(clip)) return 'failed';
  return 'pending';
}

// Formato público de um clip para a T4 (audio_url fica só no servidor).
function publicClip(clip) {
  const state = clip.state === 'failed' || clip.state === 'ready' ? clip.state : clipState(clip);
  const duration = Number(clip.duration ?? clip.metadata?.duration);
  return { id: clipId(clip), title: typeof clip.title === 'string' ? clip.title : '', state,
    audio_url: state === 'ready' ? clip.audio_url : null, duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    mime: typeof clip.mime === 'string' ? clip.mime : null };
}

const realSleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', abort, { once: true });
});

// Próximo intervalo do polling: dobra sem progresso ou em falha transitória,
// volta ao mínimo quando algum clip muda de estado; sempre entre pollMinMs e pollMaxMs.
export function nextPollDelay(current, progressed) {
  const min = sunoMcp.pollMinMs;
  const max = Math.max(min, sunoMcp.pollMaxMs);
  if (progressed || !(current >= min)) return min;
  return Math.min(max, current * 2);
}

const cancelled = () => new SunoMcpError('suno_cancelled', sunoMcpMessages.cancelled, { detail: 'cancelled' });

// Uma geração (um tools/call; o Suno devolve ~2 clips) com polling dos clips
// pendentes pela tool de status. Nunca repete o tools/call de geração. Não há
// prazo total: o polling só termina com todos os clips em estado terminal, com
// o cancelamento (signal -> suno_cancelled) ou com a credencial expirada depois
// do refresh (suno_credential_expired). Qualquer outra falha do polling
// (timeout de uma requisição, 5xx, rede, protocolo) é transitória: backoff e
// nova tentativa. suno_timeout só sai do timeout de uma requisição HTTP fora
// do polling (ex.: o tools/call inicial).
export async function generateOnce(client, { prompt, lyrics, duration, instrumental, signal, tools } = {}) {
  const found = discoverSunoTools(tools || await client.listTools());
  if (!found.generation) throw protocolError(sunoMcpMessages.noTool);
  const args = mapGenerationArguments(found.generation, { prompt, lyrics, duration, instrumental });
  if (signal?.aborted) throw cancelled();
  const data = await client.callTool(found.generation.name, args, { timeoutMs: sunoMcp.requestTimeoutMs });
  const clips = extractClips(data);
  if (!clips.length) throw protocolError();
  for (const clip of clips) clip.state = clipState(clip);
  let pending = clips.filter((clip) => clip.state === 'pending');
  if (pending.length && !found.status) { for (const clip of pending) clip.state = 'failed'; pending = []; }
  const withPartial = (error) => Object.assign(error, { partial: clips.filter((clip) => clip.state === 'ready').map(publicClip) });
  const props = properties(found.status);
  const idField = STATUS_ID_FIELDS.find((field) => field in props) || 'id';
  const batch = idField === 'ids' || idField === 'clip_ids';
  const wait = sunoMcp.sleep || realSleep;
  let delay = nextPollDelay(0, true);
  while (pending.length) {
    try { await wait(delay, signal); } catch { throw withPartial(cancelled()); }
    if (signal?.aborted) throw withPartial(cancelled());
    let progressed = false;
    const calls = batch ? [{ [idField]: pending.map(clipId) }] : pending.map((clip) => ({ [idField]: clipId(clip) }));
    for (const callArgs of calls) {
      let update;
      try { update = await client.callTool(found.status.name, callArgs, { timeoutMs: sunoMcp.requestTimeoutMs }); }
      catch (error) {
        const translated = translateSunoError(error, { signal });
        if (translated.code === 'suno_credential_expired' || translated.code === 'suno_cancelled' || signal?.aborted)
          throw withPartial(signal?.aborted ? cancelled() : translated);
        continue; // transitória: backoff e tenta de novo, sem limite de falhas
      }
      const byId = new Map(clips.map((clip) => [clipId(clip), clip]));
      for (const item of extractClips(update)) {
        const target = byId.get(clipId(item)) || (!batch ? byId.get(String(Object.values(callArgs)[0])) : null);
        if (!target || target.state !== 'pending') continue;
        Object.assign(target, Object.fromEntries(Object.entries(item).filter(([, value]) => value !== null && value !== undefined)));
        target.state = clipState(target);
        if (target.state !== 'pending') progressed = true;
      }
    }
    pending = clips.filter((clip) => clip.state === 'pending');
    delay = nextPollDelay(delay, progressed);
  }
  return { tool: found.generation.name, clips: clips.map(publicClip) };
}
