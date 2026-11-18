// Serializa as suítes que usam as tabelas Suno no Postgres real: o `node --test`
// roda arquivos em paralelo e as suítes limpam suno_accounts/suno_oauth_clients.
const KEY = 7310001;

export async function lockSunoTables(pool) {
  const client = await pool.connect();
  await client.query('SELECT pg_advisory_lock($1)', [KEY]);
  return async () => {
    try { await client.query('SELECT pg_advisory_unlock($1)', [KEY]); } finally { client.release(); }
  };
}
