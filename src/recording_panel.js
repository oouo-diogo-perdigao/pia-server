import { guildAccount, hasRecordingRole } from './discord_guild_links.js';
import { ActionRowBuilder, ButtonStyle, ComponentType, ModalBuilder, PermissionFlagsBits, Routes,
  TextInputBuilder, TextInputStyle, escapeMarkdown } from 'discord.js';

export const editWindowMs = 30 * 60 * 1000;
const maxNotes = 50;
const componentId = /^pia-rec:(stop|note|title|season):([a-f0-9-]{36})$/;
const timestamp = (date) => '<t:' + Math.floor(Date.parse(date) / 1000) + ':t>';
const actor = (who) => who?.user ? '<@' + who.user + '>' : (who?.label || 'Sistema');

function duration(ms) {
  const seconds = Math.floor(ms / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, '0')).join(':');
}

export function editableRecording(meta, now = Date.now()) {
  return meta.state !== 'recording' && Date.parse(meta.editUntil) > now;
}

export function recordingPanel(meta, ping, now = Date.now()) {
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
  if (active) {
    const values = [['Voz', ping?.udp], ['WebSocket', ping?.ws]]
      .filter(([, value]) => Number.isFinite(value) && value >= 0)
      .map(([type, value]) => type + ': ' + Math.round(value) + ' ms');
    fields.push({ name: 'Latência', value: values.join(' · ') || 'Aguardando medição.' });
  } else {
    fields.push({ name: 'Encerrada por', value: actor(meta.stoppedBy), inline: true },
      { name: 'Duração total', value: duration(meta.durationMs || 0), inline: true });
    if (meta.note) fields.push({ name: 'Motivo', value: meta.note });
    if (meta.sessionTitle) fields.push({ name: 'Nome da sessão', value: escapeMarkdown(meta.sessionTitle) });
    if (meta.seasonEnd) fields.push({ name: 'Temporada', value: 'Última sessão da temporada.' });
    if (editableRecording(meta, now)) fields.push({ name: 'Editar até', value: timestamp(meta.editUntil) });
  }
  if (notes.length) fields.push({ name: 'Notas · ' + notes.length,
    value: notes.slice(-2).map((note) => '`' + duration(note.offsetMs) + '` ' +
      escapeMarkdown(note.text.replace(/\s+/g, ' ').slice(0, 140))).join('\n') });
  const button = (action, label, style, disabled = false) =>
    ({ type: ComponentType.Button, custom_id: 'pia-rec:' + action + ':' + meta.id, label, style, disabled });
  const buttons = active ?
    [button('stop', 'Parar gravação', ButtonStyle.Danger), button('note', 'Adicionar nota', ButtonStyle.Secondary)] :
    [button('title', 'Nome da sessão', ButtonStyle.Primary, !editableRecording(meta, now)),
      button('season', meta.seasonEnd ? 'Desfazer fim da temporada' : 'Encerrar temporada',
        ButtonStyle.Secondary, !editableRecording(meta, now))];
  return { embeds: [{ title: active ? '🔴 Gravação em andamento' : 'Gravação encerrada',
    color: active ? 0xed4245 : 0x7652c6, fields }],
    components: [{ type: ComponentType.ActionRow, components: buttons }], allowed_mentions: { parse: [] } };
}

export class RecordingPanels {
  entries = new Map();
  updates = new Map();

  constructor(client) { this.client = client; }

  update(meta, ping) {
    const previous = this.updates.get(meta.id) || Promise.resolve();
    const current = previous.then(() => this.client.rest.patch(Routes.channelMessage(meta.noticeChannelId, meta.panelMessageId),
      { body: recordingPanel(meta, ping) })).catch((error) => {
      if (meta.panelError !== error.code) {
        meta.panelError = error.code || 'request';
        console.error('Discord: falha ao atualizar painel de gravação, código ' + meta.panelError);
      }
    });
    this.updates.set(meta.id, current);
    void current.finally(() => { if (this.updates.get(meta.id) === current) this.updates.delete(meta.id); });
  }

  finish(meta, persist) {
    if (!meta.panelMessageId || !meta.editUntil || this.entries.has(meta.id)) return;
    const remaining = Date.parse(meta.editUntil) - Date.now();
    if (remaining < -editWindowMs) return;
    const entry = { meta, persist, timer: null };
    const expire = () => {
      this.update(meta);
      entry.timer = setTimeout(() => this.entries.delete(meta.id), Math.max(0, Date.parse(meta.editUntil) + editWindowMs - Date.now()));
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

  close() {
    for (const { timer } of this.entries.values()) clearTimeout(timer);
    this.entries.clear();
  }

  async handle(runtime, interaction) {
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
      if ((action === 'stop' || action === 'note') ? !live : !editableRecording(meta))
        throw new Error('O prazo para esta ação terminou.');
      if (interaction.isButton() && (action === 'note' || action === 'title')) {
        const input = new TextInputBuilder().setCustomId('text').setLabel(action === 'note' ? 'Nota' : 'Nome da sessão')
          .setStyle(action === 'note' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(true).setMaxLength(action === 'note' ? 400 : 120);
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
