import { SunoError } from './suno_errors.js';
import { SunoMcpClient, discoverSunoTools, generateOnce, sunoMcp } from './suno_mcp.js';
import { sunoAccountStatus, sunoCredentialRefusal, withSunoToken } from './suno_auth.js';

// Fachada do cliente MCP por conta Suno (T3b), para a T4 e a rota admin de spike.
// Os tokens saem do sunoAccessToken/withSunoToken da T2 e nunca deixam este módulo.

export function openSunoMcp(account, sunoAccountId, { signal, timeoutMs } = {}) {
  return new SunoMcpClient({ withToken: (call) => withSunoToken(account, sunoAccountId, call), signal, timeoutMs });
}

// Recusa antes de qualquer chamada: refresh_failed -> suno_credential_expired,
// unavailable -> suno_unavailable (nunca expired), conta de outra conta PIA -> 404.
export async function requireSunoAccount(account, sunoAccountId) {
  const status = await sunoAccountStatus(account, sunoAccountId);
  const code = sunoCredentialRefusal(status.credential_state);
  if (code === 'suno_credential_expired') throw new SunoError(code, 'A conexão com o Suno expirou. Conecte a conta de novo.', 400);
  if (code) throw new SunoError(code, 'O Suno não respondeu. Tente de novo em instantes.', 502);
  return status;
}

async function withClient(account, sunoAccountId, options, run) {
  await requireSunoAccount(account, sunoAccountId);
  const client = openSunoMcp(account, sunoAccountId, options);
  try { return await run(client); }
  finally { await client.close(); }
}

export function sunoListTools(account, sunoAccountId, options = {}) {
  return withClient(account, sunoAccountId, options, async (client) => {
    const tools = await client.listTools();
    return { tools, discovery: discoverSunoTools(tools) };
  });
}

// Uma geração (um tools/call de geração, com polling se vier pendente).
// Retorna { tool, clips: [{ id, title, state: 'ready'|'failed', audio_url, duration, mime }] }.
export function sunoGenerate(account, sunoAccountId, input = {}) {
  const { signal, deadline } = input;
  return withClient(account, sunoAccountId, { signal }, (client) => generateOnce(client, { ...input, signal, deadline }));
}

export function sunoCredits(account, sunoAccountId, options = {}) {
  return withClient(account, sunoAccountId, options, async (client) => {
    const { credits } = discoverSunoTools(await client.listTools());
    if (!credits) return null;
    return client.callTool(credits.name, {});
  });
}

// Spike T10 (grátis): initialize + tools/list de uma conta Suno conectada.
// Devolve só nomes, descrições e schemas; sem tokens e sem _meta da conta.
export async function sunoSpike(account, sunoAccountId) {
  return withClient(account, sunoAccountId, {}, async (client) => {
    const server = await client.initialize();
    const tools = await client.listTools();
    const discovery = discoverSunoTools(tools);
    return {
      protocol_version: typeof server.protocolVersion === 'string' ? server.protocolVersion : null,
      server_info: server.serverInfo && typeof server.serverInfo === 'object' ?
        { name: String(server.serverInfo.name || ''), version: String(server.serverInfo.version || '') } : null,
      meta_keys: server._meta && typeof server._meta === 'object' ? Object.keys(server._meta) : [],
      tools: tools.map((tool) => ({ name: tool.name, description: typeof tool.description === 'string' ? tool.description : '',
        inputSchema: tool.inputSchema ?? null, outputSchema: tool.outputSchema ?? null })),
      discovery: Object.fromEntries(Object.entries(discovery).map(([key, tool]) => [key, tool?.name ?? null])),
    };
  });
}

// Rota admin do spike no padrão de /api/admin/* (sessão web, admin, POST com
// Origin validado em index.js). O admin escolhe uma conta Suno da própria conta PIA.
export async function sunoAdminRoute(account, path, data) {
  if (path !== '/api/admin/suno/spike' || !account?.admin) return undefined;
  if (typeof data?.suno_account_id !== 'string') throw new SunoError('bad_request', 'Informe suno_account_id.');
  return sunoSpike(account, data.suno_account_id);
}

export { sunoMcp };
