const copyButton = document.getElementById('copy-code');
const codeInput = document.getElementById('oauth-code');
const statusEl = document.getElementById('copy-status');

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function fallbackCopy(input) {
  input.focus();
  input.select();
  input.setSelectionRange(0, input.value.length);
  return typeof document.execCommand === 'function' && document.execCommand('copy');
}

if (copyButton && codeInput) {
  copyButton.addEventListener('click', async () => {
    const code = codeInput.value;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(code);
        setStatus('Código copiado. Volte à PIA e cole para continuar.');
        return;
      }
    } catch {
      // Fallback below when Clipboard API is unavailable or denied.
    }
    try {
      if (fallbackCopy(codeInput)) {
        setStatus('Código copiado. Volte à PIA e cole para continuar.');
        return;
      }
    } catch {
      // Selection remains active for manual copy.
    }
    codeInput.focus();
    codeInput.select();
    setStatus('Não foi possível copiar automaticamente. Use Ctrl+C para copiar o código.');
  });
}
