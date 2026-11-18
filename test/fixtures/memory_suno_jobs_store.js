// Store em memória com a mesma interface do pgJobStore (src/suno_jobs.js), sobre
// linhas no formato de music_generations/music_generation_tracks (T5b). O nome da
// conta Suno vem do store de contas (label → suno_name → suno_email), como o JOIN.

export function createMemorySunoJobsStore(sunoStore) {
  const generations = new Map(); // id -> row (com prompt, letra)
  const tracks = new Map(); // generation id -> [{ n, title, duration, extra, audio_url }]
  const view = (row) => {
    if (!row) return null;
    const sa = row.suno_account_id ? sunoStore?.accounts.get(row.suno_account_id) : null;
    const name = sa && String(sa.account_id) === String(row.account_id) ? sa.label || sa.suno_name || sa.suno_email || null : null;
    const { prompt, lyrics, ...rest } = row;
    void prompt; void lyrics;
    return { ...rest, suno_account_name: name,
      tracks: (tracks.get(row.id) || []).map(({ n, title, duration, extra }) => ({ n, title, duration, extra })) };
  };
  const find = (test) => [...generations.values()].find(test) || null;
  const active = (row) => row.source === 'suno' && ['queued', 'running'].includes(row.state);
  return {
    generations, tracks,
    async create(input) {
      const existing = find((row) => String(row.account_id) === String(input.account_id) && row.client_id === input.client_id);
      if (existing) return existing.source === 'suno' && existing.job_id ? { job: view(existing), created: false } : { conflict: 'client_id' };
      if (find((row) => String(row.account_id) === String(input.account_id) && active(row))) return { conflict: 'active' };
      generations.set(input.id, { id: input.id, account_id: input.account_id, client_id: input.client_id, source: 'suno',
        provider: 'suno_mcp', suno_account_id: input.suno_account_id, job_id: input.job_id, device_id: input.device_id,
        prompt: input.prompt, lyrics: input.lyrics, title: null, count: input.count, duration: input.duration,
        instrumental: input.instrumental, state: 'queued', code: null, created: new Date(Date.now() + generations.size) });
      return { job: view(generations.get(input.id)), created: true };
    },
    async byClient(accountId, clientId) { return view(find((row) => String(row.account_id) === String(accountId) && row.client_id === clientId)); },
    async get(accountId, jobId) { return view(find((row) => String(row.account_id) === String(accountId) && row.job_id === jobId && row.source === 'suno')); },
    async active(accountId) { return view(find((row) => String(row.account_id) === String(accountId) && active(row))); },
    async start(jobId) {
      const row = find((item) => item.job_id === jobId && item.state === 'queued');
      if (!row) return null;
      row.state = 'running';
      const { id, account_id, suno_account_id, job_id, prompt, lyrics, count, duration, instrumental } = row;
      return { id, account_id, suno_account_id, job_id, prompt, lyrics, count, duration, instrumental };
    },
    async addTracks(generationId, list) {
      const current = tracks.get(generationId) || [];
      for (const track of list) if (!current.some((item) => item.n === track.n)) current.push({ ...track });
      tracks.set(generationId, current);
    },
    async finish(jobId, state, code) {
      const row = find((item) => item.job_id === jobId && ['queued', 'running'].includes(item.state));
      if (!row) return false;
      Object.assign(row, { state, code });
      return true;
    },
    async cancelQueued(accountId, jobId) {
      const row = find((item) => String(item.account_id) === String(accountId) && item.job_id === jobId && item.state === 'queued');
      if (!row) return false;
      Object.assign(row, { state: 'cancelled', code: null });
      return true;
    },
    async interruptActive(accountId = null) {
      const ids = [];
      for (const row of generations.values()) if (active(row) && (accountId === null || String(row.account_id) === String(accountId))) { Object.assign(row, { state: 'interrupted', code: null }); ids.push(row.job_id); }
      return ids;
    },
    // Hard delete como o da T5b (para os testes): 409 se ativa.
    deleteGeneration(id) {
      const row = generations.get(id);
      if (!row) return 'not_found';
      if (active(row)) return 'active';
      generations.delete(id);
      tracks.delete(id);
      return 'ok';
    },
  };
}
