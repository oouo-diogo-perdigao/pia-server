import { randomInt as cryptoRandomInt } from 'node:crypto';
import { guildAccount, hasRecordingRole } from './discord_guild_links.js';
import { origin } from './auth.js';
import { textoJuridico } from './legal.js';
import { read } from './state.js';
import {
  MAX_OPTION_LENGTH,
  MAX_POLL_OPTIONS,
  addRecordingPollOption,
  closeRecordingPoll,
  getPersistedPollWinner,
  isPollOpen,
  openRecordingPoll,
  optionVoteCount,
  recordingMetaPath,
  restoreRecordingPoll,
  voteRecordingPoll,
} from './recording_poll.js';
import { ActionRowBuilder, ButtonStyle, ComponentType, ModalBuilder, PermissionFlagsBits, Routes,
  TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';

export const editWindowMs = 30 * 60 * 1000;
const maxNotes = 50;
const componentId = /^pia-rec:(stop|note|title|season):([a-f0-9-]{36})$/;
const pollComponentId = /^pia-poll:(vote|add):([a-f0-9-]{36})(?::([a-z0-9-]+))?$/;
const timestamp = (date) => '<t:' + Math.floor(Date.parse(date) / 1000) + ':t>';
const relativeTimestamp = (date) => '<t:' + Math.floor(Date.parse(date) / 1000) + ':R>';
const actor = (who) => who?.user ? '<@' + who.user + '>' : (who?.label || 'Sistema');

function duration(ms) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, '0')).join(':');
}

export function editableRecording(meta, now = Date.now()) {
  return meta.state !== 'recording' && Date.parse(meta.editUntil) > now;
}

// RF10/CA26: aviso de uso da gravação para treinamento, com link para a Política (texto em juridico.js).
export function trainingNotice(publicOrigin = origin) {
  return textoJuridico('AVISO_GRAVACAO_DISCORD') + '\nPolítica de Privacidade: ' + new URL(publicOrigin).origin + '/privacidade';
}

function formatVotes(count, initialSystemOnly = false) {
  if (initialSystemOnly) return '1 voto inicial';
  return count === 1 ? '1 voto' : count + ' votos';
}

export function formatPollButtonLabel(index, label, votes) {
  const prefix = index + '. ';
  const suffix = ' (' + votes + ')';
  const maxName = Math.max(1, 80 - prefix.length - suffix.length);
  const short = label.length > maxName ? label.slice(0, Math.max(1, maxName - 1)).trimEnd() + '…' : label;
  return prefix + short + suffix;
}

function pollOptionFields(options, heading = 'Opções') {
  const lines = options.map((option, index) => {
    const count = optionVoteCount(option);
    const initialSystemOnly = Boolean(option.initialSystemVote && (!option.voters || option.voters.length === 0));
    const kindLabel = option.kind === 'custom' ? 'Personalizada' : 'Sugerida';
    return '**' + (index + 1) + '.** ' + escapeMarkdown(option.label) + ' — ' + kindLabel + ' · ' + formatVotes(count, initialSystemOnly);
  });
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? current + '\n' + line : line;
    if (next.length > 1024 && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((value, idx) => ({
    name: chunks.length > 1 ? heading + ' (' + (idx + 1) + '/' + chunks.length + ')' : heading,
    value,
  }));
}

function pollActionRows(meta, poll, expired) {
  const rows = [];
  const options = (poll.options || []).slice(0, MAX_POLL_OPTIONS);
  for (let i = 0; i < options.length; i += 5) {
    const slice = options.slice(i, i + 5);
    rows.push({
      type: ComponentType.ActionRow,
      components: slice.map((option, offset) => ({
        type: ComponentType.Button,
        custom_id: 'pia-poll:vote:' + meta.id + ':' + option.id,
        label: formatPollButtonLabel(i + offset + 1, option.label, optionVoteCount(option)),
        style: ButtonStyle.Secondary,
        disabled: expired,
      })),
    });
  }
  rows.push({
    type: ComponentType.ActionRow,
    components: [{
      type: ComponentType.Button,
      custom_id: 'pia-poll:add:' + meta.id,
      label: 'Enviar opção personalizada',
      style: ButtonStyle.Primary,
      disabled: expired,
    }],
  });
  return rows;
}

function publicationStatusText(publication) {
  if (!publication) return null;
  if (publication.status === 'publishing') return 'Publicação em andamento';
  if (publication.status === 'published') {
    return publication.announced === false ? 'Publicado; anúncio no Discord não confirmado' : 'Publicado';
  }
  if (publication.status === 'failed') {
    return 'Não foi possível concluir a publicação\nO nome escolhido foi mantido. A publicação ainda não foi confirmada.';
  }
  return null;
}

export function canParticipateInPoll(interaction, meta) {
  if (!interaction || !meta) return false;
  if (interaction.guildId !== meta.guildId || interaction.channelId !== meta.noticeChannelId) return false;
  if (!interaction.user?.id || interaction.user.bot) return false;
  if (!interaction.member) return false;
  if (typeof interaction.channel?.permissionsFor === 'function') {
    const perms = interaction.channel.permissionsFor(interaction.member);
    return perms?.has?.(PermissionFlagsBits.ViewChannel) === true;
  }
  return interaction.memberPermissions?.has?.(PermissionFlagsBits.ViewChannel) === true;
}

export function recordingPanel(meta, ping, now = Date.now(), publicOrigin = origin) {
  const active = meta.state === 'recording';
  const members = Object.entries(meta.members || {});
  const visible = members.sort(([, a], [, b]) => Number(Boolean(a.leftAt)) - Number(Boolean(b.leftAt))).slice(0, 12);
  const notes = meta.notes || [];
  const participants = visible.map(([id, member]) => '<@' + id + '> · entrou ' + timestamp(member.joinedAt) +
    (member.leftAt ? ' · saiu ' + timestamp(member.leftAt) : ''));
  if (members.length > visible.length) participants.push('+' + (members.length - visible.length) + ' participantes');
  const fields = [
    { name: 'ID da gravação', value: '`' + meta.id + '`' },
    { name: 'Canal', value: '<#' + meta.channelId + '>', inline: true },
    { name: 'Início', value: timestamp(meta.startedAt), inline: true },
    { name: 'Iniciada por', value: meta.requester ? '<@' + meta.requester + '>' : 'Autorecord', inline: true },
    { name: 'Participantes · ' + members.filter(([, member]) => !member.leftAt).length + (active ? ' no canal' : ' ao encerrar'),
      value: participants.join('\n') || 'Nenhum participante no canal.' },
  ];

  const hasPoll = !active && Boolean(meta.poll);
  const hasProcessing = !active && !hasPoll && Boolean(meta.processing);

  if (active) {
    const values = [['Voz', ping?.udp], ['WebSocket', ping?.ws]]
      .filter(([, value]) => Number.isFinite(value) && value >= 0)
      .map(([type, value]) => type + ': ' + Math.round(value) + ' ms');
    fields.push({ name: 'Latência', value: values.join(' · ') || 'Aguardando medição.' });
    fields.push({ name: 'Privacidade', value: trainingNotice(publicOrigin) });
  } else {
    fields.push({ name: 'Encerrada por', value: actor(meta.stoppedBy), inline: true },
      { name: 'Duração total', value: duration(meta.durationMs || 0), inline: true });
    if (meta.note) fields.push({ name: 'Motivo', value: meta.note });
    if (!hasPoll && !hasProcessing && meta.sessionTitle) fields.push({ name: 'Nome da sessão', value: escapeMarkdown(meta.sessionTitle) });
    if (meta.seasonEnd) fields.push({ name: 'Temporada', value: 'Última sessão da temporada.' });
    if (!hasPoll && !hasProcessing && editableRecording(meta, now)) fields.push({ name: 'Editar até', value: timestamp(meta.editUntil) });
  }

  if (notes.length) fields.push({ name: 'Notas · ' + notes.length,
    value: notes.slice(-2).map((note) => '`' + duration(note.offsetMs) + '` ' +
      escapeMarkdown(note.text.replace(/\s+/g, ' ').slice(0, 140))).join('\n') });

  if (hasProcessing) {
    const failed = meta.processing.status === 'failed';
    if (meta.processing.status === 'skipped') {
      fields.push({ name: 'Processamento', value: 'A gravação ficou abaixo da duração mínima e não foi publicada.' });
    } else if (failed) {
      const details = ['A sessão ainda não foi publicada e a enquete não foi aberta.'];
      if (Array.isArray(meta.processing.missingConfig) && meta.processing.missingConfig.length) {
        details.push('Para processar no servidor, configure ' + meta.processing.missingConfig.join(' e ') + '.');
      }
      if (meta.processing.error) details.push(escapeMarkdown(String(meta.processing.error)));
      fields.push({ name: 'Processamento', value: details.join('\n') });
    } else {
      const stage = escapeMarkdown(String(meta.processing.stage || 'Preparando enquete…'));
      fields.push({ name: 'Processamento', value: 'Etapa atual: ' + stage + '. A publicação e a enquete ainda não começaram.' });
    }
    if (meta.sessionTitle) fields.push({ name: 'Nome informado', value: escapeMarkdown(meta.sessionTitle) });
    return {
      embeds: [{
        title: meta.processing.status === 'skipped' ? 'Gravação abaixo da duração mínima' :
          failed ? 'Não foi possível processar a sessão' : '⚙️ Processando sessão no servidor',
        color: failed ? 0xed4245 : 0x5865f2,
        fields,
      }],
      components: [],
      allowed_mentions: { parse: [] },
    };
  }

  if (hasPoll) {
    const poll = meta.poll;
    if (poll.status === 'closed') {
      const winner = poll.winner;
      if (winner) {
        fields.push({
          name: 'Nome escolhido',
          value: escapeMarkdown(winner.label) + ' · ' + formatVotes(winner.votes),
        });
      }
      fields.push(...pollOptionFields(poll.options || [], 'Resultado final'));
      const pubText = publicationStatusText(meta.publication);
      if (pubText) fields.push({ name: 'Publicação', value: pubText });
      return {
        embeds: [{
          title: 'Enquete encerrada',
          color: meta.publication?.status === 'failed' ? 0xed4245 : 0x57f287,
          fields,
        }],
        components: [],
        allowed_mentions: { parse: [] },
      };
    }

    const expired = !isPollOpen(poll, now);
    fields.push({
      name: 'Encerramento',
      value: 'Encerra ' + relativeTimestamp(poll.endsAt) + ' (' + timestamp(poll.endsAt) + ')',
    });
    fields.push(...pollOptionFields(poll.options || [], 'Opções'));
    return {
      embeds: [{
        title: '🗳️ Escolha o nome da sessão',
        description: 'A sessão ainda não foi publicada no RSS. Vote em quantos nomes quiser; cada pessoa pode votar uma vez em cada nome.',
        color: 0x5865f2,
        fields,
      }],
      components: pollActionRows(meta, poll, expired),
      allowed_mentions: { parse: [] },
    };
  }

  const button = (action, label, style, disabled = false) =>
    ({ type: ComponentType.Button, custom_id: 'pia-rec:' + action + ':' + meta.id, label, style, disabled });
  const buttons = active ?
    [button('stop', 'Parar gravação', ButtonStyle.Danger), button('note', 'Adicionar nota', ButtonStyle.Secondary),
      ...(meta.processingMode === 'server' ? [button('title', 'Nome da sessão', ButtonStyle.Primary)] : [])] :
    [button('title', 'Nome da sessão', ButtonStyle.Primary, !editableRecording(meta, now)),
      button('season', meta.seasonEnd ? 'Desfazer fim da temporada' : 'Encerrar temporada',
        ButtonStyle.Secondary, !editableRecording(meta, now))];
  return { embeds: [{ title: active ? '🔴 Gravação em andamento' : 'Gravação encerrada',
    color: active ? 0xed4245 : 0x7652c6, fields }],
    components: [{ type: ComponentType.ActionRow, components: buttons }], allowed_mentions: { parse: [] } };
}

export class RecordingPanels {
  entries = new Map();
  polls = new Map();
  updates = new Map();

  constructor(client, { now = Date.now, randomInt = cryptoRandomInt, onPollClosed = null } = {}) {
    this.client = client;
    this.now = now;
    this.randomInt = randomInt;
    this.onPollClosed = onPollClosed;
  }

  update(meta, ping) {
    if (!meta?.noticeChannelId || !meta?.panelMessageId) return Promise.resolve();
    const previous = this.updates.get(meta.id) || Promise.resolve();
    const current = previous.then(() => this.client.rest.patch(Routes.channelMessage(meta.noticeChannelId, meta.panelMessageId),
      { body: recordingPanel(meta, ping, this.now()) })).catch((error) => {
      if (meta.panelError !== error.code) {
        meta.panelError = error.code || 'request';
        console.error('Discord: falha ao atualizar painel de gravação, código ' + meta.panelError);
      }
    });
    this.updates.set(meta.id, current);
    void current.finally(() => { if (this.updates.get(meta.id) === current) this.updates.delete(meta.id); });
    return current;
  }

  finish(meta, persist) {
    if (!meta.panelMessageId || !meta.editUntil || this.entries.has(meta.id)) return;
    const remaining = Date.parse(meta.editUntil) - this.now();
    if (remaining < -editWindowMs) return;
    const entry = { meta, persist, timer: null };
    const expire = () => {
      this.update(meta);
      entry.timer = setTimeout(() => this.entries.delete(meta.id), Math.max(0, Date.parse(meta.editUntil) + editWindowMs - this.now()));
      entry.timer.unref();
    };
    this.entries.set(meta.id, entry);
    if (remaining <= 0) expire();
    else {
      this.update(meta);
      entry.timer = setTimeout(expire, remaining);
      entry.timer.unref();
    }
  }

  watchPoll(dir, meta, options = {}) {
    if (!meta?.id || !meta.poll) return;
    const existing = this.polls.get(meta.id);
    if (existing) {
      existing.dir = dir;
      existing.meta = meta;
      if (options.onPollClosed) existing.onPollClosed = options.onPollClosed;
      return existing;
    }
    const entry = { dir, meta, timer: null, onPollClosed: options.onPollClosed || this.onPollClosed };
    this.polls.set(meta.id, entry);
    if (meta.poll.status === 'open') {
      const remaining = Math.max(0, Date.parse(meta.poll.endsAt) - this.now());
      entry.timer = setTimeout(() => {
        void this.closePoll(dir, { onPollClosed: entry.onPollClosed }).catch(() => {
          console.error('Discord: falha ao encerrar enquete de gravação.');
        });
      }, remaining);
      entry.timer.unref();
    }
    return entry;
  }

  async openPoll(dir, options = {}) {
    const result = await openRecordingPoll(dir, {
      ...options,
      now: options.now || this.now,
    });
    const prevEntry = this.entries.get(result.meta.id);
    if (prevEntry) {
      clearTimeout(prevEntry.timer);
      this.entries.delete(result.meta.id);
    }
    this.watchPoll(dir, result.meta, options);
    await this.update(result.meta);
    return result;
  }

  async restorePoll(dir, options = {}) {
    const result = await restoreRecordingPoll(dir, {
      now: options.now || this.now,
      randomInt: options.randomInt || this.randomInt,
      autoClose: options.autoClose !== false,
    });
    if (!result) return null;
    const callback = options.onPollClosed || this.onPollClosed;
    if (result.status === 'open') {
      this.watchPoll(dir, result.meta, { onPollClosed: callback });
      if (options.refreshPanel) await this.update(result.meta);
    } else if (result.closedNow) {
      this.polls.set(result.meta.id, { dir, meta: result.meta, timer: null, onPollClosed: callback });
      await this.update(result.meta);
      if (typeof callback === 'function') await callback(result);
    }
    return result;
  }

  async closePoll(dir, options = {}) {
    const result = await closeRecordingPoll(dir, {
      now: options.now || this.now,
      randomInt: options.randomInt || this.randomInt,
      force: Boolean(options.force),
    });
    if (result.pending) return result;
    const existing = this.polls.get(result.meta.id);
    if (existing?.timer) clearTimeout(existing.timer);
    const callback = options.onPollClosed || existing?.onPollClosed || this.onPollClosed;
    this.polls.set(result.meta.id, { dir, meta: result.meta, timer: null, onPollClosed: callback });
    await this.update(result.meta);
    if (!result.alreadyClosed && typeof callback === 'function') {
      await callback(result);
    }
    return result;
  }

  getPollWinner(dir) {
    return getPersistedPollWinner(dir);
  }

  close() {
    for (const { timer } of this.entries.values()) clearTimeout(timer);
    this.entries.clear();
    for (const { timer } of this.polls.values()) clearTimeout(timer);
    this.polls.clear();
  }

  async handlePollInteraction(interaction, match) {
    const [, action, id, optionId] = match;
    const entry = this.polls.get(id);
    try {
      if (!entry) throw new Error('Esta enquete não está mais disponível.');
      const fresh = read(recordingMetaPath(entry.dir), null) || entry.meta;
      entry.meta = fresh;
      if (!canParticipateInPoll(interaction, fresh)) {
        throw new Error('Você não tem permissão para participar desta enquete.');
      }

      if (action === 'add' && interaction.isButton()) {
        if (!isPollOpen(fresh.poll, this.now())) {
          if (fresh.poll?.status === 'open') await this.closePoll(entry.dir);
          return await interaction.reply({ content: 'A enquete já foi encerrada.', flags: 64 });
        }
        const input = new TextInputBuilder()
          .setCustomId('label')
          .setLabel('Nome')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(MAX_OPTION_LENGTH);
        return await interaction.showModal(new ModalBuilder()
          .setCustomId('pia-poll:add:' + id)
          .setTitle('Sugerir nome da sessão')
          .addComponents(new ActionRowBuilder().addComponents(input)));
      }

      if (action === 'add' && interaction.isModalSubmit()) {
        const label = interaction.fields.getTextInputValue('label');
        const result = await addRecordingPollOption(entry.dir, {
          label,
          userId: interaction.user.id,
          now: this.now,
        });
        if (result.meta) entry.meta = result.meta;
        if (result.changed) await this.update(result.meta);
        else if (result.code === 'closed' && result.meta?.poll?.status === 'open') {
          await this.closePoll(entry.dir);
        }
        return await interaction.reply({ content: result.message, flags: 64, allowedMentions: { parse: [] } });
      }

      if (action === 'vote' && interaction.isButton()) {
        const result = await voteRecordingPoll(entry.dir, {
          optionId,
          userId: interaction.user.id,
          now: this.now,
        });
        if (result.meta) entry.meta = result.meta;
        if (result.changed) await this.update(result.meta);
        else if (result.code === 'closed' && result.meta?.poll?.status === 'open') {
          await this.closePoll(entry.dir);
        }
        return await interaction.reply({ content: result.message, flags: 64, allowedMentions: { parse: [] } });
      }
    } catch (error) {
      if (!interaction.replied) {
        const fallback = action === 'add' && interaction.isModalSubmit?.()
          ? 'Não foi possível registrar sua opção. Tente novamente.'
          : 'Não foi possível atualizar a enquete.';
        await interaction.reply({
          content: error.code ? fallback : error.message,
          flags: 64,
        }).catch(() => {});
      }
    }
  }

  async handle(runtime, interaction) {
    const pollMatch = pollComponentId.exec(interaction.customId || '');
    if (pollMatch) return await this.handlePollInteraction(interaction, pollMatch);

    const match = componentId.exec(interaction.customId || '');
    if (!match) return;
    const [, action, id] = match;
    const live = [...runtime.sessions.values()].find((session) => session.meta.id === id && !session.closed);
    const item = live ? { meta: live.meta, persist: () => live.persist() } : this.entries.get(id);
    try {
      if (!item || item.meta.guildId !== interaction.guildId || item.meta.noticeChannelId !== interaction.channelId)
        throw new Error('Este painel expirou.');
      const { meta } = item;
      const user = interaction.user.id;
      const manager = meta.requester === user || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
      const roleAllowed = action === 'stop' && !manager &&
        hasRecordingRole(interaction, (await guildAccount(runtime.account.id, meta.guildId))?.access_roles);
      if (!manager && !roleAllowed && !(action === 'note' && live?.channel.members.has(user)))
        throw new Error('Você não tem permissão para esta ação.');
      const editingLiveTitle = action === 'title' && live && meta.processingMode === 'server';
      if ((action === 'stop' || action === 'note') ? !live : !editingLiveTitle && !editableRecording(meta, this.now()))
        throw new Error('O prazo para esta ação terminou.');
      if (interaction.isButton() && (action === 'note' || action === 'title')) {
        const input = new TextInputBuilder().setCustomId('text').setLabel(action === 'note' ? 'Nota' : 'Nome da sessão')
          .setStyle(action === 'note' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(true).setMaxLength(action === 'note' ? 400 : meta.processingMode === 'server' ? MAX_OPTION_LENGTH : 120);
        if (action === 'title' && meta.sessionTitle) input.setValue(meta.sessionTitle);
        return await interaction.showModal(new ModalBuilder().setCustomId(interaction.customId)
          .setTitle(action === 'note' ? 'Adicionar nota' : 'Nome da sessão')
          .addComponents(new ActionRowBuilder().addComponents(input)));
      }
      if (interaction.isButton() && action === 'stop') {
        live.finish('', { user });
        return await interaction.reply({ content: 'Gravação encerrada.', flags: 64 });
      }
      let feedback;
      if (interaction.isButton() && action === 'season') {
        meta.seasonEnd = !meta.seasonEnd;
        feedback = meta.seasonEnd ? 'Sessão marcada como fim da temporada.' : 'Marcação de fim da temporada removida.';
      } else if (interaction.isModalSubmit() && (action === 'note' || action === 'title')) {
        const value = interaction.fields.getTextInputValue('text').trim();
        if (!value) throw new Error('Informe um texto.');
        if (action === 'note') {
          const notes = meta.notes ||= [];
          if (notes.length >= maxNotes) throw new Error('Esta gravação já tem 50 notas.');
          notes.push({ text: value, user, offsetMs: Math.floor(performance.now() - live.started) });
          feedback = 'Nota adicionada.';
        } else {
          meta.sessionTitle = value;
          meta.sessionTitleBy = user;
          feedback = 'Nome da sessão salvo.';
        }
      } else return;
      item.persist();
      this.update(meta, live?.connection.ping);
      await interaction.reply({ content: feedback, flags: 64 });
    } catch (error) {
      if (!interaction.replied) await interaction.reply({
        content: error.code ? 'Não foi possível atualizar a gravação.' : error.message, flags: 64,
      }).catch(() => {});
    }
  }
}
