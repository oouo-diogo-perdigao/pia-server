import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { after, before, beforeEach, describe, mock, test } from 'node:test';

process.env.PIA_ENCRYPTION_KEY ||= '22'.repeat(32);
process.env.PIA_ADMIN_EMAIL ||= 'admin@example.invalid';
const { migrate, pool } = await import('../src/db.js');
const audio = await import('../src/suno_audio.js');
const jobs = await import('../src/suno_jobs.js');
const { SunoMcpClient, generateOnce } = await import('../src/suno_mcp.js');
const { startFakeSunoMcp, FAKE_AUDIO_BYTES } = await import('./fixtures/fake_suno_mcp.js');
const { createMemorySunoJobsStore } = await import('./fixtures/memory_suno_jobs_store.js');
const { lockSunoTables } = await import('./fixtures/pg_suno_lock.js');

const defaults = { ...audio.sunoAudio };
const logged = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const previous = console[level];
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); if (process.env.SUNO_TEST_VERBOSE) previous(...args); };
}

// Servidor de áudio próprio (Range, chunked sem Content-Length, redirects, 410, stream lento).
function startAudioServer() {
  const state = { closed: 0, requests: [], sent: 0 };
  const body = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const server = createServer((req, res) => {
    state.requests.push({ url: req.url, range: req.headers.range });
    req.on('close', () => { if (!res.writableFinished) state.closed += 1; });
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path === '/range.mp3') {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (!match) { res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': body.length, 'Accept-Ranges': 'bytes' }); return res.end(body); }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : body.length - 1;
      if (start >= body.length) { res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }); return res.end(); }
      res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Accept-Ranges': 'bytes' });
      return res.end(body.subarray(start, end + 1));
    }
    if (path === '/gone.mp3') { res.writeHead(410); return res.end('gone ?sig=leak'); }
    if (path.startsWith('/hop/')) {
      const left = Number(path.slice(5));
      res.writeHead(302, { Location: left > 0 ? `/hop/${left - 1}?token=t` : '/range.mp3' });
      return res.end();
    }
    if (path === '/to-private') { res.writeHead(302, { Location: 'http://10.0.0.7/x.mp3' }); return res.end(); }
    if (path === '/to-ftp') { res.writeHead(302, { Location: 'ftp://127.0.0.1/x.mp3' }); return res.end(); }
    if (path === '/chunked-big') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); // sem Content-Length
      const chunk = Buffer.alloc(16 * 1024, 7);
      let sent = 0;
      const pump = () => { while (sent < 400 * 1024) { sent += chunk.length; if (!res.write(chunk)) return res.once('drain', pump); } res.end(); };
      return pump();
    }
    if (path === '/stream' || path === '/huge') {
      // /stream: 20 MiB com Content-Length; /huge: 110 MiB em chunks de 64 KiB, sem Content-Length.
      const total = path === '/stream' ? 20 * 1024 * 1024 : 110 * 1024 * 1024;
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', ...(path === '/stream' ? { 'Content-Length': total } : {}) });
      const chunk = Buffer.alloc(64 * 1024, 3);
      let sent = 0;
      state.sent = 0;
      const pump = () => {
        while (sent < total && !res.destroyed) {
          sent += chunk.length;
          state.sent = sent;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        if (!res.destroyed) res.end();
      };
      return pump();
    }
    if (path === '/drip') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.write(Buffer.alloc(1024, 1));
      const timer = setInterval(() => { if (!res.destroyed) res.write(Buffer.alloc(1024, 1)); }, 20);
      return res.on('close', () => clearInterval(timer));
    }
    if (path === '/octet.bin') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 3 }); return res.end('abc'); }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    base: 'http://127.0.0.1:' + server.address().port, port: server.address().port, state, body,
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  })));
}

const modes = [{ name: 'memory store' }];
if (process.env.PIA_TEST_PG === '1') modes.push({ name: 'postgres store', pg: true });

for (const mode of modes) {
  describe('Suno track proxy (' + mode.name + ')', () => {
    let fake, upstream, server, base, unlock, memory, store;
    const devices = new Map();
    const pia = {};
    const seen = [];

    async function call(path, { device, headers = {} } = {}) {
      const response = await fetch(base + path, { headers: { ...(device ? { Authorization: 'Bearer ' + device } : {}), ...headers } });
      const buffer = Buffer.from(await response.arrayBuffer());
      const head = JSON.stringify([...response.headers]);
      seen.push(head, buffer.toString('latin1'));
      let json = null;
      try { json = JSON.parse(buffer.toString()); } catch { json = null; }
      return { status: response.status, headers: response.headers, buffer, json };
    }

    // Geração Suno da conta `who` com faixas apontando para `urls` (n = 1..).
    async function generation(who, urls) {
      const input = { id: randomUUID(), job_id: randomUUID(), account_id: pia[who].id, device_id: pia[who].device.device_id,
        suno_account_id: null, client_id: randomUUID(), prompt: 'p', lyrics: null, count: Math.max(1, Math.min(10, urls.length)),
        duration: null, instrumental: true, suno_account_name: null };
      const { job } = await store.create(input);
      await store.addTracks(job.generation_id || input.id, urls.map((url, index) => ({ n: index + 1, title: 't' + index, duration: 1, extra: false, audio_url: url })));
      await store.start(input.job_id);
      await store.finish(input.job_id, 'completed', null);
      return input.id;
    }
    async function localGeneration(who) {
      const id = randomUUID();
      if (!mode.pg) memory.insertLocal({ id, account_id: pia[who].id, client_id: randomUUID(), prompt: 'local', count: 1 });
      else {
        await pool.query(`INSERT INTO pia_server.music_generations(id,account_id,client_id,source,provider,prompt,state)
          VALUES($1,$2,$3,'local','local','local','completed')`, [id, pia[who].id, randomUUID()]);
        await pool.query('INSERT INTO pia_server.music_generation_tracks(generation_id,n,title) VALUES($1,1,$2)', [id, 'Local']);
      }
      return id;
    }
    async function fakeClips(behaviors) {
      fake.resetRecordings();
      const mcp = new SunoMcpClient({ token: fake.token, url: fake.url });
      const urls = [];
      for (let i = 0; i < Math.ceil(behaviors.length / 2); i++) {
        const { clips } = await generateOnce(mcp, { prompt: 'x' });
        for (const clip of clips) urls.push(clip);
      }
      await mcp.close();
      return behaviors.map((behavior, index) => { fake.setAudioBehavior(urls[index].id, behavior); return urls[index].audio_url; });
    }
    const path = (id, n) => `/device/music/generations/${id}/tracks/${n}/audio`;

    before(async () => {
      fake = await startFakeSunoMcp({ leaky: true, clipsPerCall: 2, timeoutDelayMs: 400 });
      upstream = await startAudioServer();
      if (mode.pg) { unlock = await lockSunoTables(pool); await migrate(); }
      server = createServer((req, res) => {
        const url = new URL(req.url, 'http://pia.test');
        audio.sunoAudioRoute(req, res, url, { authenticateDevice: async (header) => devices.get(/^Bearer (.+)$/.exec(header || '')?.[1]) || null })
          .then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = 'http://127.0.0.1:' + server.address().port;
    });

    beforeEach(async () => {
      Object.assign(audio.sunoAudio, defaults, { allowLoopbackForTests: true, headersTimeoutMs: 2000, idleTimeoutMs: 2000 });
      devices.clear();
      if (mode.pg) {
        await pool.query("DELETE FROM pia_server.accounts WHERE email LIKE 'suno-audio-test-%'");
        store = jobs.pgJobStore;
        audio.useSunoTrackStore(audio.pgTrackStore);
      } else {
        memory = createMemorySunoJobsStore(null);
        store = memory;
        audio.useSunoTrackStore(memory);
      }
      for (const name of ['a', 'b']) {
        let id = name === 'a' ? 101 : 202;
        const deviceIds = [randomUUID(), randomUUID()];
        if (mode.pg) {
          ({ rows: [{ id }] } = await pool.query('INSERT INTO pia_server.accounts(email) VALUES($1) RETURNING id', ['suno-audio-test-' + name + '@example.invalid']));
          for (const deviceId of deviceIds)
            await pool.query('INSERT INTO pia_server.devices(id,account_id,name,digest) VALUES($1,$2,$3,$4)', [deviceId, id, 'PC', randomUUID()]);
        }
        const token = randomBytes(32).toString('base64url');
        const other = randomBytes(32).toString('base64url');
        const device = { id, device_id: deviceIds[0] };
        devices.set(token, device);
        devices.set(other, { id, device_id: deviceIds[1] });
        pia[name] = { id, token, other, device };
      }
    });

    after(async () => {
      await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
      const audioBase = fake.audioBaseUrl;
      await fake.close();
      await upstream.close();
      Object.assign(audio.sunoAudio, defaults);
      audio.useSunoTrackStore(null);
      await unlock?.();
      for (const text of seen) {
        assert.ok(!text.includes(audioBase) && !text.includes(upstream.base), 'link do Suno não vaza para o device');
        assert.ok(!/fake-suno-signature|X-Amz|sig=|token=/.test(text), 'query do link não vaza');
      }
      assert.ok(!logged.some((line) => /https?:\/\/|sig=|token=|X-Amz/.test(line)), 'log sem link');
    });

    test('streams the track to the origin device and to another device of the same PIA account', async () => {
      const [url] = await fakeClips(['ok']);
      const id = await generation('a', [url]);
      for (const device of [pia.a.token, pia.a.other]) {
        const result = await call(path(id, 1), { device });
        assert.equal(result.status, 200);
        assert.equal(result.headers.get('content-type'), 'audio/mpeg');
        assert.equal(result.headers.get('content-length'), String(FAKE_AUDIO_BYTES.length));
        assert.equal(result.headers.get('cache-control'), 'no-store');
        assert.ok(result.buffer.equals(FAKE_AUDIO_BYTES));
      }
      assert.equal(fake.audioDownloads().length, 2);
    });

    test('404 for another PIA account, missing track, local generation and malformed ids; 401 when unpaired', async () => {
      const [url] = await fakeClips(['ok']);
      const id = await generation('a', [url]);
      const local = await localGeneration('a');
      const cases = [
        [path(id, 1), pia.b.token, 'music_generation_not_found'],
        [path(randomUUID(), 1), pia.a.token, 'music_generation_not_found'],
        [path('nope', 1), pia.a.token, 'music_generation_not_found'],
        [path(id, 2), pia.a.token, 'suno_track_not_found'],
        [path(id, 'x'), pia.a.token, 'suno_track_not_found'],
        [path(id, 0), pia.a.token, 'suno_track_not_found'],
        [path(local, 1), pia.a.token, 'suno_track_not_found'],
      ];
      for (const [target, device, code] of cases) {
        const result = await call(target, { device });
        assert.equal(result.status, 404, target);
        assert.equal(result.json.code, code, target);
      }
      const unpaired = await call(path(id, 1), { device: 'x'.repeat(43) });
      assert.deepEqual([unpaired.status, unpaired.json], [401, { error: 'Pareamento inválido.' }]);
      assert.equal(fake.audioDownloads().length, 0, 'nenhuma recusa toca o Suno');
    });

    test('upstream 403/404/410 → 410 suno_track_unavailable; 500 → 502 suno_unavailable; html → 502 download_failed', async () => {
      const urls = await fakeClips(['403', '404', '500', 'html']);
      const id = await generation('a', [...urls, upstream.base + '/gone.mp3']);
      const expect = [[1, 410, 'suno_track_unavailable'], [2, 410, 'suno_track_unavailable'], [3, 502, 'suno_unavailable'],
        [4, 502, 'download_failed'], [5, 410, 'suno_track_unavailable']];
      for (const [n, status, code] of expect) {
        const result = await call(path(id, n), { device: pia.a.token });
        assert.equal(result.status, status, 'faixa ' + n);
        assert.equal(result.json.code, code, 'faixa ' + n);
      }
      assert.equal((await call(path(id, 5), { device: pia.a.token })).json.error, 'Esta música não está mais disponível no Suno.');
    });

    test('slow upstream → 502 suno_timeout; truncated body aborts the response', async () => {
      const urls = await fakeClips([{ mode: 'slow', delayMs: 500 }, 'truncated']);
      const id = await generation('a', urls);
      audio.sunoAudio.headersTimeoutMs = 100;
      const slow = await call(path(id, 1), { device: pia.a.token });
      assert.deepEqual([slow.status, slow.json.code], [502, 'suno_timeout']);
      audio.sunoAudio.headersTimeoutMs = 2000;
      await assert.rejects(call(path(id, 2), { device: pia.a.token }), 'corpo truncado não termina como sucesso');
    });

    test('100 MiB limit: declared Content-Length is refused before streaming; counted bytes abort without it', async () => {
      const urls = await fakeClips([{ mode: 'large', size: 300 * 1024 }]);
      const id = await generation('a', [urls[0], upstream.base + '/chunked-big']);
      audio.sunoAudio.maxBytes = 100 * 1024; // limite reduzido no teste
      const declared = await call(path(id, 1), { device: pia.a.token });
      assert.deepEqual([declared.status, declared.json.code], [502, 'suno_track_too_large']);
      await assert.rejects(call(path(id, 2), { device: pia.a.token }), 'passa do limite no meio do stream e aborta');
      audio.sunoAudio.maxBytes = defaults.maxBytes;
      const full = await call(path(id, 2), { device: pia.a.token });
      assert.equal(full.status, 200);
      assert.equal(full.buffer.length, 400 * 1024);
    });

    test('redirects: up to 3 hops revalidated one by one; a 4th hop, a private target or another scheme is refused', async () => {
      const [fakeRedirect] = await fakeClips(['redirect']); // fake: 302 para http://example.invalid (não loopback)
      const id = await generation('a', [upstream.base + '/hop/2', upstream.base + '/hop/3', upstream.base + '/to-private',
        upstream.base + '/to-ftp', fakeRedirect]);
      const ok = await call(path(id, 1), { device: pia.a.token });
      assert.equal(ok.status, 200);
      assert.ok(ok.buffer.equals(upstream.body));
      for (const n of [2, 3, 4, 5]) {
        const result = await call(path(id, n), { device: pia.a.token });
        assert.deepEqual([result.status, result.json.code], [502, 'download_failed'], 'faixa ' + n);
      }
    });

    test('DNS: private, link-local and loopback answers are blocked; https only outside the test flag', async () => {
      const resolved = new Map([['cdn.suno.test', '127.0.0.1'], ['private.suno.test', '10.1.2.3'], ['link.suno.test', '169.254.169.254']]);
      audio.sunoAudio.lookup = (host, options, callback) => {
        const address = resolved.get(host);
        if (!address) return callback(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
        callback(null, [{ address, family: 4 }]);
      };
      const port = upstream.port;
      const id = await generation('a', [`http://cdn.suno.test:${port}/range.mp3`, `http://private.suno.test:${port}/range.mp3`,
        `https://link.suno.test:${port}/range.mp3`, 'http://10.0.0.9/x.mp3', `https://cdn.suno.test:${port}/range.mp3`,
        `http://user:pw@127.0.0.1:${port}/range.mp3`, `http://missing.suno.test:${port}/x.mp3`]);
      assert.equal((await call(path(id, 1), { device: pia.a.token })).status, 200, 'loopback via DNS só com a flag de teste');
      for (const n of [2, 3, 4, 6]) assert.equal((await call(path(id, n), { device: pia.a.token })).json.code, 'download_failed', 'faixa ' + n);
      assert.equal((await call(path(id, 7), { device: pia.a.token })).json.code, 'suno_unavailable');
      audio.sunoAudio.allowLoopbackForTests = false;
      for (const n of [1, 5]) assert.equal((await call(path(id, n), { device: pia.a.token })).json.code, 'download_failed', 'sem a flag: http e loopback recusados');
      assert.equal(audio.allowedAddress('8.8.8.8'), true);
      for (const address of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.1.1', '::1', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '0.0.0.0'])
        assert.equal(audio.allowedAddress(address), false, address);
    });

    test('Range: a simple range is forwarded and answered with 206 and Content-Range; octet-stream is accepted', async () => {
      const id = await generation('a', [upstream.base + '/range.mp3', upstream.base + '/octet.bin']);
      const part = await call(path(id, 1), { device: pia.a.token, headers: { Range: 'bytes=10-19' } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
      assert.equal(part.headers.get('content-length'), '10');
      assert.ok(part.buffer.equals(upstream.body.subarray(10, 20)));
      const ignored = await call(path(id, 1), { device: pia.a.token, headers: { Range: 'bytes=1-2,5-6' } });
      assert.equal(ignored.status, 200, 'multi-range é ignorado');
      assert.equal(upstream.state.requests.at(-1).range, undefined);
      const bad = await call(path(id, 1), { device: pia.a.token, headers: { Range: 'bytes=5000-' } });
      assert.deepEqual([bad.status, bad.json.code], [416, 'bad_request']);
      const octet = await call(path(id, 2), { device: pia.a.token });
      assert.deepEqual([octet.status, octet.buffer.toString()], [200, 'abc']);
    });

    // Lê o corpo chunk a chunk, só contando (o teste também não acumula o arquivo).
    async function drain(target) {
      const response = await fetch(base + target, { headers: { Authorization: 'Bearer ' + pia.a.token } });
      let bytes = 0;
      let failed = false;
      try { for await (const chunk of response.body) bytes += chunk.length; } catch { failed = true; }
      return { status: response.status, bytes, failed };
    }

    test('pure streaming: no file is created (fs spies, tmpdir and cwd unchanged) during a 20 MiB download', async () => {
      const id = await generation('a', [upstream.base + '/stream']);
      const listing = () => [fs.readdirSync(tmpdir()).sort().join('|'), fs.readdirSync(process.cwd()).sort().join('|')];
      const beforeFiles = listing();
      const spies = [
        mock.method(fs, 'createWriteStream'), mock.method(fs, 'writeFile'), mock.method(fs, 'writeFileSync'),
        mock.method(fs, 'open'), mock.method(fs, 'openSync'), mock.method(fs, 'appendFile'),
        mock.method(fs.promises, 'open'), mock.method(fs.promises, 'writeFile'), mock.method(fs.promises, 'appendFile'),
        mock.method(fs.promises, 'mkdtemp'), mock.method(fs, 'mkdtempSync'),
      ];
      let result;
      try { result = await drain(path(id, 1)); } finally { for (const spy of spies) spy.mock.restore(); }
      assert.deepEqual([result.status, result.bytes, result.failed], [200, 20 * 1024 * 1024, false]);
      assert.deepEqual(spies.map((spy) => spy.mock.callCount()), spies.map(() => 0), 'nenhuma chamada de escrita/abertura de arquivo');
      assert.deepEqual(listing(), beforeFiles, 'tmpdir e cwd sem arquivo novo');
    });

    test('more than 100 MiB without Content-Length: counted chunk by chunk, upstream aborted, memory does not grow with the size', async () => {
      const id = await generation('a', [upstream.base + '/huge']);
      const closed = upstream.state.closed;
      global.gc?.();
      const rss = process.memoryUsage().rss;
      let peak = rss;
      const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
      let result;
      try { result = await drain(path(id, 1)); } finally { clearInterval(sampler); }
      assert.equal(result.status, 200);
      assert.equal(result.failed, true, 'a resposta é encerrada no limite');
      assert.ok(result.bytes <= defaults.maxBytes, 'nunca repassa mais que 100 MiB: ' + result.bytes);
      assert.ok(result.bytes > defaults.maxBytes - 8 * 1024 * 1024, 'repassou em streaming até perto do limite: ' + result.bytes);
      for (let i = 0; i < 100 && upstream.state.closed === closed; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(upstream.state.closed, closed + 1, 'upstream abortado');
      assert.ok(upstream.state.sent < 110 * 1024 * 1024, 'o Suno não chegou a mandar tudo');
      assert.ok(peak - rss < 48 * 1024 * 1024, 'memória não cresce com o tamanho (pico +' + Math.round((peak - rss) / 1048576) + ' MiB)');
    });

    test('client disconnect aborts the upstream request', async () => {
      const id = await generation('a', [upstream.base + '/drip']);
      const before = upstream.state.closed;
      const controller = new AbortController();
      const response = await fetch(base + path(id, 1), { headers: { Authorization: 'Bearer ' + pia.a.token }, signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      await reader.read();
      controller.abort();
      for (let i = 0; i < 100 && upstream.state.closed === before; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(upstream.state.closed, before + 1, 'upstream encerrado');
    });
  });
}

after(async () => { if (process.env.PIA_TEST_PG === '1') await pool.end(); });
