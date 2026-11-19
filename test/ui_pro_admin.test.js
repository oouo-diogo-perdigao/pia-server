import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { workspaceHtml } from '../src/workspace_ui.js';

function createFakeDom(initialHash = '#recordings') {
  const byId = new Map();
  let focusedEl = null;

  function makeClassList() {
    const set = new Set();
    return {
      toggle(name, force) {
        if (force === undefined) {
          if (set.has(name)) set.delete(name);
          else set.add(name);
        } else if (force) set.add(name);
        else set.delete(name);
      },
      contains: (name) => set.has(name),
    };
  }

  function makeEl(tag, id = '') {
    const attrs = new Map();
    const el = {
      tagName: tag.toUpperCase(),
      id,
      hidden: false,
      disabled: false,
      checked: false,
      value: '',
      _textContent: '',
      children: [],
      dataset: {},
      className: '',
      classList: makeClassList(),
      style: {},
      href: '',
      hash: '',
      title: '',
      type: '',
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') this.id = String(v);
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) { attrs.delete(k); },
      focus() { focusedEl = this; },
      contains(target) { return target === this || this.children.includes(target); },
      addEventListener() {},
      replaceChildren(...nodes) {
        this.children = nodes.map((n) => (typeof n === 'string' ? { textContent: n } : n));
      },
      append(...nodes) {
        for (const n of nodes) this.children.push(typeof n === 'string' ? { textContent: n } : n);
      },
      get textContent() {
        if (this.children.length && !this._textContent) {
          return this.children.map((c) => c.textContent || '').join('');
        }
        return this._textContent;
      },
      set textContent(v) {
        this._textContent = String(v ?? '');
        this.children = [];
      },
      reportValidity() { return true; },
    };
    if (id) byId.set(id, el);
    return el;
  }

  const allIds = [
    'feedback', 'login', 'panel', 'page-title', 'account', 'account-email', 'account-initial',
    'account-picture', 'account-menu', 'connections', 'folder', 'recording-destination', 'rules',
    'save-rules', 'example', 'recordings', 'devices', 'refresh', 'drive', 'drive-picker',
    'drive-account', 'drive-path', 'drive-folders', 'drive-more', 'drive-picker-feedback',
    'drive-new-folder', 'drive-create', 'drive-select', 'drive-close', 'drive-google-settings',
    'prepare-device-drive', 'mcp-expiration', 'mcp-custom-expiration', 'mcp-days', 'mcp',
    'mcp-issued-expiration', 'mcp-revoke', 'token', 'logout', 'gmail-watch', 'calendar-watch',
    'calendar-lead', 'secretary-save', 'secretary-error', 'storage-account', 'storage-name',
    'storage-type', 'storage-endpoint', 'storage-public', 'storage-bucket', 'storage-region',
    'storage-color', 'storage-access', 'storage-secret', 'storage-reveal', 'storage-default',
    'storage-save', 'storage-remove', 'discord', 'discord-reveal', 'discord-state',
    'save-discord', 'discord-channel', 'discord-save-channel', 'discord-link', 'discord-test',
    'discord-remove', 'taverns-token', 'taverns-reveal', 'taverns-state', 'taverns-save',
    'taverns-remove', 'taverns-destination', 'taverns-test',
    'admin', 'admin-link', 'admin-denied', 'admin-vpn-blocked', 'admin-retry',
    'admin-blocked-feedback', 'admin-content', 'admin-add-form', 'email', 'admin-email-error',
    'add-account', 'admin-feedback', 'admin-refresh', 'admin-accounts-status', 'admin-accounts',
    'recordings-processing', 'processing-loading', 'processing-plan-notice', 'processing-standard',
    'processing-pro', 'processing-saved-mode', 'processing-mode-group', 'processing-mode-local',
    'processing-mode-server', 'processing-prerequisites', 'save-processing-mode', 'processing-feedback',
  ];
  for (const id of allIds) makeEl('div', id);
  byId.get('admin').hidden = true;
  byId.get('admin-link').hidden = true;
  byId.get('admin-denied').hidden = true;
  byId.get('admin-vpn-blocked').hidden = true;
  byId.get('admin-content').hidden = true;
  byId.get('admin-email-error').hidden = true;
  byId.get('processing-standard').hidden = true;
  byId.get('processing-pro').hidden = true;
  byId.get('processing-prerequisites').hidden = true;
  byId.get('processing-plan-notice').hidden = true;

  const railLinks = [
    { hash: '#recordings', label: 'Gravações', hidden: false },
    { hash: '#devices', label: 'Computadores', hidden: false },
    { hash: '#mcp', label: 'MCP', hidden: false },
    { hash: '#admin', label: 'Administração', el: byId.get('admin-link') },
    { hash: '#connectors', label: 'Conectores', hidden: false },
  ].map((item) => {
    const el = item.el || makeEl('a');
    el.hash = item.hash;
    el.setAttribute('aria-label', item.label);
    if (item.hidden !== undefined) el.hidden = item.hidden;
    return el;
  });

  const pageSections = [
    { page: 'recordings', el: byId.get('recordings-processing') },
    { page: 'devices', el: makeEl('section') },
    { page: 'mcp', el: makeEl('section') },
    { page: 'admin', el: byId.get('admin') },
    { page: 'connectors', el: makeEl('section') },
  ].map((item) => {
    item.el.dataset.page = item.page;
    return item.el;
  });

  const document = {
    getElementById: (id) => byId.get(id) || makeEl('div', id),
    createElement: (tag) => makeEl(tag),
    querySelectorAll(selector) {
      if (selector === 'aside a.rail-icon:not([hidden])') return railLinks.filter((l) => !l.hidden);
      if (selector === '[data-page]') return pageSections;
      return [];
    },
    addEventListener() {},
  };

  const location = { hash: initialHash, assign() {}, reload() {} };
  const windowObj = { addEventListener() {}, confirm: () => true };
  return {
    document,
    window: windowObj,
    location,
    el: (id) => byId.get(id),
    focused: () => focusedEl,
    clearFocus: () => { focusedEl = null; },
  };
}

let importCounter = 0;
async function loadUiWithMocks(handlers, initialHash = '#recordings') {
  const dom = createFakeDom(initialHash);
  const calls = [];
  globalThis.__PIA_UI_TEST__ = true;
  globalThis.document = dom.document;
  globalThis.window = dom.window;
  globalThis.location = dom.location;
  globalThis.Option = function Option(text, value) { return { text, value }; };
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body });
    const handler = handlers[url] || handlers[method + ' ' + url];
    if (!handler) {
      return { ok: true, status: 200, json: async () => ([]) };
    }
    const res = typeof handler === 'function' ? await handler({ url, method, body }) : handler;
    const status = res.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => res.body ?? {},
    };
  };
  const ui = await import(`../web/ui.js?t=${++importCounter}`);
  return { dom, ui, calls };
}

test('HTML template: workspaceHtml renderiza seções de processamento Pro e admin VPN sem erros', () => {
  const html = workspaceHtml(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8'));
  assert.match(html, /id="recordings-processing"/);
  assert.match(html, /id="processing-mode-local"/);
  assert.match(html, /id="processing-mode-server"/);
  assert.match(html, /id="save-processing-mode"/);
  assert.match(html, /id="admin-vpn-blocked"/);
  assert.match(html, /id="admin-accounts"/);
});

test('C1: usuário comum mantém #admin-link oculto e acesso direto a #admin exibe acesso negado genérico', async () => {
  const { dom, ui, calls } = await loadUiWithMocks({
    '/api/status': { body: { email: 'user@example.com', admin: false, isAdminAccount: false, adminVpnAllowed: false, pro: false, server_processing: false, rules: [], recordings: [] } },
    '/api/devices': { body: [] },
  }, '#admin');

  await ui.refresh();
  ui.navigate();

  assert.equal(dom.el('admin-link').hidden, true);
  assert.equal(dom.el('admin-denied').hidden, false);
  assert.equal(dom.el('admin-vpn-blocked').hidden, true);
  assert.equal(dom.el('admin-content').hidden, true);
  assert.equal(calls.some((c) => c.url.includes('/api/admin/')), false);
});

test('C1: admin fora da VPN oculta #admin-link, exibe bloqueio VPN em #admin e Tentar novamente revalida', async () => {
  let vpnAllowed = false;
  const { dom, ui } = await loadUiWithMocks({
    '/api/status': () => ({
      body: {
        id: 1, email: 'admin@example.com',
        admin: vpnAllowed, isAdminAccount: true, adminVpnAllowed: vpnAllowed,
        pro: false, server_processing: false, rules: [], recordings: [],
      },
    }),
    '/api/devices': { body: [] },
    '/api/admin/accounts': { body: { accounts: [{ id: 1, email: 'admin@example.com', admin: true, pro: false, server_processing: false }] } },
  }, '#admin');

  await ui.refresh();
  ui.navigate();

  assert.equal(dom.el('admin-link').hidden, true);
  assert.equal(dom.el('admin-vpn-blocked').hidden, false);
  assert.equal(dom.el('admin-content').hidden, true);

  vpnAllowed = true;
  await dom.el('admin-retry').onclick();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(dom.el('admin-link').hidden, false);
  assert.equal(dom.el('admin-vpn-blocked').hidden, true);
  assert.equal(dom.el('admin-content').hidden, false);
  assert.equal(dom.el('admin-accounts').children.length, 1);
});

test('C1: admin na VPN lista contas, valida/cadastra e-mail e alterna Pro com confirmação do servidor', async () => {
  const accounts = [
    { id: 1, email: 'admin@example.com', admin: true, pro: false, server_processing: false },
    { id: 2, email: 'mestre@example.com', admin: false, pro: true, server_processing: true },
  ];
  const { dom, ui } = await loadUiWithMocks({
    '/api/status': { body: { id: 1, email: 'admin@example.com', admin: true, isAdminAccount: true, adminVpnAllowed: true, pro: false, server_processing: false, rules: [], recordings: [] } },
    '/api/devices': { body: [] },
    'GET /api/admin/accounts': () => ({ body: { accounts } }),
    'POST /api/admin/accounts': ({ body }) => {
      accounts.push({ id: 3, email: body.email, admin: false, pro: false, server_processing: false });
      return { body: { ok: true } };
    },
    'POST /api/admin/accounts/pro': ({ body }) => {
      const target = accounts.find((a) => a.id === body.id);
      target.pro = body.pro;
      if (!target.pro) target.server_processing = false;
      return { body: { account: target } };
    },
  }, '#admin');

  await ui.refresh();
  await ui.loadAdminAccounts();

  assert.equal(dom.el('admin-accounts').children.length, 2);

  // E-mail inválido mantém entrada e foca campo
  dom.el('email').value = 'invalido';
  await ui.submitAddAccount();
  assert.equal(dom.el('email').value, 'invalido');
  assert.equal(dom.el('email').getAttribute('aria-invalid'), 'true');
  assert.equal(dom.focused(), dom.el('email'));

  // Cadastro válido
  dom.el('email').value = 'novo@example.com';
  await ui.submitAddAccount();
  assert.equal(dom.el('email').value, '');
  assert.equal(dom.el('admin-feedback').textContent, 'Conta autorizada.');
  assert.equal(dom.el('admin-accounts').children.length, 3);

  // Toggle Pro na conta 2 (desabilitar)
  const secondItem = dom.el('admin-accounts').children[1];
  const switchBtn = secondItem.children[1];
  assert.equal(switchBtn.getAttribute('aria-label'), 'Plano Pro de mestre@example.com');
  assert.equal(switchBtn.getAttribute('aria-checked'), 'true');
  await switchBtn.onclick();
  assert.match(dom.el('admin-feedback').textContent, /Plano Pro desabilitado/);
  const updatedBtn = dom.el('admin-accounts').children[1].children[1];
  assert.equal(updatedBtn.getAttribute('aria-checked'), 'false');
  assert.equal(updatedBtn.textContent, 'Desabilitado');
});

test('C1: resposta 403 em operação admin limpa dados e retorna ao estado bloqueado VPN', async () => {
  const { dom, ui } = await loadUiWithMocks({
    '/api/status': { body: { id: 1, email: 'admin@example.com', admin: true, isAdminAccount: true, adminVpnAllowed: true, pro: false, server_processing: false, rules: [], recordings: [] } },
    '/api/devices': { body: [] },
    'GET /api/admin/accounts': { body: { accounts: [{ id: 2, email: 'mestre@example.com', admin: false, pro: false, server_processing: false }] } },
    'POST /api/admin/accounts/pro': { status: 403, body: { error: 'Acesso restrito à VPN.' } },
  }, '#admin');

  await ui.refresh();
  await ui.loadAdminAccounts();
  assert.equal(dom.el('admin-accounts').children.length, 1);

  const switchBtn = dom.el('admin-accounts').children[0].children[1];
  await switchBtn.onclick();

  assert.equal(dom.el('admin-accounts').children.length, 0);
  assert.equal(dom.el('admin-content').hidden, true);
  assert.equal(dom.el('admin-vpn-blocked').hidden, false);
  assert.equal(dom.el('admin-link').hidden, true);
});

test('C2: conta padrão vê Plano Padrão (local) sem controles; conta Pro salva modo e trata 403 preservando regras', async () => {
  let statusPayload = {
    email: 'pro@example.com', admin: false, isAdminAccount: false, adminVpnAllowed: false,
    pro: true, server_processing: false, rules: [{ guildId: '1', channelId: '2' }], recordings: [],
    missingPrerequisites: ['bucket', 'campanha'],
  };
  let postModeResponse = { body: { pro: true, server_processing: true } };

  const { dom, ui } = await loadUiWithMocks({
    '/api/status': () => ({ body: statusPayload }),
    '/api/devices': { body: [] },
    'POST /api/recordings/processing-mode': () => postModeResponse,
  }, '#recordings');

  await ui.refresh();
  assert.equal(dom.el('processing-loading').hidden, true);
  assert.equal(dom.el('processing-standard').hidden, true);
  assert.equal(dom.el('processing-pro').hidden, false);
  assert.equal(dom.el('processing-mode-local').checked, true);
  assert.equal(dom.el('save-processing-mode').disabled, true);

  // Selecionar servidor mantém rascunho até confirmar e mostra pré-requisitos faltantes
  dom.el('processing-mode-local').checked = false;
  dom.el('processing-mode-server').checked = true;
  dom.el('processing-mode-server').onchange();

  assert.equal(dom.el('save-processing-mode').disabled, false);
  assert.equal(dom.el('processing-prerequisites').hidden, false);
  assert.match(dom.el('processing-prerequisites').textContent, /Para processar no servidor, configure bucket e campanha/);

  // Confirmar salvamento
  await ui.saveProcessingMode();
  assert.equal(dom.el('processing-feedback').textContent, 'Modo de processamento salvo.');
  assert.equal(dom.el('save-processing-mode').disabled, true);

  // Simular edição não salva nas regras + tentativa de mudança que retorna 403 (rebaixado)
  dom.el('rules').value = '[{"custom":true}]';
  dom.el('processing-mode-server').checked = false;
  dom.el('processing-mode-local').checked = true;
  dom.el('processing-mode-local').onchange();

  postModeResponse = { status: 403, body: { error: 'Plano Pro necessário.' } };
  await ui.saveProcessingMode();

  assert.equal(dom.el('processing-standard').hidden, false);
  assert.equal(dom.el('processing-pro').hidden, true);
  assert.equal(dom.el('processing-plan-notice').hidden, false);
  assert.equal(dom.el('processing-plan-notice').textContent, 'Seu plano mudou. Novas gravações serão processadas somente localmente.');
  // Não sobrescreve outras configurações
  assert.equal(dom.el('rules').value, '[{"custom":true}]');
});
