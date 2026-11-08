import { recordingFolder, recordingName } from './recording_format.js';
import { guildAccount } from './discord_guild_links.js';
import { handleRecordingCommand, recordingCommands, registerRecordingCommands } from './recording_commands.js';
import { linkDiscordChannel } from './connectors.js';
import { mkdirSync, closeSync, ftruncateSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { EndBehaviorType, entersState, joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { root, save, snowflake } from './state.js';

const RATE = 48000;
const MAX_MS = 6 * 3600 * 1000;
const NOTICE = '🔴 A PIA vai gravar este canal de voz em faixas separadas e guardar a sessão no Google Drive. Avise a organização se não concordar e saia do canal antes do início.';

export function positionForFrame(samplesWritten, elapsedMs, frameSamples) {
  const expected = Math.max(0, Math.floor(elapsedMs * RATE / 1000) - frameSamples);
  // Leave room for packet jitter. Preserve longer gaps and late arrivals.
  return expected > samplesWritten + RATE * 0.06 ? expected : samplesWritten;
}

class Recording {
  constructor(account, connection, rule, channel, requester) {
    this.connection = connection;
    this.channel = channel;
    this.rule = rule;
    this.accountId = account.id;
    this.started = performance.now();
    this.closed = false;
    this.tracks = new Map();
    const date = new Date();
    const id = randomUUID();
    const name = recordingName(channel.guild.name, channel.name, date);
    this.folder = join(root, String(account.id), id);
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    this.meta = { id, name, channelId: rule.channelId, guildId: rule.guildId, startedAt: date.toISOString(),
      folderId: recordingFolder(account), driveAccount: account.recording_drive_account || null,
      state: 'recording', tracks: [], usernames: {}, ...(requester ? { requester } : {}) };
    this.persist();
    connection.receiver.speaking.on('start', (userId) => this.listen(userId));
    this.limit = setTimeout(() => this.finish(), MAX_MS);
  }

  persist() { save(join(this.folder, 'recording.json'), this.meta); }

  listen(userId) {
    const user = this.channel.members.get(userId)?.user;
    if (this.closed || !snowflake.test(userId) || !user || user.bot || this.tracks.has(userId)) return;
    let fd, stream, decoder;
    try {
      fd = openSync(join(this.folder, userId + '.pcm'), 'w', 0o600);
      decoder = new OpusScript(RATE, 1, OpusScript.Application.AUDIO);
      stream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
      const track = { fd, stream, decoder, samples: 0 };
      this.tracks.set(userId, track);
      this.meta.tracks.push(userId);
      this.meta.usernames[userId] = user.username;
      this.persist();
      stream.on('data', (packet) => {
        if (this.closed) return;
        let frame;
        try { frame = decoder.decode(packet); } catch { return; }
        try {
          const offset = positionForFrame(track.samples, performance.now() - this.started, frame.length / 2);
          const bytes = writeSync(fd, frame, 0, frame.length, offset * 2);
          if (bytes !== frame.length) throw new Error('short write');
          track.samples = offset + bytes / 2;
        } catch { this.finish('Falha ao gravar áudio no disco.'); }
      });
      stream.on('error', () => this.finish('Recepção de áudio interrompida.'));
    } catch {
      if (!this.tracks.has(userId)) {
        stream?.destroy();
        decoder?.delete();
        if (fd !== undefined) closeSync(fd);
      }
      this.finish('Falha ao abrir uma faixa.');
    }
  }

  finish(reason = '') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.limit);
    clearTimeout(this.emptyTimer);
    const samples = Math.floor((performance.now() - this.started) * RATE / 1000);
    this.meta.tracks = [];
    for (const [id, track] of this.tracks) {
      track.stream.destroy();
      track.decoder.delete();
      if (track.samples) {
        this.meta.tracks.push(id);
        try { ftruncateSync(track.fd, Math.max(samples, track.samples) * 2); }
        catch { reason ||= 'Falha ao completar a duração da faixa.'; }
      }
      closeSync(track.fd);
    }
    this.meta.state = this.meta.tracks.length ? 'queued' : 'empty';
    this.meta.endedAt = new Date().toISOString();
    this.meta.note = reason;
    try { this.persist(); }
    finally {
      if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    }
  }
}

export class DiscordRecorder {
  sessions = new Map();
  pending = new Set();
  blocked = new Set();
  error = '';
  closed = false;

  constructor(account, token, destinations = new Map()) {
    this.account = account;
    this.destinations = destinations;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.client.on(Events.ClientReady, () => {
      this.evaluate();
      registerRecordingCommands(this.client).catch(() => {
        console.error('Não foi possível registrar os comandos de gravação do Discord.');
      });
    });
    this.client.on(Events.VoiceStateUpdate, (before, after) => {
      if (before.channelId === after.channelId || after.member?.user.bot) return;
      this.evaluate(after.channelId, after.id);
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === 'link') void this.linkChannel(interaction);
      else if (recordingCommands.some(({ name }) => name === interaction.commandName))
        void handleRecordingCommand(this, interaction);
    });
    this.client.on(Events.Error, () => { this.error = 'Conexão com Discord interrompida.'; });
    this.client.login(token).catch(() => { this.error = 'O Discord recusou a conexão do bot.'; });
  }

  async linkChannel(interaction) {
    try {
      await interaction.deferReply({ flags: 64 });
      await linkDiscordChannel(this.account, interaction);
      await interaction.editReply('Canal vinculado à PIA Server. DISCORD_CHANNEL_ID=' + interaction.channelId);
    } catch (error) {
      const message = error.code ? 'Não foi possível vincular o canal.' : error.message;
      if (interaction.deferred) await interaction.editReply(message).catch(() => {});
    }
  }

  setDestinations(destinations) {
    const signature = (routes) => JSON.stringify([...routes].sort(([a], [b]) => a.localeCompare(b))
      .map(([guild, account]) => [guild, account.id, recordingFolder(account), account.recording_drive_account, Boolean(account.drive_refresh), account.rules]));
    const changed = signature(this.destinations) !== signature(destinations);
    this.destinations = destinations;
    if (changed) this.evaluate();
  }

  evaluate(joinedChannel, joinedUser) {
    if (this.closed || !this.client.isReady()) return;
    const rules = new Map([...this.destinations].flatMap(([guild, account]) =>
      account.rules.filter((rule) => rule.guildId === guild).map((rule) => [rule.channelId, rule])));
    for (const [channelId, recording] of this.sessions) {
      if (recording.closed) { this.sessions.delete(channelId); continue; }
      const destination = this.destinations.get(recording.meta.guildId);
      const rule = recording.meta.requester || destination?.id !== recording.accountId
        ? recording.rule : rules.get(channelId);
      if (!rule) { recording.finish(); continue; }
      const channel = this.client.channels.cache.get(channelId);
      const humans = channel?.members?.some((member) => !member.user.bot);
      if (humans) { clearTimeout(recording.emptyTimer); recording.emptyTimer = undefined; }
      else if (!recording.emptyTimer) {
        recording.emptyTimer = setTimeout(() => recording.finish(), rule.emptySeconds * 1000);
      }
    }
    for (const rule of rules.values()) {
      const account = this.destinations.get(rule.guildId);
      if (!account.drive_refresh || !recordingFolder(account)) continue;
      const channel = this.client.channels.cache.get(rule.channelId);
      if (!channel?.isVoiceBased() || channel.guildId !== rule.guildId) continue;
      const humans = channel.members.filter((member) => !member.user.bot);
      if (!humans.size) this.blocked.delete(rule.channelId);
      if (this.guildBusy(rule.guildId) || this.blocked.has(rule.channelId)) continue;
      if (humans.size < rule.minPeople) continue;
      if (rule.triggerUsers.length && (joinedChannel !== rule.channelId || !rule.triggerUsers.includes(joinedUser))) continue;
      this.pending.add(rule.guildId);
      this.start(account, rule, channel).catch(() => {
        this.error = 'Não foi possível iniciar. Confira acesso ao canal de voz e de aviso.';
      }).finally(() => this.pending.delete(rule.guildId));
    }
  }

  guildBusy(guildId) {
    return this.pending.has(guildId) ||
      [...this.sessions.values()].some((item) => !item.closed && item.meta.guildId === guildId);
  }

  async startManual(account, channel, requester) {
    if (this.guildBusy(channel.guildId)) throw new Error('Já há uma gravação ou teste neste servidor.');
    if (!account.drive_refresh || !recordingFolder(account))
      throw new Error('Configure a pasta de gravações no Google Drive no painel da PIA Server.');
    this.pending.add(channel.guildId);
    try {
      const configured = account.rules.find((rule) => rule.channelId === channel.id);
      const rule = { guildId: channel.guildId, channelId: channel.id,
        noticeChannelId: channel.isSendable() ? channel.id : configured?.noticeChannelId,
        minPeople: 1, emptySeconds: 30 };
      if (!await this.start(account, rule, channel, requester))
        throw new Error('A gravação não começou. Confira se ainda há participantes no canal.');
    } finally { this.pending.delete(channel.guildId); }
  }

  connect(channel) {
    return joinVoiceChannel({ channelId: channel.id, guildId: channel.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator, group: String(this.account.id),
      selfMute: true, selfDeaf: false });
  }

  async start(account, rule, channel, requester) {
    const notice = rule.noticeChannelId && await this.client.channels.fetch(rule.noticeChannelId);
    if (!notice?.isSendable() || notice.guildId !== rule.guildId) throw new Error('A PIA precisa enviar o aviso no chat do canal antes de gravar.');
    await notice.send({ content: NOTICE, allowedMentions: { parse: [] } });
    await new Promise((resolve) => setTimeout(resolve, 8000));
    const destination = async () => {
      if (this.closed) return;
      const current = await guildAccount(this.account.id, rule.guildId);
      if (current?.id === account.id && current.drive_refresh && recordingFolder(current) &&
          (requester || current.rules.some((item) => item.channelId === rule.channelId))) return current;
    };
    if (!await destination() || channel.members.filter((member) => !member.user.bot).size < rule.minPeople) return false;
    const connection = this.connect(channel);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15000);
      const current = await destination();
      if (!current) {
        connection.destroy();
        return;
      }
      const session = new Recording(current, connection, rule, channel, requester);
      this.sessions.set(channel.id, session);
      this.blocked.add(channel.id);
      connection.on(VoiceConnectionStatus.Disconnected, () => session.finish('Conexão de voz interrompida.'));
      connection.on('error', () => session.finish('Falha na conexão de voz.'));
      this.error = '';
      return true;
    } catch (error) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      throw error;
    }
  }

  stop(channelId, accountId) {
    const session = this.sessions.get(channelId);
    if (!session || session.closed || (accountId !== undefined && session.accountId !== accountId)) return false;
    session.finish();
    return true;
  }

  close() {
    this.closed = true;
    for (const session of this.sessions.values()) session.finish();
    this.client.destroy();
  }
}
