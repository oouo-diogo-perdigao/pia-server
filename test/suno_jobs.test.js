import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

process.env.PIA_ENCRYPTION_KEY ||= '22'.repeat(32);
process.env.PIA_ADMIN_EMAIL ||= 'admin@example.invalid';
const { migrate, pool } = await import('../src/db.js');
const auth = await import('../src/suno_auth.js');
const { sunoMcp } = await import('../src/suno_mcp.js');
const jobs = await import('../src/suno_jobs.js');
const { sunoIdentity } = await import('../src/suno_identity.js');
const { startFakeSunoMcp } = await import('./fixtures/fake_suno_mcp.js');
const { startFakeSunoOAuth } = await import('./fixtures/fake_suno_oauth.js');
const { createMemorySunoStore } = await import('./fixtures/memory_suno_store.js');
const { createMemorySunoJobsStore } = await import('./fixtures/memory_suno_jobs_store.js');
const { lockSunoTables } = await import('./fixtures/pg_suno_lock.js');
const history = await import('../src/music_generations.js');

const mcpDefaults = { ...sunoMcp };
const originalOAuth = { ...auth.sunoOAuth };
const SUNO_A = { id: 'suno-user-a', email: 'a@suno.test', label: 'Suno A' };
const SUNO_B = { id: 'suno-user-b', email: 'b@suno.test', label: 'Suno B' };
const PROMPT = 'samba-enredo secreto do prompt';
const LYRICS = 'letra secreta da música';

const logged = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const previous = console[level];
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); if (process.env.SUNO_TEST_VERBOSE) previous(...args); };
}

// Stub MCP mínimo (geração com ordem de clips controlada e polling).
function startStub(handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'DELETE') return res.writeHead(204).end();
    const message = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (message.method === 'notifications/initialized') return res.writeHead(202).end();
    const send = (body, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body }));
    };
    if (message.method === 'initialize') return send({ result: { protocolVersion: '2025-11-25', serverInfo: { name: 'stub' } } });
    return handler(message, send);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port + '/mcp',
    close: () => new Promise((done) => { server.closeAllConnections(); server.close(done); }),
  })));
}
const text = (data) => ({ result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
const GEN = { name: 'generate_music', inputSchema: { type: 'object', properties: { prompt: {}, lyrics: {}, duration: { type: 'integer' } }, required: ['prompt'] } };
const STATUS = { name: 'get_clip', inputSchema: { type: 'object', properties: { clip_id: {} }, required: ['clip_id'] } };

const modes = [{ name: 'memory store' }];
if (process.env.PIA_TEST_PG === '1') modes.push({ name: 'postgres store', pg: true });

for (const mode of modes) {
  describe('Suno jobs (' + mode.name + ')', () => {
    let oauth, fake, server, base, unlock, sunoStore, jobStore;
    const devices = new Map();
    const pia = {};
    const responses = [];

    async function readJson(req) {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Envie JSON.');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const data = JSON.parse(Buffer.concat(chunks));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Objeto JSON obrigatório.');
      return data;
    }

    async function call(method, path, { device, body } = {}) {
      const headers = {};
      if (device) headers.Authorization = 'Bearer ' + device;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const raw = await response.text();
      responses.push(raw);
      let json = null;
      try { json = JSON.parse(raw); } catch { json = null; }
      return { status: response.status, json, text: raw };
    }

    async function connect(who, sunoAccount) {
      const started = await auth.sunoConnect(pia[who].device);
      const { code, state } = oauth.authorize(started.url, { account: sunoAccount });
      const done = await auth.sunoCallback(new URLSearchParams({ code, state }));
      assert.equal(done.ok, true, JSON.stringify(done));
      return done.suno_account_id;
    }

    const create = (who, body = {}) => call('POST', '/device/suno/jobs', { device: pia[who].token,
      body: { prompt: PROMPT, lyrics: LYRICS, duration: 30, count: 1, client_job_id: randomUUID(), ...body } });
    const getJob = (who, id) => call('GET', '/device/suno/jobs/' + id, { device: pia[who].token });
    async function finished(who, id) { await jobs.settleSunoJobs(); return (await getJob(who, id)).json; }

    async function storedTracks(generationId) {
      if (!mode.pg) return jobStore.tracks.get(generationId) || [];
      const { rows } = await pool.query('SELECT * FROM pia_server.music_generation_tracks WHERE generation_id=$1 ORDER BY n', [generationId]);
      return rows;
    }
    async function storedGeneration(generationId) {
      if (!mode.pg) return jobStore.generations.get(generationId) || null;
      const { rows: [row] } = await pool.query('SELECT * FROM pia_server.music_generations WHERE id=$1', [generationId]);
      return row || null;
    }

    before(async () => {
      fake = await startFakeSunoMcp({ accounts: { 'unused-bearer': null }, requireSession: true, leaky: true, timeoutDelayMs: 300 });
      oauth = await startFakeSunoOAuth({ onToken: (access, account) => fake.addAccount(access, account) });
      Object.assign(auth.sunoOAuth, { registerUrl: oauth.base + '/register', authorizeUrl: oauth.base + '/authorize', tokenUrl: oauth.base + '/token' });
      if (mode.pg) {
        unlock = await lockSunoTables(pool);
        await migrate();
      }
      server = createServer((req, res) => {
        const url = new URL(req.url, 'http://pia.test');
        const options = { authenticateDevice: async (header) => devices.get(/^Bearer (.+)$/.exec(header || '')?.[1]) || null, readBody: readJson };
        (async () => {
          if (await jobs.sunoJobsRoute(req, res, url, options)) return;
          if (await auth.sunoRoute(req, res, url, options)) return;
          res.writeHead(404); res.end();
        })();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = 'http://127.0.0.1:' + server.address().port;
    });

    beforeEach(async () => {
      await jobs.settleSunoJobs();
      Object.assign(sunoMcp, mcpDefaults, { url: fake.url, requestTimeoutMs: 3000, sleep: (ms, signal) => new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = setTimeout(resolve, 1); // tempo fake do backoff de 5 a 60 s
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      }) });
      sunoIdentity.mcpUrl = fake.url;
      fake.resetRecordings();
      fake.setScenarios(['success']);
      fake.timeoutDelayMs = 300;
      oauth.config.expiresIn = 900;
      devices.clear();
      if (mode.pg) {
        await pool.query("DELETE FROM pia_server.accounts WHERE email LIKE 'suno-jobs-test-%'");
        await pool.query("DELETE FROM pia_server.suno_accounts WHERE suno_subject LIKE 'suno-user-%'"); // identidades usadas aqui
        await pool.query('DELETE FROM pia_server.suno_oauth_clients');
        auth.useSunoStore(auth.pgStore);
        jobs.useSunoJobStore(jobs.pgJobStore);
      } else {
        sunoStore = createMemorySunoStore();
        jobStore = createMemorySunoJobsStore(sunoStore);
        auth.useSunoStore(sunoStore);
        jobs.useSunoJobStore(jobStore);
      }
      for (const name of ['a', 'b']) {
        let id = name === 'a' ? 101 : 202;
        const deviceIds = [randomUUID(), randomUUID()];
        if (mode.pg) {
          ({ rows: [{ id }] } = await pool.query('INSERT INTO pia_server.accounts(email) VALUES($1) RETURNING id', ['suno-jobs-test-' + name + '@example.invalid']));
          for (const deviceId of deviceIds)
            await pool.query('INSERT INTO pia_server.devices(id,account_id,name,digest) VALUES($1,$2,$3,$4)', [deviceId, id, 'PC', randomUUID()]);
        }
        const token = randomBytes(32).toString('base64url');
        const other = randomBytes(32).toString('base64url');
        const device = { id, device_id: deviceIds[0], email: 'suno-jobs-test-' + name + '@example.invalid' };
        devices.set(token, device);
        devices.set(other, { ...device, device_id: deviceIds[1] });
        pia[name] = { id, token, other, device };
      }
    });

    after(async () => {
      await jobs.settleSunoJobs();
      const audioBase = fake.audioBaseUrl;
      await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
      await oauth.close();
      await fake.close();
      Object.assign(auth.sunoOAuth, originalOAuth);
      Object.assign(sunoMcp, mcpDefaults);
      auth.useSunoStore(null);
      jobs.useSunoJobStore(null);
      await unlock?.();
      // Nada sensível no log: tokens, links, prompt e letra.
      const secrets = [...oauth.issued.flatMap((item) => [item.access_token, item.refresh_token]), 'fake-suno-signature', PROMPT, LYRICS, '/audio/'];
      assert.ok(!logged.some((line) => secrets.some((secret) => secret && line.includes(secret))), 'log sem segredo');
      // Nenhuma resposta de device leva audio_url, link do fake ou assinatura.
      for (const raw of responses) {
        assert.ok(!raw.includes('audio_url'), 'audio_url fora do payload');
        assert.ok(!raw.includes(audioBase) && !raw.includes('X-Amz-Signature') && !raw.includes('fake-suno-signature'));
      }
    });

    test('N=3: ceil(3/2) calls, 3 requested + 1 extra stored, payload without audio_url', async () => {
      const id = await connect('a', SUNO_A);
      fake.setScenarios(['success', 'odd_extra']);
      const clientJobId = randomUUID();
      const created = await create('a', { count: 3, client_job_id: clientJobId });
      assert.equal(created.status, 202, created.text);
      assert.equal(created.json.state, 'queued');
      assert.equal(created.json.total, 3);
      assert.match(created.json.job_id, /^[0-9a-f-]{36}$/);
      assert.equal(created.json.client_job_id, clientJobId);
      const job = await finished('a', created.json.job_id);
      assert.equal(job.state, 'completed');
      assert.deepEqual([job.completed, job.total, job.extra_ready], [3, 3, 1]);
      assert.equal(job.ready_text, '3 de 3 músicas prontas (+1 extra)');
      assert.equal(job.code, null);
      assert.equal(job.error, null);
      assert.deepEqual(job.suno_account, { id, name: 'Suno A' });
      assert.equal(job.from_this_device, true);
      assert.deepEqual(job.tracks.map((track) => [track.n, track.extra]), [[1, false], [2, false], [3, false], [4, true]]);
      assert.deepEqual(Object.keys(job.tracks[0]).sort(), ['duration', 'extra', 'n', 'title']);
      assert.equal(fake.generationCalls().length, 2);
      const other = await call('GET', '/device/suno/jobs/' + job.job_id, { device: pia.a.other });
      assert.equal(other.json.from_this_device, false, 'outro PC da mesma conta consulta, sem ser a origem');
      const stored = await storedTracks(job.generation_id);
      assert.equal(stored.length, 4);
      assert.ok(stored.every((track) => /^http:\/\/127\.0\.0\.1:\d+\/audio\//.test(track.audio_url)), 'link do Suno só no servidor');
      const generation = await storedGeneration(job.generation_id);
      assert.equal(generation.source, 'suno');
      assert.equal(generation.provider, 'suno_mcp');
      assert.equal(String(generation.account_id), String(pia.a.id));
      assert.equal(generation.suno_account_id, id);
      assert.equal(generation.job_id, job.job_id);
      assert.equal(generation.client_id, clientJobId);
      assert.equal(generation.device_id, pia.a.device.device_id);
      assert.deepEqual([generation.prompt, generation.lyrics, generation.count, generation.duration, generation.state],
        [PROMPT, LYRICS, 3, 30, 'completed']);
      const args = JSON.parse(fake.generationCalls()[0].body).params.arguments;
      assert.deepEqual(args, { prompt: PROMPT, lyrics: LYRICS, instrumental: false, duration: 30 });
    });

    test('partial in the 1st call stops the batch: 1 of 3, incomplete_batch, one tools/call (CA07)', async () => {
      await connect('a', SUNO_A);
      fake.setScenarios(['partial', 'success']);
      const job = await finished('a', (await create('a', { count: 3 })).json.job_id);
      assert.equal(job.state, 'failed');
      assert.equal(job.code, 'incomplete_batch');
      assert.deepEqual([job.completed, job.total, job.extra_ready], [1, 3, 0]);
      assert.equal(job.ready_text, '1 de 3 músicas prontas');
      assert.equal(fake.generationCalls().length, 1);
    });

    test('a failed extra does not fail the job; success then 503 keeps 2 of 3', async () => {
      await connect('a', SUNO_A);
      fake.setScenarios(['success', 'partial']);
      let job = await finished('a', (await create('a', { count: 3 })).json.job_id);
      assert.equal(job.state, 'completed');
      assert.deepEqual([job.completed, job.extra_ready], [3, 0]);
      fake.resetRecordings();
      fake.setScenarios(['success', '503']);
      job = await finished('a', (await create('a', { count: 3 })).json.job_id);
      assert.equal(job.state, 'failed');
      assert.equal(job.code, 'suno_unavailable');
      assert.equal(job.error, 'Suno indisponível no momento, tente de novo ou use outro gerador');
      assert.deepEqual([job.completed, job.total], [2, 3]);
      assert.equal(fake.generationCalls().length, 2);
    });

    test('an extra that is ready in a partial failure is kept with extra:true (stub)', async () => {
      await connect('a', SUNO_A);
      const stub = await startStub((message, send) => {
        if (message.method === 'tools/list') return send({ result: { tools: [GEN] } });
        return send(text({ clips: [{ id: 'x1', status: 'error', error: 'falhou' }, { id: 'x2', status: 'complete', title: 'Extra', audio_url: 'https://cdn.suno.test/x2.mp3?sig=s' }] }));
      });
      sunoMcp.url = stub.url;
      const job = await finished('a', (await create('a', { count: 1 })).json.job_id);
      await stub.close();
      assert.equal(job.state, 'failed');
      assert.equal(job.code, 'incomplete_batch');
      assert.deepEqual([job.completed, job.total, job.extra_ready], [0, 1, 1]);
      assert.equal(job.ready_text, '0 de 1 música pronta (+1 extra)');
      assert.deepEqual(job.tracks, [{ n: 1, title: 'Extra', duration: null, extra: true }]);
      assert.equal((await storedTracks(job.generation_id))[0].audio_url, 'https://cdn.suno.test/x2.mp3?sig=s');
    });

    test('pending clips are polled through the status tool (stub) and durations are rounded', async () => {
      await connect('a', SUNO_A);
      let polls = 0;
      const stub = await startStub((message, send) => {
        if (message.method === 'tools/list') return send({ result: { tools: [GEN, STATUS] } });
        if (message.params.name === 'generate_music') return send(text([{ id: 'p1', status: 'queued' }, { id: 'p2', status: 'queued' }]));
        polls++;
        const id = message.params.arguments.clip_id;
        return send(text(polls > 2 ? { id, status: 'complete', audio_url: 'https://cdn.suno.test/' + id + '.mp3', duration: 61.6 } : { id, status: 'streaming' }));
      });
      sunoMcp.url = stub.url;
      const job = await finished('a', (await create('a', { count: 2 })).json.job_id);
      await stub.close();
      assert.equal(job.state, 'completed');
      assert.deepEqual(job.tracks.map((track) => track.duration), [62, 62]);
    });

    for (const [scenarios, code, message] of [
      [['401', '401'], 'suno_credential_expired', 'A autorização da conta Suno Suno A expirou. Reconecte em Configurações → Música'],
      [['402'], 'suno_no_credits', 'A conta Suno Suno A está sem créditos.'],
      [['500'], 'suno_unavailable', 'Suno indisponível no momento, tente de novo ou use outro gerador'],
    ]) {
      test('Suno ' + scenarios[0] + ' ends the job as failed with ' + code + ' and no automatic retry', async () => {
        await connect('a', SUNO_A);
        fake.setScenarios(scenarios);
        const job = await finished('a', (await create('a', { count: 2 })).json.job_id);
        assert.equal(job.state, 'failed');
        assert.equal(job.code, code);
        assert.equal(job.error, message);
        assert.equal(job.completed, 0);
        assert.equal(fake.generationCalls().length, scenarios.length);
      });
    }

    test('timeout: suno_timeout, the paid call is never repeated', async () => {
      await connect('a', SUNO_A);
      fake.setScenarios(['timeout']);
      fake.timeoutDelayMs = 800;
      sunoMcp.requestTimeoutMs = 150;
      const job = await finished('a', (await create('a', { count: 2 })).json.job_id);
      assert.equal(job.state, 'failed');
      assert.equal(job.code, 'suno_timeout');
      assert.equal(job.error, 'O Suno não respondeu a tempo; a geração pode ter sido concluída lá');
      assert.equal(fake.generationCalls().length, 1);
    });

    test('RN10: one active job per PIA account (409 suno_job_active); idempotent by client_job_id; status.active_job', async () => {
      await connect('a', SUNO_A);
      fake.setScenarios(['timeout']);
      const clientJobId = randomUUID();
      const first = await create('a', { client_job_id: clientJobId });
      assert.equal(first.status, 202);
      const repeat = await create('a', { client_job_id: clientJobId, prompt: 'outro prompt', count: 5 });
      assert.equal(repeat.status, 200);
      assert.equal(repeat.json.job_id, first.json.job_id);
      assert.equal(repeat.json.total, 1, 'devolve o job original');
      const busy = await create('a');
      assert.equal(busy.status, 409);
      assert.equal(busy.json.code, 'suno_job_active');
      const fromOther = await call('POST', '/device/suno/jobs', { device: pia.a.other, body: { prompt: 'x', client_job_id: randomUUID() } });
      assert.equal(fromOther.json.code, 'suno_job_active', 'vale para a conta PIA, não para o PC');
      const status = await call('GET', '/device/suno/status', { device: pia.a.other });
      assert.equal(status.json.active_job.job_id, first.json.job_id);
      assert.equal(status.json.active_job.from_this_device, false);
      assert.equal(status.json.active_job.total, 1);
      await connect('b', SUNO_B);
      assert.equal((await create('b')).status, 202, 'outra conta PIA não é bloqueada');
      await jobs.settleSunoJobs();
      assert.equal((await call('GET', '/device/suno/status', { device: pia.a.token })).json.active_job, null);
      assert.equal((await create('a')).status, 202);
    });

    test('cancel while running keeps ready tracks and starts no new tools/call', async () => {
      await connect('a', SUNO_A);
      fake.setScenarios(['success', 'timeout', 'success']);
      fake.timeoutDelayMs = 2000;
      const created = await create('a', { count: 6 });
      for (let i = 0; i < 100 && fake.generationCalls().length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const cancelled = await call('POST', '/device/suno/jobs/' + created.json.job_id + '/cancel', { device: pia.a.other });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.json.state, 'cancelled');
      assert.equal(cancelled.json.code, null);
      assert.deepEqual([cancelled.json.completed, cancelled.json.total], [2, 6]);
      await jobs.settleSunoJobs();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(fake.generationCalls().length, 2, 'nenhum tools/call depois do cancelamento');
      const again = await call('POST', '/device/suno/jobs/' + created.json.job_id + '/cancel', { device: pia.a.token });
      assert.equal(again.json.state, 'cancelled', 'cancelar de novo é idempotente');
    });

    test('cancel of a queued job never calls Suno; boot recovery turns active jobs into interrupted without tools/call', async () => {
      const id = await connect('a', SUNO_A);
      const store = mode.pg ? jobs.pgJobStore : jobStore;
      const insert = (clientId) => store.create({ id: randomUUID(), job_id: randomUUID(), account_id: pia.a.id, device_id: pia.a.device.device_id,
        suno_account_id: id, client_id: clientId, prompt: 'p', lyrics: null, count: 2, duration: null, instrumental: true });
      const queued = (await insert(randomUUID())).job;
      const cancelled = await call('POST', '/device/suno/jobs/' + queued.job_id + '/cancel', { device: pia.a.token });
      assert.equal(cancelled.json.state, 'cancelled');
      const running = (await insert(randomUUID())).job;
      await store.start(running.job_id);
      const recovered = await jobs.recoverSunoJobs({ accountId: pia.a.id });
      assert.deepEqual(recovered, [running.job_id]);
      const job = (await getJob('a', running.job_id)).json;
      assert.equal(job.state, 'interrupted');
      assert.match(job.error, /reiniciou/);
      assert.equal(fake.generationCalls().length, 0);
    });

    test('account choice: required with 2 valid accounts, own account only, refusals by credential state', async () => {
      assert.equal((await create('a')).json.code, 'suno_not_connected');
      oauth.config.expiresIn = 30;
      const first = await connect('a', SUNO_A);
      oauth.failures.refresh.push(503);
      const unavailable = await create('a');
      assert.equal(unavailable.status, 502);
      assert.equal(unavailable.json.code, 'suno_unavailable', 'unavailable nunca vira expired');
      oauth.revokeRefresh();
      const expired = await create('a');
      assert.equal(expired.status, 400);
      assert.equal(expired.json.code, 'suno_credential_expired');
      oauth.config.expiresIn = 900;
      const second = await connect('a', SUNO_B);
      const third = await connect('a', { id: 'suno-user-c', email: 'c@suno.test', label: 'Suno C' });
      void second;
      const required = await create('a');
      assert.equal(required.status, 400);
      assert.equal(required.json.code, 'suno_account_required');
      const explicitExpired = await create('a', { suno_account_id: first });
      assert.equal(explicitExpired.json.code, 'suno_credential_expired');
      const ok = await create('a', { suno_account_id: third });
      assert.equal(ok.status, 202);
      assert.equal(ok.json.suno_account.name, 'Suno C');
      await jobs.settleSunoJobs();
      const foreign = await create('b', { suno_account_id: third });
      assert.equal(foreign.status, 404);
      assert.equal(foreign.json.code, 'suno_account_not_found');
      assert.equal(fake.generationCalls().length, 1, 'recusas não chamam o Suno');
    });

    test('validation, unpaired device and jobs of another PIA account', async () => {
      await connect('a', SUNO_A);
      for (const body of [{ count: 11 }, { count: 0 }, { count: 1.5 }, { duration: 5 }, { duration: 181 }, { prompt: '  ' },
        { client_job_id: 'nope' }, { client_job_id: undefined }, { instrumental: 'sim' }, { prompt: 'x'.repeat(4001) }]) {
        const result = await create('a', body);
        assert.equal(result.status, 400, JSON.stringify(body));
        assert.equal(result.json.code, 'bad_request');
      }
      const unpaired = await call('POST', '/device/suno/jobs', { device: 'x'.repeat(43), body: {} });
      assert.deepEqual([unpaired.status, unpaired.json], [401, { error: 'Pareamento inválido.' }]);
      const created = await create('a');
      await jobs.settleSunoJobs();
      for (const path of ['/device/suno/jobs/' + created.json.job_id, '/device/suno/jobs/' + randomUUID(), '/device/suno/jobs/nope']) {
        const result = await call('GET', path, { device: pia.b.token });
        assert.equal(result.status, 404);
        assert.equal(result.json.code, 'suno_job_not_found');
      }
      const cancel = await call('POST', '/device/suno/jobs/' + created.json.job_id + '/cancel', { device: pia.b.token });
      assert.equal(cancel.status, 404);
    });

    test('history hard delete: 409 while active, then prompt, lyrics and links are really gone', async () => {
      await connect('a', SUNO_A);
      fake.setScenarios(['timeout']);
      const created = await create('a', { count: 2 });
      const generationId = created.json.generation_id;
      // PG: DELETE real da T5b (src/music_generations.js); memória: o mesmo contrato no store fake.
      if (mode.pg) {
        await assert.rejects(history.deleteGeneration(pia.a.device, generationId),
          (error) => error.status === 409 && error.musicCode === 'music_generation_active');
      } else assert.equal(jobStore.deleteGeneration(generationId), 'active');
      await jobs.settleSunoJobs();
      assert.equal((await storedTracks(generationId)).length, 2);
      if (mode.pg) {
        // O histórico real da conta mostra o item Suno com as faixas, sem audio_url.
        const listed = await history.listGenerations(pia.a.device, {});
        const item = listed.items.find((entry) => entry.id === generationId);
        assert.equal(item.source, 'suno');
        assert.equal(item.provider, 'suno_mcp');
        assert.equal(item.suno_account.name, 'Suno A');
        assert.equal(item.state, 'completed');
        assert.deepEqual(item.tracks.map((track) => Object.keys(track).sort()), [['duration', 'extra', 'n', 'title'], ['duration', 'extra', 'n', 'title']]);
        assert.ok(!JSON.stringify(listed).includes('audio_url'));
        assert.deepEqual(await history.deleteGeneration(pia.a.device, generationId), { ok: true });
      } else assert.equal(jobStore.deleteGeneration(generationId), 'ok');
      assert.equal(await storedGeneration(generationId), null);
      assert.deepEqual(await storedTracks(generationId), []);
      if (mode.pg) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pia_server.music_generation_tracks t
          WHERE t.generation_id=$1`, [generationId]);
        assert.equal(rows[0].n, 0);
      }
      const gone = await getJob('a', created.json.job_id);
      assert.equal(gone.status, 404);
    });
  });
}

after(async () => { if (process.env.PIA_TEST_PG === '1') await pool.end(); });
