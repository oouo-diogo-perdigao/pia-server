import { guildAccount, hasRecordingRole, requestGuildLink, setRecordingRole, unlinkGuild } from './discord_guild_links.js';
import { origin } from './auth.js';
import { ButtonStyle, ComponentType, ChannelType, PermissionFlagsBits, SlashCommandBuilder, Routes } from 'discord.js';
import { EndBehaviorType, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { pool } from './db.js';
import { recordings } from './queue.js';
import { validateRules } from './state.js';

const guildOnly = (name, description) => new SlashCommandBuilder().setName(name).setDescription(description).setContexts(0);
const adminOnly = (name, description) => guildOnly(name, description).setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
const voice = (option) => option.setName('channel').setDescription('Canal de voz')
  .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice);
export const recordingCommands = [
  guildOnly('join', 'Inicia uma gravação em faixas separadas').addChannelOption(voice),
  guildOnly('stop', 'Encerra a gravação em andamento'),
  guildOnly('recordings', 'Lista as gravações recentes disponíveis para você'),
  guildOnly('voice-test', 'Recebe uma amostra privada do próprio microfone'),
  guildOnly('info', 'Mostra o estado e as estatísticas do gravador'),
  adminOnly('bless', 'Vincula este servidor Discord a uma conta PIA'),
  adminOnly('unbless', 'Desvincula este servidor da conta PIA'),
  adminOnly('server-settings', 'Configura as permissões de gravação da PIA')
    .addSubcommandGroup((group) => group.setName('access-role').setDescription('Gerencia os cargos com acesso')
      .addSubcommand((sub) => sub.setName('add').setDescription('Autoriza um cargo a iniciar e parar gravações')
        .addRoleOption((option) => option.setName('role').setDescription('Cargo autorizado').setRequired(true)))
      .addSubcommand((sub) => sub.setName('remove').setDescription('Remove o acesso de um cargo')
        .addRoleOption((option) => option.setName('role').setDescription('Cargo a remover').setRequired(true)))),
  adminOnly('autorecord', 'Gerencia as regras de gravação automática')
    .addSubcommand((sub) => sub.setName('on').setDescription('Configura a gravação automática no canal')
      .addChannelOption((option) => voice(option).setRequired(true))
      .addChannelOption((option) => option.setName('notice').setDescription('Canal de aviso')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice).setRequired(true))
      .addIntegerOption((option) => option.setName('minimum').setDescription('Mínimo de pessoas').setMinValue(1).setMaxValue(99))
      .addUserOption((option) => option.setName('trigger').setDescription('Membro cuja entrada dispara a gravação')))
    .addSubcommand((sub) => sub.setName('off').setDescription('Desativa a regra de um canal')
      .addChannelOption((option) => voice(option).setRequired(true)))
    .addSubcommand((sub) => sub.setName('view').setDescription('Lista regras deste servidor'))
    .addSubcommand((sub) => sub.setName('prune').setDescription('Remove regras de canais que já foram excluídos')),
  adminOnly('bot-profile', 'Personaliza o perfil da PIA neste servidor')
    .addSubcommand((sub) => sub.setName('set').setDescription('Altera apelido, descrição, avatar ou banner')
      .addStringOption((option) => option.setName('nickname').setDescription('Apelido').setMaxLength(32))
      .addStringOption((option) => option.setName('bio').setDescription('Descrição').setMaxLength(190))
      .addAttachmentOption((option) => option.setName('avatar').setDescription('Imagem para o avatar'))
      .addAttachmentOption((option) => option.setName('banner').setDescription('Imagem para o banner')))
    .addSubcommand((sub) => sub.setName('remove').setDescription('Restaura o perfil padrão neste servidor')),
].map((command) => command.toJSON());

export async function registerRecordingCommands(client) {
  const route = Routes.applicationCommands(client.application.id);
  // Upsert each owned command. Other commands, including /link, stay registered.
  for (const command of recordingCommands) await client.rest.post(route, { body: command });
  // A previous release also published server-scoped commands. Their schemas
  // take precedence over the global copies and need the new code option too.
  for (const guild of client.guilds?.cache.values() || []) {
    const local = Routes.applicationGuildCommands(client.application.id, guild.id);
    const installed = new Set((await client.rest.get(local)).map(({ name }) => name));
    for (const command of recordingCommands.filter(({ name }) => ['bless', 'unbless'].includes(name))) {
      if (!installed.has(command.name)) continue;
      const { contexts, integration_types, ...body } = command;
      await client.rest.post(local, { body });
    }
  }
}

const isAdmin = (interaction) => Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
const ownChannel = (interaction) => interaction.guild.voiceStates.cache.get(interaction.user.id)?.channel;
const guildRules = (rules, guildId) => rules.filter((rule) => rule.guildId === guildId);
const lines = (items, empty) => items.length ? items.join('\n').slice(0, 1950) : empty;

export function visibleRecordings(items, guildId, userId, admin) {
  return items.filter(({ meta }) => meta.guildId === guildId &&
    (admin || meta.requester === userId || meta.tracks.includes(userId)))
    .sort((a, b) => b.meta.startedAt.localeCompare(a.meta.startedAt));
}

async function changeRules(runtime, account, interaction) {
  const action = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const channel = interaction.options.getChannel('channel');
  const id = account.id;
  if (action === 'view') {
    const { rows: [account] } = await pool.query('SELECT rules FROM pia_server.accounts WHERE id=$1', [id]);
    return lines(guildRules(account.rules, guildId).map((rule) =>
      '<#' + rule.channelId + '> · aviso <#' + rule.noticeChannelId + '> · mín. ' + rule.minPeople +
      (rule.triggerUsers.length ? ' · gatilhos ' +
        rule.triggerUsers.map((user) => '<@' + user + '>').join(', ') : '')), 'Nenhuma regra neste servidor.');
  }
  const knownChannels = action === 'prune' ? await interaction.guild.channels.fetch() : null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [account] } = await client.query('SELECT rules FROM pia_server.accounts WHERE id=$1 FOR UPDATE', [id]);
    const rules = account.rules.filter((rule) => rule.guildId !== guildId ||
      (knownChannels ? knownChannels.has(rule.channelId) && knownChannels.has(rule.noticeChannelId) : rule.channelId !== channel.id));
    if (action === 'on') {
      const notice = interaction.options.getChannel('notice', true);
      const trigger = interaction.options.getUser('trigger');
      rules.push({ guildId, channelId: channel.id, noticeChannelId: notice.id,
        minPeople: interaction.options.getInteger('minimum') ?? 2, triggerUsers: trigger ? [trigger.id] : [],
        emptySeconds: 30 });
    }
    await client.query('UPDATE pia_server.accounts SET rules=$2 WHERE id=$1', [id, JSON.stringify(validateRules(rules))]);
    await client.query('COMMIT');
    runtime.setDestinations(new Map(runtime.destinations).set(guildId, { ...account, rules }));
    return action === 'prune' ? 'Regras removidas: ' + (account.rules.length - rules.length) + '.' : 'Regra atualizada.';
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function profileImage(attachment) {
  const url = new URL(attachment.url);
  const mime = attachment.contentType;
  const limit = 2 * 1024 * 1024;
  if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' ||
      !/^image\/(png|jpeg|gif|webp)$/.test(mime || '') || attachment.size > limit)
    throw new Error('Envie uma imagem PNG, JPG, GIF ou WebP de até 2 MiB.');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== mime)
    throw new Error('O Discord não retornou a imagem esperada.');
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw new Error('A imagem excede 2 MiB.');
    chunks.push(chunk);
  }
  return 'data:' + mime + ';base64,' + Buffer.concat(chunks).toString('base64');
}

async function profile(interaction) {
  const reset = interaction.options.getSubcommand() === 'remove';
  const body = {};
  for (const [field, option] of [['nick', 'nickname'], ['bio', 'bio']]) {
    const value = interaction.options.getString(option);
    if (reset || value !== null) body[field] = reset ? null : value;
  }
  for (const field of ['avatar', 'banner']) {
    const attachment = interaction.options.getAttachment(field);
    if (reset || attachment) body[field] = reset ? null : await profileImage(attachment);
  }
  if (!Object.keys(body).length) throw new Error('Informe pelo menos um campo do perfil.');
  await interaction.client.rest.patch(Routes.guildMember(interaction.guildId, '@me'), { body });
  return reset ? 'Perfil padrão restaurado neste servidor.' : 'Perfil atualizado neste servidor.';
}

export function wave(frames) {
  const audio = Buffer.concat(frames);
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(audio.length + 36, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}

async function voiceTest(runtime, interaction) {
  const channel = ownChannel(interaction);
  if (!channel) throw new Error('Entre em um canal de voz para testar o microfone.');
  if (runtime.guildBusy(channel.guildId)) throw new Error('Já há uma gravação ou teste neste servidor.');
  runtime.pending.add(channel.guildId);
  let connection, decoder, stream;
  try {
    connection = runtime.connect(channel);
    await entersState(connection, VoiceConnectionStatus.Ready, 15000);
    decoder = new OpusScript(48000, 1, OpusScript.Application.AUDIO);
    const frames = [];
    let size = 0;
    await interaction.editReply('Fale por 5 segundos. A amostra será entregue apenas nesta resposta.');
    stream = connection.receiver.subscribe(interaction.user.id, { end: { behavior: EndBehaviorType.Manual } });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      stream.once('error', (error) => { clearTimeout(timer); reject(error); });
      stream.on('data', (packet) => {
        if (size >= 480000) return;
        try {
          const frame = decoder.decode(packet);
          size += frame.length;
          frames.push(frame);
        } catch { /* A damaged packet can be skipped. */ }
      });
    });
    if (!frames.length) throw new Error('Nenhuma fala foi recebida. Confira o microfone e tente de novo.');
    return { content: 'Amostra do seu microfone.', files: [{ attachment: wave(frames), name: 'pia-voice-test.wav' }] };
  } finally {
    stream?.destroy();
    decoder?.delete();
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    runtime.pending.delete(channel.guildId);
  }
}

async function run(runtime, interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const admin = isAdmin(interaction);
  const command = interaction.commandName;
  if (!interaction.inGuild()) throw new Error('Use este comando em um servidor.');
  if (['bless', 'unbless', 'autorecord', 'bot-profile', 'server-settings'].includes(command) && !admin)
    throw new Error('Este comando exige permissão de administrador.');
  if (command === 'bless') {
    const token = await requestGuildLink(runtime.account.id, guildId, userId, interaction.guild.name, () =>
      interaction.editReply({ content: 'Servidor abençoado e vinculado à sua conta PIA.', components: [] }));
    return {
      content: 'Abra a PIA Server para confirmar o vínculo deste servidor. O botão é privado e expira em 10 minutos.',
      components: [{ type: ComponentType.ActionRow, components: [{
        type: ComponentType.Button, style: ButtonStyle.Link,
        label: 'Confirmar na PIA Server', url: origin + '/discord/bless/' + token,
      }] }],
    };
  }
  if (command === 'unbless') {
    if (!await unlinkGuild(runtime.account.id, guildId)) return 'Este servidor não tinha vínculo ativo.';
    return 'Vínculo removido. As gravações existentes continuam na conta original.';
  }
  if (command === 'server-settings') {
    const role = interaction.options.getRole('role', true);
    if (role.id === guildId) throw new Error('Escolha um cargo específico do servidor.');
    const add = interaction.options.getSubcommand() === 'add';
    await setRecordingRole(runtime.account.id, guildId, role.id, add);
    return add ? 'Cargo <@&' + role.id + '> autorizado a iniciar e parar gravações.' :
      'Acesso removido do cargo <@&' + role.id + '>.';
  }
  if (command === 'join') {
    const account = await guildAccount(runtime.account.id, guildId);
    if (!account) throw new Error('Um administrador precisa vincular este servidor com /bless primeiro.');
    if (!admin && !hasRecordingRole(interaction, account.access_roles))
      throw new Error('Você precisa de um cargo de gravação autorizado.');
    const channel = interaction.options.getChannel('channel') || ownChannel(interaction);
    if (!channel?.isVoiceBased() || channel.guildId !== guildId || (!admin && ownChannel(interaction)?.id !== channel.id))
      throw new Error('Entre no canal de voz que você quer gravar.');
    const meta = await runtime.startManual(account, channel, userId, interaction.channel);
    return 'Gravando <#' + channel.id + '> em faixas separadas. [Abrir painel](https://discord.com/channels/' +
      guildId + '/' + meta.noticeChannelId + '/' + meta.panelMessageId + ').';
  }
  if (command === 'stop') {
    const session = [...runtime.sessions.values()].find((item) => !item.closed && item.meta.guildId === guildId);
    if (!session) throw new Error('Nenhuma gravação em andamento neste servidor.');
    if (!admin && session.meta.requester !== userId) {
      const account = await guildAccount(runtime.account.id, guildId);
      if (!hasRecordingRole(interaction, account?.access_roles))
        throw new Error('Peça a quem iniciou, a um administrador ou a alguém com cargo autorizado.');
    }
    runtime.stop(session.meta.channelId, undefined, { user: userId });
    return 'Gravação encerrada. Se houve fala, o arquivo será preparado e enviado ao Drive.';
  }
  if (command === 'voice-test') return voiceTest(runtime, interaction);
  if (command === 'bot-profile') return profile(interaction);
  const account = await guildAccount(runtime.account.id, guildId);
  if (!account) throw new Error('Este servidor precisa de um vínculo ativo. Use /bless.');
  if (command === 'autorecord') return changeRules(runtime, account, interaction);
  const items = visibleRecordings(recordings(account), guildId, userId, admin);
  if (command === 'recordings') return lines(items.slice(0, 8).map(({ meta }) => {
    const file = meta.state === 'uploaded' && meta.driveId ? ' · <https://drive.google.com/open?id=' + encodeURIComponent(meta.driveId) + '>' : '';
    const status = { recording: 'gravando', queued: 'aguardando envio', uploaded: 'no Drive', empty: 'sem áudio' };
    return '• ' + meta.startedAt.slice(0, 16).replace('T', ' ') + ' UTC · <#' + meta.channelId + '> · ' +
      (status[meta.state] || meta.state) + file;
  }), 'Nenhuma gravação disponível.');
  return 'PIA Server · gravação multifaixa no Discord\n' + items.length + ' gravações visíveis para você · ' +
    items.filter(({ meta }) => meta.state === 'uploaded').length + ' no Drive.';
}

export async function handleRecordingCommand(runtime, interaction) {
  try {
    await interaction.deferReply({ flags: 64 });
    const result = await run(runtime, interaction);
    await interaction.editReply({ ...(typeof result === 'string' ? { content: result } : result), allowedMentions: { parse: [] } });
  } catch (error) {
    if (interaction.deferred) {
      await interaction.editReply({ content: error.code ? 'A operação falhou. Confira as permissões da PIA e tente novamente.' :
        error.message, allowedMentions: { parse: [] } }).catch(() => {});
    }
  }
}
