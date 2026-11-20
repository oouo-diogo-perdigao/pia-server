/**
 * Fixture em memória com semântica transacional (BEGIN / COMMIT / ROLLBACK)
 * para testes multi-conta de `src/connectors.js`, sem banco real nem rede.
 */

const LEGACY_PREFIX = 'PIA-BACKUP-PLAIN-1\n';

function cloneState(store) {
  return {
    accounts: new Map(
      [...store.accounts.entries()].map(([id, acc]) => [id, structuredClone(acc)]),
    ),
    connectors: new Map(
      [...store.connectors.entries()].map(([key, row]) => [key, structuredClone(row)]),
    ),
    profiles: new Map(
      [...store.profiles.entries()].map(([id, row]) => [id, structuredClone(row)]),
    ),
  };
}

export function buildLegacyProfileSnapshot({
  settings = [],
  documents = [],
  secrets = {},
  chats = {},
} = {}) {
  const payload = {
    version: 1,
    settings,
    documents,
    secrets,
  };
  return {
    version: 1,
    backup: Buffer.from(LEGACY_PREFIX + JSON.stringify(payload), 'utf8').toString('base64'),
    chats,
  };
}

export function createMemoryConnectorsStore({ seal, unseal }) {
  let committed = {
    accounts: new Map(),
    connectors: new Map(),
    profiles: new Map(),
  };
  const writeFailures = [];
  const queryLog = [];

  function connectorKey(accountId, type) {
    return `${accountId}:${type}`;
  }

  function addAccount({
    id,
    email = `conta${id}@example.invalid`,
    connectors_initialized = false,
    discord_token = null,
    discord_bot_id = null,
    drive_refresh = null,
    folder_id = null,
  }) {
    const account = {
      id,
      email,
      connectors_initialized: Boolean(connectors_initialized),
      discord_token,
      discord_bot_id,
      drive_refresh,
      folder_id,
    };
    committed.accounts.set(id, account);
    return account;
  }

  function setLegacyProfile(accountId, snapshot) {
    committed.profiles.set(accountId, {
      account_id: accountId,
      ciphertext: seal(JSON.stringify(snapshot)),
    });
  }

  function seedConnectorPart(accountId, type, part) {
    committed.connectors.set(connectorKey(accountId, type), {
      account_id: accountId,
      type,
      ciphertext: seal(JSON.stringify(part)),
    });
  }

  function readDecryptedPart(accountId, type) {
    const row = committed.connectors.get(connectorKey(accountId, type));
    return row?.ciphertext ? JSON.parse(unseal(row.ciphertext)) : null;
  }

  function listConnectorTypes(accountId) {
    return [...committed.connectors.values()]
      .filter((row) => row.account_id === accountId)
      .map((row) => row.type)
      .sort();
  }

  function getAccount(accountId) {
    return committed.accounts.get(accountId) || null;
  }

  function failNextWrite(
    error = new Error('Falha simulada de escrita no armazenamento de conectores.'),
    matcher = /INSERT INTO pia_server\.connectors|DELETE FROM pia_server\.connectors/i,
  ) {
    writeFailures.push({ error, matcher });
  }

  function maybeFailWrite(sql) {
    const index = writeFailures.findIndex((item) => item.matcher.test(sql));
    if (index === -1) return;
    const [{ error }] = writeFailures.splice(index, 1);
    throw error;
  }

  function executeQuery(target, rawSql, params = []) {
    const sql = String(rawSql).replace(/\s+/g, ' ').trim();
    queryLog.push({ sql, params: structuredClone(params) });

    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return { rows: [], rowCount: 0 };
    }

    if (/^SELECT id FROM pia_server\.accounts WHERE id=\$1 FOR UPDATE$/i.test(sql)) {
      const account = target.accounts.get(params[0]);
      return { rows: account ? [{ id: account.id }] : [], rowCount: account ? 1 : 0 };
    }

    if (
      /SELECT a\.connectors_initialized AS initialized,c\.ciphertext FROM pia_server\.accounts a LEFT JOIN pia_server\.connectors c ON c\.account_id=a\.id WHERE a\.id=\$1/i.test(
        sql,
      )
    ) {
      const account = target.accounts.get(params[0]);
      if (!account) return { rows: [], rowCount: 0 };
      const parts = [...target.connectors.values()].filter((row) => row.account_id === account.id);
      if (parts.length === 0) {
        return {
          rows: [{ initialized: account.connectors_initialized, ciphertext: null }],
          rowCount: 1,
        };
      }
      return {
        rows: parts.map((row) => ({
          initialized: account.connectors_initialized,
          ciphertext: row.ciphertext,
        })),
        rowCount: parts.length,
      };
    }

    if (/^SELECT ciphertext FROM pia_server\.profiles WHERE account_id=\$1$/i.test(sql)) {
      const profile = target.profiles.get(params[0]);
      return {
        rows: profile ? [{ ciphertext: profile.ciphertext }] : [],
        rowCount: profile ? 1 : 0,
      };
    }

    if (
      /^DELETE FROM pia_server\.connectors WHERE account_id=\$1 AND NOT\(type=ANY\(\$2::text\[\]\)\)$/i.test(
        sql,
      )
    ) {
      maybeFailWrite(sql);
      const [accountId, keepTypes] = params;
      const keep = new Set(keepTypes || []);
      let removed = 0;
      for (const [key, row] of [...target.connectors.entries()]) {
        if (row.account_id === accountId && !keep.has(row.type)) {
          target.connectors.delete(key);
          removed += 1;
        }
      }
      return { rows: [], rowCount: removed };
    }

    if (/^INSERT INTO pia_server\.connectors\(account_id,type,ciphertext\)/i.test(sql)) {
      maybeFailWrite(sql);
      const [accountId, type, ciphertext] = params;
      target.connectors.set(connectorKey(accountId, type), {
        account_id: accountId,
        type,
        ciphertext,
      });
      return { rows: [], rowCount: 1 };
    }

    if (
      /^UPDATE pia_server\.accounts SET connectors_initialized=true WHERE id=\$1$/i.test(sql)
    ) {
      const account = target.accounts.get(params[0]);
      if (account) account.connectors_initialized = true;
      return { rows: [], rowCount: account ? 1 : 0 };
    }

    if (
      /^UPDATE pia_server\.accounts SET discord_token=NULL,discord_bot_id=NULL WHERE id=\$1$/i.test(
        sql,
      )
    ) {
      const account = target.accounts.get(params[0]);
      if (account) {
        account.discord_token = null;
        account.discord_bot_id = null;
      }
      return { rows: [], rowCount: account ? 1 : 0 };
    }

    if (/^SELECT account_id AS id FROM pia_server\.connectors WHERE type='legacy'$/i.test(sql)) {
      const rows = [...target.connectors.values()]
        .filter((row) => row.type === 'legacy')
        .map((row) => ({ id: row.account_id }));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`Query SQL não suportada na fixture de conectores: ${sql}`);
  }

  function install(t, pool) {
    t.mock.method(pool, 'query', async (sql, params) => executeQuery(committed, sql, params));
    t.mock.method(pool, 'connect', async () => {
      let tx = null;
      return {
        async query(rawSql, params) {
          const sql = String(rawSql).replace(/\s+/g, ' ').trim();
          if (sql === 'BEGIN') {
            tx = cloneState(committed);
            queryLog.push({ sql, params: [] });
            return { rows: [], rowCount: 0 };
          }
          if (sql === 'COMMIT') {
            if (tx) committed = tx;
            tx = null;
            queryLog.push({ sql, params: [] });
            return { rows: [], rowCount: 0 };
          }
          if (sql === 'ROLLBACK') {
            tx = null;
            queryLog.push({ sql, params: [] });
            return { rows: [], rowCount: 0 };
          }
          return executeQuery(tx || committed, sql, params);
        },
        release() {
          tx = null;
        },
      };
    });
  }

  return {
    addAccount,
    setLegacyProfile,
    seedConnectorPart,
    readDecryptedPart,
    listConnectorTypes,
    getAccount,
    failNextWrite,
    install,
    queryLog,
  };
}

export function mockAuthenticatedFetch(t, handler) {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const entry = {
      url: String(url),
      method: init.method || 'GET',
      headers: { ...(init.headers || {}) },
      body: init.body,
    };
    calls.push(entry);
    if (handler) return handler(entry, calls);
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: 'msg-mock-001', status: 'SENT' };
      },
    };
  });
  return calls;
}
