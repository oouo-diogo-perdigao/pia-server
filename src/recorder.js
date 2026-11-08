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
  constructor(account, connection, rule, permitted) {
    this.connection = connection;
    this.permitted = permitted;
    this.started = performance.now();
    this.closed = false;
    this.tracks = new Map();
    const date = new Date();
    const id = randomUUID();
    const name = 'pia_' + id + '_' + date.toISOString().slice(0, 10) + '_' +
      date.toISOString().slice(11, 19).replaceAll(':', '-') + '.aup.zip';
    this.folder = join(root, String(account.id), id);
    mkdirSync(this.folder, { recursive: true, mode: 0o700 });
    this.meta = { id, name, channelId: rule.channelId, guildId: rule.guildId, startedAt: date.toISOString(),
      folderId: account.folder_id, state: 'recording', tracks: [] };
    this.persist();
    connection.receiver.speaking.on('start', (userId) => this.listen(userId));
    this.limit = setTimeout(() => this.finish(), MAX_MS);
  }

  persist() { save(join(this.folder, 'recording.json'), this.meta); }

  listen(userId) {
    if (this.closed || !snowflake.test(userId) || !this.permitted(userId) || this.tracks.has(userId)) return;
    let fd, stream, decoder;
    try {
      fd = openSync(join(this.folder, userId + '.pcm'), 'w', 0o600);
      decoder = new OpusScript(RATE, 1, OpusScript.Application.AUDIO);
      stream = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
      const track = { fd, stream, decoder, samples: 0 };
      this.tracks.set(userId, track);
      this.meta.tracks.push(userId);
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

  constructor(account, token) {
    this.account = account;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
    this.client.on(Events.ClientReady, () => this.evaluate());
    this.client.on(Events.VoiceStateUpdate, (before, after) => {
      if (before.channelId === after.channelId || after.member?.user.bot) return;
      this.evaluate(after.channelId, after.id);
    });
    this.client.on(Events.Error, () => { this.error = 'Conexão com Discord interrompida.'; });
    this.client.login(token).catch(() => { this.error = 'O Discord recusou a conexão do bot.'; });
  }

  evaluate(joinedChannel, joinedUser) {
    if (this.closed || !this.client.isReady()) return;
    const account = this.account;
    const rules = new Map(account.rules.map((rule) => [rule.channelId, rule]));
    for (const [channelId, recording] of this.sessions) {
      if (recording.closed) { this.sessions.delete(channelId); continue; }
      const rule = rules.get(channelId);
      if (!rule) { recording.finish(); continue; }
      const channel = this.client.channels.cache.get(channelId);
      const humans = channel?.members?.some((member) => !member.user.bot);
      if (humans) { clearTimeout(recording.emptyTimer); recording.emptyTimer = undefined; }
      else if (!recording.emptyTimer) {
        recording.emptyTimer = setTimeout(() => recording.finish(), rule.emptySeconds * 1000);
      }
    }
    if (!account.drive_refresh || !account.folder_id) return;
    for (const rule of rules.values()) {
      const channel = this.client.channels.cache.get(rule.channelId);
      if (!channel?.isVoiceBased() || channel.guildId !== rule.guildId) continue;
      const humans = channel.members.filter((member) => !member.user.bot);
      if (!humans.size) this.blocked.delete(rule.channelId);
      if (this.pending.has(rule.guildId) || this.blocked.has(rule.channelId) ||
          [...this.sessions.values()].some((item) => !item.closed && item.meta.guildId === rule.guildId)) continue;
      if (humans.size < rule.minPeople) continue;
      if (rule.triggerUsers.length && (joinedChannel !== rule.channelId || !rule.triggerUsers.includes(joinedUser))) continue;
      this.pending.add(rule.guildId);
      this.start(rule, channel).catch(() => {
        this.error = 'Não foi possível iniciar. Confira acesso ao canal de voz e de aviso.';
      }).finally(() => this.pending.delete(rule.guildId));
    }
  }

  async start(rule, channel) {
    const notice = await this.client.channels.fetch(rule.noticeChannelId);
    if (!notice?.isSendable() || notice.guildId !== rule.guildId) throw new Error('invalid notice channel');
    await notice.send({ content: NOTICE, allowedMentions: { parse: [] } });
    await new Promise((resolve) => setTimeout(resolve, 8000));
    if (this.closed || !this.account.rules.some((item) => item.channelId === rule.channelId) ||
        channel.members.filter((member) => !member.user.bot).size < rule.minPeople) return;
    const connection = joinVoiceChannel({ channelId: channel.id, guildId: channel.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator, group: String(this.account.id),
      selfMute: true, selfDeaf: false });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15000);
      if (this.closed || !this.account.rules.some((item) => item.channelId === rule.channelId)) {
        connection.destroy();
        return;
      }
      const session = new Recording(this.account, connection, rule, (id) =>
        channel.members.has(id) && !channel.members.get(id).user.bot);
      this.sessions.set(channel.id, session);
      this.blocked.add(channel.id);
      connection.on(VoiceConnectionStatus.Disconnected, () => session.finish('Conexão de voz interrompida.'));
      connection.on('error', () => session.finish('Falha na conexão de voz.'));
      this.error = '';
    } catch (error) {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      throw error;
    }
  }

  stop(channelId) {
    const session = this.sessions.get(channelId);
    if (!session || session.closed) return false;
    session.finish();
    return true;
  }

  close() {
    this.closed = true;
    for (const session of this.sessions.values()) session.finish();
    this.client.destroy();
  }
}
