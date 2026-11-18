import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';

process.env.PIA_ENCRYPTION_KEY ||= '22'.repeat(32);
process.env.PIA_ADMIN_EMAIL ||= 'admin@example.invalid';
const { migrate, pool } = await import('../src/db.js');
const auth = await import('../src/suno_auth.js');
const mcpLib = await import('../src/suno_mcp.js');
const client = await import('../src/suno_client.js');
const { resolveSunoIdentity, sunoIdentity } = await import('../src/suno_identity.js');
const { publicError } = await import('../src/suno_errors.js');
const { startFakeSunoMcp } = await import('./fixtures/fake_suno_mcp.js');
const { startFakeSunoOAuth } = await import('./fixtures/fake_suno_oauth.js');
const { createMemorySunoStore } = await import('./fixtures/memory_suno_store.js');
const { lockSunoTables } = await import('./fixtures/pg_suno_lock.js');

const { SunoMcpClient, sunoMcp, discoverSunoTools, mapGenerationArguments, generateOnce, redactSuno } = mcpLib;
const defaults = { ...sunoMcp };
const originalOAuth = { ...auth.sunoOAuth };
const originalSources = [...sunoIdentity.sources];

// Captura o console: nenhum token, assinatura ou bearer pode aparecer.
const logged = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const previous = console[level];
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); if (process.env.SUNO_TEST_VERBOSE) previous(...args); };
}

const expectCode = async (promise, code, check) => {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.stack);
    check?.(error);
    return true;
  });
};
const methods = (fake) => fake.rpcMethods();
// Tempo fake do polling: o sleep injetado anota o intervalo pedido e cede só um
// tick (respeitando o signal), então o backoff de 5 a 60 s roda instantâneo.
const sleeps = [];
const fakeSleep = (ms, signal) => new Promise((resolve, reject) => {
  sleeps.push(ms);
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, 1);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
const fast = () => { sleeps.length = 0; Object.assign(sunoMcp, { sleep: fakeSleep, requestTimeoutMs: 2000 }); };

afterEach(() => { Object.assign(sunoMcp, defaults); });

// ---------------------------------------------------------------------------
// Cliente puro contra o fake base (requireSession: true), em JSON e SSE.

for (const responseMode of ['json', 'sse']) {
  describe('SunoMcpClient with the base fake (' + responseMode + ')', () => {
    let fake;
    before(async () => { fake = await startFakeSunoMcp({ requireSession: true, responseMode, timeoutDelayMs: 800 }); });
    beforeEach(() => { fake.resetRecordings(); fake.setScenarios(['success']); fast(); });
    after(async () => { await fake.close(); });
    const open = (options = {}) => new SunoMcpClient({ token: fake.token, url: fake.url, ...options });

    test('initialize sends Mcp-Session-Id, notifications/initialized and lists tools', async () => {
      const mcp = open();
      const server = await mcp.initialize();
      assert.equal(server.serverInfo.name, 'fake-suno-mcp');
      const tools = await mcp.listTools();
      assert.deepEqual(tools.map((tool) => tool.name), ['generate_music', 'get_account', 'get_credits']);
      await mcp.close();
      assert.deepEqual(methods(fake).slice(0, 3), ['initialize', 'notifications/initialized', 'tools/list']);
      const list = fake.requests.find((req) => req.jsonrpcMethod === 'tools/list');
      assert.ok(list.headers['mcp-session-id'], 'tools/list leva a sessão');
      assert.equal(list.headers['mcp-protocol-version'], '2025-11-25');
      assert.ok(fake.requests.some((req) => req.method === 'DELETE'), 'close encerra a sessão');
    });

    test('discovery picks generation, account and credits tools; no status tool in the base fake', async () => {
      const mcp = open();
      const found = discoverSunoTools(await mcp.listTools());
      assert.equal(found.generation.name, 'generate_music');
      assert.equal(found.account.name, 'get_account');
      assert.equal(found.credits.name, 'get_credits');
      assert.equal(found.status, null);
      await mcp.close();
    });

    test('success: one tools/call with mapped arguments returns 2 ready clips', async () => {
      const mcp = open();
      const result = await generateOnce(mcp, { prompt: '  lofi chuva ', lyrics: 'la la', duration: 30.4 });
      await mcp.close();
      assert.equal(result.tool, 'generate_music');
      assert.equal(result.clips.length, 2);
      for (const clip of result.clips) {
        assert.equal(clip.state, 'ready');
        assert.match(clip.id, /^clip-/);
        assert.match(clip.audio_url, /^http:\/\/127\.0\.0\.1/);
      }
      const [call] = fake.generationCalls();
      assert.equal(fake.generationCalls().length, 1);
      assert.deepEqual(call.toolArguments ?? call.payload?.params?.arguments ?? JSON.parse(call.body).params.arguments,
        { prompt: 'lofi chuva', lyrics: 'la la', instrumental: false, duration: 30 });
    });

    test('instrumental when there are no lyrics; odd_extra still yields 2 ready clips', async () => {
      fake.setScenarios(['odd_extra']);
      const mcp = open();
      const result = await generateOnce(mcp, { prompt: 'jazz' });
      await mcp.close();
      assert.deepEqual(result.clips.map((clip) => clip.state), ['ready', 'ready']);
      const body = JSON.parse(fake.generationCalls()[0].body);
      assert.equal(body.params.arguments.instrumental, true);
      assert.ok(!('lyrics' in body.params.arguments));
    });

    test('partial: the failed clip comes back as failed without audio', async () => {
      fake.setScenarios(['partial']);
      const mcp = open();
      const result = await generateOnce(mcp, { prompt: 'rock' });
      await mcp.close();
      assert.deepEqual(result.clips.map((clip) => clip.state), ['ready', 'failed']);
      assert.equal(result.clips[1].audio_url, null);
    });

    test('timeout: suno_timeout from AbortSignal and the paid call is never repeated', async () => {
      fake.setScenarios(['timeout']);
      const mcp = open();
      await mcp.listTools();
      sunoMcp.requestTimeoutMs = 150; // timeout de UMA requisição (o tools/call inicial)
      await expectCode(generateOnce(mcp, { prompt: 'x' }), 'suno_timeout', (error) => {
        assert.deepEqual(publicError(error), { status: 502, body: { error: error.message, code: 'suno_timeout' } });
      });
      await mcp.close();
      assert.equal(fake.generationCalls().length, 1);
    });

    for (const [scenario, code, upstream] of [['401', 'suno_credential_expired', 401], ['402', 'suno_no_credits', 402],
      ['503', 'suno_unavailable', 503], ['500', 'suno_unavailable', 500]]) {
      test('scenario ' + scenario + ' maps to ' + code, async () => {
        fake.setScenarios([scenario]);
        const mcp = open();
        await expectCode(generateOnce(mcp, { prompt: 'x' }), code, (error) => {
          assert.equal(error.upstreamStatus, upstream);
          assert.ok(!/Suno unavailable|Unauthorized|Insufficient/.test(error.message), 'texto do Suno não vaza');
        });
        await mcp.close();
        assert.equal(fake.generationCalls().length, 1, 'sem retry automático');
      });
    }

    test('expired session: reinitializes once and repeats the request', async () => {
      const mcp = open();
      await mcp.listTools();
      fake.expireSessions();
      const result = await generateOnce(mcp, { prompt: 'x' });
      await mcp.close();
      assert.equal(result.clips.length, 2);
      assert.equal(methods(fake).filter((name) => name === 'initialize').length, 2);
      assert.equal(fake.generationCalls().filter((req) => req.status === 200).length, 1);
    });

    test('a 401 on initialize is a credential error; an unreachable host is suno_unavailable', async () => {
      await expectCode(new SunoMcpClient({ token: 'wrong-token', url: fake.url }).listTools(), 'suno_credential_expired');
      const dead = createServer();
      await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' + dead.address().port + '/mcp';
      await new Promise((resolve) => dead.close(resolve));
      await expectCode(new SunoMcpClient({ token: 't', url }).listTools(), 'suno_unavailable', (error) => assert.equal(error.detail, 'network'));
    });

    test('refuses before any paid call when the schema has no prompt field or misses a required field', async () => {
      const tool = { name: 'generate_music', inputSchema: { type: 'object', properties: { prompt: {}, model: {} }, required: ['prompt', 'model'] } };
      assert.throws(() => mapGenerationArguments(tool, { prompt: 'x' }), { code: 'suno_unavailable' });
      assert.throws(() => mapGenerationArguments({ name: 'g', inputSchema: { properties: { foo: {} } } }, { prompt: 'x' }), { code: 'suno_unavailable' });
      const mcp = open();
      await expectCode(generateOnce(mcp, { prompt: 'x', tools: [tool] }), 'suno_unavailable');
      await expectCode(generateOnce(mcp, { prompt: 'x', tools: [{ name: 'get_credits' }] }), 'suno_unavailable');
      await mcp.close();
      assert.equal(fake.generationCalls().length, 0);
    });

    test('an aborted signal cancels before the paid call', async () => {
      const controller = new AbortController();
      const mcp = open({ signal: controller.signal });
      const tools = await mcp.listTools();
      controller.abort();
      await expectCode(generateOnce(mcp, { prompt: 'x', tools, signal: controller.signal }), 'suno_cancelled');
      await mcp.close();
      assert.equal(fake.generationCalls().length, 0);
    });
  });
}

describe('redact and leaky fake', () => {
  let fake;
  before(async () => { fake = await startFakeSunoMcp({ requireSession: true, leaky: true }); });
  after(async () => { await fake.close(); });

  test('errors from a leaky Suno never carry the bearer; redactSuno strips signed URLs', async () => {
    for (const scenario of ['401', '503']) {
      fake.setScenarios([scenario]);
      const mcp = new SunoMcpClient({ token: fake.token, url: fake.url });
      await assert.rejects(generateOnce(mcp, { prompt: 'x' }), (error) => {
        const text = JSON.stringify({ message: error.message, ...error }) + error.stack;
        assert.ok(!text.includes(fake.token), 'sem bearer no erro');
        return true;
      });
      await mcp.close();
    }
    fake.setScenarios(['success']);
    const mcp = new SunoMcpClient({ token: fake.token, url: fake.url });
    const { clips } = await generateOnce(mcp, { prompt: 'x' });
    await mcp.close();
    assert.match(clips[0].audio_url, /X-Amz-Signature/);
    const red = redactSuno('falhou ' + clips[0].audio_url + ' Authorization: Bearer ' + fake.token + ' token=pia-redact-marker sig=1', [fake.token]);
    // Marcador fixo: um trecho curto ('abc') podia aparecer no id aleatório clip-<hex> e quebrar o teste.
    assert.ok(!red.includes(fake.token) && !red.includes('fake-suno-signature') && !red.includes('pia-redact-marker'));
    assert.match(red, /\[redacted\]/);
    assert.ok(!logged.some((line) => line.includes(fake.token) || line.includes('fake-suno-signature')));
  });
});

// ---------------------------------------------------------------------------
// Stub inline (o fake base não tem tool de status): polling, paginação, SSE com
// notificações intercaladas, isError e identidade via account-me.

function startStub(handler) {
  const state = { calls: [], session: 'stub-session' };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'DELETE') return res.writeHead(204).end();
    const message = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    state.calls.push(message);
    if (message.method === 'notifications/initialized') return res.writeHead(202).end();
    const send = (body, status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body }));
    };
    if (message.method === 'initialize')
      return send({ result: { protocolVersion: '2025-11-25', serverInfo: { name: 'stub', version: '1' }, _meta: state.meta || {} } }, 200, { 'Mcp-Session-Id': state.session });
    return handler(message, send, res, state);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port + '/mcp', state,
    toolCalls: (name) => state.calls.filter((call) => call.method === 'tools/call' && call.params.name === name),
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  })));
}

const text = (data) => ({ result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
const GEN = { name: 'create_song', inputSchema: { type: 'object', properties: { gpt_description_prompt: { type: 'string' }, make_instrumental: { type: 'boolean' } }, required: ['gpt_description_prompt'] } };
const STATUS = { name: 'get_clip', inputSchema: { type: 'object', properties: { clip_id: { type: 'string' } }, required: ['clip_id'] } };
const BATCH = { name: 'get_clips', inputSchema: { type: 'object', properties: { ids: { type: 'array' } }, required: ['ids'] } };

describe('polling and discovery with an inline stub', () => {
  beforeEach(fast);

  test('pending clips are polled through the status tool until ready (one generation call)', async () => {
    let polls = 0;
    const stub = await startStub((message, send) => {
      if (message.method === 'tools/list') return send({ result: { tools: [GEN, STATUS] } });
      if (message.params.name === 'create_song') return send(text([{ id: 'c1', status: 'queued' }, { id: 'c2', status: 'queued' }]));
      polls++;
      const id = message.params.arguments.clip_id;
      const ready = polls > 2;
      return send({ result: { structuredContent: { id, status: ready ? 'complete' : 'streaming', audio_url: ready ? 'https://cdn.test/' + id + '.mp3' : null, duration: 61.5 } } });
    });
    const mcp = new SunoMcpClient({ token: 't', url: stub.url });
    const result = await generateOnce(mcp, { prompt: 'samba' });
    await mcp.close();
    await stub.close();
    assert.deepEqual(result.clips.map((clip) => [clip.id, clip.state, clip.duration]), [['c1', 'ready', 61.5], ['c2', 'ready', 61.5]]);
    assert.equal(stub.toolCalls('create_song').length, 1);
    assert.deepEqual(stub.toolCalls('create_song')[0].params.arguments, { gpt_description_prompt: 'samba', make_instrumental: true });
  });

  test('transient polling failures (5xx, 429, 408) never end the generation: backoff 5 s → 60 s, then it completes (batch tool)', async () => {
    let polls = 0;
    const stub = await startStub((message, send) => {
      if (message.method === 'tools/list') return send({ result: { tools: [GEN, BATCH] } });
      if (message.params.name === 'create_song') return send(text({ clips: [{ id: 'a', status: 'complete', audio_url: 'https://cdn.test/a.mp3' }, { id: 'b', status: 'queued' }] }));
      polls++;
      if (polls <= 3) return send({}, 503); // 5xx
      if (polls === 4) return send({ error: { code: -32000, message: 'Too many requests Bearer t' } }, 429); // rate limit
      if (polls === 5) return send({}, 408);
      if (polls <= 7) return send(text({ clips: [{ id: 'b', status: 'streaming' }] })); // sem progresso
      return send(text({ clips: [{ id: 'b', status: 'complete', audio_url: 'https://cdn.test/b.mp3' }] }));
    });
    const mcp = new SunoMcpClient({ token: 't', url: stub.url });
    const result = await generateOnce(mcp, { prompt: 'x' });
    assert.deepEqual(result.clips.map((clip) => [clip.id, clip.state]), [['a', 'ready'], ['b', 'ready']]);
    assert.deepEqual(stub.toolCalls('get_clips')[0].params.arguments, { ids: ['b'] });
    assert.equal(stub.toolCalls('get_clips').length, 8);
    assert.deepEqual(sleeps, [5000, 10000, 20000, 40000, 60000, 60000, 60000, 60000]);
    assert.equal(stub.toolCalls('create_song').length, 1);
    await mcp.close();
    await stub.close();
  });

  test('transient errors are classified as such; permanent ones are not', () => {
    const { transientSunoError, SunoMcpError } = mcpLib;
    const make = (code, detail, upstreamStatus) => new SunoMcpError(code, 'x', { detail, upstreamStatus });
    for (const error of [make('suno_unavailable', 'network'), make('suno_unavailable', 'http_5xx', 503), make('suno_unavailable', 'rate_limited', 429),
      make('suno_timeout', 'timeout'), make('suno_timeout', 'timeout', 408)]) assert.equal(transientSunoError(error), true, error.detail);
    for (const error of [make('suno_no_credits', null, 402), make('suno_unavailable', 'protocol'), make('suno_unavailable', 'http_4xx', 403),
      make('suno_unavailable', 'tool_error'), make('suno_credential_expired', null, 401), make('suno_cancelled', 'cancelled')])
      assert.equal(transientSunoError(error), false, error.code + ' ' + error.detail);
  });

  test('a request timeout while polling is transient; progress resets the backoff to 5 s', async () => {
    let polls = 0;
    const stub = await startStub((message, send) => {
      if (message.method === 'tools/list') return send({ result: { tools: [GEN, STATUS] } });
      if (message.params.name === 'create_song') return send(text([{ id: 'a', status: 'queued' }, { id: 'b', status: 'queued' }]));
      polls++;
      const id = message.params.arguments.clip_id;
      if (polls === 1) return; // nunca responde: estoura o requestTimeoutMs dessa requisição
      if (id === 'a') return send(text({ id, status: 'complete', audio_url: 'https://cdn.test/a.mp3' }));
      return send(text({ id, status: polls > 5 ? 'complete' : 'queued', audio_url: polls > 5 ? 'https://cdn.test/b.mp3' : null }));
    });
    const mcp = new SunoMcpClient({ token: 't', url: stub.url });
    const tools = await mcp.listTools();
    sunoMcp.requestTimeoutMs = 100;
    const result = await generateOnce(mcp, { prompt: 'x', tools });
    assert.deepEqual(result.clips.map((clip) => clip.state), ['ready', 'ready']);
    assert.equal(sleeps[0], 5000);
    assert.ok(sleeps.includes(5000, 1), 'progresso volta ao mínimo');
    assert.ok(sleeps.every((ms) => ms >= 5000 && ms <= 60000));
    await mcp.close();
    await stub.close();
  });

  test('polling ends only on terminal state, cancel or expired credential', async () => {
    const stub = await startStub((message, send) => {
      if (message.method === 'tools/list') return send({ result: { tools: [GEN, STATUS] } });
      if (message.params.name === 'create_song') return send(text([{ id: 'a', status: 'queued' }, { id: 'b', status: 'queued' }]));
      const id = message.params.arguments.clip_id;
      if (id === 'a') return send(text({ id, status: 'complete', audio_url: 'https://cdn.test/a.mp3' }));
      if (stub.state.mode === 'expired') return send({ error: { code: -32001, message: 'Unauthorized' } }, 401);
      return send(text({ id, status: stub.state.mode === 'fail' ? 'failed' : 'queued' }));
    });
    let mcp = new SunoMcpClient({ token: 't', url: stub.url });
    stub.state.mode = 'fail';
    const done = await generateOnce(mcp, { prompt: 'x' });
    assert.deepEqual(done.clips.map((clip) => clip.state), ['ready', 'failed']);
    stub.state.mode = 'expired';
    await expectCode(generateOnce(mcp, { prompt: 'x' }), 'suno_credential_expired', (error) => {
      assert.deepEqual(error.partial.map((clip) => clip.id), ['a']);
    });
    await mcp.close();
    stub.state.mode = 'queued';
    const controller = new AbortController();
    mcp = new SunoMcpClient({ token: 't', url: stub.url, signal: controller.signal });
    setTimeout(() => controller.abort(), 60);
    await expectCode(generateOnce(mcp, { prompt: 'x', signal: controller.signal }), 'suno_cancelled', (error) => {
      assert.deepEqual(error.partial.map((clip) => clip.id), ['a'], 'cancelar entrega as faixas prontas');
    });
    assert.ok(sleeps.length > 3, 'continua consultando, sem prazo total');
    assert.ok(!('generationTimeoutMs' in sunoMcp) && !('maxStatusFailures' in sunoMcp));
    await stub.close();
  });

  test('pending without a status tool becomes failed; tools/list is paginated; SSE skips notifications', async () => {
    const stub = await startStub((message, send, res) => {
      if (message.method === 'tools/list') {
        if (!message.params?.cursor) return send({ result: { tools: [GEN], nextCursor: 'p2' } });
        return send({ result: { tools: [{ name: 'account-me', inputSchema: { type: 'object', properties: {} } }] } });
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
      res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: message.id, ...text([{ id: 'q', status: 'queued' }]) }) + '\n\n');
    });
    const mcp = new SunoMcpClient({ token: 't', url: stub.url });
    const tools = await mcp.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ['create_song', 'account-me']);
    assert.equal(discoverSunoTools(tools).account.name, 'account-me');
    const result = await generateOnce(mcp, { prompt: 'x' });
    assert.deepEqual(result.clips.map((clip) => clip.state), ['failed']);
    await mcp.close();
    await stub.close();
  });

  test('isError results are classified by text without leaking it', async () => {
    const stub = await startStub((message, send) => {
      if (message.method === 'tools/list') return send({ result: { tools: [GEN] } });
      const reason = stub.state.reasons.shift();
      return send({ result: { isError: true, content: [{ type: 'text', text: reason + ' Bearer secret-xyz' }] } });
    });
    stub.state.reasons = ['Insufficient credits', 'Token expired', 'boom'];
    const mcp = new SunoMcpClient({ token: 't', url: stub.url });
    await expectCode(generateOnce(mcp, { prompt: 'x' }), 'suno_no_credits');
    await expectCode(generateOnce(mcp, { prompt: 'x' }), 'suno_credential_expired');
    await expectCode(generateOnce(mcp, { prompt: 'x' }), 'suno_unavailable', (error) => {
      assert.equal(error.detail, 'tool_error');
      assert.ok(!error.message.includes('secret-xyz'));
    });
    await mcp.close();
    await stub.close();
  });

  test('identity: account-me with an id is used; without an id falls back to initialize _meta', async () => {
    const stub = await startStub((message, send) => {
      if (message.method === 'tools/list') return send({ result: { tools: [{ name: 'account-me', inputSchema: { type: 'object', properties: {} } }] } });
      return send({ result: { structuredContent: stub.state.me } });
    });
    const previous = sunoIdentity.mcpUrl;
    sunoIdentity.mcpUrl = stub.url;
    try {
      stub.state.me = { user: { id: 'u-1', email: 'u@suno.test', display_name: 'Ana' } };
      assert.deepEqual(await resolveSunoIdentity('t', { sources: ['mcp_get_account'] }),
        { subject: 'u-1', email: 'u@suno.test', name: 'Ana', source: 'mcp_get_account' });
      stub.state.me = { avatar_url: 'x', display_name: 'Ana', handle: 'ana' };
      stub.state.meta = { 'suno/account': { id: 'u-2', label: 'Ana 2' } };
      const identity = await resolveSunoIdentity('t', { sources: ['mcp_get_account', 'mcp_initialize_meta'] });
      assert.equal(identity.subject, 'u-2');
      assert.equal(identity.source, 'mcp_initialize_meta');
    } finally { sunoIdentity.mcpUrl = previous; await stub.close(); }
  });
});

// ---------------------------------------------------------------------------
// Polling com o fake da T3c (cenário `pending` + tool de status). O fake não
// injeta erro HTTP na tool de status, então um proxy fino na frente dele troca
// só as consultas escolhidas por uma resposta de erro; o resto vai ao fake.

function startStatusProxy(target, statusName) {
  const state = { inject: null, injected: 0 };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    let message = null;
    try { message = JSON.parse(raw.toString() || 'null'); } catch { message = null; }
    if (message?.method === 'tools/call' && message.params?.name === statusName && state.inject) {
      const out = state.inject(message.params.arguments || {});
      if (out) {
        state.injected += 1;
        res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
        return res.end(typeof out.raw === 'string' ? out.raw : JSON.stringify({ jsonrpc: '2.0', id: message.id, ...out.body }));
      }
    }
    const headers = {};
    for (const name of ['authorization', 'content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version'])
      if (req.headers[name]) headers[name] = req.headers[name];
    const upstream = await fetch(target, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : raw });
    const out = {};
    for (const name of ['content-type', 'mcp-session-id']) if (upstream.headers.get(name)) out[name] = upstream.headers.get(name);
    res.writeHead(upstream.status, out);
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port + '/mcp', state,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  })));
}

describe('polling with the T3c fake (pending scenario + status tool)', () => {
  let fake, proxy;
  beforeEach(fast);
  afterEach(async () => { await proxy?.close(); await fake?.close(); proxy = null; fake = null; });
  const start = async (options) => {
    fake = await startFakeSunoMcp({ scenarios: 'pending', requireSession: true, ...options });
    proxy = await startStatusProxy(fake.url, fake.statusTool?.name ?? null);
    return new SunoMcpClient({ token: fake.token, url: proxy.url });
  };
  const ids = () => fake.clips().map((clip) => clip.id);

  test('pending clips poll until ready or failed; the failed one comes back without audio', async () => {
    const mcp = await start({ statusTool: 'get_clip', pendingPolls: 2, pendingFail: [2] });
    const { clips } = await generateOnce(mcp, { prompt: 'x' });
    assert.deepEqual(clips.map((clip) => clip.state), ['ready', 'failed']);
    assert.ok(clips[0].audio_url && !clips[1].audio_url);
    assert.equal(fake.generationCalls().length, 1, 'um único tools/call pago');
    assert.equal(fake.statusCalls().length, 6, '3 rodadas × 2 clips (K=2 pendentes + a final)');
    assert.deepEqual(sleeps, [5000, 10000, 20000]);
    await mcp.close();
  });

  test('permanent errors end the polling with the ready tracks: 402, credits, 4xx, protocol', async () => {
    const cases = [
      ['402', 'suno_no_credits', 400, () => ({ status: 402, body: { error: { code: 402, message: 'Insufficient credits' } } })],
      ['credits', 'suno_no_credits', 400, () => ({ body: { result: { isError: true, content: [{ type: 'text', text: 'Insufficient credits' }] } } })],
      ['400', 'suno_unavailable', 502, () => ({ status: 400, body: {} })],
      ['403', 'suno_unavailable', 502, () => ({ status: 403, body: {} })],
      ['rpc', 'suno_unavailable', 502, () => ({ body: { error: { code: -32603, message: 'boom Bearer t' } } })],
      ['garbage', 'suno_unavailable', 502, () => ({ raw: '{"jsonrpc":"2.0"' })],
      ['tool_error', 'suno_unavailable', 502, () => ({ body: { result: { isError: true, content: [{ type: 'text', text: 'boom' }] } } })],
    ];
    for (const [name, code, status, reply] of cases) {
      sleeps.length = 0;
      const mcp = await start({ statusTool: 'get_clip', pendingPolls: 0 });
      // 1ª rodada: o clip 1 vai ao fake e fica pronto; o clip 2 recebe o erro permanente.
      proxy.state.inject = (args) => (args.clip_id === ids()[1] ? reply() : null);
      await expectCode(generateOnce(mcp, { prompt: 'x' }), code, (error) => {
        assert.equal(error.status, status, name);
        assert.deepEqual(error.partial.map((clip) => [clip.id, clip.state]), [[ids()[0], 'ready']], name + ': prontas preservadas');
        assert.ok(error.partial[0].audio_url);
        assert.ok(!/Bearer|boom|Insufficient/.test(error.message), 'texto do Suno não vaza');
      });
      assert.equal(proxy.state.injected, 1, name + ': o polling para no erro');
      assert.deepEqual(sleeps, [5000], name + ': sem backoff');
      assert.equal(fake.generationCalls().length, 1);
      await mcp.close();
      await proxy.close(); await fake.close(); proxy = null; fake = null;
    }
  });

  test('429, 408 and 5xx back off and retry (batch tool); ready tracks are kept and a pending clip may end failed', async () => {
    const mcp = await start({ statusTool: 'get_clips', pendingPolls: 0, pendingFail: [2] });
    const replies = [{ status: 503, body: {} }, { status: 500, body: {} }, { status: 429, body: { error: { code: -32000, message: 'Too many requests' } } },
      { status: 408, body: {} }, { status: 502, body: {} }];
    proxy.state.inject = () => replies.shift() || null;
    const { clips } = await generateOnce(mcp, { prompt: 'x' });
    assert.deepEqual(clips.map((clip) => clip.state), ['ready', 'failed']);
    assert.equal(proxy.state.injected, 5);
    assert.equal(fake.statusCalls().length, 1, 'uma consulta em lote chegou ao fake');
    assert.deepEqual(sleeps, [5000, 10000, 20000, 40000, 60000, 60000]);
    await mcp.close();
  });

  test('a 401 while polling refreshes and retries; a repeated 401 is suno_credential_expired with the ready tracks', async () => {
    // Igual ao withSunoToken: um 401 renova o token e repete só aquela requisição; o segundo 401 expira.
    let refreshes = 0;
    const withToken = async (fn) => {
      const outcome = await fn(fake.token);
      if (outcome?.status !== 401) return outcome;
      refreshes += 1;
      const again = await fn(fake.token);
      if (again?.status === 401) throw new mcpLib.SunoMcpError('suno_credential_expired', 'expirou', { upstreamStatus: 401 });
      return again;
    };
    const unauthorized = { status: 401, body: { error: { code: -32001, message: 'Unauthorized' } } };
    await start({ statusTool: 'get_clip', pendingPolls: 0 });
    let mcp = new SunoMcpClient({ withToken, url: proxy.url });
    let once = true;
    proxy.state.inject = () => (once ? (once = false, unauthorized) : null);
    const ok = await generateOnce(mcp, { prompt: 'x' });
    assert.deepEqual(ok.clips.map((clip) => clip.state), ['ready', 'ready']);
    assert.equal(refreshes, 1);
    await mcp.close();
    sleeps.length = 0;
    mcp = new SunoMcpClient({ withToken, url: proxy.url });
    const first = fake.clips().length;
    proxy.state.inject = (args) => (args.clip_id === fake.clips()[first + 1]?.id ? unauthorized : null);
    await expectCode(generateOnce(mcp, { prompt: 'x' }), 'suno_credential_expired', (error) => {
      assert.deepEqual(error.partial.map((clip) => clip.id), [fake.clips()[first].id]);
    });
    assert.deepEqual(sleeps, [5000], 'credencial expirada não faz backoff');
    await mcp.close();
  });

  test('tool_error scenarios on the paid call map to unavailable, credits and expired without leaking the text', async () => {
    const mcp = await start({ scenarios: ['tool_error', 'tool_error_credits', 'tool_error_unauthorized'], leaky: true });
    await expectCode(generateOnce(mcp, { prompt: 'x' }), 'suno_unavailable', (error) => assert.equal(error.detail, 'tool_error'));
    await expectCode(generateOnce(mcp, { prompt: 'x' }), 'suno_no_credits');
    await expectCode(generateOnce(mcp, { prompt: 'x' }), 'suno_credential_expired', (error) => assert.ok(!error.message.includes(fake.token)));
    await mcp.close();
  });

  test('identity through account-me and every account envelope of the fake', async () => {
    const previous = sunoIdentity.mcpUrl;
    try {
      for (const [accountTool, accountEnvelope] of [['account-me', 'user'], ['get_account', 'profile'], ['account-me', 'none'], ['get_account', 'account']]) {
        const local = await startFakeSunoMcp({ accountTool, accountEnvelope, account: { id: 'suno-id-' + accountEnvelope, email: accountEnvelope + '@suno.test', label: 'Conta' } });
        sunoIdentity.mcpUrl = local.url;
        try {
          const identity = await resolveSunoIdentity(local.token, { sources: ['mcp_get_account'] });
          assert.equal(identity.subject, 'suno-id-' + accountEnvelope, accountTool + '/' + accountEnvelope);
          assert.equal(identity.email, accountEnvelope + '@suno.test');
          assert.equal(identity.source, 'mcp_get_account');
        } finally { await local.close(); }
      }
    } finally { sunoIdentity.mcpUrl = previous; }
  });
});

// ---------------------------------------------------------------------------
// Fachada por conta Suno (token da T2, refresh reativo, estados de credencial).

const modes = [{ name: 'memory store' }];
if (process.env.PIA_TEST_PG === '1') modes.push({ name: 'postgres store', pg: true });

for (const mode of modes) {
  describe('Suno MCP facade (' + mode.name + ')', () => {
    let oauth, fake, unlock;
    const pia = {};
    const SUNO_A = { id: 'suno-user-a', email: 'a@suno.test', label: 'Suno A' };

    async function connect(account, sunoAccount) {
      const started = await auth.sunoConnect(account);
      const { code, state } = oauth.authorize(started.url, { account: sunoAccount });
      const done = await auth.sunoCallback(new URLSearchParams({ code, state }));
      assert.equal(done.ok, true, JSON.stringify(done));
      return done.suno_account_id;
    }

    before(async () => {
      fake = await startFakeSunoMcp({ accounts: { 'unused-bearer': null }, requireSession: true, responseMode: 'sse' });
      oauth = await startFakeSunoOAuth({ onToken: (access, account) => fake.addAccount(access, account) });
      Object.assign(auth.sunoOAuth, { registerUrl: oauth.base + '/register', authorizeUrl: oauth.base + '/authorize', tokenUrl: oauth.base + '/token' });
      if (mode.pg) { unlock = await lockSunoTables(pool); await migrate(); auth.useSunoStore(auth.pgStore); }
    });

    beforeEach(async () => {
      sunoMcp.url = fake.url;
      fast();
      fake.resetRecordings();
      fake.setScenarios(['success']);
      oauth.config.expiresIn = 900;
      for (const key of Object.keys(oauth.calls)) oauth.calls[key] = 0;
      sunoIdentity.sources = [...originalSources];
      if (mode.pg) {
        await pool.query('DELETE FROM pia_server.suno_connect_attempts');
        await pool.query('DELETE FROM pia_server.suno_accounts');
        await pool.query('DELETE FROM pia_server.suno_oauth_clients');
        await pool.query("DELETE FROM pia_server.accounts WHERE email LIKE 'suno-mcp-test-%'");
        for (const name of ['a', 'b']) {
          const { rows: [{ id }] } = await pool.query('INSERT INTO pia_server.accounts(email) VALUES($1) RETURNING id', ['suno-mcp-test-' + name + '@example.invalid']);
          pia[name] = { id, admin: name === 'a' };
        }
      } else {
        auth.useSunoStore(createMemorySunoStore());
        pia.a = { id: 101, admin: true };
        pia.b = { id: 202, admin: false };
      }
    });

    after(async () => {
      await oauth.close();
      await fake.close();
      Object.assign(auth.sunoOAuth, originalOAuth);
      Object.assign(sunoMcp, defaults);
      auth.useSunoStore(null);
      await unlock?.();
    });

    test('sunoGenerate uses the stored token and returns ready clips', async () => {
      const id = await connect(pia.a, SUNO_A);
      const result = await client.sunoGenerate(pia.a, id, { prompt: 'forró', lyrics: 'ô ô' });
      assert.equal(result.clips.length, 2);
      assert.equal(fake.generationCalls().length, 1);
      assert.equal(fake.generationCalls()[0].accountId, 'suno-user-a');
    });

    test('a 401 from Suno refreshes once and repeats only the rejected request; a second 401 is suno_credential_expired', async () => {
      const id = await connect(pia.a, SUNO_A);
      fake.setScenarios(['401', 'success']);
      const result = await client.sunoGenerate(pia.a, id, { prompt: 'x' });
      assert.equal(result.clips.length, 2);
      assert.equal(oauth.calls.refresh, 1);
      assert.deepEqual(fake.generationCalls().map((req) => req.status), [401, 200]);
      fake.resetRecordings();
      fake.setScenarios(['401', '401']);
      await expectCode(client.sunoGenerate(pia.a, id, { prompt: 'x' }), 'suno_credential_expired', (error) => {
        assert.equal(error.upstreamStatus, undefined, 'não propaga upstreamStatus para outro retry');
      });
      assert.equal(fake.generationCalls().length, 2);
    });

    test('credential state unavailable refuses with suno_unavailable (never expired), refresh_failed with suno_credential_expired', async () => {
      oauth.config.expiresIn = 30; // dentro da margem de 60 s: exige refresh
      const id = await connect(pia.a, SUNO_A);
      oauth.failures.refresh.push(503);
      await expectCode(client.sunoGenerate(pia.a, id, { prompt: 'x' }), 'suno_unavailable');
      assert.equal(fake.generationCalls().length, 0);
      oauth.revokeRefresh();
      await expectCode(client.sunoGenerate(pia.a, id, { prompt: 'x' }), 'suno_credential_expired');
      await expectCode(client.sunoListTools(pia.a, id), 'suno_credential_expired');
      assert.equal(fake.generationCalls().length, 0);
    });

    test('another PIA account cannot use the Suno account', async () => {
      const id = await connect(pia.a, SUNO_A);
      await expectCode(client.sunoGenerate(pia.b, id, { prompt: 'x' }), 'suno_account_not_found');
      await expectCode(client.sunoSpike(pia.b, id), 'suno_account_not_found');
    });

    test('identity: account:null on the fake gives suno_identity_unavailable from the MCP sources', async () => {
      sunoIdentity.sources = ['mcp_get_account', 'mcp_initialize_meta', 'mcp_get_credits'];
      const started = await auth.sunoConnect(pia.a);
      const { code, state } = oauth.authorize(started.url, { account: null });
      const done = await auth.sunoCallback(new URLSearchParams({ code, state }));
      assert.equal(done.ok, false);
      assert.equal(done.code, 'suno_identity_unavailable');
    });

    test('admin spike lists tool names and schemas without tokens; credits through discovery', async () => {
      const id = await connect(pia.a, SUNO_A);
      const spike = await client.sunoAdminRoute(pia.a, '/api/admin/suno/spike', { suno_account_id: id });
      assert.deepEqual(spike.tools.map((tool) => tool.name), ['generate_music', 'get_account', 'get_credits']);
      assert.deepEqual(spike.discovery, { generation: 'generate_music', status: null, account: 'get_account', credits: 'get_credits' });
      assert.equal(spike.server_info.name, 'fake-suno-mcp');
      assert.deepEqual(spike.meta_keys, ['suno/account']);
      const serialized = JSON.stringify(spike);
      for (const issued of oauth.issued) assert.ok(!serialized.includes(issued.access_token) && !serialized.includes(issued.refresh_token));
      assert.equal(fake.generationCalls().length, 0, 'spike não gera música');
      assert.equal(await client.sunoAdminRoute(pia.b, '/api/admin/suno/spike', { suno_account_id: id }), undefined, 'só admin');
      await expectCode(client.sunoAdminRoute(pia.a, '/api/admin/suno/spike', {}), 'bad_request');
      assert.equal((await client.sunoCredits(pia.a, id)).credits, 42);
      assert.ok(!logged.some((line) => oauth.issued.some((issued) => line.includes(issued.access_token) || line.includes(issued.refresh_token))));
    });
  });
}

after(async () => { if (process.env.PIA_TEST_PG === '1') await pool.end(); });
