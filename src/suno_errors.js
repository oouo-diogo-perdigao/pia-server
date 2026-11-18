// Erros públicos das rotas Suno: sempre `{error, code}`, e o `code` só sai
// quando está na lista branca (o handler geral de index.js usa publicError).

export const publicCodes = new Set([
  'bad_request', 'internal_error', 'suno_connect_not_found',
  'suno_not_connected', 'suno_credential_expired', 'suno_unavailable', 'suno_identity_unavailable',
  'suno_account_taken', 'suno_account_mismatch', 'suno_account_not_found', 'suno_oauth_denied', 'suno_oauth_invalid',
  'suno_account_required', 'suno_job_active', 'suno_no_credits', 'suno_timeout', 'suno_track_unavailable',
  'incomplete_batch', 'download_failed', 'suno_job_not_found',
]);

export class SunoError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SunoError';
    this.code = code;
    this.status = status;
  }
}

export function publicError(error) {
  if (error instanceof SunoError && publicCodes.has(error.code))
    return { status: error.status, body: { error: error.message, code: error.code } };
  return null;
}

export const sunoMessages = {
  taken: 'Esta conta Suno já está conectada a outra conta PIA. Desconecte-a lá antes de conectá-la aqui.',
  mismatch: 'A conta autorizada no Suno não é a conta que você pediu para reconectar.',
  identity: 'O Suno não informou a identidade da conta. Tente de novo mais tarde.',
  unavailable: 'O Suno não respondeu. Tente de novo em instantes.',
  expired: 'A conexão com o Suno expirou. Conecte a conta de novo.',
  notConnected: 'Conecte uma conta Suno na PIA Server.',
  denied: 'O Suno não autorizou a conexão.',
  invalid: 'Autorização inválida ou expirada. Conecte de novo pela PIA.',
};
