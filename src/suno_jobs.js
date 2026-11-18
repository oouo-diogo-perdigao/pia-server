import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { SunoError, publicError } from './suno_errors.js';
import { sunoCredentialRefusal, sunoHooks, sunoSettings, sunoStatus } from './suno_auth.js';
import { requireSunoAccount, sunoGenerate } from './suno_client.js';
import { ACTIVE_STATES, SUNO_ACCOUNT_SQL } from './music_generations.js';

// Jobs de geração do Suno (T4, contrato v3 FINAL + v3.2).
//
// O job É o item de pia_server.music_generations (tabela da T5b, source 'suno',
// provider 'suno_mcp', job_id) e as faixas são as linhas de
// music_generation_tracks (n, title, duration, extra, audio_url). Não há tabela
// própria: o hard delete do histórico (T5b) apaga prompt, letra e links em
// cascata e nada sensível sobra aqui. O servidor não guarda áudio (RN13): só o
// link do Suno, que nunca vai no payload do device (RN19).
//
// Worker no próprio processo. Cada job faz ceil(N/2) chamadas sunoGenerate em
// sequência e para no primeiro clip que falhar (sem chamada extra). Toda faixa
// pronta é guardada, inclusive a extra do N ímpar e a extra pronta numa falha
// parcial (extra: true). Cancelar aborta a espera (signal → suno_cancelled →
// cancelled), mantém as faixas prontas e não inicia tools/call novo. No boot,
// jobs queued/running viram interrupted e nunca refazem tools/call (RN11).

export const SUNO_PROVIDER = 'suno_mcp';
export { ACTIVE_STATES };
export const JOB_STATES = Object.freeze(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']);
const LIMITS = Object.freeze({ prompt: 4000, lyrics: 20000 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sunoJobSettings = { cancelWaitMs: 5000 };

// ---------------------------------------------------------------------------
// Store Postgres (DDL de music_generations da T5b, src/db.js; nome da conta Suno
// pelo mesmo SUNO_ACCOUNT_SQL de src/music_generations.js). Um job ativo por conta PIA:
// advisory lock por conta dentro da transação de criação.

const JOB_COLUMNS = `g.id,g.account_id,g.client_id,g.source,g.provider,g.suno_account_id,g.job_id,g.device_id,
  g.count,g.duration,g.instrumental,g.state,g.code,g.created,${SUNO_ACCOUNT_SQL.name} AS suno_account_name`;
const FROM = `FROM pia_server.music_generations g ${SUNO_ACCOUNT_SQL.join}`;

async function withTracks(client, row) {
  if (!row) return null;
  const { rows } = await client.query(
    'SELECT n,title,duration,extra FROM pia_server.music_generation_tracks WHERE generation_id=$1 ORDER BY n', [row.id]);
  return { ...row, tracks: rows };
}

export const pgJobStore = {
  // { job, created } ou { conflict: 'active' | 'client_id' }.
  async create(input) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('pia_suno_job:' || $1::text, 0))", [String(input.account_id)]);
      const { rows: [existing] } = await client.query(`SELECT ${JOB_COLUMNS} ${FROM} WHERE g.account_id=$1 AND g.client_id=$2`,
        [input.account_id, input.client_id]);
      if (existing) {
        await client.query('COMMIT');
        return existing.source === 'suno' && existing.job_id ? { job: await withTracks(pool, existing), created: false } : { conflict: 'client_id' };
      }
      const { rows: [active] } = await client.query(`SELECT 1 FROM pia_server.music_generations
        WHERE account_id=$1 AND source='suno' AND state IN ('queued','running') LIMIT 1`, [input.account_id]);
      if (active) { await client.query('ROLLBACK'); return { conflict: 'active' }; }
      await client.query(`INSERT INTO pia_server.music_generations(id,account_id,client_id,source,provider,suno_account_id,job_id,
        device_id,prompt,lyrics,count,duration,instrumental,state,suno_account_name)
        VALUES($1,$2,$3,'suno',$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued',
          (SELECT COALESCE(label, suno_name, suno_email) FROM pia_server.suno_accounts WHERE id=$5 AND account_id=$2))`,
      [input.id, input.account_id, input.client_id, SUNO_PROVIDER, input.suno_account_id, input.job_id, input.device_id,
        input.prompt, input.lyrics, input.count, input.duration, input.instrumental]);
      await client.query('COMMIT');
      return { job: await this.get(input.account_id, input.job_id), created: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  },
  async byClient(accountId, clientId) {
    const { rows: [row] } = await pool.query(`SELECT ${JOB_COLUMNS} ${FROM} WHERE g.account_id=$1 AND g.client_id=$2`, [accountId, clientId]);
    return withTracks(pool, row);
  },
  async get(accountId, jobId) {
    const { rows: [row] } = await pool.query(`SELECT ${JOB_COLUMNS} ${FROM} WHERE g.account_id=$1 AND g.job_id=$2 AND g.source='suno'`,
      [accountId, jobId]);
    return withTracks(pool, row);
  },
  async active(accountId) {
    const { rows: [row] } = await pool.query(`SELECT ${JOB_COLUMNS} ${FROM} WHERE g.account_id=$1 AND g.source='suno'
      AND g.state IN ('queued','running') ORDER BY g.created LIMIT 1`, [accountId]);
    return withTracks(pool, row);
  },
  // queued -> running; devolve os parâmetros da geração (com prompt e letra) só para o worker.
  async start(jobId) {
    const { rows: [row] } = await pool.query(`UPDATE pia_server.music_generations SET state='running'
      WHERE job_id=$1 AND source='suno' AND state='queued'
      RETURNING id,account_id,suno_account_id,job_id,prompt,lyrics,count,duration,instrumental`, [jobId]);
    return row || null;
  },
  async addTracks(generationId, tracks) {
    for (const track of tracks) {
      await pool.query(`INSERT INTO pia_server.music_generation_tracks(generation_id,n,title,duration,extra,audio_url)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [generationId, track.n, track.title, track.duration, track.extra, track.audio_url]);
    }
  },
  async finish(jobId, state, code) {
    const { rowCount } = await pool.query(`UPDATE pia_server.music_generations SET state=$2,code=$3
      WHERE job_id=$1 AND source='suno' AND state IN ('queued','running')`, [jobId, state, code]);
    return rowCount > 0;
  },
  async cancelQueued(accountId, jobId) {
    const { rowCount } = await pool.query(`UPDATE pia_server.music_generations SET state='cancelled',code=NULL
      WHERE account_id=$1 AND job_id=$2 AND source='suno' AND state='queued'`, [accountId, jobId]);
    return rowCount > 0;
  },
  async interruptActive(accountId = null) {
    const { rows } = await pool.query(`UPDATE pia_server.music_generations SET state='interrupted',code=NULL
      WHERE source='suno' AND state IN ('queued','running') AND ($1::bigint IS NULL OR account_id=$1) RETURNING job_id`, [accountId]);
    return rows.map((row) => row.job_id);
  },
};

let store = pgJobStore;
export function useSunoJobStore(next) { store = next || pgJobStore; }

// ---------------------------------------------------------------------------
// Formato do device. Nunca leva audio_url, prompt nem letra.

export function readyText(completed, total, extra = 0) {
  const noun = total === 1 ? 'música pronta' : 'músicas prontas';
  return `${completed} de ${total} ${noun}` + (extra > 0 ? ` (+${extra} extra)` : '');
}

const accountName = (row) => row.suno_account_name || 'Suno';

export function jobMessage(row) {
  const name = accountName(row);
  switch (row.code) {
    case 'suno_credential_expired': return `A autorização da conta Suno ${name} expirou. Reconecte em Configurações → Música`;
    case 'suno_no_credits': return `A conta Suno ${name} está sem créditos.`;
    case 'suno_unavailable': return 'Suno indisponível no momento, tente de novo ou use outro gerador';
    case 'suno_timeout': return 'O Suno não respondeu a tempo; a geração pode ter sido concluída lá';
    case 'incomplete_batch': return 'O Suno devolveu menos músicas que o esperado.';
    case 'suno_not_connected': return 'Conecte uma conta Suno na PIA Server.';
    case 'internal_error': return 'Falha ao gerar a música.';
    default: break;
  }
  if (row.state === 'interrupted') return 'A geração foi interrompida porque a PIA Server reiniciou. As músicas prontas foram mantidas.';
  if (row.state === 'failed') return 'Falha ao gerar a música.';
  return null;
}

export function publicJob(row, device = null) {
  const tracks = (row.tracks || []).map((track) => ({ n: track.n, title: track.title ?? null, duration: track.duration ?? null, extra: Boolean(track.extra) }));
  const extra = tracks.filter((track) => track.extra).length;
  const completed = Math.min(tracks.length - extra, row.count);
  return {
    job_id: row.job_id, generation_id: row.id, client_job_id: row.client_id, state: row.state,
    completed, total: row.count, extra_ready: extra, ready_text: readyText(completed, row.count, extra),
    error: jobMessage(row), code: row.code ?? null,
    suno_account: row.suno_account_id || row.suno_account_name
      ? { id: row.suno_account_id ?? null, name: row.suno_account_name ?? null } : null,
    device_id: row.device_id ?? null, from_this_device: Boolean(device?.device_id && row.device_id === device.device_id),
    created: row.created instanceof Date ? row.created.toISOString() : row.created ?? null,
    tracks,
  };
}

// active_job do GET /device/suno/status (nível da conta PIA).
export function activeJobSummary(row, device) {
  if (!row) return null;
  const job = publicJob(row, device);
  return { job_id: job.job_id, generation_id: job.generation_id, client_job_id: job.client_job_id, state: job.state,
    suno_account_id: row.suno_account_id ?? null, completed: job.completed, total: job.total, extra_ready: job.extra_ready,
    device_id: job.device_id, from_this_device: job.from_this_device };
}

// ---------------------------------------------------------------------------
// Validação e escolha da conta Suno (RN09/RN10).

const bad = (message) => new SunoError('bad_request', message);
const notFound = () => new SunoError('suno_job_not_found', 'Geração do Suno não encontrada.', 404);

export function validateJobInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('Objeto JSON obrigatório.');
  const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  if (!prompt || prompt.length > LIMITS.prompt) throw bad('Informe o prompt (até 4000 caracteres).');
  if (data.lyrics != null && typeof data.lyrics !== 'string') throw bad('Letra inválida.');
  const lyrics = typeof data.lyrics === 'string' && data.lyrics.trim() ? data.lyrics.trim() : null;
  if (lyrics && lyrics.length > LIMITS.lyrics) throw bad('Letra acima do limite.');
  const count = data.count == null ? 1 : data.count;
  if (!Number.isInteger(count) || count < 1 || count > sunoSettings.max_count) throw bad('A quantidade deve ser de 1 a 10.');
  const [min, max] = sunoSettings.duration;
  const duration = data.duration == null ? null : data.duration;
  if (duration !== null && (!Number.isInteger(duration) || duration < min || duration > max)) throw bad('A duração deve ser de 10 a 180 s.');
  if (data.instrumental != null && typeof data.instrumental !== 'boolean') throw bad('instrumental deve ser booleano.');
  const instrumental = typeof data.instrumental === 'boolean' ? data.instrumental : !lyrics;
  if (typeof data.client_job_id !== 'string' || !uuid.test(data.client_job_id)) throw bad('Informe client_job_id (uuid).');
  if (data.suno_account_id != null && typeof data.suno_account_id !== 'string') throw bad('suno_account_id inválido.');
  return { prompt, lyrics, count, duration, instrumental, client_id: data.client_job_id.toLowerCase(),
    suno_account_id: data.suno_account_id || null };
}

async function chooseSunoAccount(account, requested) {
  if (requested) {
    await requireSunoAccount(account, requested); // 404 de outra conta; refresh_failed/unavailable recusam
    return requested;
  }
  const { accounts } = await sunoStatus(account);
  const valid = accounts.filter((item) => item.available);
  if (valid.length === 1) return valid[0].id;
  if (valid.length > 1) throw new SunoError('suno_account_required', 'Escolha a conta Suno.');
  if (!accounts.length) throw new SunoError('suno_not_connected', 'Conecte uma conta Suno na PIA Server.');
  const refusal = accounts.some((item) => item.credential_state === 'unavailable') ? 'unavailable' : 'refresh_failed';
  const code = sunoCredentialRefusal(refusal);
  throw code === 'suno_unavailable' ? new SunoError(code, 'Suno indisponível no momento, tente de novo ou use outro gerador', 502)
    : new SunoError(code, 'A conexão com o Suno expirou. Reconecte em Configurações → Música.');
}

// ---------------------------------------------------------------------------
// API usada pelas rotas.

const running = new Map(); // job_id -> { controller, promise }

export async function createSunoJob(account, data) {
  const input = validateJobInput(data);
  const insert = { ...input, id: randomUUID(), job_id: randomUUID(), account_id: account.id, device_id: account.device_id || null };
  // Repetição idempotente (mesmo client_job_id) antes de qualquer recusa: devolve
  // o job original, mesmo ativo, ignorando diferenças no corpo.
  const known = await store.byClient(account.id, input.client_id);
  if (known?.source === 'suno' && known.job_id) return { status: 200, job: publicJob(known, account) };
  if (known) throw bad('client_job_id já usado por outra geração.');
  if (await store.active(account.id)) throw activeError();
  insert.suno_account_id = await chooseSunoAccount(account, input.suno_account_id);
  const result = await store.create(insert);
  if (result.conflict === 'active') throw activeError();
  if (result.conflict === 'client_id') throw bad('client_job_id já usado por outra geração.');
  if (result.created) schedule(result.job.job_id);
  return { status: result.created ? 202 : 200, job: publicJob(result.job, account) };
}

const activeError = () => new SunoError('suno_job_active', 'Já há uma geração do Suno em andamento nesta conta. Aguarde terminar.', 409);

export async function getSunoJob(account, jobId) {
  const row = uuid.test(jobId || '') ? await store.get(account.id, jobId) : null;
  if (!row) throw notFound();
  return publicJob(row, account);
}

export async function cancelSunoJob(account, jobId) {
  const row = uuid.test(jobId || '') ? await store.get(account.id, jobId) : null;
  if (!row) throw notFound();
  if (row.state === 'queued' && await store.cancelQueued(account.id, jobId)) return getSunoJob(account, jobId);
  const work = running.get(jobId);
  if (work) {
    work.controller.abort(new Error('cancelled'));
    let timer;
    await Promise.race([work.promise, new Promise((resolve) => { timer = setTimeout(resolve, sunoJobSettings.cancelWaitMs); })]);
    clearTimeout(timer);
  }
  return getSunoJob(account, jobId);
}

// Recuperação no boot: nada que estava na fila ou rodando é retomado. `accountId`
// só restringe a varredura (testes num banco compartilhado); o boot usa todas.
export async function recoverSunoJobs({ accountId = null } = {}) {
  try { return await store.interruptActive(accountId); } catch (error) {
    if (error?.code === '42P01') { console.error('Tabela music_generations ausente: jobs do Suno indisponíveis até a T5b.'); return []; }
    throw error;
  }
}

// Espera os jobs em andamento (testes e desligamento).
export async function settleSunoJobs() { await Promise.allSettled([...running.values()].map((work) => work.promise)); }

sunoHooks.activeJob = async (account) => {
  try { return activeJobSummary(await store.active(account.id), account); } catch (error) {
    if (error?.code === '42P01') return null; // music_generations (T5b) ainda não existe
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Worker.

function schedule(jobId) {
  if (running.has(jobId)) return;
  const controller = new AbortController();
  const work = { controller, promise: null };
  running.set(jobId, work);
  work.promise = new Promise((resolve) => setImmediate(resolve))
    .then(() => runJob(jobId, controller.signal))
    .catch(() => { console.error('Falha no worker de jobs do Suno.'); })
    .finally(() => running.delete(jobId));
}

const roundDuration = (value) => (Number.isFinite(value) && value >= 0 ? Math.min(3600, Math.round(value)) : null);

async function runJob(jobId, signal) {
  const row = await store.start(jobId);
  if (!row) return;
  const account = { id: row.account_id };
  const total = row.count;
  let n = 0; // número da faixa salva (1..20)
  let completed = 0; // faixas pedidas prontas
  // Extra é posicional (RN12/§4.4): na chamada k, o clip i (0 ou 1) ocupa a vaga
  // 2k+i; a partir de `total` é extra (o 2º clip da última chamada de N ímpar),
  // e um 3º clip numa chamada também. Clips prontos de um erro (partial do
  // polling) preenchem primeiro as vagas pedidas. No máximo 20 faixas (DDL).
  const save = async (clips, call, { partial = false } = {}) => {
    const tracks = [];
    let index = 0;
    let free = Math.max(0, Math.min(2, total - call * 2));
    for (const clip of clips || []) {
      const i = index++;
      if (clip.state !== 'ready' || !clip.audio_url || n >= 20) continue;
      const extra = partial ? free <= 0 : i >= 2 || call * 2 + i >= total;
      if (partial) free -= 1;
      if (!extra) completed += 1;
      n += 1;
      tracks.push({ n, title: typeof clip.title === 'string' && clip.title ? clip.title.slice(0, 200) : null,
        duration: roundDuration(clip.duration), extra, audio_url: clip.audio_url });
    }
    if (tracks.length) await store.addTracks(row.id, tracks);
  };
  let state = 'completed';
  let code = null;
  let call = 0;
  try {
    for (; call < Math.ceil(total / 2); call++) {
      if (signal.aborted) throw new SunoError('suno_cancelled', 'Cancelado.');
      const result = await sunoGenerate(account, row.suno_account_id, {
        prompt: row.prompt, lyrics: row.lyrics || '', duration: row.duration ?? null, instrumental: row.instrumental, signal });
      await save(result.clips, call);
      const failed = result.clips.some((clip) => clip.state !== 'ready');
      const short = result.clips.length < Math.min(2, total - call * 2);
      if (failed || short) break; // para no primeiro clip com falha ou no lote curto, sem chamada extra
    }
    if (completed < total) { state = 'failed'; code = 'incomplete_batch'; }
  } catch (error) {
    if (error?.partial?.length) await save(error.partial, call, { partial: true }).catch(() => {});
    if (error?.code === 'suno_cancelled' || signal.aborted) { state = 'cancelled'; code = null; }
    else {
      state = 'failed';
      code = publicError(error)?.body.code || 'internal_error';
      if (code === 'internal_error') console.error('Falha inesperada num job do Suno.');
    }
  }
  if (state === 'failed' && completed >= total) { state = 'completed'; code = null; }
  await store.finish(jobId, state, code);
}

// ---------------------------------------------------------------------------
// Rotas de device (contrato §4.2/§4.4/v3 FINAL). O download da faixa é da T5
// (GET /device/music/generations/:id/tracks/:n/audio).

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function sunoJobsRoute(req, res, url, { authenticateDevice, readBody }) {
  const path = url.pathname;
  const jobMatch = /^\/device\/suno\/jobs\/([^/]+)$/.exec(path);
  const cancelMatch = /^\/device\/suno\/jobs\/([^/]+)\/cancel$/.exec(path);
  const known = (req.method === 'POST' && (path === '/device/suno/jobs' || cancelMatch)) || (req.method === 'GET' && jobMatch);
  if (!known) return false;
  try {
    const account = await authenticateDevice(req.headers.authorization);
    if (!account) { send(res, 401, { error: 'Pareamento inválido.' }); return true; }
    if (path === '/device/suno/jobs') {
      const { status, job } = await createSunoJob(account, await readBody(req, 64 * 1024));
      send(res, status, job);
    } else if (cancelMatch) send(res, 200, await cancelSunoJob(account, cancelMatch[1]));
    else send(res, 200, await getSunoJob(account, jobMatch[1]));
  } catch (error) {
    const known = publicError(error);
    if (known) send(res, known.status, known.body);
    else if (error instanceof SyntaxError || ['Envie JSON.', 'Corpo acima do limite da rota.', 'Objeto JSON obrigatório.'].includes(error?.message))
      send(res, 400, { error: 'Requisição inválida.', code: 'bad_request' });
    else { console.error('Falha na rota de jobs do Suno.'); send(res, 500, { error: 'A operação falhou.', code: 'internal_error' }); }
  }
  return true;
}

