import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CLIPS_PER_CALL,
  DEFAULT_ACCOUNT,
  DEFAULT_REDIRECT_LOCATION,
  DEFAULT_TOKEN,
  FAKE_AUDIO_BYTES,
  FakeSunoMcp,
  TOOL_ERROR_TEXTS,
  clipsFromResult,
  generationCallsFor,
  loadSunoToolsList,
  normalizeStatusTool,
  splitRequestedAndExtra,
  startFakeSunoMcp,
  takeNClips,
} from './fixtures/fake_suno_mcp.js';
import { SunoMcpClient, generateOnce, sunoMcp } from '../src/suno_mcp.js';
import { resolveSunoIdentity, sunoIdentity } from '../src/suno_identity.js';

async function rpc(url, method, params = {}, { token = DEFAULT_TOKEN, id = 1, session, timeoutMs = 5000 } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers['Mcp-Session-Id'] = session;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: text ? JSON.parse(text) : null };
}

async function generate(suno, prompt = 'piano', options = {}) {
  const res = await rpc(suno.url, 'tools/call', { name: 'generate_music', arguments: { prompt } }, { id: 2, ...options });
  assert.equal(res.status, 200);
  return clipsFromResult(res.json.result);
}

async function download(url) {
  const res = await fetch(url, { redirect: 'manual' });
  return { status: res.status, type: res.headers.get('content-type'), body: Buffer.from(await res.arrayBuffer()) };
}

function rawSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(socket));
    socket.on('error', reject);
  });
}

test('initialize, notifications/initialized and tools/list follow the heuristic MCP contract', async () => {
  await using suno = await startFakeSunoMcp();
  assert.equal(suno.toolsListSource, 'plano-heuristico');
  assert.match(suno.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const init = await rpc(suno.url, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  assert.equal(init.status, 200);
  assert.equal(init.json.result.serverInfo.name, 'fake-suno-mcp');
  const session = init.headers.get('mcp-session-id');
  assert.match(session, /^[0-9a-f]{32}$/);
  const notified = await rpc(suno.url, 'notifications/initialized', {}, { session });
  assert.equal(notified.status, 202);
  const list = await rpc(suno.url, 'tools/list', {}, { session });
  assert.equal(list.headers.get('mcp-session-id'), null, 'session header only on initialize');
  assert.deepEqual(list.json.result.tools.map((tool) => tool.name), ['generate_music', 'get_account', 'get_credits']);
  assert.equal(suno.generationTool, 'generate_music');
  const again = await rpc(suno.url, 'initialize', {});
  assert.notEqual(again.headers.get('mcp-session-id'), session, 'new session per handshake');
  assert.deepEqual(suno.rpcMethods(), ['initialize', 'notifications/initialized', 'tools/list', 'initialize']);
});

test('success returns two clips whose audio is served by the fake itself on loopback', async () => {
  await using suno = await startFakeSunoMcp();
  const clips = await generate(suno, 'jazz');
  assert.equal(clips.length, CLIPS_PER_CALL);
  for (const clip of clips) {
    assert.equal(clip.status, 'complete');
    assert.ok(clip.audio_url.startsWith(`${suno.audioBaseUrl}/`));
    assert.equal(new URL(clip.audio_url).hostname, '127.0.0.1');
    assert.equal(clip._audioBehavior, undefined, 'internal keys stay private');
    const audio = await download(clip.audio_url);
    assert.equal(audio.status, 200);
    assert.equal(audio.type, 'audio/mpeg');
    assert.deepEqual(audio.body, FAKE_AUDIO_BYTES);
  }
  const [call] = suno.generationCalls();
  assert.deepEqual(call.toolArguments, { prompt: 'jazz' });
  assert.equal(call.json().params.name, 'generate_music');
  assert.deepEqual(suno.audioDownloads().map((req) => req.clipId), clips.map((clip) => clip.id));
});

test('odd_extra: N=3 needs ceil(3/2) calls and the extra clip of the last call is ready and downloadable', async () => {
  const requested = 3;
  await using suno = await startFakeSunoMcp({ scenarios: ['success', 'odd_extra'], requested });
  const batches = [];
  for (let i = 0; i < generationCallsFor(requested); i += 1) batches.push(await generate(suno, `jazz ${i}`));
  assert.equal(generationCallsFor(requested), 2);
  assert.deepEqual(batches.map((batch) => batch.length), [2, 2]);
  assert.ok(batches[1].every((clip) => clip.status === 'complete' && clip.audio_url));
  for (const clip of batches.flat()) assert.deepEqual((await download(clip.audio_url)).body, FAKE_AUDIO_BYTES);

  const extras = suno.extraClips();
  assert.deepEqual(extras.map((clip) => clip.id), [batches[1][1].id]);
  assert.equal(extras[0].call, 2);
  assert.ok(suno.audioDownloads().some((req) => req.clipId === extras[0].id && req.extra && req.status === 200));

  const split = splitRequestedAndExtra(batches, requested);
  assert.equal(split.completed, 3);
  assert.equal(split.total, 3);
  assert.equal(split.extra_ready, 1);
  assert.deepEqual(split.tracks.map((clip) => clip.extra), [false, false, false]);
  assert.equal(split.extras[0].id, batches[1][1].id);
  assert.equal(split.extras[0].extra, true);
  assert.deepEqual(takeNClips(batches, requested).map((clip) => clip.id), split.tracks.map((clip) => clip.id));
  assert.deepEqual(suno.generationCalls().map((req) => req.scenario), ['success', 'odd_extra']);
});

test('odd_extra without requested marks the last clip of that call as extra', async () => {
  await using suno = await startFakeSunoMcp({ scenario: 'odd_extra' });
  const clips = await generate(suno);
  assert.deepEqual(suno.clips().map((clip) => clip.extra), [false, true]);
  assert.equal(suno.extraClips()[0].id, clips[1].id);
});

test('partial returns a failed last clip without audio and stops the batch before the next scenario', async () => {
  await using suno = await startFakeSunoMcp({ scenarios: ['partial', '401'], requested: 3 });
  const clips = await generate(suno, 'parcial');
  assert.equal(clips.length, 2);
  assert.ok(clips[0].audio_url);
  assert.equal(clips[1].audio_url, null);
  assert.equal(clips[1].status, 'error');
  assert.equal(clips[1].error, 'sem áudio');
  assert.deepEqual((await download(clips[0].audio_url)).body, FAKE_AUDIO_BYTES);
  assert.equal((await download(suno.audioUrl(clips[1].id))).status, 404);
  assert.deepEqual(splitRequestedAndExtra([clips], 3), {
    tracks: [{ ...clips[0], extra: false }], extras: [], completed: 1, total: 3, extra_ready: 0,
  });
  assert.equal(suno.extraClips().length, 0);
  const second = await rpc(suno.url, 'tools/call', { name: 'generate_music', arguments: {} }, { id: 3 });
  assert.equal(second.status, 401);
});

test('error scenarios map to 401, 402, 503 and 500 with JSON-RPC errors', async () => {
  await using suno = await startFakeSunoMcp({ scenarios: ['401', '402', '503', '500', 'success'] });
  const call = (id) => rpc(suno.url, 'tools/call', { name: 'generate_music', arguments: { prompt: 'x' } }, { id });
  const unauthorized = await call(1);
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer');
  assert.deepEqual(unauthorized.json.error, { code: -32001, message: 'Unauthorized' });
  const credits = await call(2);
  assert.equal(credits.status, 402);
  assert.deepEqual(credits.json.error, { code: 402, message: 'Insufficient credits' });
  for (const [id, status] of [[3, 503], [4, 500]]) {
    const res = await call(id);
    assert.equal(res.status, status);
    assert.equal(res.json.id, id);
    assert.deepEqual(res.json.error, { code: -32000, message: 'Suno unavailable' });
  }
  assert.equal((await call(5)).status, 200);
  assert.equal((await call(6)).status, 200, 'the last scenario repeats');
  assert.deepEqual(suno.generationCalls().map((req) => req.status), [401, 402, 503, 500, 200, 200]);
  suno.setScenarios('503');
  assert.equal((await call(7)).status, 503);
});

test('wrong or missing bearer gets 401 on initialize and on RPCs, and token null disables auth', async () => {
  await using suno = await startFakeSunoMcp();
  const init = await rpc(suno.url, 'initialize', {}, { token: null });
  assert.equal(init.status, 401);
  assert.equal(init.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await rpc(suno.url, 'tools/list', {}, { token: 'wrong' })).status, 401);
  await using open = await startFakeSunoMcp({ token: null });
  assert.equal((await rpc(open.url, 'tools/list', {}, { token: null })).status, 200);
  await using lazy = await startFakeSunoMcp({ authOnInitialize: false });
  assert.equal((await rpc(lazy.url, 'initialize', {}, { token: null })).status, 200);
});

test('timeout delays the answer past a short client timeout and the fake keeps serving', async () => {
  await using suno = await startFakeSunoMcp({ scenarios: ['timeout', 'success'], timeoutDelayMs: 400 });
  await assert.rejects(
    rpc(suno.url, 'tools/call', { name: 'generate_music', arguments: {} }, { timeoutMs: 100 }),
    (error) => error.name === 'TimeoutError',
  );
  assert.equal(suno.generationCalls().length, 1, 'call recorded before the wait');
  assert.equal(suno.generationCalls()[0].scenario, 'timeout');
  await new Promise((resolve) => setTimeout(resolve, 500)); // the delayed write hits an aborted socket
  assert.equal((await generate(suno)).length, 2);

  suno.setScenarios('timeout');
  const slowOk = await rpc(suno.url, 'tools/call', { name: 'generate_music', arguments: {} }, { timeoutMs: 3000 });
  assert.equal(slowOk.status, 200, 'a patient client eventually gets clips');
  assert.equal(clipsFromResult(slowOk.json.result).length, 2);
});

test('close() cancels a pending timeout wait quickly', async () => {
  const suno = await startFakeSunoMcp({ scenario: 'timeout', timeoutDelayMs: 10_000 });
  const pending = rpc(suno.url, 'tools/call', { name: 'generate_music', arguments: {} }).catch((error) => error);
  while (!suno.generationCalls().length) await new Promise((resolve) => setTimeout(resolve, 10));
  const started = Date.now();
  await suno.close();
  assert.ok(Date.now() - started < 1000);
  assert.ok((await pending) instanceof Error);
});

test('connection resets (RST mid-request, mid-timeout and mid-stream) do not crash the fake', async () => {
  await using suno = await startFakeSunoMcp({ timeoutDelayMs: 200, audioBehavior: { mode: 'large', size: 32 * 1024 * 1024 } });
  const crashes = [];
  const onCrash = (error) => crashes.push(error);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  try {
    const halfBody = await rawSocket(suno.port);
    halfBody.write('POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"js');
    await new Promise((resolve) => setTimeout(resolve, 50));
    halfBody.resetAndDestroy();

    suno.setScenarios('timeout');
    const waiting = await rawSocket(suno.port);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'generate_music', arguments: {} } });
    waiting.write(`POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${DEFAULT_TOKEN}\r\n` +
      `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    while (!suno.generationCalls().length) await new Promise((resolve) => setTimeout(resolve, 10));
    waiting.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 300));

    suno.setScenarios('success');
    const [clip] = await generate(suno);
    const streaming = await rawSocket(suno.port);
    streaming.on('error', () => {});
    const firstBytes = new Promise((resolve) => streaming.once('data', resolve));
    streaming.write(`GET ${new URL(clip.audio_url).pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
    await firstBytes;
    streaming.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 200));

    const controller = new AbortController();
    const res = await fetch(clip.audio_url, { signal: controller.signal });
    const reader = res.body.getReader();
    await reader.read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const list = await rpc(suno.url, 'tools/list');
    assert.equal(list.status, 200, 'still serving after resets');
    assert.deepEqual(crashes, []);
    assert.ok(suno.connectionErrors.every((code) => typeof code === 'string'));
  } finally {
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  }
});

test('close() releases the port, is idempotent and drops keep-alive connections', async () => {
  const suno = await startFakeSunoMcp();
  const { port } = suno;
  await generate(suno); // leaves a keep-alive socket in the fetch pool
  await suno.close();
  await suno.close();
  await assert.rejects(rawSocket(port), (error) => error.code === 'ECONNREFUSED');
  assert.throws(() => suno.url, /não foi iniciado/);
});

test('requireSession demands the Mcp-Session-Id and supports expiry and DELETE for re-handshake', async () => {
  await using suno = await startFakeSunoMcp({ requireSession: true });
  const missing = await rpc(suno.url, 'tools/list');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json.error, { code: -32000, message: 'Session not found' });
  let session = (await rpc(suno.url, 'initialize')).headers.get('mcp-session-id');
  assert.equal((await rpc(suno.url, 'tools/list', {}, { session })).status, 200);
  suno.expireSessions();
  assert.equal((await rpc(suno.url, 'tools/call', { name: 'generate_music', arguments: {} }, { session })).status, 404);
  session = (await rpc(suno.url, 'initialize')).headers.get('mcp-session-id');
  assert.equal((await generate(suno, 'ok', { session })).length, 2);
  const deleted = await fetch(suno.url, { method: 'DELETE', headers: { 'Mcp-Session-Id': session } });
  assert.equal(deleted.status, 204);
  assert.equal((await rpc(suno.url, 'tools/list', {}, { session })).status, 404);
  assert.equal((await fetch(suno.url, { method: 'DELETE' })).status, 400);
});

test('requireSession false ignores expired sessions', async () => {
  await using suno = await startFakeSunoMcp();
  suno.expireSessions();
  assert.equal((await rpc(suno.url, 'tools/list', {}, { session: 'stale' })).status, 200);
});

test('audio behaviors: http errors, html, redirect without following, truncated, slow and large', async () => {
  await using suno = await startFakeSunoMcp({
    clipsPerCall: 6,
    timeoutDelayMs: 50,
    audioBehavior: ['403', 'html', 'redirect', 'truncated', { mode: 'slow', delayMs: 150 }, { mode: 'large', size: 300_000 }],
  });
  const [forbidden, html, redirect, truncated, slow, large] = await generate(suno);
  assert.equal((await download(forbidden.audio_url)).status, 403);
  const page = await download(html.audio_url);
  assert.equal(page.status, 200);
  assert.equal(page.type, 'text/html');
  const moved = await fetch(redirect.audio_url, { redirect: 'manual' });
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get('location'), DEFAULT_REDIRECT_LOCATION);
  await assert.rejects(download(truncated.audio_url));
  const started = Date.now();
  assert.deepEqual((await download(slow.audio_url)).body, FAKE_AUDIO_BYTES);
  assert.ok(Date.now() - started >= 140);
  const big = await download(large.audio_url);
  assert.equal(big.body.length, 300_000);
  suno.setAudioBehavior(forbidden.id, 500);
  assert.equal((await download(forbidden.audio_url)).status, 500);
  assert.throws(() => suno.setAudioBehavior('clip-unknown', 'ok'), /clip desconhecido/);
  assert.equal((await download(`${suno.audioBaseUrl}/clip-unknown.mp3`)).status, 404);
});

test('leaky signs audio urls and leaks the bearer in error messages (for redact tests)', async () => {
  await using suno = await startFakeSunoMcp({ leaky: true, scenarios: ['success', '503'] });
  const [clip] = await generate(suno);
  assert.match(clip.audio_url, /X-Amz-Signature=fake-suno-signature&token=suno-test-token$/);
  assert.deepEqual((await download(clip.audio_url)).body, FAKE_AUDIO_BYTES);
  const failed = await rpc(suno.url, 'tools/call', { name: 'generate_music', arguments: {} });
  assert.equal(failed.json.error.message, 'Suno unavailable: Bearer suno-test-token');
});

test('sse responseMode wraps JSON-RPC answers as text/event-stream', async () => {
  await using suno = await startFakeSunoMcp({ responseMode: 'sse', scenarios: ['success', '401'] });
  const res = await rpc(suno.url, 'tools/list').catch((error) => error);
  assert.ok(res instanceof SyntaxError, 'body is not plain JSON');
  const raw = await fetch(suno.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DEFAULT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'generate_music', arguments: {} } }),
  });
  assert.equal(raw.headers.get('content-type'), 'text/event-stream');
  const text = await raw.text();
  assert.match(text, /^event: message\ndata: /);
  const message = JSON.parse(text.split('\n').find((line) => line.startsWith('data: ')).slice(6));
  assert.equal(clipsFromResult(message.result).length, 2);
  const denied = await rpc(suno.url, 'tools/call', { name: 'generate_music', arguments: {} });
  assert.equal(denied.status, 401, 'http errors stay plain JSON');
});

test('get_credits, base64 audio, unknown tool, unknown method and malformed bodies', async () => {
  await using suno = await startFakeSunoMcp({ credits: 7, includeBase64: true, clipsPerCall: 1 });
  const credits = await rpc(suno.url, 'tools/call', { name: 'get_credits', arguments: {} });
  assert.deepEqual(JSON.parse(credits.json.result.content[0].text), { credits: 7, account: DEFAULT_ACCOUNT });
  const [clip] = await generate(suno);
  assert.deepEqual(Buffer.from(clip.audio_base64, 'base64'), FAKE_AUDIO_BYTES);
  assert.equal(clip.format, 'mp3');
  assert.equal(suno.generationCalls().length, 1, 'get_credits is not a generation');
  const unknownTool = await rpc(suno.url, 'tools/call', { name: 'delete_everything', arguments: {} });
  assert.equal(unknownTool.json.error.code, -32602);
  assert.equal((await rpc(suno.url, 'resources/list')).json.error.code, -32601);
  const bad = await fetch(suno.url, { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  const notObject = await fetch(suno.url, { method: 'POST', body: '[1]' });
  assert.equal((await notObject.json()).error.code, -32600);
  suno.resetRecordings();
  assert.deepEqual(suno.requests, []);
  assert.deepEqual(suno.clips(), []);
});

test('tools list fixture is preferred when present and unknown scenarios are rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fake-suno-'));
  try {
    const path = join(dir, 'tools.json');
    writeFileSync(path, JSON.stringify({ result: { tools: [{ name: 'suno_generate_custom_music', inputSchema: {} }] } }));
    assert.equal(loadSunoToolsList(path).source, 't2-fixture');
    writeFileSync(path, JSON.stringify({ tools: null }));
    assert.equal(loadSunoToolsList(path).source, 'plano-heuristico');
    await using suno = await startFakeSunoMcp({ toolsListPath: join(dir, 'missing.json'), tools: [{ name: 'create_song' }] });
    assert.equal(suno.toolsListSource, 'explicit');
    assert.equal(suno.generationTool, 'create_song');
    const res = await rpc(suno.url, 'tools/call', { name: 'create_song', arguments: { style: 'samba' } });
    assert.equal(clipsFromResult(res.json.result)[0].title, 'samba');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await assert.rejects(startFakeSunoMcp({ scenario: 'boom' }), /cenário desconhecido/);
});

async function accountOf(suno, token) {
  const res = await rpc(suno.url, 'tools/call', { name: 'get_account', arguments: {} }, { token });
  assert.equal(res.status, 200);
  return JSON.parse(res.json.result.content[0].text).account;
}

const ACCOUNT_A = { id: 'suno-sub-aaa', email: 'ana@suno.test', label: 'Ana' };
const ACCOUNT_B = { id: 'suno-sub-bbb', email: 'bia@suno.test', label: 'Bia' };

test('account identity is exposed in get_account, get_credits, initialize _meta and recorded per request', async () => {
  await using suno = await startFakeSunoMcp({ account: ACCOUNT_A });
  assert.deepEqual(await accountOf(suno), ACCOUNT_A);
  const credits = await rpc(suno.url, 'tools/call', { name: 'get_credits', arguments: {} });
  assert.deepEqual(JSON.parse(credits.json.result.content[0].text).account, ACCOUNT_A);
  const init = await rpc(suno.url, 'initialize');
  assert.deepEqual(init.json.result._meta['suno/account'], ACCOUNT_A);
  await generate(suno);
  assert.equal(suno.generationCalls()[0].accountId, ACCOUNT_A.id);
  assert.equal(suno.generationCalls().length, 1, 'identity lookups are not generations');
  await using defaults = await startFakeSunoMcp();
  assert.deepEqual(await accountOf(defaults), DEFAULT_ACCOUNT);
});

test('one instance serves two different Suno accounts by bearer, and setAccount swaps one at runtime', async () => {
  await using suno = await startFakeSunoMcp({ accounts: { 'tok-a': ACCOUNT_A, 'tok-b': ACCOUNT_B } });
  assert.equal(suno.token, 'tok-a');
  assert.deepEqual(await accountOf(suno, 'tok-a'), ACCOUNT_A);
  assert.deepEqual(await accountOf(suno, 'tok-b'), ACCOUNT_B);
  assert.equal((await rpc(suno.url, 'tools/list', {}, { token: DEFAULT_TOKEN })).status, 401);
  await generate(suno, 'a', { token: 'tok-a' });
  await generate(suno, 'b', { token: 'tok-b' });
  assert.deepEqual(suno.generationCalls().map((req) => req.accountId), [ACCOUNT_A.id, ACCOUNT_B.id]);
  suno.setAccount(ACCOUNT_B, 'tok-a');
  assert.deepEqual(await accountOf(suno, 'tok-a'), ACCOUNT_B);
  suno.addAccount('tok-c', null);
  assert.equal(await accountOf(suno, 'tok-c'), null, 'Suno without a stable identity');
  assert.deepEqual(suno.accountFor('tok-b'), ACCOUNT_B);
});

test('same Suno account behind two bearers simulates an account already linked to another PIA', async () => {
  await using suno = await startFakeSunoMcp({ accounts: { 'tok-pia-1': ACCOUNT_A, 'tok-pia-2': ACCOUNT_A } });
  const first = await accountOf(suno, 'tok-pia-1');
  const second = await accountOf(suno, 'tok-pia-2');
  assert.equal(first.id, second.id, 'stable id collides, so pia-server must answer suno_account_taken (RN08)');
});

test('two fake instances run in parallel, each with its own account, port and clips', async () => {
  const [a, b] = await Promise.all([
    startFakeSunoMcp({ account: ACCOUNT_A, scenario: 'success' }),
    startFakeSunoMcp({ account: ACCOUNT_B, scenario: '402' }),
  ]);
  try {
    assert.notEqual(a.port, b.port);
    const [accountA, accountB, clipsA, deniedB] = await Promise.all([
      accountOf(a),
      accountOf(b),
      generate(a),
      rpc(b.url, 'tools/call', { name: 'generate_music', arguments: {} }),
    ]);
    assert.deepEqual(accountA, ACCOUNT_A);
    assert.deepEqual(accountB, ACCOUNT_B);
    assert.equal(deniedB.status, 402);
    assert.equal((await download(clipsA[0].audio_url)).status, 200);
    assert.equal((await download(`${b.audioBaseUrl}/${clipsA[0].id}.mp3`)).status, 404, 'clips are per instance');
    await a.close();
    assert.deepEqual(await accountOf(b), ACCOUNT_B, 'closing one does not affect the other');
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});

test('with auth disabled the single account still comes back and setAccount changes it', async () => {
  await using suno = await startFakeSunoMcp({ token: null, account: ACCOUNT_B });
  assert.deepEqual(await accountOf(suno, null), ACCOUNT_B);
  suno.setAccount(null);
  assert.equal(await accountOf(suno, null), null);
});

// -- T3c: cenário pending + tool de status, tool de conta configurável, erros de tool ----

async function callTool(suno, name, args = {}) {
  const res = await rpc(suno.url, 'tools/call', { name, arguments: args }, { id: 7 });
  assert.equal(res.status, 200);
  return res.json.result;
}
const parsed = (result) => JSON.parse(result.content[0].text);

test('statusTool is opt-in: default tools/list is unchanged and get_clip/get_clips get the T3b schemas', async () => {
  await using plain = await startFakeSunoMcp();
  const names = (await rpc(plain.url, 'tools/list')).json.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['generate_music', 'get_account', 'get_credits']);
  await using single = await startFakeSunoMcp({ statusTool: 'get_clip' });
  const singleTools = (await rpc(single.url, 'tools/list')).json.result.tools;
  const getClip = singleTools.find((tool) => tool.name === 'get_clip');
  assert.deepEqual(getClip.inputSchema.required, ['clip_id']);
  assert.equal(getClip.inputSchema.properties.clip_id.type, 'string');
  await using batch = await startFakeSunoMcp({ statusTool: 'get_clips' });
  const getClips = (await rpc(batch.url, 'tools/list')).json.result.tools.find((tool) => tool.name === 'get_clips');
  assert.deepEqual(getClips.inputSchema.required, ['ids']);
  assert.equal(getClips.inputSchema.properties.ids.type, 'array');
  assert.deepEqual(normalizeStatusTool({ name: 'clip-get', idField: 'clip_ids' }), { name: 'clip-get', idField: 'clip_ids', batch: true });
  assert.throws(() => normalizeStatusTool(42), /statusTool/);
});

test('pending: clips stay pending for K polls per clip, then complete with downloadable loopback audio', async () => {
  await using suno = await startFakeSunoMcp({ scenario: 'pending', statusTool: 'get_clip', pendingPolls: 2 });
  const clips = await generate(suno);
  assert.equal(clips.length, 2);
  for (const clip of clips) { assert.equal(clip.status, 'pending'); assert.equal(clip.audio_url, null); }
  assert.equal((await download(suno.audioUrl(clips[0].id))).status, 404, 'no audio while pending');
  const [a, b] = clips.map((clip) => clip.id);
  assert.equal(parsed(await callTool(suno, 'get_clip', { clip_id: a })).status, 'pending');
  assert.equal(parsed(await callTool(suno, 'get_clip', { clip_id: a })).status, 'pending');
  const done = parsed(await callTool(suno, 'get_clip', { clip_id: a }));
  assert.equal(done.status, 'complete');
  assert.equal(done.audio_url, suno.audioUrl(a));
  assert.equal(parsed(await callTool(suno, 'get_clip', { clip_id: b })).status, 'pending', 'K is counted per clip');
  const audio = await download(done.audio_url);
  assert.equal(audio.status, 200);
  assert.deepEqual(audio.body, FAKE_AUDIO_BYTES);
  assert.equal(suno.statusCalls().length, 4);
  assert.equal(suno.generationCalls().length, 1, 'status polls are not generations');
  const missing = await callTool(suno, 'get_clip', { clip_id: 'clip-nope' });
  assert.equal(missing.isError, true);
});

test('pending: pendingFail by ordinal and by id, batch get_clips, and runtime failClip/setPendingPolls', async () => {
  await using suno = await startFakeSunoMcp({ scenario: 'pending', statusTool: 'get_clips', pendingPolls: 0, pendingFail: [2], clipsPerCall: 3 });
  const [c1, c2, c3] = (await generate(suno)).map((clip) => clip.id);
  const states = parsed(await callTool(suno, 'get_clips', { ids: [c1, c2, c3, 'clip-unknown'] })).clips;
  assert.deepEqual(states.map((clip) => [clip.id, clip.status]), [[c1, 'complete'], [c2, 'failed'], [c3, 'complete']]);
  assert.equal(states[1].audio_url, null);
  assert.ok(states[1].error);
  assert.equal(suno.extraClips().length, 0);

  suno.setPendingPolls(1);
  const [d1, d2, d3] = (await generate(suno)).map((clip) => clip.id);
  suno.setPendingFail([d3]);
  suno.failClip(d1);
  assert.deepEqual(parsed(await callTool(suno, 'get_clips', { ids: [d1, d2, d3] })).clips.map((clip) => clip.status), ['pending', 'pending', 'pending']);
  assert.deepEqual(parsed(await callTool(suno, 'get_clips', { ids: [d1, d2, d3] })).clips.map((clip) => clip.status), ['failed', 'complete', 'failed']);
  assert.throws(() => suno.failClip('clip-nope'), /desconhecido/);
  assert.throws(() => suno.setPendingPolls(-1), /pendingPolls/);
});

test('pending works end to end with the T3b client (generateOnce), single and batch status tools', async () => {
  const saved = { ...sunoMcp };
  Object.assign(sunoMcp, { sleep: async () => {}, requestTimeoutMs: 3000 });
  try {
    for (const statusTool of ['get_clip', 'get_clips']) {
      await using suno = await startFakeSunoMcp({ scenario: 'pending', statusTool, pendingPolls: 2, pendingFail: [2], requireSession: true });
      const client = new SunoMcpClient({ token: suno.token, url: suno.url });
      try {
        const out = await generateOnce(client, { prompt: 'piano' });
        assert.equal(out.tool, 'generate_music');
        assert.deepEqual(out.clips.map((clip) => clip.state), ['ready', 'failed'], statusTool);
        assert.equal(out.clips[0].audio_url, suno.audioUrl(out.clips[0].id));
        assert.equal(suno.statusCalls().length, statusTool === 'get_clip' ? 6 : 3);
      } finally { await client.close(); }
    }
  } finally { Object.assign(sunoMcp, saved); }
});

test('accountTool renames or removes the account tool and accountEnvelope shapes its answer', async () => {
  await using renamed = await startFakeSunoMcp({ account: ACCOUNT_A, accountTool: 'account-me', accountEnvelope: 'user' });
  const names = (await rpc(renamed.url, 'tools/list')).json.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['generate_music', 'account-me', 'get_credits']);
  assert.deepEqual(parsed(await callTool(renamed, 'account-me')), { user: ACCOUNT_A });
  const old = await rpc(renamed.url, 'tools/call', { name: 'get_account', arguments: {} });
  assert.equal(old.json.error.code, -32602, 'old name is gone');
  await using bare = await startFakeSunoMcp({ account: ACCOUNT_A, accountEnvelope: 'none' });
  assert.deepEqual(parsed(await callTool(bare, 'get_account')), ACCOUNT_A);
  await using profile = await startFakeSunoMcp({ account: ACCOUNT_A, accountEnvelope: 'profile' });
  assert.deepEqual(parsed(await callTool(profile, 'get_account')), { profile: ACCOUNT_A });
  await using none = await startFakeSunoMcp({ accountTool: null });
  assert.deepEqual((await rpc(none.url, 'tools/list')).json.result.tools.map((tool) => tool.name), ['generate_music', 'get_credits']);
  assert.throws(() => new FakeSunoMcp({ accountEnvelope: 'wrapped' }), /accountEnvelope/);
});

test('resolveSunoIdentity reads every accountTool/accountEnvelope variant from the fake', async () => {
  const savedUrl = sunoIdentity.mcpUrl;
  try {
    for (const [accountTool, accountEnvelope] of [['account-me', 'user'], ['get_account', 'none'], ['account_me', 'account']]) {
      await using suno = await startFakeSunoMcp({ account: ACCOUNT_A, accountTool, accountEnvelope });
      sunoIdentity.mcpUrl = suno.url;
      const identity = await resolveSunoIdentity(suno.token, { sources: ['mcp_get_account'] });
      assert.deepEqual(identity, { subject: ACCOUNT_A.id, email: ACCOUNT_A.email, name: ACCOUNT_A.label, source: 'mcp_get_account' });
    }
  } finally { sunoIdentity.mcpUrl = savedUrl; }
});

test('tool_error scenarios answer HTTP 200 with result.isError and texts the T3b client classifies', async () => {
  await using suno = await startFakeSunoMcp({ scenarios: ['tool_error', 'tool_error_credits', 'tool_error_unauthorized'] });
  for (const scenario of ['tool_error', 'tool_error_credits', 'tool_error_unauthorized']) {
    const res = await rpc(suno.url, 'tools/call', { name: 'generate_music', arguments: { prompt: 'x' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.error, undefined);
    assert.equal(res.json.result.isError, true);
    assert.equal(res.json.result.content[0].text, TOOL_ERROR_TEXTS[scenario]);
  }
  assert.deepEqual(suno.generationCalls().map((call) => call.scenario), ['tool_error', 'tool_error_credits', 'tool_error_unauthorized']);
  assert.equal(suno.clips().length, 0);

  const saved = { ...sunoMcp };
  Object.assign(sunoMcp, { requestTimeoutMs: 3000 });
  try {
    const expected = { tool_error: ['suno_unavailable', 'tool_error'], tool_error_credits: ['suno_no_credits'], tool_error_unauthorized: ['suno_credential_expired'] };
    for (const [scenario, [code, detail]] of Object.entries(expected)) {
      await using fake = await startFakeSunoMcp({ scenario, leaky: true });
      const client = new SunoMcpClient({ token: fake.token, url: fake.url });
      try {
        await assert.rejects(generateOnce(client, { prompt: 'piano' }), (error) => {
          assert.equal(error.code, code, scenario);
          if (detail) assert.equal(error.detail, detail);
          assert.ok(!String(error.message).includes(fake.token), 'bearer is redacted by the client');
          return true;
        });
      } finally { await client.close(); }
    }
  } finally { Object.assign(sunoMcp, saved); }
  await using custom = await startFakeSunoMcp({ scenario: 'tool_error', toolErrorTexts: { tool_error: 'boom' } });
  assert.equal((await callTool(custom, 'generate_music', { prompt: 'x' })).content[0].text, 'boom');
});
