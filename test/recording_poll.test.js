import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { ComponentType, PermissionFlagsBits, Routes } from 'discord.js';
import {
  MAX_POLL_OPTIONS,
  POLL_DURATION_MS,
  addRecordingPollOption,
  closeRecordingPoll,
  getPersistedPollWinner,
  openRecordingPoll,
  optionVoteCount,
  recordingMetaPath,
  restoreRecordingPoll,
  selectPollWinner,
  voteRecordingPoll,
} from '../src/recording_poll.js';
import {
  RecordingPanels,
  canParticipateInPoll,
  formatPollButtonLabel,
  recordingPanel,
} from '../src/recording_panel.js';
import { read, save } from '../src/state.js';

const RECORDING_ID = '11111111-2222-3333-4444-555555555555';
const GUILD_ID = '100000000000000001';
const VOICE_CHANNEL_ID = '100000000000000002';
const NOTICE_CHANNEL_ID = '100000000000000003';
const PANEL_MESSAGE_ID = '100000000000000004';
const AUTHOR_ID = '200000000000000001';
const USER_B = '200000000000000002';
const USER_C = '200000000000000003';

const sandbox = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.poll-tmp-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));

function createFixtureDir(overrides = {}) {
  const dir = mkdtempSync(join(sandbox, 'case-'));
  const startedAt = '2026-11-19T12:00:00.000Z';
  const meta = {
    id: RECORDING_ID,
    name: 'Guild20261119120000000-voz.aup.zip',
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    noticeChannelId: NOTICE_CHANNEL_ID,
    panelMessageId: PANEL_MESSAGE_ID,
    startedAt,
    endedAt: '2026-11-19T13:00:00.000Z',
    durationMs: 3600000,
    requester: AUTHOR_ID,
    stoppedBy: { user: AUTHOR_ID },
    state: 'queued',
    tracks: [AUTHOR_ID, USER_B],
    members: {
      [AUTHOR_ID]: { joinedAt: startedAt },
      [USER_B]: { joinedAt: startedAt },
    },
    notes: [{ text: 'Momento épico na ponte', user: AUTHOR_ID, offsetMs: 120000 }],
    ...overrides,
  };
  save(recordingMetaPath(dir), meta);
  return { dir, meta, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function createFakeClient() {
  const patches = [];
  return {
    patches,
    rest: {
      async patch(route, payload) {
        patches.push({ route, body: payload.body });
        return payload.body;
      },
    },
  };
}

function createInteraction({
  customId,
  userId = USER_B,
  bot = false,
  guildId = GUILD_ID,
  channelId = NOTICE_CHANNEL_ID,
  hasMember = true,
  canView = true,
  modal = false,
  modalLabel = '',
}) {
  const replies = [];
  const modals = [];
  const interaction = {
    customId,
    guildId,
    channelId,
    user: { id: userId, bot },
    member: hasMember ? { id: userId, roles: [] } : null,
    channel: {
      permissionsFor(member) {
        if (!member) return null;
        return {
          has(flag) {
            return flag === PermissionFlagsBits.ViewChannel ? canView : false;
          },
        };
      },
    },
    replied: false,
    isButton: () => !modal,
    isModalSubmit: () => modal,
    fields: {
      getTextInputValue(name) {
        if (name === 'label') return modalLabel;
        return '';
      },
    },
    async reply(payload) {
      this.replied = true;
      replies.push(payload);
    },
    async showModal(modalBuilder) {
      modals.push(typeof modalBuilder.toJSON === 'function' ? modalBuilder.toJSON() : modalBuilder);
    },
  };
  return { interaction, replies, modals };
}

test('openRecordingPoll persists 1h deadline once, gives initial custom title 1 vote and refuses empty poll', async () => {
  const fixture = createFixtureDir({ sessionTitle: 'A Batalha na Taverna', sessionTitleBy: AUTHOR_ID });
  try {
    let nowMs = Date.parse('2026-11-19T14:00:00.000Z');
    const opened = await openRecordingPoll(fixture.dir, {
      suggestions: ['O Segredo do Sino', 'A batalha na taverna', 'Sombras no Cais'],
      now: () => nowMs,
    });
    assert.equal(opened.created, true);
    assert.equal(opened.poll.durationMs, POLL_DURATION_MS);
    assert.equal(Date.parse(opened.poll.endsAt) - Date.parse(opened.poll.openedAt), POLL_DURATION_MS);
    assert.equal(opened.poll.options.length, 3, 'deduplica sugestão igual ao título inicial');
    assert.equal(opened.poll.options[0].kind, 'custom');
    assert.equal(opened.poll.options[0].label, 'A Batalha na Taverna');
    assert.equal(optionVoteCount(opened.poll.options[0]), 1);
    assert.deepEqual(opened.poll.options[0].voters, [AUTHOR_ID]);
    assert.equal(opened.poll.options[0].initialSystemVote, false);
    assert.equal(opened.poll.options[1].kind, 'suggested');
    assert.equal(optionVoteCount(opened.poll.options[1]), 0);

    // Chamar novamente não reinicia relógio nem reseta opções.
    nowMs += 15 * 60 * 1000;
    const second = await openRecordingPoll(fixture.dir, {
      suggestions: ['Outra Sugestão'],
      now: () => nowMs,
    });
    assert.equal(second.created, false);
    assert.equal(second.poll.endsAt, opened.poll.endsAt);
    assert.equal(second.poll.options.length, 3);
  } finally {
    fixture.cleanup();
  }

  const emptyFixture = createFixtureDir();
  try {
    await assert.rejects(
      () => openRecordingPoll(emptyFixture.dir, { suggestions: ['   '] }),
      /Nenhuma opção disponível/,
    );
  } finally {
    emptyFixture.cleanup();
  }
});

test('initial custom title with unknown author starts with 1 system vote without fabricating a user', async () => {
  const fixture = createFixtureDir({ sessionTitle: 'Crônica da Névoa' });
  try {
    const nowMs = Date.parse('2026-11-19T14:00:00.000Z');
    const opened = await openRecordingPoll(fixture.dir, {
      suggestions: ['Caminho das Pedras'],
      now: () => nowMs,
    });
    const first = opened.poll.options[0];
    assert.equal(first.kind, 'custom');
    assert.equal(first.createdBy, null);
    assert.equal(first.initialSystemVote, true);
    assert.deepEqual(first.voters, []);
    assert.equal(optionVoteCount(first), 1);

    const panel = recordingPanel(opened.meta, null, nowMs + 1000);
    const optionsField = panel.embeds[0].fields.find((field) => field.name.startsWith('Opções'));
    assert.match(optionsField.value, /Crônica da Névoa — Personalizada · 1 voto inicial/);
    assert.doesNotMatch(optionsField.value, /<@/);
  } finally {
    fixture.cleanup();
  }
});

test('voting allows multiple options per user, prevents duplicate vote per option and survives concurrent writes', async () => {
  const fixture = createFixtureDir({ sessionTitle: 'Noite de Lua Vermelha', sessionTitleBy: AUTHOR_ID });
  try {
    const nowMs = Date.parse('2026-11-19T14:00:00.000Z');
    const opened = await openRecordingPoll(fixture.dir, {
      suggestions: ['O Pacto Antigo', 'Ecos do Abismo'],
      now: () => nowMs,
    });
    const [opt1, opt2, opt3] = opened.poll.options;

    // Autor do título inicial não consegue duplicar voto na própria opção inicial.
    const dupAuthor = await voteRecordingPoll(fixture.dir, { optionId: opt1.id, userId: AUTHOR_ID, now: () => nowMs + 1000 });
    assert.equal(dupAuthor.ok, true);
    assert.equal(dupAuthor.changed, false);
    assert.equal(dupAuthor.alreadyVoted, true);
    assert.equal(optionVoteCount(dupAuthor.option), 1);

    // Mesmo usuário vota em múltiplas opções simultaneamente (concorrência + unicidade).
    const [v1, v2, v3, v4] = await Promise.all([
      voteRecordingPoll(fixture.dir, { optionId: opt2.id, userId: USER_B, now: () => nowMs + 2000 }),
      voteRecordingPoll(fixture.dir, { optionId: opt3.id, userId: USER_B, now: () => nowMs + 2000 }),
      voteRecordingPoll(fixture.dir, { optionId: opt2.id, userId: USER_B, now: () => nowMs + 2000 }),
      voteRecordingPoll(fixture.dir, { optionId: opt2.id, userId: USER_C, now: () => nowMs + 2000 }),
    ]);
    assert.equal(v1.changed, true);
    assert.equal(v2.changed, true);
    assert.equal(v3.changed, false);
    assert.equal(v3.alreadyVoted, true);
    assert.equal(v4.changed, true);

    const persisted = read(recordingMetaPath(fixture.dir), null);
    assert.equal(optionVoteCount(persisted.poll.options[1]), 2);
    assert.equal(optionVoteCount(persisted.poll.options[2]), 1);

    // Após o prazo exato, voto é recusado.
    const expiredVote = await voteRecordingPoll(fixture.dir, {
      optionId: opt3.id,
      userId: USER_C,
      now: () => Date.parse(opened.poll.endsAt),
    });
    assert.equal(expiredVote.ok, false);
    assert.equal(expiredVote.code, 'closed');
    assert.equal(expiredVote.message, 'A enquete já foi encerrada.');
  } finally {
    fixture.cleanup();
  }
});

test('custom option submission normalizes duplicates before enforcing the 20-option limit', async () => {
  const fixture = createFixtureDir();
  try {
    const nowMs = Date.parse('2026-11-19T14:00:00.000Z');
    const initialSuggestions = Array.from({ length: MAX_POLL_OPTIONS - 1 }, (_, i) => 'Sugestão ' + (i + 1));
    await openRecordingPoll(fixture.dir, { suggestions: initialSuggestions, now: () => nowMs });

    // Rejeita vazio e acima de 100 caracteres.
    const emptyRes = await addRecordingPollOption(fixture.dir, { label: '   ', userId: USER_B, now: () => nowMs + 1000 });
    assert.equal(emptyRes.ok, false);
    assert.equal(emptyRes.message, 'Informe um nome.');

    const longRes = await addRecordingPollOption(fixture.dir, { label: 'x'.repeat(101), userId: USER_B, now: () => nowMs + 1000 });
    assert.equal(longRes.ok, false);
    assert.equal(longRes.code, 'too_long');

    // Adiciona a 20ª opção (atinge o limite).
    const added = await addRecordingPollOption(fixture.dir, { label: '  Torre dos Ventos  ', userId: USER_B, now: () => nowMs + 2000 });
    assert.equal(added.ok, true);
    assert.equal(added.changed, true);
    assert.equal(added.option.label, 'Torre dos Ventos');
    assert.equal(added.option.kind, 'custom');
    assert.equal(optionVoteCount(added.option), 1);
    assert.equal(added.message, 'Opção adicionada e seu voto registrado.');

    // Com a lista cheia (20 opções), opção NOVA é bloqueada pelo limite.
    const overflow = await addRecordingPollOption(fixture.dir, { label: 'Vigésima Primeira', userId: USER_C, now: () => nowMs + 3000 });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.code, 'limit');
    assert.equal(overflow.message, 'A enquete atingiu o limite de opções. Você ainda pode votar nas opções existentes.');

    // Com a lista cheia (20 opções), DUPLICATA (case-insensitive) ainda registra o voto na opção existente!
    const dupVote = await addRecordingPollOption(fixture.dir, { label: '  torre dos ventos ', userId: USER_C, now: () => nowMs + 4000 });
    assert.equal(dupVote.ok, true);
    assert.equal(dupVote.duplicate, true);
    assert.equal(dupVote.changed, true);
    assert.equal(dupVote.message, 'Essa opção já existe. Seu voto foi registrado nela.');
    assert.equal(optionVoteCount(dupVote.option), 2);

    // Mesmo usuário reenviando a duplicata não soma voto.
    const dupAgain = await addRecordingPollOption(fixture.dir, { label: 'TORRE DOS VENTOS', userId: USER_C, now: () => nowMs + 5000 });
    assert.equal(dupAgain.ok, true);
    assert.equal(dupAgain.duplicate, true);
    assert.equal(dupAgain.changed, false);
    assert.equal(dupAgain.alreadyVoted, true);
    assert.equal(dupAgain.message, 'Essa opção já existe e você já votou nela.');
    assert.equal(optionVoteCount(dupAgain.option), 2);
  } finally {
    fixture.cleanup();
  }
});

test('selectPollWinner enforces all 4 deterministic tie-break rules including zero-vote ties', () => {
  // 1. Vitória simples
  const w1 = selectPollWinner({
    options: [
      { id: 'opt-1', label: 'A', kind: 'custom', createdOrder: 0, voters: ['u1'] },
      { id: 'opt-2', label: 'B', kind: 'suggested', createdOrder: 1, voters: ['u1', 'u2'] },
    ],
  });
  assert.equal(w1.optionId, 'opt-2');
  assert.equal(w1.tieBreakReason, 'highest');

  // 2. Empate entre sugerida (3) e personalizada (3) -> personalizada vence
  const w2 = selectPollWinner({
    options: [
      { id: 'opt-1', label: 'Sugerida', kind: 'suggested', createdOrder: 0, voters: ['u1', 'u2', 'u3'] },
      { id: 'opt-2', label: 'Personalizada', kind: 'custom', createdOrder: 1, voters: ['u1', 'u2', 'u3'] },
    ],
  });
  assert.equal(w2.optionId, 'opt-2');
  assert.equal(w2.tieBreakReason, 'custom_priority');

  // 3. Empate entre personalizadas (3 cada) -> criada primeiro vence
  const w3 = selectPollWinner({
    options: [
      { id: 'opt-1', label: 'Custom Tardia', kind: 'custom', createdOrder: 2, createdAt: '2026-11-19T14:10:00.000Z', voters: ['u1', 'u2', 'u3'] },
      { id: 'opt-2', label: 'Custom Inicial', kind: 'custom', createdOrder: 0, createdAt: '2026-11-19T14:00:00.000Z', voters: ['u1', 'u2', 'u3'] },
      { id: 'opt-3', label: 'Sugerida', kind: 'suggested', createdOrder: 1, voters: ['u1', 'u2', 'u3'] },
    ],
  });
  assert.equal(w3.optionId, 'opt-2');
  assert.equal(w3.tieBreakReason, 'earliest_custom');

  // 4. Empate apenas entre sugeridas (2 votos) -> aleatória somente entre as empatadas
  let seenMax = null;
  const w4 = selectPollWinner({
    options: [
      { id: 'opt-1', label: 'Menos votada', kind: 'suggested', createdOrder: 0, voters: ['u1'] },
      { id: 'opt-2', label: 'Sugerida A', kind: 'suggested', createdOrder: 1, voters: ['u1', 'u2'] },
      { id: 'opt-3', label: 'Sugerida B', kind: 'suggested', createdOrder: 2, voters: ['u2', 'u3'] },
    ],
  }, (max) => {
    seenMax = max;
    return 1;
  });
  assert.equal(seenMax, 2);
  assert.equal(w4.optionId, 'opt-3');
  assert.equal(w4.tieBreakReason, 'random_suggested');

  // 5. Empate em zero apenas entre sugeridas -> aleatória entre elas
  const w5 = selectPollWinner({
    options: [
      { id: 'opt-1', label: 'Zero A', kind: 'suggested', createdOrder: 0, voters: [] },
      { id: 'opt-2', label: 'Zero B', kind: 'suggested', createdOrder: 1, voters: [] },
    ],
  }, () => 0);
  assert.equal(w5.optionId, 'opt-1');
  assert.equal(w5.votes, 0);
  assert.equal(w5.tieBreakReason, 'random_suggested');
});

test('restoreRecordingPoll survives restarts with original deadline, closes expired polls and persists winner idempotently', async () => {
  const fixture = createFixtureDir({ sessionTitle: 'O Vale Esquecido', sessionTitleBy: AUTHOR_ID });
  try {
    let nowMs = Date.parse('2026-11-19T14:00:00.000Z');
    const opened = await openRecordingPoll(fixture.dir, {
      suggestions: ['Portão de Ferro', 'Chama Azul'],
      now: () => nowMs,
    });
    await voteRecordingPoll(fixture.dir, { optionId: opened.poll.options[1].id, userId: USER_B, now: () => nowMs + 10000 });
    assert.equal(getPersistedPollWinner(fixture.dir), null);

    // Simula reinício 20 minutos depois: enquete continua aberta com prazo original intacto.
    nowMs += 20 * 60 * 1000;
    const midRestore = await restoreRecordingPoll(fixture.dir, { now: () => nowMs });
    assert.equal(midRestore.status, 'open');
    assert.equal(midRestore.remainingMs, 40 * 60 * 1000);
    assert.equal(optionVoteCount(midRestore.poll.options[1]), 1);

    // closeRecordingPoll antes do prazo sem force permanece pendente.
    const premature = await closeRecordingPoll(fixture.dir, { now: () => nowMs });
    assert.equal(premature.pending, true);
    assert.equal(premature.winner, null);

    // Simula reinício após 1h completa: restauração fecha, elege e persiste vencedor (empate 1x1 -> custom vence).
    nowMs = Date.parse(opened.poll.endsAt) + 5000;
    const closedEvents = [];
    const client = createFakeClient();
    const panels = new RecordingPanels(client, {
      now: () => nowMs,
      onPollClosed: (event) => closedEvents.push(event),
    });
    const restored = await panels.restorePoll(fixture.dir);
    assert.equal(restored.status, 'closed');
    assert.equal(restored.closedNow, true);
    assert.equal(restored.winner.label, 'O Vale Esquecido');
    assert.equal(restored.winner.tieBreakReason, 'custom_priority');
    assert.equal(closedEvents.length, 1);
    assert.equal(client.patches.length, 1);
    assert.equal(client.patches[0].route, Routes.channelMessage(NOTICE_CHANNEL_ID, PANEL_MESSAGE_ID));

    // Vencedor persistido disponível para C3 e fechamento repetido é idempotente.
    const persistedWinner = getPersistedPollWinner(fixture.dir);
    assert.equal(persistedWinner.label, 'O Vale Esquecido');
    assert.equal(persistedWinner.votes, 1);

    const again = await closeRecordingPoll(fixture.dir, { now: () => nowMs + 60000, randomInt: () => { throw new Error('não deve re-sortear'); } });
    assert.equal(again.alreadyClosed, true);
    assert.equal(again.winner.optionId, persistedWinner.optionId);
    panels.close();
  } finally {
    fixture.cleanup();
  }
});

test('Discord card rendering respects Discord limits, disambiguates long labels and handles processing/publication states', async () => {
  const fixture = createFixtureDir({ sessionTitle: 'Nome Inicial' });
  try {
    const nowMs = Date.parse('2026-11-19T14:00:00.000Z');

    // Estado de processamento (C3)
    const procPanel = recordingPanel({
      ...fixture.meta,
      processing: { status: 'running', stage: 'Transcrever' },
    }, null, nowMs);
    assert.equal(procPanel.embeds[0].title, '⚙️ Processando sessão no servidor');
    assert.match(procPanel.embeds[0].fields.find((f) => f.name === 'Processamento').value, /Etapa atual: Transcrever/);
    assert.equal(procPanel.embeds[0].fields.find((f) => f.name === 'Nome informado').value, 'Nome Inicial');
    assert.equal(procPanel.components.length, 0);

    // Estado de falha no processamento com pré-requisitos faltantes
    const failProc = recordingPanel({
      ...fixture.meta,
      processing: { status: 'failed', missingConfig: ['bucket', 'campanha'] },
    }, null, nowMs);
    assert.equal(failProc.embeds[0].title, 'Não foi possível processar a sessão');
    assert.match(failProc.embeds[0].fields.find((f) => f.name === 'Processamento').value, /bucket e campanha/);

    // 20 opções com nomes longos compartilhando prefixo -> 4 linhas de voto + 1 linha de adicionar = 5 ActionRows
    const longPrefix = 'A Grande Jornada dos Aventureiros de Eldoria no Capítulo ';
    const suggestions = Array.from({ length: MAX_POLL_OPTIONS - 1 }, (_, i) => longPrefix + (i + 1) + ' — Parte Final');
    const opened = await openRecordingPoll(fixture.dir, { suggestions, now: () => nowMs });
    const pollPanel = recordingPanel(opened.meta, null, nowMs + 1000);

    assert.equal(pollPanel.embeds[0].title, '🗳️ Escolha o nome da sessão');
    assert.deepEqual(pollPanel.allowed_mentions, { parse: [] });
    assert.equal(pollPanel.components.length, 5, '4 ActionRows de voto + 1 ActionRow reservada para adicionar');
    assert.equal(pollPanel.components[4].components[0].label, 'Enviar opção personalizada');

    const voteButtons = pollPanel.components.slice(0, 4).flatMap((row) => row.components);
    assert.equal(voteButtons.length, 20);
    const uniqueLabels = new Set(voteButtons.map((btn) => btn.label));
    assert.equal(uniqueLabels.size, 20, 'rótulos abreviados permanecem desambiguados');
    for (const btn of voteButtons) {
      assert.ok(btn.label.length <= 80, 'limite de 80 caracteres por botão no Discord');
    }
    for (const field of pollPanel.embeds[0].fields) {
      assert.ok(field.value.length <= 1024, 'limite de 1024 caracteres por campo no embed');
    }
    assert.ok(formatPollButtonLabel(12, 'x'.repeat(100), 99).length <= 80);

    // Estado encerrado + publicação (publishing / published / announced:false / failed)
    const closed = await closeRecordingPoll(fixture.dir, { now: () => Date.parse(opened.poll.endsAt), force: false });
    const pubPending = recordingPanel({ ...closed.meta, publication: { status: 'publishing' } }, null, nowMs + POLL_DURATION_MS);
    assert.equal(pubPending.embeds[0].title, 'Enquete encerrada');
    assert.equal(pubPending.components.length, 0);
    assert.equal(pubPending.embeds[0].fields.find((f) => f.name === 'Publicação').value, 'Publicação em andamento');

    const pubUnannounced = recordingPanel({ ...closed.meta, publication: { status: 'published', announced: false } }, null, nowMs + POLL_DURATION_MS);
    assert.equal(pubUnannounced.embeds[0].fields.find((f) => f.name === 'Publicação').value, 'Publicado; anúncio no Discord não confirmado');

    const pubFailed = recordingPanel({ ...closed.meta, publication: { status: 'failed' } }, null, nowMs + POLL_DURATION_MS);
    assert.match(pubFailed.embeds[0].fields.find((f) => f.name === 'Publicação').value, /O nome escolhido foi mantido/);
  } finally {
    fixture.cleanup();
  }
});

test('RecordingPanels.handle validates channel membership, handles vote/modal flow and updates the same Discord message', async () => {
  const fixture = createFixtureDir({ sessionTitle: 'Sessão Zero', sessionTitleBy: AUTHOR_ID });
  try {
    const nowMs = Date.parse('2026-11-19T14:00:00.000Z');
    const client = createFakeClient();
    const panels = new RecordingPanels(client, { now: () => nowMs });
    const opened = await panels.openPoll(fixture.dir, { suggestions: ['Caminho do Norte'] });
    assert.equal(client.patches.length, 1);

    // 1. Usuário sem permissão de ver o canal é bloqueado.
    const denied = createInteraction({
      customId: 'pia-poll:vote:' + RECORDING_ID + ':' + opened.poll.options[1].id,
      userId: USER_B,
      canView: false,
    });
    assert.equal(canParticipateInPoll(denied.interaction, opened.meta), false);
    await panels.handle({ sessions: new Map(), account: { id: 1 } }, denied.interaction);
    assert.equal(denied.replies[0].content, 'Você não tem permissão para participar desta enquete.');
    assert.equal(client.patches.length, 1, 'não altera o card quando rejeitado');

    // 2. Voto autorizado grava em disco e atualiza a mesma mensagem.
    const voteCall = createInteraction({
      customId: 'pia-poll:vote:' + RECORDING_ID + ':' + opened.poll.options[1].id,
      userId: USER_B,
    });
    await panels.handle({ sessions: new Map(), account: { id: 1 } }, voteCall.interaction);
    assert.equal(voteCall.replies[0].content, 'Seu voto em ‘Caminho do Norte’ foi registrado.');
    assert.equal(voteCall.replies[0].flags, 64);
    assert.equal(client.patches.length, 2);
    assert.equal(client.patches[1].route, Routes.channelMessage(NOTICE_CHANNEL_ID, PANEL_MESSAGE_ID));

    // 3. Clique em Enviar opção personalizada abre o modal correto.
    const addBtn = createInteraction({
      customId: 'pia-poll:add:' + RECORDING_ID,
      userId: USER_C,
    });
    await panels.handle({ sessions: new Map(), account: { id: 1 } }, addBtn.interaction);
    assert.equal(addBtn.modals.length, 1);
    assert.equal(addBtn.modals[0].title, 'Sugerir nome da sessão');
    assert.equal(addBtn.modals[0].custom_id, 'pia-poll:add:' + RECORDING_ID);

    // 4. Envio do modal persiste a nova opção e atualiza o card.
    const addSubmit = createInteraction({
      customId: 'pia-poll:add:' + RECORDING_ID,
      userId: USER_C,
      modal: true,
      modalLabel: 'A Coroa Quebrada',
    });
    await panels.handle({ sessions: new Map(), account: { id: 1 } }, addSubmit.interaction);
    assert.equal(addSubmit.replies[0].content, 'Opção adicionada e seu voto registrado.');
    assert.equal(client.patches.length, 3);

    const saved = read(recordingMetaPath(fixture.dir), null);
    assert.equal(saved.poll.options.length, 3);
    assert.equal(saved.poll.options[2].label, 'A Coroa Quebrada');
    assert.deepEqual(saved.poll.options[2].voters, [USER_C]);

    panels.close();
  } finally {
    fixture.cleanup();
  }
});
