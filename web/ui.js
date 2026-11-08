const element = (id) => document.getElementById(id);
const say = (text) => { element('feedback').textContent = text; };
let edited = false;

async function api(path, data) {
  const response = await fetch('/api/' + path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Falha na solicitação.');
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

async function refresh() {
  const state = await api('status');
  element('panel').hidden = false;
  element('login').hidden = true;
  element('admin').hidden = !state.admin;
  element('admin-link').hidden = !state.admin;
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
  if (!edited) element('rules').value = JSON.stringify(state.rules, null, 2);
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

element('rules').oninput = () => { edited = true; };
on('example', () => {
  edited = true;
  element('rules').value = JSON.stringify([{
    guildId: '', channelId: '', noticeChannelId: '', minPeople: 2, triggerUsers: [], emptySeconds: 30,
  }], null, 2);
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
on('drive', async () => { await api('drive/folder', {}); await refresh(); });
on('save-rules', async () => {
  await api('rules', { rules: JSON.parse(element('rules').value) });
  edited = false;
  say('Regras salvas.');
  await refresh();
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
on('add-account', async () => {
  await api('admin/accounts', { email: element('email').value });
  element('email').value = '';
  say('Conta autorizada.');
});
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

function navigate() {
  const links = Array.from(document.querySelectorAll('aside a.rail-icon:not([hidden])'));
  const [section, connector] = location.hash.split('/');
  const current = links.find((link) => link.hash === section) || links[0];
  const page = current.hash.slice(1);
  element('page-title').textContent = current.getAttribute('aria-label');
  for (const link of links) {
    if (link === current) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  for (const section of document.querySelectorAll('[data-page]')) {
    section.classList.toggle('page-hidden', section.dataset.page !== page);
  }
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
