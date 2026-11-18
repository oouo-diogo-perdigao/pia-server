import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CLIPS_PER_CALL,
  DEFAULT_REDIRECT_LOCATION,
  DEFAULT_TOKEN,
  FAKE_AUDIO_BYTES,
  clipsFromResult,
  generationCallsFor,
  loadSunoToolsList,
  splitRequestedAndExtra,
  startFakeSunoMcp,
  takeNClips,
} from './fixtures/fake_suno_mcp.js';

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
  assert.deepEqual(list.json.result.tools.map((tool) => tool.name), ['generate_music', 'get_credits']);
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
  assert.deepEqual(JSON.parse(credits.json.result.content[0].text), { credits: 7 });
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
