import { SunoError, sunoMessages } from './suno_errors.js';
import { SunoMcpClient, discoverSunoTools, sunoMcp } from './suno_mcp.js';

// Identidade estável da conta Suno (suno_subject), mais e-mail e nome para
// exibição. A fonte real só se confirma no spike (T10), então a leitura fica
// isolada aqui e tenta as fontes na ordem de `sunoIdentity.sources`:
//   mcp_get_account      tool de conta descoberta no tools/list (get_account,
//                        account-me, get_profile…) -> { account | user | profile }
//   mcp_initialize_meta  initialize -> result._meta['suno/account']
//   mcp_get_credits      tool de créditos descoberta (get_credits, account-usage…) -> { account }
//   userinfo             GET sunoIdentity.userinfoUrl (só se configurada)
//   token_claims         claims `sub`/`email`/`name` do access token JWT (recebido
//                        direto do token endpoint por TLS; sem verificar assinatura)
// Nenhum token ou corpo de resposta é logado.

export const sunoIdentity = {
  // mcpUrl e protocolVersion são os do cliente MCP (src/suno_mcp.js).
  get mcpUrl() { return sunoMcp.url; },
  set mcpUrl(value) { sunoMcp.url = value; },
  get protocolVersion() { return sunoMcp.protocolVersion; },
  set protocolVersion(value) { sunoMcp.protocolVersion = value; },
  userinfoUrl: null,
  sources: ['mcp_get_account', 'mcp_initialize_meta', 'mcp_get_credits', 'userinfo', 'token_claims'],
  timeoutMs: 15000,
};

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const subject = raw.id ?? raw.sub ?? raw.user_id;
  if ((typeof subject !== 'string' && typeof subject !== 'number') || !String(subject).trim() || String(subject).length > 200) return null;
  const text = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null);
  return { subject: String(subject).trim(), email: text(raw.email), name: text(raw.label ?? raw.name ?? raw.display_name ?? raw.handle) };
}

// A conta pode vir em { account }, { user }, { profile } ou no próprio objeto.
const accountOf = (data) => normalize(data?.account) || normalize(data?.user) || normalize(data?.profile) || normalize(data);

async function discovered(ctx, kind) {
  const client = ctx.mcp();
  const tool = discoverSunoTools(await client.listTools())[kind];
  if (!tool || (tool.inputSchema?.required || []).length) return null;
  return client.callTool(tool.name, {});
}

function jwtClaims(token) {
  const part = typeof token === 'string' ? token.split('.')[1] : '';
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; }
}

const readers = {
  mcp_get_account: async (ctx) => accountOf(await discovered(ctx, 'account')),
  mcp_initialize_meta: async (ctx) => normalize((await ctx.mcp().initialize())?._meta?.['suno/account']),
  mcp_get_credits: async (ctx) => normalize((await discovered(ctx, 'credits'))?.account),
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
  const ctx = { token: accessToken, mcp: () => (session ||= new SunoMcpClient({ token: accessToken, timeoutMs: sunoIdentity.timeoutMs })) };
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
