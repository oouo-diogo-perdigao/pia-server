const element = (id) => document.getElementById(id);
const say = (text) => { element('feedback').textContent = text; };
let savedRules = null;
let savingRules = false;
let selectedDriveAccount = '';
let currentState = null;
let savedPro = null;
let savedServerProcessing = false;
let draftServerProcessing = null;
let savingProcessingMode = false;
let planChangedNotice = '';
let adminAccounts = [];
let adminAccountsLoaded = false;
let loadingAdminAccounts = false;
const adminBusyIds = new Set();

const rulesDirty = () => savedRules !== null && element('rules').value !== savedRules;
function updateRulesButton() { element('save-rules').disabled = savingRules || !rulesDirty(); }
const isProcessingDirty = () => savedPro === true && draftServerProcessing !== null && draftServerProcessing !== savedServerProcessing;
const isValidEmail = (value) => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;

function resolveAdminAccess(state) {
  const effectiveAdmin = Boolean(state?.admin);
  const vpnAllowed = state?.adminVpnAllowed === undefined ? effectiveAdmin : Boolean(state.adminVpnAllowed);
  const isAdminAccount = state?.isAdminAccount === undefined ? effectiveAdmin : Boolean(state.isAdminAccount);
  return {
    effectiveAdmin: effectiveAdmin && vpnAllowed,
    isAdminAccount,
    vpnAllowed,
  };
}

async function api(path, data) {
  const response = await fetch('/api/' + path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.error || 'Falha na solicitação.');
    error.status = response.status;
    error.data = value;
    throw error;
  }
  return value;
}

function on(id, action) {
  element(id).onclick = async () => {
    const button = element(id);
    button.disabled = true;
    say('');
    try { await action(); }
    catch (error) { say(error.message); }
    finally { button.disabled = false; }
  };
}

let destinationRequest = 0;
let currentRecordingFolder;
let destinationLabel;
async function showRecordingPath() {
  const id = currentRecordingFolder;
  const request = ++destinationRequest;
  if (!id) return;
  const label = element('recording-destination');
  try {
    const result = await api('recording-folder');
    if (request === destinationRequest && result.id === id && result.path.length)
      label.textContent = result.path.join(' / ');
  } catch {
    if (request === destinationRequest) label.textContent = destinationLabel + ' · caminho indisponível';
  }
}

function currentPage() {
  const [section] = (location.hash || '').split('/');
  return section ? section.slice(1) : 'recordings';
}

function applyStatusToProcessing(state) {
  const wasPro = savedPro === true;
  const nextPro = Boolean(state?.pro);
  const nextServerProcessing = nextPro ? Boolean(state?.server_processing) : false;
  if (wasPro && !nextPro) {
    planChangedNotice = 'Seu plano mudou. Novas gravações serão processadas somente localmente.';
    draftServerProcessing = false;
  } else if (nextPro && !wasPro && savedPro !== null) {
    planChangedNotice = '';
  }
  const hadDraft = isProcessingDirty();
  savedPro = nextPro;
  savedServerProcessing = nextServerProcessing;
  if (!hadDraft || !nextPro || draftServerProcessing === null) {
    draftServerProcessing = nextServerProcessing;
  }
}

function computeMissingPrerequisites(state) {
  if (Array.isArray(state?.missingPrerequisites) && state.missingPrerequisites.length) {
    return state.missingPrerequisites.map((item) => {
      if (typeof item === 'string') {
        const lower = item.toLowerCase();
        if (lower.includes('bucket') || lower.includes('storage')) return { label: item, href: '#connectors/storage', linkText: 'Conectores / Object Storage' };
        if (lower.includes('campanha') || lower.includes('regra')) return { label: item, href: '#recordings', linkText: 'Regras de gravação' };
        return { label: item };
      }
      return item;
    });
  }
  const missing = [];
  const hasStorage = state?.hasObjectStorage !== undefined
    ? Boolean(state.hasObjectStorage)
    : (connectorState ? Boolean(connectorState.objectStorage?.length) : true);
  if (!hasStorage) {
    missing.push({ label: 'bucket/Object Storage', href: '#connectors/storage', linkText: 'Conectores / Object Storage' });
  }
  const hasCampaign = state?.hasCampaign !== undefined
    ? Boolean(state.hasCampaign)
    : (Array.isArray(state?.rules) ? state.rules.length > 0 : true);
  if (!hasCampaign) {
    missing.push({ label: 'campanha/regras de gravação', href: '#recordings', linkText: 'Regras de gravação' });
  }
  return missing;
}

function renderProcessingSection() {
  const loading = element('processing-loading');
  const notice = element('processing-plan-notice');
  const standard = element('processing-standard');
  const pro = element('processing-pro');
  if (savedPro === null) {
    loading.hidden = false;
    standard.hidden = true;
    pro.hidden = true;
    notice.hidden = true;
    return;
  }
  loading.hidden = true;
  if (planChangedNotice) {
    notice.textContent = planChangedNotice;
    notice.hidden = false;
  } else {
    notice.textContent = '';
    notice.hidden = true;
  }
  if (!savedPro) {
    standard.hidden = false;
    pro.hidden = true;
    return;
  }
  standard.hidden = true;
  pro.hidden = false;
  const localRadio = element('processing-mode-local');
  const serverRadio = element('processing-mode-server');
  const saveBtn = element('save-processing-mode');
  localRadio.checked = draftServerProcessing === false;
  serverRadio.checked = draftServerProcessing === true;
  localRadio.disabled = savingProcessingMode;
  serverRadio.disabled = savingProcessingMode;
  saveBtn.disabled = savingProcessingMode || !isProcessingDirty();

  const missing = computeMissingPrerequisites(currentState);
  const ineligible = currentState?.serverProcessingEligible === false || missing.length > 0;
  const savedLabel = savedServerProcessing ? 'Processar no servidor (Pro)' : 'Processar somente local';
  const savedModeEl = element('processing-saved-mode');
  if (savedServerProcessing && ineligible) {
    savedModeEl.textContent = 'Modo salvo: ' + savedLabel + ' · Estado efetivo: bloqueado até configurar os pré-requisitos.';
  } else {
    savedModeEl.textContent = 'Modo salvo: ' + savedLabel + '.';
  }

  const prereqEl = element('processing-prerequisites');
  if ((draftServerProcessing || savedServerProcessing) && missing.length > 0) {
    const names = missing.map((item) => item.label).join(' e ');
    prereqEl.replaceChildren('Para processar no servidor, configure ' + names + '. ');
    const links = missing.filter((item) => item.href);
    links.forEach((item, index) => {
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.linkText || item.label;
      if (index > 0) prereqEl.append(' · ');
      prereqEl.append(a);
    });
    prereqEl.hidden = false;
  } else {
    prereqEl.replaceChildren();
    prereqEl.hidden = true;
  }
}

function renderAdminView() {
  const access = resolveAdminAccess(currentState);
  const denied = element('admin-denied');
  const blocked = element('admin-vpn-blocked');
  const content = element('admin-content');
  if (access.effectiveAdmin) {
    denied.hidden = true;
    blocked.hidden = true;
    content.hidden = false;
  } else if (access.isAdminAccount) {
    denied.hidden = true;
    blocked.hidden = false;
    content.hidden = true;
  } else {
    denied.hidden = false;
    blocked.hidden = true;
    content.hidden = true;
  }
}

function clearAdminData() {
  adminAccounts = [];
  adminAccountsLoaded = false;
  loadingAdminAccounts = false;
  adminBusyIds.clear();
  element('admin-accounts').replaceChildren();
  element('admin-accounts-status').textContent = '';
  element('admin-feedback').textContent = '';
}

function handleAdminForbidden(message) {
  clearAdminData();
  if (currentState) {
    currentState = { ...currentState, admin: false, adminVpnAllowed: false };
  }
  element('admin-link').hidden = true;
  renderAdminView();
  const access = resolveAdminAccess(currentState);
  const text = message || (access.isAdminAccount
    ? 'Acesso administrativo indisponível fora da VPN autorizada.'
    : 'Acesso negado.');
  element('admin-blocked-feedback').textContent = access.isAdminAccount ? text : '';
  say(text);
}

function setAdminControlsDisabled(disabled) {
  element('email').disabled = disabled;
  element('add-account').disabled = disabled;
  element('admin-refresh').disabled = disabled;
}

function renderAdminAccounts(focusAccountId = null) {
  const list = element('admin-accounts');
  const statusEl = element('admin-accounts-status');
  if (loadingAdminAccounts) {
    statusEl.textContent = 'Carregando contas…';
    setAdminControlsDisabled(true);
    return;
  }
  setAdminControlsDisabled(false);
  if (!adminAccountsLoaded) {
    list.replaceChildren();
    return;
  }
  if (!adminAccounts.length) {
    statusEl.textContent = 'Nenhuma conta cadastrada.';
    list.replaceChildren();
    return;
  }
  statusEl.textContent = '';
  let buttonToFocus = null;
  list.replaceChildren(...adminAccounts.map((acc) => {
    const li = document.createElement('li');
    li.className = 'admin-account-item';
    const info = document.createElement('div');
    info.className = 'admin-account-info';
    const emailEl = document.createElement('span');
    emailEl.className = 'admin-account-email';
    emailEl.textContent = acc.email;
    const meta = document.createElement('div');
    meta.className = 'admin-account-meta';

    const idBadge = document.createElement('span');
    idBadge.className = 'account-badge';
    idBadge.textContent = 'ID ' + acc.id;
    meta.append(idBadge);

    if (acc.admin) {
      const adminBadge = document.createElement('span');
      adminBadge.className = 'account-badge account-badge--admin';
      adminBadge.textContent = 'Administrador';
      meta.append(adminBadge);
    }

    const proBadge = document.createElement('span');
    proBadge.className = 'account-badge' + (acc.pro ? ' account-badge--pro' : '');
    proBadge.textContent = acc.pro ? 'Pro habilitado' : 'Pro desabilitado';
    meta.append(proBadge);

    const modeBadge = document.createElement('span');
    modeBadge.className = 'account-badge';
    modeBadge.textContent = (acc.pro && acc.server_processing) ? 'Modo: Servidor' : 'Modo: Somente local';
    meta.append(modeBadge);

    info.append(emailEl, meta);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'switch-pro';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(Boolean(acc.pro)));
    toggle.setAttribute('aria-label', 'Plano Pro de ' + acc.email);
    toggle.textContent = acc.pro ? 'Habilitado' : 'Desabilitado';
    toggle.disabled = adminBusyIds.has(acc.id);
    toggle.onclick = () => toggleAccountPro(acc, toggle);

    if (focusAccountId !== null && acc.id === focusAccountId) {
      buttonToFocus = toggle;
    }
    li.append(info, toggle);
    return li;
  }));
  if (buttonToFocus && typeof buttonToFocus.focus === 'function') buttonToFocus.focus();
}

async function loadAdminAccounts() {
  const access = resolveAdminAccess(currentState);
  if (!access.effectiveAdmin) return;
  loadingAdminAccounts = true;
  renderAdminAccounts();
  try {
    const data = await api('admin/accounts');
    adminAccounts = Array.isArray(data?.accounts) ? data.accounts : [];
    adminAccountsLoaded = true;
    loadingAdminAccounts = false;
    renderAdminAccounts();
  } catch (error) {
    loadingAdminAccounts = false;
    setAdminControlsDisabled(false);
    if (error.status === 403) {
      handleAdminForbidden(error.message);
      return;
    }
    element('admin-accounts-status').textContent = 'Não foi possível carregar as contas. Tente novamente.';
    say(error.message || 'Não foi possível carregar as contas.');
  }
}

async function toggleAccountPro(account, button) {
  const nextPro = !account.pro;
  adminBusyIds.add(account.id);
  button.disabled = true;
  element('admin-feedback').textContent = '';
  say('');
  try {
    const result = await api('admin/accounts/pro', { id: account.id, pro: nextPro });
    const updated = result?.account || (result?.id !== undefined ? { ...account, ...result } : { ...account, pro: nextPro });
    adminAccounts = adminAccounts.map((item) => (item.id === account.id ? { ...item, ...updated } : item));
    adminBusyIds.delete(account.id);
    renderAdminAccounts(account.id);
    const msg = updated.pro
      ? 'Plano Pro habilitado.'
      : 'Plano Pro desabilitado. Novas gravações dessa conta passam ao modo local.';
    element('admin-feedback').textContent = msg;
    say(msg);
    if (currentState && (currentState.id === account.id || currentState.email === account.email)) {
      await refresh().catch(() => {});
    }
  } catch (error) {
    adminBusyIds.delete(account.id);
    if (error.status === 403) {
      handleAdminForbidden(error.message);
      return;
    }
    button.disabled = false;
    if (typeof button.focus === 'function') button.focus();
    const msg = error.message || 'Não foi possível atualizar o plano Pro.';
    element('admin-feedback').textContent = msg;
    say(msg);
  }
}

async function refresh() {
  const state = await api('status');
  currentState = state;
  const adminAccess = resolveAdminAccess(state);
  element('panel').hidden = false;
  element('login').hidden = true;
  element('admin-link').hidden = !adminAccess.effectiveAdmin;
  if (!adminAccess.effectiveAdmin) clearAdminData();
  renderAdminView();
  applyStatusToProcessing(state);
  renderProcessingSection();
  if (adminAccess.effectiveAdmin && currentPage() === 'admin' && !adminAccountsLoaded && !loadingAdminAccounts) {
    void loadAdminAccounts();
  }
  element('account').title = state.email;
  element('account-email').textContent = state.email;
  element('account-initial').textContent = state.email[0]?.toUpperCase() || '';
  const picture = element('account-picture');
  if (state.picture) {
    if (picture.getAttribute('src') !== state.picture) picture.src = state.picture;
  } else {
    picture.removeAttribute('src');
    picture.hidden = true;
    element('account-initial').hidden = false;
  }
  element('connections').textContent = 'Discord: ' + (state.discordConnected ? 'conectado' :
    state.discordError || (state.discordConfigured ? 'conectando' : 'aguardando token')) +
    ' · Google Drive: ' + (state.driveConnected ? 'autorizado' : 'aguardando autorização');
  element('folder').hidden = !state.folderId;
  if (state.folderId) element('folder').href = 'https://drive.google.com/drive/folders/' + encodeURIComponent(state.folderId);
  selectedDriveAccount = state.recordingDriveAccount || 'server-google-primary';
  currentRecordingFolder = state.folderId;
  destinationRequest++;
  destinationLabel = state.folderId ?
    (state.folderName || 'Pasta de gravações já configurada') : 'Nenhuma pasta selecionada.';
  element('recording-destination').textContent = destinationLabel;
  if (!location.hash || location.hash === '#recordings') void showRecordingPath();
  if (!rulesDirty() && !savingRules) {
    savedRules = JSON.stringify(state.rules, null, 2);
    element('rules').value = savedRules;
  }
  updateRulesButton();
  element('recordings').replaceChildren(...state.recordings.map((item) => {
    const li = document.createElement('li');
    li.textContent = item.name + ' · ' + item.state + (item.error ? ' · ' + item.error : '') +
      (item.note ? ' · ' + item.note : '');
    if (item.state === 'recording') {
      const stop = document.createElement('button');
      stop.textContent = 'Encerrar gravação';
      stop.onclick = async () => {
        stop.disabled = true;
        try { await api('recordings/stop', { channelId: item.channelId }); await refresh(); }
        catch (error) { say(error.message); stop.disabled = false; }
      };
      li.append(' ', stop);
    }
    return li;
  }));
  const list = await api('devices');
  element('devices').replaceChildren(...list.map((device) => {
    const li = document.createElement('li');
    li.textContent = device.name + (device.online ? ' · online' : ' · offline');
    const button = document.createElement('button');
    button.textContent = 'Revogar';
    button.onclick = async () => {
      button.disabled = true;
      try { await api('devices/revoke', { id: device.id }); await refresh(); }
      catch (error) { say(error.message); button.disabled = false; }
    };
    li.append(' ', button);
    return li;
  }));
}

element('rules').oninput = updateRulesButton;
on('example', () => {
  element('rules').value = JSON.stringify([{
    guildId: '', channelId: '', noticeChannelId: '', minPeople: 2, triggerUsers: [], emptySeconds: 30,
  }], null, 2);
  updateRulesButton();
});
on('save-discord', async () => {
  const token = botSecrets.discord.edited();
  if (!token) throw new Error('Informe um novo token do Discord.');
  await api('discord', { token });
  element('discord').value = '';
  await refreshConnectors();
  say('Bot salvo.');
  await refresh();
});
let drivePath = [];
let drivePage = null;
let driveRequest = 0;
const drivePicker = element('drive-picker');
const rootFolder = { id: 'root', name: 'Meu Drive' };

async function showDriveFolders(path, cursor) {
  const version = ++driveRequest;
  const feedback = element('drive-picker-feedback');
  const list = element('drive-folders');
  const identity = element('drive-account').value;
  drivePath = path;
  drivePage = null;
  element('drive-select').disabled = true;
  element('drive-create').disabled = true;
  element('drive-more').hidden = true;
  if (!cursor) list.replaceChildren();
  element('drive-path').replaceChildren(...path.map((folder, index) => {
    const button = document.createElement('button');
    button.textContent = folder.name;
    button.onclick = () => showDriveFolders(path.slice(0, index + 1));
    return button;
  }));
  feedback.textContent = 'Carregando pastas…';
  try {
    const result = await api('recording-folders', { identity, folder: path.at(-1).id, cursor });
    if (version !== driveRequest || !drivePicker.open) return;
    drivePage = result;
    for (const folder of result.folders) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = folder.name;
      button.onclick = () => showDriveFolders([...path, folder]);
      item.append(button);
      list.append(item);
    }
    element('drive-select').disabled = !result.current.writable;
    element('drive-create').disabled = !(result.current.writable || result.current.canCreate);
    element('drive-more').hidden = !result.cursor;
    feedback.textContent = !list.children.length ? 'Nenhuma subpasta disponível nesta conta.' : '';
  } catch (error) {
    if (version === driveRequest) feedback.textContent = error.message;
  }
}

on('drive', async () => {
  const state = await api('connectors');
  const accounts = [...(state.primaryGoogle ? [state.primaryGoogle] : []), ...state.google];
  if (!accounts.length) throw new Error('Autorize uma conta em Conectores / Google.');
  const select = element('drive-account');
  select.replaceChildren(...accounts.map((account) =>
    new Option(account.email || account.label || account.id, account.id)));
  if (accounts.some((account) => account.id === selectedDriveAccount)) select.value = selectedDriveAccount;
  element('drive-new-folder').value = '';
  drivePicker.showModal();
  await showDriveFolders([rootFolder]);
});
element('drive-account').onchange = () => showDriveFolders([rootFolder]);
element('drive-close').onclick = () => drivePicker.close();
element('drive-google-settings').onclick = () => drivePicker.close();
element('drive-more').onclick = () => showDriveFolders(drivePath, drivePage?.cursor);
async function saveDriveFolder(name) {
  const current = drivePage?.current;
  if (!(current?.writable || (name && current?.canCreate))) return;
  element('drive-select').disabled = true;
  element('drive-create').disabled = true;
  try {
    await api('recording-folder', { identity: element('drive-account').value, folder: current.id, name });
    drivePicker.close();
    await refresh();
    say('Pasta das novas gravações salva.');
  } catch (error) {
    element('drive-picker-feedback').textContent = error.message;
  } finally {
    element('drive-select').disabled = !drivePage?.current.writable;
    element('drive-create').disabled = !(drivePage?.current.writable || drivePage?.current.canCreate);
  }
}
element('drive-select').onclick = () => saveDriveFolder();
element('drive-create').onclick = () => {
  const name = element('drive-new-folder').value.trim();
  if (!name) {
    element('drive-picker-feedback').textContent = 'Informe o nome da nova pasta.';
    return;
  }
  void saveDriveFolder(name);
};

element('save-rules').onclick = async () => {
  if (savingRules || !rulesDirty()) return;
  savingRules = true;
  const draft = element('rules').value;
  updateRulesButton();
  try {
    const result = await api('rules', { rules: JSON.parse(draft) });
    savedRules = JSON.stringify(result.rules, null, 2);
    if (element('rules').value === draft) element('rules').value = savedRules;
    say('Regras salvas.');
  } catch (error) { say(error.message); }
  finally { savingRules = false; updateRulesButton(); }
};
on('prepare-device-drive', async () => {
  await api('drive/folder', {});
  say('Pasta para arquivos dos computadores preparada.');
});
on('refresh', refresh);
element('mcp-expiration').onchange = (event) => {
  element('mcp-custom-expiration').hidden = event.target.value !== 'custom';
};
on('mcp', async () => {
  const duration = element('mcp-expiration').value;
  const custom = element('mcp-days');
  if (duration === 'custom' && !custom.reportValidity()) return;
  const expiresInDays = duration === 'never' ? null : Number(duration === 'custom' ? custom.value : duration);
  const issued = await api('mcp/token', { expiresInDays });
  element('token').textContent = issued.token;
  element('mcp-issued-expiration').textContent = issued.expiresAt ?
    'Válido até ' + new Date(issued.expiresAt).toLocaleString() : 'Sem expiração.';
});
on('mcp-revoke', async () => {
  await api('mcp/revoke', {});
  element('token').textContent = '';
  element('mcp-issued-expiration').textContent = '';
  say('Tokens MCP revogados.');
});
on('logout', async () => { await api('logout', {}); location.reload(); });
function setEmailFieldError(message) {
  const emailInput = element('email');
  const errorEl = element('admin-email-error');
  if (message) {
    emailInput.setAttribute('aria-invalid', 'true');
    errorEl.textContent = message;
    errorEl.hidden = false;
    if (typeof emailInput.focus === 'function') emailInput.focus();
  } else {
    emailInput.setAttribute('aria-invalid', 'false');
    errorEl.textContent = '';
    errorEl.hidden = true;
  }
}

async function submitAddAccount(event) {
  if (event) event.preventDefault();
  const emailInput = element('email');
  const addBtn = element('add-account');
  const raw = emailInput.value.trim();
  element('admin-feedback').textContent = '';
  say('');
  if (!isValidEmail(raw)) {
    setEmailFieldError('Informe um e-mail válido.');
    return;
  }
  setEmailFieldError('');
  addBtn.disabled = true;
  try {
    await api('admin/accounts', { email: raw });
    emailInput.value = '';
    element('admin-feedback').textContent = 'Conta autorizada.';
    say('Conta autorizada.');
    await loadAdminAccounts();
  } catch (error) {
    if (error.status === 403) {
      handleAdminForbidden(error.message);
      return;
    }
    setEmailFieldError(error.message || 'Não foi possível autorizar a conta.');
    element('admin-feedback').textContent = error.message || 'Não foi possível autorizar a conta.';
    say(error.message || 'Não foi possível autorizar a conta.');
  } finally {
    if (resolveAdminAccess(currentState).effectiveAdmin && !loadingAdminAccounts) {
      addBtn.disabled = false;
    }
  }
}

async function saveProcessingMode() {
  if (savingProcessingMode || !isProcessingDirty()) return;
  const desired = Boolean(draftServerProcessing);
  savingProcessingMode = true;
  element('processing-feedback').textContent = '';
  say('');
  renderProcessingSection();
  try {
    const result = await api('recordings/processing-mode', { server_processing: desired });
    const resultPro = result?.pro === undefined ? true : Boolean(result.pro);
    if (!resultPro) {
      savedPro = false;
      savedServerProcessing = false;
      draftServerProcessing = false;
      planChangedNotice = 'Seu plano mudou. Novas gravações serão processadas somente localmente.';
      if (currentState) currentState = { ...currentState, pro: false, server_processing: false };
      say(planChangedNotice);
    } else {
      savedPro = true;
      savedServerProcessing = result?.server_processing === undefined ? desired : Boolean(result.server_processing);
      draftServerProcessing = savedServerProcessing;
      planChangedNotice = '';
      if (currentState) {
        currentState = {
          ...currentState,
          pro: true,
          server_processing: savedServerProcessing,
          ...(result?.missingPrerequisites !== undefined ? { missingPrerequisites: result.missingPrerequisites } : {}),
          ...(result?.serverProcessingEligible !== undefined ? { serverProcessingEligible: result.serverProcessingEligible } : {}),
        };
      }
      element('processing-feedback').textContent = 'Modo de processamento salvo.';
      say('Modo de processamento salvo.');
    }
  } catch (error) {
    if (error.status === 403) {
      savedPro = false;
      savedServerProcessing = false;
      draftServerProcessing = false;
      planChangedNotice = 'Seu plano mudou. Novas gravações serão processadas somente localmente.';
      if (currentState) currentState = { ...currentState, pro: false, server_processing: false };
      element('processing-feedback').textContent = '';
      say(planChangedNotice);
    } else {
      const msg = error.message || 'Não foi possível salvar o modo.';
      element('processing-feedback').textContent = msg;
      say(msg);
      const saveBtn = element('save-processing-mode');
      if (typeof saveBtn.focus === 'function') saveBtn.focus();
    }
  } finally {
    savingProcessingMode = false;
    renderProcessingSection();
  }
}

element('admin-add-form').onsubmit = submitAddAccount;
element('admin-refresh').onclick = () => { void loadAdminAccounts(); };
element('admin-retry').onclick = async () => {
  const retryBtn = element('admin-retry');
  retryBtn.disabled = true;
  element('admin-blocked-feedback').textContent = '';
  try {
    await refresh();
    const access = resolveAdminAccess(currentState);
    if (access.effectiveAdmin) {
      await loadAdminAccounts();
    } else if (access.isAdminAccount) {
      element('admin-blocked-feedback').textContent = 'Acesso ainda indisponível fora da VPN autorizada.';
    }
  } catch (error) {
    element('admin-blocked-feedback').textContent = error.message || 'Não foi possível verificar o acesso.';
  } finally {
    retryBtn.disabled = false;
  }
};
element('processing-mode-local').onchange = () => {
  if (!element('processing-mode-local').checked) return;
  draftServerProcessing = false;
  element('processing-feedback').textContent = '';
  renderProcessingSection();
};
element('processing-mode-server').onchange = () => {
  if (!element('processing-mode-server').checked) return;
  draftServerProcessing = true;
  element('processing-feedback').textContent = '';
  renderProcessingSection();
};
element('save-processing-mode').onclick = () => { void saveProcessingMode(); };

function initUi() {
  refresh().then(navigate).catch(async () => {
    element('login').hidden = false;
    const health = await fetch('/health').then((r) => r.json()).catch(() => null);
    if (!health?.googleLogin) say('O login Google aguarda a configuração do servidor.');
  });
  api('secretary').then((settings) => {
    element('gmail-watch').checked = settings.mail;
    element('calendar-watch').checked = settings.calendar;
    element('calendar-lead').value = settings.lead_minutes;
    element('secretary-error').textContent = settings.last_error || '';
  }).catch(() => {});
}
if (!globalThis.__PIA_UI_TEST__) initUi();
on('secretary-save', async () => {
  await api('secretary', { mail: element('gmail-watch').checked,
    calendar: element('calendar-watch').checked, lead_minutes: Number(element('calendar-lead').value) });
  element('secretary-error').textContent = '';
  say('Secretária salva.');
});
let connectorState;
const input = (id) => element(id).value;

let storageVersion = 0;

function secretField(fieldId, toggleId, label, load) {
  const field = element(fieldId);
  const toggle = element(toggleId);
  let revealed = '';
  let version = 0;

  function visibility(visible) {
    const title = (visible ? 'Ocultar ' : 'Mostrar ') + label;
    toggle.setAttribute('aria-pressed', String(visible));
    toggle.setAttribute('aria-label', title);
    toggle.title = title;
    field.type = visible ? 'text' : 'password';
  }

  function hide() {
    version++;
    if (field.value === revealed) field.value = '';
    revealed = '';
    visibility(false);
  }

  function configured(hasSecret) {
    field.placeholder = hasSecret ? '********' : '';
    toggle.hidden = !hasSecret;
  }

  on(toggleId, async () => {
    if (field.type === 'text') return hide();
    if (!field.value) {
      const request = version;
      const secret = await load();
      if (request !== version || field.value || !secret) return;
      field.value = revealed = secret;
    }
    visibility(true);
  });

  return {
    hide, configured,
    reset() { hide(); field.value = ''; configured(false); },
    edited() { return field.value === revealed ? '' : field.value; },
  };
}

const storageSecret = secretField('storage-secret', 'storage-reveal', 'Secret Key', async () =>
  (await api('connectors/storage-credential', { id: input('storage-account'), reveal: true })).secretKey);
const botSecrets = Object.fromEntries([['discord', 'discord'], ['taverns', 'taverns-token']].map(([provider, field]) =>
  [provider, secretField(field, provider + '-reveal', 'token do bot', async () =>
    (await api('connectors/bot-credential', { provider })).token)]));

async function storageFields() {
  const version = ++storageVersion;
  storageSecret.reset();
  const access = element('storage-access');
  const id = input('storage-account');
  const account = connectorState.objectStorage.find((item) => item.id === id);
  for (const [field, value] of Object.entries({
    name: account?.name, type: account?.provider || 's3', endpoint: account?.endpoint,
    public: account?.public_url, bucket: account?.bucket, region: account?.region,
    color: account?.color || '#9b7aff', access: '',
  })) element('storage-' + field).value = value || '';
  element('storage-default').checked = Boolean(id && id === connectorState.storageDefault);
  element('storage-remove').hidden = !id;
  if (!id) return;
  const data = await api('connectors/storage-credential', { id });
  if (version !== storageVersion) return;
  if (!access.value) access.value = data.accessKey;
  storageSecret.configured(data.hasSecret);
}

async function refreshConnectors(selectedId = input('storage-account')) {
  connectorState = await api('connectors');
  for (const [provider, control] of Object.entries(botSecrets)) {
    control.hide();
    control.configured(connectorState[provider].configured);
  }
  for (const provider of ['google', 'microsoft']) {
    const primary = provider === 'google' && connectorState.primaryGoogle;
    const accounts = primary ? [primary, ...connectorState.google] : connectorState[provider];
    element(provider + '-accounts').replaceChildren(...accounts.map((account) => {
      const item = document.createElement('li');
      item.textContent = account.email || account.label || account.id;
      if (account === primary) item.append(' · conta de login');
      else {
        const button = document.createElement('button');
        button.textContent = 'Desconectar';
        button.onclick = () => removeAccount(provider, account.id).catch((error) => say(error.message));
        item.append(' ', button);
      }
      return item;
    }));
  }
  element('microsoft-client').value = connectorState.microsoftClient;
  element('discord-state').textContent = connectorState.discord.configured ? '· configurado' : '';
  element('discord-channel').value = connectorState.discord.channel;
  element('taverns-state').textContent = connectorState.taverns.configured ? '· configurado' : '';
  const select = element('storage-account');
  select.replaceChildren(new Option('Nova conta', ''), ...connectorState.objectStorage.map((item) => new Option(item.name, item.id)));
  select.value = connectorState.objectStorage.some((item) => item.id === selectedId) ? selectedId : '';
  await storageFields();
}

async function removeAccount(provider, id) {
  if (!window.confirm('Remover este conector da sua conta?')) return;
  await api('connectors/remove', { provider, id });
  await refreshConnectors();
  say('Conector removido.');
}

async function saveConnector(provider, data) {
  const result = await api('connectors/save', { provider, ...data });
  await refreshConnectors(result.id);
  say('Configuração salva.');
}

for (const provider of ['google', 'microsoft']) {
  on(provider + '-add', async () => { location.assign((await api('connectors/oauth', { provider })).url); });
}
on('microsoft-save', async () => {
  await saveConnector('microsoft', { clientId: input('microsoft-client'), clientSecret: input('microsoft-secret') });
  element('microsoft-secret').value = '';
});
on('discord-save-channel', () => saveConnector('discord', { channel: input('discord-channel') }));
on('discord-link', async () => {
  await api('connectors/discord-link', {});
  say('Comando /link habilitado para administradores.');
});
on('discord-remove', async () => { await removeAccount('discord'); await refresh(); });
on('taverns-save', async () => {
  const token = botSecrets.taverns.edited();
  if (!token) throw new Error('Informe um novo token do Taverns.');
  await saveConnector('taverns', { token });
  element('taverns-token').value = '';
});
on('taverns-remove', () => removeAccount('taverns'));
for (const [provider, field] of [['discord', 'discord-channel'], ['taverns', 'taverns-destination']]) {
  on(provider + '-test', async () => {
    await api('connectors/test', { provider, destination: input(field).trim() });
    say('Mensagem de teste enviada.');
  });
}
element('storage-account').onchange = () => storageFields().catch((error) => say(error.message));
on('storage-save', () => saveConnector('object_storage', {
  id: input('storage-account'), name: input('storage-name'), type: input('storage-type'),
  endpoint: input('storage-endpoint'), publicUrl: input('storage-public'), region: input('storage-region'),
  bucket: input('storage-bucket'), color: input('storage-color'), accessKey: input('storage-access'),
  secretKey: storageSecret.edited(), default: element('storage-default').checked,
}));
on('storage-remove', () => removeAccount('object_storage', input('storage-account')));

const accountMenu = element('account-menu');
document.addEventListener('click', (event) => {
  if (!accountMenu.contains(event.target)) accountMenu.open = false;
});
accountMenu.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  accountMenu.open = false;
  element('account').focus();
});

element('account-picture').onload = () => {
  element('account-picture').hidden = false;
  element('account-initial').hidden = true;
};
element('account-picture').onerror = () => {
  element('account-picture').hidden = true;
  element('account-initial').hidden = false;
};

function selectConnector(id) {
  for (const [provider, control] of Object.entries(botSecrets))
    if (id !== provider) control.hide();
  if (id !== 'storage') storageSecret.hide();
  for (const control of document.querySelectorAll('[data-connector]'))
    control.setAttribute('aria-pressed', String(control.dataset.connector === id));
  for (const panel of document.querySelectorAll('[data-connector-panel]'))
    panel.hidden = panel.dataset.connectorPanel !== id;
}

for (const control of document.querySelectorAll('[data-connector]'))
  control.onclick = () => selectConnector(control.dataset.connector);
selectConnector('google');

function navigate(event) {
  const links = Array.from(document.querySelectorAll('aside a.rail-icon:not([hidden])'));
  const [section, connector] = location.hash.split('/');
  const directAdmin = section === '#admin';
  const current = directAdmin ? null : (links.find((link) => link.hash === section) || links[0]);
  const page = directAdmin ? 'admin' : current.hash.slice(1);
  element('page-title').textContent = directAdmin ? 'Administração' : current.getAttribute('aria-label');
  for (const link of links) {
    if (link === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (page === 'admin') {
    element('admin').hidden = false;
    renderAdminView();
    if (resolveAdminAccess(currentState).effectiveAdmin && !loadingAdminAccounts) {
      void loadAdminAccounts();
    }
  } else {
    element('admin').hidden = !resolveAdminAccess(currentState).effectiveAdmin;
  }
  for (const sectionEl of document.querySelectorAll('[data-page]')) {
    sectionEl.classList.toggle('page-hidden', sectionEl.dataset.page !== page);
  }
  if (page === 'recordings' && event) void showRecordingPath();
  if (page === 'connectors') {
    const id = connector === 'object_storage' ? 'storage' : connector;
    if (id && Array.from(document.querySelectorAll('[data-connector]')).some((control) => control.dataset.connector === id)) {
      selectConnector(id);
    }
    refreshConnectors().catch((error) => say(error.message));
  }
  else {
    storageVersion++;
    storageSecret.reset();
    for (const control of Object.values(botSecrets)) control.reset();
    element('storage-access').value = '';
  }
}
window.addEventListener('hashchange', navigate);

export {
  initUi,
  isValidEmail,
  loadAdminAccounts,
  navigate,
  refresh,
  resolveAdminAccess,
  saveProcessingMode,
  submitAddAccount,
};
