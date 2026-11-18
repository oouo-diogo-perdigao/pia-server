import { SunoError, sunoMessages } from './suno_errors.js';

// Identidade estável da conta Suno (suno_subject), mais e-mail e nome para
// exibição. A fonte real só se confirma no spike (T10), então a leitura fica
// isolada aqui e tenta as fontes na ordem de `sunoIdentity.sources`:
//   mcp_get_account      tools/call get_account -> { account: { id, email, label } }
//   mcp_initialize_meta  initialize -> result._meta['suno/account']
//   mcp_get_credits      tools/call get_credits -> { account }
//   userinfo             GET sunoIdentity.userinfoUrl (só se configurada)
//   token_claims         claims `sub`/`email`/`name` do access token JWT (recebido
//                        direto do token endpoint por TLS; sem verificar assinatura)
// Nenhum token ou corpo de resposta é logado.

export const sunoIdentity = {
  mcpUrl: 'https://api.suno.com/mcp',
  userinfoUrl: null,
  sources: ['mcp_get_account', 'mcp_initialize_meta', 'mcp_get_credits', 'userinfo', 'token_claims'],
  protocolVersion: '2025-11-25',
  timeoutMs: 15000,
};

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const subject = raw.id ?? raw.sub ?? raw.user_id;
  if ((typeof subject !== 'string' && typeof subject !== 'number') || !String(subject).trim() || String(subject).length > 200) return null;
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null);
  return { subject: String(subject).trim(), email: text(raw.email), name: text(raw.label ?? raw.name ?? raw.display_name ?? raw.handle) };
}

async function readRpc(response) {
  const type = response.headers.get('content-type') || '';
  const text = await response.text();
  if (type.includes('text/event-stream')) {
    const events = text.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
    for (const data of events.reverse()) { try { const parsed = JSON.parse(data); if (parsed?.jsonrpc) return parsed; } catch { /* ignora */ } }
    return null;
  }
  try { return JSON.parse(text); } catch { return null; }
}

class McpSession {
  constructor(token) { this.token = token; this.session = ''; this.id = 0; this.initialized = null; }
  async post(body) {
    const headers = { Authorization: 'Bearer ' + this.token, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': sunoIdentity.protocolVersion };
    if (this.session) headers['Mcp-Session-Id'] = this.session;
    const response = await fetch(sunoIdentity.mcpUrl, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.timeout(sunoIdentity.timeoutMs) });
    return response;
  }
  async initialize() {
    if (this.initialized) return this.initialized;
    const response = await this.post({ jsonrpc: '2.0', id: ++this.id, method: 'initialize', params: {
      protocolVersion: sunoIdentity.protocolVersion, capabilities: {}, clientInfo: { name: 'pia-server', version: '0.1.0' } } });
    if (!response.ok) { await response.body?.cancel(); throw new Error('initialize ' + response.status); }
    this.session = response.headers.get('mcp-session-id') || '';
    const message = await readRpc(response);
    this.initialized = message?.result || {};
    const note = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await note.body?.cancel();
    return this.initialized;
  }
  async tool(name) {
    await this.initialize();
    const response = await this.post({ jsonrpc: '2.0', id: ++this.id, method: 'tools/call', params: { name, arguments: {} } });
    if (!response.ok) { await response.body?.cancel(); throw new Error('tools/call ' + response.status); }
    const result = (await readRpc(response))?.result;
    if (!result || result.isError) throw new Error('tools/call isError');
    if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
    const text = result.content?.find((part) => part?.type === 'text')?.text;
    return text ? JSON.parse(text) : {};
  }
  async close() {
    if (!this.session) return;
    try {
      const response = await fetch(sunoIdentity.mcpUrl, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: 'Bearer ' + this.token, 'Mcp-Session-Id': this.session } });
      await response.body?.cancel();
    } catch { /* sessão expira sozinha */ }
  }
}

function jwtClaims(token) {
  const part = typeof token === 'string' ? token.split('.')[1] : '';
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
}

const readers = {
  mcp_get_account: async (ctx) => normalize((await ctx.mcp().tool('get_account'))?.account),
  mcp_initialize_meta: async (ctx) => normalize((await ctx.mcp().initialize())?._meta?.['suno/account']),
  mcp_get_credits: async (ctx) => normalize((await ctx.mcp().tool('get_credits'))?.account),
  userinfo: async (ctx) => {
    if (!sunoIdentity.userinfoUrl) return null;
    const response = await fetch(sunoIdentity.userinfoUrl, { headers: { Authorization: 'Bearer ' + ctx.token, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(sunoIdentity.timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); return null; }
    return normalize(await response.json());
  },
  token_claims: async (ctx) => normalize(jwtClaims(ctx.token)),
};

export async function resolveSunoIdentity(accessToken, { sources = sunoIdentity.sources } = {}) {
  let session;
  const ctx = { token: accessToken, mcp: () => (session ||= new McpSession(accessToken)) };
  try {
    for (const source of sources) {
      const reader = readers[source];
      if (!reader) continue;
      try {
        const identity = await reader(ctx);
        if (identity) return { ...identity, source };
      } catch { /* tenta a próxima fonte */ }
    }
  } finally { await session?.close(); }
  throw new SunoError('suno_identity_unavailable', sunoMessages.identity, 502);
}
