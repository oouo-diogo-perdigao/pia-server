/**
 * Card 0005-C3 — Testes de baseline Discord, fixture transacional multi-conta
 * e contrato de destino padrão Taverns.gg (`TAVERNS_DESTINATION`, `taverns.destination`, R-6).
 *
 * Sem credenciais reais, sem envios a provedores externos e sem banco real.
 *
 * Mapeamento de dependências com 0005-C1 (`src/connectors.js`):
 * - Testes de BASELINE (executam e passam na base 90693fa, sem depender de C1):
 *   1. baseline Discord multi-conta (leitura, canal válido/inválido, teste mockado, remoção, isolamento e rollback)
 *   2. baseline Taverns: splitProfile/inicialização legada preservando `TAVERNS_DESTINATION` e campanhas do desktop
 *   3. baseline Taverns: validação de dois UUIDs em `testConnector` com fetch autenticado mockado e rollback de token
 *
 * - Testes marcados com `[depende-de-C1]` (executam automaticamente assim que C1 expor
 *   `taverns.destination` em `publicConnectors`, ou quando `PIA_REQUIRE_0005_C1=1` for definido):
 *   4. `[depende-de-C1]` GET /api/connectors expõe `taverns.destination` vazio quando ausente, sem expor token
 *   5. `[depende-de-C1]` POST /api/connectors/save grava e recarrega `destination` sem token, preservando credencial
 *      (provado via fetch autenticado mockado), outras chaves da seção e isolamento entre duas contas
 *   6. `[depende-de-C1]` omissão de `destination` preserva valor salvo; vazio explícito e formatos inválidos falham
 *   7. `[depende-de-C1]` precedência do registro persistido sobre snapshot legado (CA-04)
 *   8. `[depende-de-C1]` rollback atômico em falha simulada de escrita ao salvar destino
 *   9. `[depende-de-C1]` R-6: desconectar Taverns remove só a credencial e preserva destino/demais dados;
 *      reconexão recupera `configured=true` com mesmo destino, mantendo Discord e segunda conta intactos
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLegacyProfileSnapshot,
  createMemoryConnectorsStore,
  mockAuthenticatedFetch,
} from './fixtures/memory_connectors_store.js';

process.env.PIA_ENCRYPTION_KEY ||= '22'.repeat(32);

const { pool, seal, unseal } = await import('../src/db.js');
const {
  publicConnectors,
  registry,
  removeConnector,
  runtime,
  saveConnector,
  splitProfile,
  testConnector,
} = await import('../src/connectors.js');

const DEST_A1 = '11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222';
const DEST_A2 = '33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444';
const DEST_B1 = '55555555-5555-4555-8555-555555555555/66666666-6666-4666-8666-666666666666';
const DEST_LEGACY = '77777777-7777-4777-8777-777777777777/88888888-8888-4888-8888-888888888888';
const DEST_CAMPAIGN_1 = '99999999-9999-4999-8999-999999999999/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DEST_CAMPAIGN_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const TOKEN_A1 = 'tavbot_fixture_conta_a_token_1';
const TOKEN_A2 = 'tavbot_fixture_conta_a_token_2';
const TOKEN_B1 = 'tavbot_fixture_conta_b_token_1';
const DISCORD_TOKEN_A = 'discord_fixture_token_conta_a';
const DISCORD_TOKEN_B = 'discord_fixture_token_conta_b';
const DISCORD_CHANNEL_A = '123456789012345678';
const DISCORD_CHANNEL_B = '987654321098765432';

const REQUIRE_C1 = process.env.PIA_REQUIRE_0005_C1 === '1';

function setupStore(t) {
  const store = createMemoryConnectorsStore({ seal, unseal });
  store.install(t, pool);
  return store;
}

async function detectC1Contract(t) {
  const probe = setupStore(t);
  const acc = probe.addAccount({ id: 999, connectors_initialized: true });
  const info = await publicConnectors(acc);
  return Object.hasOwn(info.taverns || {}, 'destination');
}

async function requireC1OrSkip(t) {
  const available = await detectC1Contract(t);
  if (!available && !REQUIRE_C1) {
    t.skip('Depende de 0005-C1 (taverns.destination / TAVERNS_DESTINATION / R-6 em src/connectors.js)');
    return false;
  }
  return true;
}

// ============================================================================
// BLOCO A — BASELINE (independente de C1; valida regressão Discord e base Taverns)
// ============================================================================

test('baseline Discord multi-conta: leitura, gravação de canal, teste mockado, remoção, isolamento e rollback', async (t) => {
  const store = setupStore(t);
  const acc1 = store.addAccount({
    id: 1,
    connectors_initialized: true,
    discord_token: seal(DISCORD_TOKEN_A),
    discord_bot_id: 'bot-a',
  });
  const acc2 = store.addAccount({
    id: 2,
    connectors_initialized: true,
    discord_token: seal(DISCORD_TOKEN_B),
    discord_bot_id: 'bot-b',
  });

  // Estado inicial
  const initial1 = await publicConnectors(acc1);
  assert.deepEqual(initial1.discord, { configured: true, channel: '' });
  assert.doesNotMatch(JSON.stringify(initial1), new RegExp(DISCORD_TOKEN_A));

  // Gravar canal válido na conta 1 e outro canal na conta 2
  assert.deepEqual(
    await saveConnector(acc1, { provider: 'discord', channel: DISCORD_CHANNEL_A }),
    { ok: true },
  );
  assert.deepEqual(
    await saveConnector(acc2, { provider: 'discord', channel: DISCORD_CHANNEL_B }),
    { ok: true },
  );

  // Isolamento multi-conta
  assert.deepEqual((await publicConnectors(acc1)).discord, {
    configured: true,
    channel: DISCORD_CHANNEL_A,
  });
  assert.deepEqual((await publicConnectors(acc2)).discord, {
    configured: true,
    channel: DISCORD_CHANNEL_B,
  });

  // Validação de canal inválido preserva o canal salvo
  await assert.rejects(
    saveConnector(acc1, { provider: 'discord', channel: 'canal-invalido' }),
    /ID de canal Discord inválido/,
  );
  assert.equal((await publicConnectors(acc1)).discord.channel, DISCORD_CHANNEL_A);

  // Teste autenticado com fetch mockado (sem rede real)
  const calls = mockAuthenticatedFetch(t);
  const testRes = await testConnector(acc1, {
    provider: 'discord',
    destination: DISCORD_CHANNEL_A,
  });
  assert.equal(testRes.id, 'msg-mock-001');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_A}/messages`,
  );
  assert.equal(calls[0].headers.Authorization, `Bot ${DISCORD_TOKEN_A}`);

  // Rollback em falha simulada de escrita preserva canal anterior da conta 1 e estado da conta 2
  store.failNextWrite(new Error('Falha simulada ao gravar Discord'));
  await assert.rejects(
    saveConnector(acc1, { provider: 'discord', channel: '555555555555555555' }),
    /Falha simulada ao gravar Discord/,
  );
  assert.equal((await publicConnectors(acc1)).discord.channel, DISCORD_CHANNEL_A);
  assert.equal((await publicConnectors(acc2)).discord.channel, DISCORD_CHANNEL_B);

  // Remoção do Discord na conta 1 limpa seção Discord e token na conta 1 sem afetar conta 2
  await removeConnector(acc1, { provider: 'discord' });
  const reloadedAcc1 = store.getAccount(1);
  assert.equal(reloadedAcc1.discord_token, null);
  assert.deepEqual((await publicConnectors(reloadedAcc1)).discord, {
    configured: false,
    channel: '',
  });
  assert.deepEqual((await publicConnectors(acc2)).discord, {
    configured: true,
    channel: DISCORD_CHANNEL_B,
  });
});

test('baseline Taverns: splitProfile importa TAVERNS_DESTINATION legado e preserva campanhas do desktop intactas', async (t) => {
  const store = setupStore(t);
  const campaignsDoc = {
    integrations: {
      taverns_notify: true,
      taverns_channels: [DEST_CAMPAIGN_1, DEST_CAMPAIGN_2],
    },
    campaign_details: {
      Mestre: { Campanha: 'Mesa Teste', rss_key: 'mesa/rss.xml', players: {} },
    },
  };
  const secretRef = 'setting:Connectors/taverns:TAVERNS_BOT_TOKEN';
  const legacySnapshot = buildLegacyProfileSnapshot({
    settings: [
      ['Connectors/taverns', 'TAVERNS_BOT_TOKEN', null, 'secret', secretRef],
      ['Connectors/taverns', 'TAVERNS_DESTINATION', JSON.stringify(DEST_LEGACY), 'str', null],
      ['general', 'PORT', '"8762"', 'int', null],
    ],
    documents: [
      ['Apps/podcast_automation/campaigns', JSON.stringify(campaignsDoc)],
    ],
    secrets: {
      [secretRef]: TOKEN_A1,
    },
  });

  // splitProfile extrai Connectors/taverns e mantém Apps/podcast_automation/campaigns intacto no snapshot
  const split = splitProfile(legacySnapshot);
  assert.equal(split.state.settings['Connectors/taverns'].TAVERNS_BOT_TOKEN, TOKEN_A1);
  assert.equal(split.state.settings['Connectors/taverns'].TAVERNS_DESTINATION, DEST_LEGACY);

  const cleanedRaw = Buffer.from(split.snapshot.backup, 'base64')
    .toString('utf8')
    .slice('PIA-BACKUP-PLAIN-1\n'.length);
  const cleanedPayload = JSON.parse(cleanedRaw);
  assert.deepEqual(cleanedPayload.documents, [
    ['Apps/podcast_automation/campaigns', JSON.stringify(campaignsDoc)],
  ]);

  // Inicialização via registry() importa snapshot legado na conta desinicializada e marca initialized=true
  const acc1 = store.addAccount({ id: 1, connectors_initialized: false });
  store.setLegacyProfile(1, legacySnapshot);

  const state = await registry(acc1);
  assert.equal(state.settings['Connectors/taverns'].TAVERNS_DESTINATION, DEST_LEGACY);
  assert.equal(state.settings['Connectors/taverns'].TAVERNS_BOT_TOKEN, TOKEN_A1);
  assert.equal(store.getAccount(1).connectors_initialized, true);
});

test('baseline Taverns: testConnector valida dois UUIDs, usa fetch autenticado mockado, isola contas e faz rollback em falha', async (t) => {
  const store = setupStore(t);
  const acc1 = store.addAccount({ id: 1, connectors_initialized: true });
  const acc2 = store.addAccount({ id: 2, connectors_initialized: true });

  await saveConnector(acc1, { provider: 'taverns', token: TOKEN_A1 });
  await saveConnector(acc2, { provider: 'taverns', token: TOKEN_B1 });

  const calls = mockAuthenticatedFetch(t);

  // Destino válido (dois UUIDs) envia POST autenticado para cada conta com seu próprio token
  const res1 = await testConnector(acc1, { provider: 'taverns', destination: DEST_A1 });
  const res2 = await testConnector(acc2, { provider: 'taverns', destination: DEST_B1 });
  assert.equal(res1.id, 'msg-mock-001');
  assert.equal(res2.id, 'msg-mock-001');
  assert.equal(calls.length, 2);

  const [t1, c1] = DEST_A1.split('/');
  const [t2, c2] = DEST_B1.split('/');
  assert.equal(calls[0].url, `https://api.tav.gg/api/v1/taverns/${t1}/channels/${c1}/messages`);
  assert.equal(calls[0].headers.Authorization, `Bot ${TOKEN_A1}`);
  assert.equal(calls[1].url, `https://api.tav.gg/api/v1/taverns/${t2}/channels/${c2}/messages`);
  assert.equal(calls[1].headers.Authorization, `Bot ${TOKEN_B1}`);

  // Destinos inválidos são rejeitados sem disparar fetch
  const invalidDestinations = [
    '',
    '   ',
    '11111111-1111-4111-8111-111111111111',
    `${DEST_A1}/extra`,
    'zzzzzzzz-zzzz-4zzz-8zzz-zzzzzzzzzzzz/22222222-2222-4222-8222-222222222222',
    'taverna/canal',
    null,
    12345,
  ];
  for (const invalid of invalidDestinations) {
    await assert.rejects(
      testConnector(acc1, { provider: 'taverns', destination: invalid }),
      /Informe o (canal de teste|destino como ID da taverna\/ID do canal)/,
    );
  }
  assert.equal(calls.length, 2, 'Nenhuma chamada HTTP deve ocorrer para destinos inválidos');

  // Rollback em falha de escrita ao atualizar token preserva token anterior
  store.failNextWrite(new Error('Falha simulada ao gravar token Taverns'));
  await assert.rejects(
    saveConnector(acc1, { provider: 'taverns', token: TOKEN_A2 }),
    /Falha simulada ao gravar token Taverns/,
  );
  await testConnector(acc1, { provider: 'taverns', destination: DEST_A1 });
  assert.equal(calls[2].headers.Authorization, `Bot ${TOKEN_A1}`);
});

// ============================================================================
// BLOCO B — CONTRATO 0005-C1 (taverns.destination, TAVERNS_DESTINATION e R-6)
// ============================================================================

test('[depende-de-C1] GET /api/connectors retorna taverns.destination vazio quando ausente e nunca expõe o token', async (t) => {
  if (!(await requireC1OrSkip(t))) return;

  const store = setupStore(t);
  const acc1 = store.addAccount({ id: 1, connectors_initialized: true });
  const acc2 = store.addAccount({ id: 2, connectors_initialized: true });

  // Conta 1 sem token e sem destino
  const emptyInfo = await publicConnectors(acc1);
  assert.deepEqual(emptyInfo.taverns, { configured: false, destination: '' });

  // Conta 2 apenas com token (sem destino)
  await saveConnector(acc2, { provider: 'taverns', token: TOKEN_B1 });
  const tokenOnlyInfo = await publicConnectors(acc2);
  assert.deepEqual(tokenOnlyInfo.taverns, { configured: true, destination: '' });
  assert.doesNotMatch(JSON.stringify(tokenOnlyInfo), new RegExp(TOKEN_B1));
});

test('[depende-de-C1] salvar destination sem token grava/recarrega TAVERNS_DESTINATION, preserva token (provado via fetch mockado), outras chaves e isola duas contas', async (t) => {
  if (!(await requireC1OrSkip(t))) return;

  const store = setupStore(t);
  const acc1 = store.addAccount({ id: 1, connectors_initialized: true });
  const acc2 = store.addAccount({ id: 2, connectors_initialized: true });

  // Semeia conta 1 com token e chave extra na seção Connectors/taverns; conta 2 com outro token e destino
  store.seedConnectorPart(1, 'taverns', {
    settings: {
      'Connectors/taverns': {
        TAVERNS_BOT_TOKEN: TOKEN_A1,
        TAVERNS_EXTRA_KEY: 'valor-preservado-c1',
      },
    },
    documents: {},
    secrets: {},
  });
  store.seedConnectorPart(2, 'taverns', {
    settings: {
      'Connectors/taverns': {
        TAVERNS_BOT_TOKEN: TOKEN_B1,
        TAVERNS_DESTINATION: DEST_B1,
      },
    },
    documents: {},
    secrets: {},
  });

  // Salvar destino na conta 1 sem informar token
  const saveRes = await saveConnector(acc1, { provider: 'taverns', destination: DEST_A1 });
  assert.deepEqual(saveRes, { ok: true });
  assert.doesNotMatch(JSON.stringify(saveRes), new RegExp(TOKEN_A1));

  // Recarga via publicConnectors e inspeção de runtime/persistência
  const pub1 = await publicConnectors(acc1);
  assert.deepEqual(pub1.taverns, { configured: true, destination: DEST_A1 });
  assert.doesNotMatch(JSON.stringify(pub1), new RegExp(TOKEN_A1));

  const rt1 = await runtime(acc1, 'taverns');
  assert.equal(rt1.settings.TAVERNS_DESTINATION, DEST_A1);
  assert.equal(rt1.settings.TAVERNS_EXTRA_KEY, 'valor-preservado-c1');

  // Prova de preservação do token por fetch autenticado mockado (sem expor valor no GET/save)
  const calls = mockAuthenticatedFetch(t);
  await testConnector(acc1, { provider: 'taverns', destination: DEST_A1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, `Bot ${TOKEN_A1}`);

  // Edição do destino na conta 1 sem token atualiza só a conta 1 e mantém conta 2 intacta
  await saveConnector(acc1, { provider: 'taverns', destination: DEST_A2 });
  assert.deepEqual((await publicConnectors(acc1)).taverns, {
    configured: true,
    destination: DEST_A2,
  });
  assert.deepEqual((await publicConnectors(acc2)).taverns, {
    configured: true,
    destination: DEST_B1,
  });

  // Token continua utilizável após edição do destino
  await testConnector(acc1, { provider: 'taverns', destination: DEST_A2 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, `Bot ${TOKEN_A1}`);
});

test('[depende-de-C1] omissão de destination preserva valor existente; vazio explícito e formatos inválidos geram erro sem alterar registro', async (t) => {
  if (!(await requireC1OrSkip(t))) return;

  const store = setupStore(t);
  const acc1 = store.addAccount({ id: 1, connectors_initialized: true });

  await saveConnector(acc1, { provider: 'taverns', token: TOKEN_A1, destination: DEST_A1 });
  assert.deepEqual((await publicConnectors(acc1)).taverns, {
    configured: true,
    destination: DEST_A1,
  });

  // Omissão de destination ao atualizar só o token preserva o destino salvo
  await saveConnector(acc1, { provider: 'taverns', token: TOKEN_A2 });
  assert.deepEqual((await publicConnectors(acc1)).taverns, {
    configured: true,
    destination: DEST_A1,
  });

  // Vazio explícito e valores inválidos são rejeitados sem limpar nem alterar DEST_A1
  const rejected = [
    '',
    '   ',
    '11111111-1111-4111-8111-111111111111',
    `${DEST_A1}/extra`,
    'gggggggg-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222',
    'invalido',
    null,
    42,
  ];
  for (const bad of rejected) {
    await assert.rejects(
      saveConnector(acc1, { provider: 'taverns', destination: bad }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, new RegExp(TOKEN_A2));
        return true;
      },
    );
  }

  // Valor anterior e token permanecem preservados
  assert.deepEqual((await publicConnectors(acc1)).taverns, {
    configured: true,
    destination: DEST_A1,
  });
  const calls = mockAuthenticatedFetch(t);
  await testConnector(acc1, { provider: 'taverns', destination: DEST_A1 });
  assert.equal(calls[0].headers.Authorization, `Bot ${TOKEN_A2}`);
});

test('[depende-de-C1] precedência: registro persistido prevalece sobre snapshot legado sem reimportar após inicialização', async (t) => {
  if (!(await requireC1OrSkip(t))) return;

  const store = setupStore(t);
  const secretRef = 'setting:Connectors/taverns:TAVERNS_BOT_TOKEN';
  const legacySnapshot = buildLegacyProfileSnapshot({
    settings: [
      ['Connectors/taverns', 'TAVERNS_BOT_TOKEN', null, 'secret', secretRef],
      ['Connectors/taverns', 'TAVERNS_DESTINATION', JSON.stringify(DEST_LEGACY), 'str', null],
    ],
    secrets: { [secretRef]: TOKEN_A1 },
  });

  // Conta 1 desinicializada herda destino legado na primeira leitura
  const acc1 = store.addAccount({ id: 1, connectors_initialized: false });
  store.setLegacyProfile(1, legacySnapshot);
  assert.deepEqual((await publicConnectors(acc1)).taverns, {
    configured: true,
    destination: DEST_LEGACY,
  });

  // Após atualizar destino na conta 1, o registro persistido prevalece sobre o snapshot legado
  await saveConnector(acc1, { provider: 'taverns', destination: DEST_A2 });
  assert.deepEqual((await publicConnectors(acc1)).taverns, {
    configured: true,
    destination: DEST_A2,
  });

  // Conta 2 já inicializada sem destino NÃO reimporta snapshot legado
  const acc2 = store.addAccount({ id: 2, connectors_initialized: true });
  store.setLegacyProfile(2, legacySnapshot);
  assert.deepEqual((await publicConnectors(acc2)).taverns, {
    configured: false,
    destination: '',
  });
});

test('[depende-de-C1] rollback em falha simulada de escrita preserva destino anterior, token e segunda conta', async (t) => {
  if (!(await requireC1OrSkip(t))) return;

  const store = setupStore(t);
  const acc1 = store.addAccount({ id: 1, connectors_initialized: true });
  const acc2 = store.addAccount({ id: 2, connectors_initialized: true });

  await saveConnector(acc1, { provider: 'taverns', token: TOKEN_A1, destination: DEST_A1 });
  await saveConnector(acc2, { provider: 'taverns', token: TOKEN_B1, destination: DEST_B1 });

  store.failNextWrite(new Error('Falha simulada de commit/escrita Taverns'));
  await assert.rejects(
    saveConnector(acc1, { provider: 'taverns', destination: DEST_A2 }),
    /Falha simulada de commit\/escrita Taverns/,
  );

  // Estado da conta 1 e conta 2 permanece íntegro após rollback
  assert.deepEqual((await publicConnectors(acc1)).taverns, {
    configured: true,
    destination: DEST_A1,
  });
  assert.deepEqual((await publicConnectors(acc2)).taverns, {
    configured: true,
    destination: DEST_B1,
  });

  const calls = mockAuthenticatedFetch(t);
  await testConnector(acc1, { provider: 'taverns', destination: DEST_A1 });
  assert.equal(calls[0].headers.Authorization, `Bot ${TOKEN_A1}`);
});

test('[depende-de-C1] R-6: desconectar Taverns remove só a credencial e preserva destino/demais dados; reconexão recupera configured=true com mesmo destino', async (t) => {
  if (!(await requireC1OrSkip(t))) return;

  const store = setupStore(t);
  const acc1 = store.addAccount({
    id: 1,
    connectors_initialized: true,
    discord_token: seal(DISCORD_TOKEN_A),
    discord_bot_id: 'bot-a',
  });
  const acc2 = store.addAccount({ id: 2, connectors_initialized: true });

  // Conta 1 tem Taverns (token + destino + chave extra) e Discord; Conta 2 tem Taverns independente
  store.seedConnectorPart(1, 'taverns', {
    settings: {
      'Connectors/taverns': {
        TAVERNS_BOT_TOKEN: TOKEN_A1,
        TAVERNS_DESTINATION: DEST_A1,
        TAVERNS_EXTRA_META: 'manter-apos-desconexao',
      },
    },
    documents: {
      'Connectors/taverns': { note: 'preservar-documento-taverns' },
    },
    secrets: {},
  });
  await saveConnector(acc1, { provider: 'discord', channel: DISCORD_CHANNEL_A });
  await saveConnector(acc2, { provider: 'taverns', token: TOKEN_B1, destination: DEST_B1 });

  // Desconectar Taverns na conta 1
  const removed = await removeConnector(acc1, { provider: 'taverns' });
  assert.deepEqual(removed, { ok: true });

  // Conta 1 fica configured=false, preserva o destino e mantém Discord intacto
  const afterDisconnect1 = await publicConnectors(acc1);
  assert.deepEqual(afterDisconnect1.taverns, { configured: false, destination: DEST_A1 });
  assert.deepEqual(afterDisconnect1.discord, { configured: true, channel: DISCORD_CHANNEL_A });
  assert.doesNotMatch(JSON.stringify(afterDisconnect1), new RegExp(TOKEN_A1));

  const rtAfterDisconnect1 = await runtime(acc1, 'taverns');
  assert.equal(rtAfterDisconnect1.settings.TAVERNS_BOT_TOKEN, undefined);
  assert.equal(rtAfterDisconnect1.settings.TAVERNS_DESTINATION, DEST_A1);
  assert.equal(rtAfterDisconnect1.settings.TAVERNS_EXTRA_META, 'manter-apos-desconexao');

  // Testar Taverns desconectado falha por falta de bot sem disparar fetch
  const calls = mockAuthenticatedFetch(t);
  await assert.rejects(
    testConnector(acc1, { provider: 'taverns', destination: DEST_A1 }),
    /Configure o bot antes de testar/,
  );
  assert.equal(calls.length, 0);

  // Conta 2 permanece 100% operacional e isolada
  assert.deepEqual((await publicConnectors(acc2)).taverns, {
    configured: true,
    destination: DEST_B1,
  });
  await testConnector(acc2, { provider: 'taverns', destination: DEST_B1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.Authorization, `Bot ${TOKEN_B1}`);

  // Reconexão na conta 1 só com novo token recupera configured=true mantendo exatamente o mesmo destino
  await saveConnector(acc1, { provider: 'taverns', token: TOKEN_A2 });
  const afterReconnect1 = await publicConnectors(acc1);
  assert.deepEqual(afterReconnect1.taverns, { configured: true, destination: DEST_A1 });
  assert.doesNotMatch(JSON.stringify(afterReconnect1), new RegExp(TOKEN_A2));

  // Chamada autenticada mockada comprova uso do novo token (nunca do token revogado)
  await testConnector(acc1, { provider: 'taverns', destination: DEST_A1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].headers.Authorization, `Bot ${TOKEN_A2}`);
});
