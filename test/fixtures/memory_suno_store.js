// Store em memória com a mesma interface do pgStore de src/suno_auth.js, para
// rodar os testes da T2 sem Postgres (CI). As transações são serializadas por
// um mutex global (equivale, para os testes, ao SELECT … FOR UPDATE) e o
// UNIQUE(suno_subject) devolve o mesmo code 23505 do Postgres.

export function createMemorySunoStore() {
  const accounts = new Map();
  const attempts = new Map();
  const clients = new Map();
  let chain = Promise.resolve();
  const copy = (row) => (row ? { ...row } : null);
  const uniqueError = () => Object.assign(new Error('duplicate key'), { code: '23505' });

  function tx(working) {
    return {
      async lockBySubject(subject) { return copy([...working.values()].find((row) => row.suno_subject === subject)); },
      async lockById(id) { return copy(working.get(id)); },
      async insertAccount(row) {
        if (working.has(row.id) || [...working.values()].some((item) => item.suno_subject === row.suno_subject)) throw uniqueError();
        working.set(row.id, { suno_email: null, suno_name: null, scopes: null, last_error_code: null, created: new Date(), ...row });
      },
      async updateAccount(id, patch) { if (working.has(id)) working.set(id, { ...working.get(id), ...patch }); },
      async updateAttempt(id, patch) { if (attempts.has(id)) Object.assign(attempts.get(id), patch); },
    };
  }

  return {
    accounts, attempts, clients,
    transaction(change) {
      const run = chain.then(async () => {
        const working = new Map([...accounts].map(([id, row]) => [id, { ...row }]));
        const result = await change(tx(working));
        accounts.clear();
        for (const [id, row] of working) accounts.set(id, row);
        return result;
      });
      chain = run.catch(() => {});
      return run;
    },
    async getClient(redirectUri) { return clients.get(redirectUri) || null; },
    async saveClient(redirectUri, clientId) { if (!clients.has(redirectUri)) clients.set(redirectUri, clientId); return clients.get(redirectUri); },
    async createAttempt(attempt) {
      const pending = [...attempts.values()].filter((item) => item.account_id === attempt.account_id && item.status === 'pending')
        .sort((a, b) => b.created - a.created);
      for (const old of pending.slice(9)) attempts.delete(old.id);
      attempts.set(attempt.id, { ...attempt, status: 'pending', suno_account_id: null, code: null, created: Date.now() + attempts.size / 1000,
        expires: new Date(Date.now() + 600000) });
    },
    async getAttempt(accountId, id) {
      const row = attempts.get(id);
      return row && String(row.account_id) === String(accountId) ? { ...row, expired: row.expires < new Date() } : null;
    },
    async claimAttempt(stateDigest) {
      const row = [...attempts.values()].find((item) => item.state_digest === stateDigest);
      if (!row || row.status !== 'pending' || row.expires <= new Date() || !row.verifier) return null;
      const claimed = { ...row };
      row.verifier = '';
      return claimed;
    },
    async finishAttempt(id, patch) { if (attempts.has(id)) Object.assign(attempts.get(id), patch); },
    async listAccounts(accountId) {
      return [...accounts.values()].filter((row) => String(row.account_id) === String(accountId)).sort((a, b) => a.created - b.created).map(copy);
    },
    async getAccount(accountId, id) {
      const row = accounts.get(id);
      return row && String(row.account_id) === String(accountId) ? copy(row) : null;
    },
    async deleteAccount(accountId, id) {
      const row = accounts.get(id);
      if (!row || String(row.account_id) !== String(accountId)) return false;
      accounts.delete(id);
      for (const attempt of attempts.values()) {
        if (attempt.suno_account_id === id) attempt.suno_account_id = null;
        if (attempt.replace_account_id === id) attempt.replace_account_id = null;
      }
      return true;
    },
  };
}
