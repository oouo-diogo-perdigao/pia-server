import { isAdminVpnAllowed } from './admin_vpn.js';

export const ADMIN_VPN_ERROR = 'Acesso ao painel administrativo permitido somente via VPN.';

/**
 * Calcula os flags de plano, modo efetivo e autorização administrativa para `/api/status`.
 * Contas comuns (não-Pro) sempre têm `server_processing` efetivo `false`.
 */
export function accountStatusFlags(account, req, vpnCheck = isAdminVpnAllowed) {
  const pro = Boolean(account?.pro);
  const isAdminAccount = Boolean(account?.admin);
  const adminVpnAllowed = Boolean(req && vpnCheck(req));
  return {
    pro,
    server_processing: Boolean(pro && account?.server_processing),
    isAdminAccount,
    adminVpnAllowed,
    admin: Boolean(isAdminAccount && adminVpnAllowed),
  };
}

/**
 * Normaliza uma linha de conta para a listagem e mutações administrativas.
 */
export function formatAdminAccount(row) {
  const pro = Boolean(row.pro);
  return {
    id: row.id,
    email: row.email,
    admin: Boolean(row.admin),
    pro,
    server_processing: Boolean(pro && row.server_processing),
  };
}

function parseAccountId(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0 ? String(raw) : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[1-9]\d{0,18}$/.test(trimmed)) return trimmed;
  }
  return null;
}

/**
 * Garante que a requisição para qualquer rota `/api/admin/*` venha de uma sessão
 * administradora e de um IP autorizado em `PIA_ADMIN_VPN_CIDRS`.
 */
export function isAdminRequestAuthorized(req, account, vpnCheck = isAdminVpnAllowed) {
  return Boolean(account?.admin && vpnCheck(req));
}

export async function listAdminAccounts(pool) {
  const { rows } = await pool.query(
    'SELECT id, email, admin, pro, server_processing FROM pia_server.accounts ORDER BY id ASC',
  );
  return { accounts: rows.map(formatAdminAccount) };
}

export async function authorizeAdminAccount(pool, data) {
  const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error('E-mail inválido.');
  }
  const { rows } = await pool.query(
    `INSERT INTO pia_server.accounts(email) VALUES($1)
     ON CONFLICT(email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, admin, pro, server_processing`,
    [email],
  );
  return { ok: true, account: formatAdminAccount(rows[0]) };
}

export async function setAccountPro(pool, data) {
  const id = parseAccountId(data?.id);
  if (!id) throw new Error('ID de conta inválido.');
  if (typeof data?.pro !== 'boolean') throw new Error('Valor de pro inválido.');
  const { rows } = await pool.query(
    `UPDATE pia_server.accounts SET pro=$2 WHERE id=$1
     RETURNING id, email, admin, pro, server_processing`,
    [id, data.pro],
  );
  if (!rows.length) return { status: 404, body: { error: 'Conta não encontrada.' } };
  return { status: 200, body: { ok: true, account: formatAdminAccount(rows[0]) } };
}

/**
 * Atualiza o modo de processamento da conta autenticada de forma atômica.
 * Ativar `server_processing = true` exige `pro = true` na mesma instrução SQL.
 */
export async function setProcessingMode(pool, account, data) {
  if (typeof data?.server_processing !== 'boolean') {
    throw new Error('Valor de server_processing inválido.');
  }
  if (data.server_processing) {
    const { rows } = await pool.query(
      `UPDATE pia_server.accounts SET server_processing=true
       WHERE id=$1 AND pro=true
       RETURNING pro, server_processing`,
      [account.id],
    );
    if (!rows.length) {
      return {
        status: 403,
        body: {
          error: 'O processamento no servidor exige o Plano Pro.',
          pro: false,
          server_processing: false,
        },
      };
    }
    return {
      status: 200,
      body: {
        ok: true,
        pro: Boolean(rows[0].pro),
        server_processing: Boolean(rows[0].pro && rows[0].server_processing),
      },
    };
  }

  const { rows } = await pool.query(
    `UPDATE pia_server.accounts SET server_processing=false
     WHERE id=$1
     RETURNING pro, server_processing`,
    [account.id],
  );
  if (!rows.length) {
    return { status: 404, body: { error: 'Conta não encontrada.' } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      pro: Boolean(rows[0].pro),
      server_processing: Boolean(rows[0].pro && rows[0].server_processing),
    },
  };
}
