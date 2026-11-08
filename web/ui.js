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
  element('account').textContent = state.email;
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
  await api('discord', { token: element('discord').value });
  element('discord').value = '';
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
on('mcp', async () => {
  element('token').textContent = (await api('mcp/token', {})).token;
});
on('mcp-revoke', async () => {
  await api('mcp/revoke', {});
  element('token').textContent = '';
  say('Tokens MCP revogados.');
});
on('pair-device', async () => {
  element('device-token').textContent = (await api('devices/pair', { name: element('device-name').value })).token;
  await refresh();
});
on('logout', async () => { await api('logout', {}); location.reload(); });
on('add-account', async () => {
  await api('admin/accounts', { email: element('email').value });
  element('email').value = '';
  say('Conta autorizada.');
});
refresh().catch(async () => {
  element('login').hidden = false;
  const health = await fetch('/health').then((r) => r.json()).catch(() => null);
  if (!health?.googleLogin) say('O login Google aguarda a configuração do servidor.');
});
