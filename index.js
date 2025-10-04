require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, SelectMenuBuilder } = require('discord.js');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { Worker } = require('worker_threads');
const http = require('http'); // Thêm để tạo server HTTP

// CONFIG
const TOKEN = process.env.DISCORD_TOKEN; // bắt buộc
const VATSIM_CHANNEL_ID = process.env.VATSIM_CHANNEL_ID || '1412853057968017469';
const REPENT_CHANNEL_ID = process.env.REPENT_CHANNEL_ID || '1413556917707472896';
const GROUP_FLIGHT_CHANNEL_ID = process.env.GROUP_FLIGHT_CHANNEL_ID || '1366417558395289640';
const GUILD_ID = process.env.GUILD_ID || '1365693391668777051';
const OWNER_ID = process.env.OWNER_ID;

if (!TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment. Create a .env file or set env variable.');
  process.exit(1);
}

if (!OWNER_ID) {
  console.error('Missing OWNER_ID in environment. Add it to .env file.');
  process.exit(1);
}

const ROLES_FILE = path.join(__dirname, 'roles.json');
const BANS_FILE = path.join(__dirname, 'bans.json');
const VATSIM_MSG_FILE = path.join(__dirname, 'vatsim_message.json');

let roles = { memberRoleId: null, devRoleId: null, adminRoleId: null, banRoleId: null, pendingRoleId: null, otherRoles: [] };
if (fs.existsSync(ROLES_FILE)) roles = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
let bans = fs.existsSync(BANS_FILE) ? JSON.parse(fs.readFileSync(BANS_FILE, 'utf8')) : { users: {} };
let vatsimMessageStore = fs.existsSync(VATSIM_MSG_FILE) ? JSON.parse(fs.readFileSync(VATSIM_MSG_FILE, 'utf8')) : {};

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages] });

// store active group-flight events
let events = new Map();

// store pending role requests
let pendingRequests = new Map();

// Worker
const vatsimWorker = new Worker(path.join(__dirname, 'vatsimWorker.js'));

vatsimWorker.on('message', async (data) => {
  if (data.error) return console.error('VATSIM worker error:', data.error);
  try {
    const embed = new EmbedBuilder().setTitle('VATSIM Online Update').setTimestamp();
    const controllers = data.controllers || [];
    const pilots = data.pilots || [];
    const maxItems = 20;
    const ctrlText = controllers.length ? controllers.slice(0, maxItems).map(c => `${c.callsign} (${c.name || 'unknown'})`).join('\n') : 'None';
    const pilotsText = pilots.length ? pilots.slice(0, maxItems).map(p => `${p.callsign} ${p.flight_plan ? `${p.flight_plan.departure}->${p.flight_plan.arrival}` : ''}`).join('\n') : 'None';
    embed.addFields(
      { name: `ATC Online (${controllers.length})`, value: ctrlText, inline: false },
      { name: `Pilots (${pilots.length})`, value: pilotsText, inline: false }
    );

    // Try edit existing message
    if (vatsimMessageStore.messageId && vatsimMessageStore.channelId) {
      try {
        const channel = await client.channels.fetch(vatsimMessageStore.channelId);
        const msg = await channel.messages.fetch(vatsimMessageStore.messageId);
        if (msg) {
          await msg.edit({ embeds: [embed] });
          return;
        }
      } catch (err) {
        console.warn('Could not fetch/edit stored VATSIM message, will create new. Reason:', err.message || err);
      }
    }

    // send new message and save
    const channel = await client.channels.fetch(VATSIM_CHANNEL_ID);
    const sent = await channel.send({ embeds: [embed] });
    vatsimMessageStore = { messageId: sent.id, channelId: channel.id };
    fs.writeFileSync(VATSIM_MSG_FILE, JSON.stringify(vatsimMessageStore, null, 2));

  } catch (err) {
    console.error('Error processing VATSIM data:', err);
  }
});

vatsimWorker.on('error', err => console.error('VATSIM worker thread error:', err));

client.once('ready', async () => {
  console.log(`Bot logged in as ${client.user.tag}`);

  // Register slash commands (global)
  const commands = [
    new SlashCommandBuilder().setName('give_role').setDescription('Xin role'),
    new SlashCommandBuilder().setName('group_flight').setDescription('Tạo group flight'),
    new SlashCommandBuilder().setName('send_announcements').setDescription('Gửi thông báo')
      .addChannelOption(option => option.setName('channel').setDescription('Kênh gửi').setRequired(true))
      .addStringOption(option => option.setName('message').setDescription('Nội dung').setRequired(true)),
    new SlashCommandBuilder().setName('give_band').setDescription('Ban người dùng')
      .addUserOption(option => option.setName('user').setDescription('Người dùng').setRequired(true))
      .addIntegerOption(option => option.setName('duration').setDescription('Thời gian (phút)').setRequired(true))
  ];

  try {
    await client.application.commands.set(commands.map(c => c.toJSON()));
    console.log('Registered application commands.');
  } catch (err) {
    console.warn('Failed to register commands:', err.message || err);
  }

  // restore bans timeouts
  for (const [userId, ban] of Object.entries(bans.users)) {
    const timeLeft = ban.endTime - Date.now();
    if (timeLeft > 0) setTimeout(() => unbanUser(userId), timeLeft);
    else unbanUser(userId);
  }

  // ensure message exists for editing
  await ensureVatsimMessageExists();

  // scheduling: update immediately then every periodMs
  const periodMs = (process.env.VATSIM_UPDATE_MINUTES ? parseInt(process.env.VATSIM_UPDATE_MINUTES) : 20) * 60 * 1000;
  vatsimWorker.postMessage('update');
  setInterval(() => vatsimWorker.postMessage('update'), periodMs);
  console.log(`VATSIM updater running: immediate + every ${periodMs / 60000} minutes`);

  // Add counter to keep bot awake
  let counter = 0;
  setInterval(() => {
    counter++;
    console.log(`Wake-up counter: ${counter}`);
  }, 15 * 60 * 1000); // Every 15 minutes
});

client.on('guildMemberAdd', async (member) => {
  if (member.guild.id === GUILD_ID && roles.pendingRoleId) {
    try {
      await member.roles.add(roles.pendingRoleId);
      console.log(`Added pending role to new member ${member.user.tag}`);
    } catch (err) {
      console.error('Error adding pending role:', err);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand() && !interaction.isButton() && !interaction.isModalSubmit() && !interaction.isSelectMenu()) return;

  try {
    if (interaction.isCommand()) {
      switch (interaction.commandName) {
        case 'give_role':
          await handleRequestRole(interaction);
          break;
        case 'group_flight':
          await handleGroupFlight(interaction);
          break;
        case 'send_announcements':
          await handleAnnouncement(interaction);
          break;
        case 'give_band':
          await handleBan(interaction);
          break;
      }
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    } else if (interaction.isSelectMenu()) {
      await handleSelect(interaction);
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
    if (interaction.replied || interaction.deferred) {
      try { await interaction.followUp({ content: 'Đã có lỗi nội bộ.', ephemeral: true }); } catch(e){}
    } else {
      try { await interaction.reply({ content: 'Đã có lỗi nội bộ.', ephemeral: true }); } catch(e){}
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const userId = message.author.id;

  if (bans.users[userId] && bans.users[userId].endTime > Date.now()) return;
});

// ---------- Interaction handlers ----------

async function handleRequestRole(interaction) {
  const member = interaction.member;
  const userId = member.id;
  if ((bans.users[userId] && bans.users[userId].endTime > Date.now()) || (member.roles && member.roles.cache.has(roles.banRoleId))) {
    return interaction.reply({ content: 'Bạn đang bị ban, không thể xin role.', ephemeral: true });
  }

  const hasDev = member.roles.cache.has(roles.devRoleId);
  const hasAdmin = member.roles.cache.has(roles.adminRoleId);
  const hasMember = member.roles.cache.has(roles.memberRoleId);

  if (hasMember || hasDev || hasAdmin) {
    const filteredRoles = (roles.otherRoles || []).filter(r => r.id !== roles.devRoleId && r.id !== roles.adminRoleId);
    if (filteredRoles.length === 0) return interaction.reply({ content: 'Không có role nào có thể xin.', ephemeral: true });

    const row = new ActionRowBuilder().addComponents(
      new SelectMenuBuilder()
        .setCustomId('select_role')
        .setPlaceholder('Chọn role')
        .addOptions(filteredRoles.map(r => ({ label: r.name, value: r.id })))
    );
    await interaction.reply({ content: 'Chọn role bạn muốn xin:', components: [row], ephemeral: true });
  } else {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('request_member').setLabel('Xin Role Member').setStyle(ButtonStyle.Primary)
    );
    await interaction.reply({ content: 'Bạn cần có role Member trước. Bấm để xin:', components: [row], ephemeral: true });
  }
}

async function handleSelect(interaction) {
  if (interaction.customId === 'select_role') {
    const roleId = interaction.values[0];
    if (roleId === roles.devRoleId || roleId === roles.adminRoleId) {
      return interaction.update({ content: 'Không thể xin role DEV hoặc Admin.', components: [] });
    }

    // Send approval request instead of adding role
    const requestId = Date.now().toString();
    pendingRequests.set(requestId, { userId: interaction.user.id, roleId, guildId: interaction.guild.id });

    try {
      const owner = await client.users.fetch(OWNER_ID);
      const roleName = roles.otherRoles.find(r => r.id === roleId)?.name || 'Unknown';
      const embed = new EmbedBuilder()
        .setTitle('Role Request')
        .setDescription(`User ${interaction.user.tag} (${interaction.user.id}) requests role ${roleName}.`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_${requestId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`deny_${requestId}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
      );
      await owner.send({ embeds: [embed], components: [row] });
      await interaction.update({ content: 'Request sent to owner for approval.', components: [] });
    } catch (err) {
      console.error('Error sending DM to owner:', err);
      await interaction.update({ content: 'Error sending request.', components: [] });
      pendingRequests.delete(requestId);
    }
  }
}

async function handleButton(interaction) {
  const customId = interaction.customId;

  if (customId === 'request_member') {
    // Send approval request for member role
    const requestId = Date.now().toString();
    pendingRequests.set(requestId, { userId: interaction.user.id, roleId: roles.memberRoleId, guildId: interaction.guild.id });

    try {
      const owner = await client.users.fetch(OWNER_ID);
      const embed = new EmbedBuilder()
        .setTitle('Role Request')
        .setDescription(`User ${interaction.user.tag} (${interaction.user.id}) requests Member role.`);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_${requestId}`).setLabel('Approve').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`deny_${requestId}`).setLabel('Deny').setStyle(ButtonStyle.Danger)
      );
      await owner.send({ embeds: [embed], components: [row] });
      await interaction.update({ content: 'Request sent to owner for approval.', components: [] });
    } catch (err) {
      console.error('Error sending DM to owner:', err);
      await interaction.update({ content: 'Error sending request.', components: [] });
      pendingRequests.delete(requestId);
    }
  } else if (customId.startsWith('approve_') || customId.startsWith('deny_')) {
    const action = customId.split('_')[0];
    const requestId = customId.split('_')[1];
    const request = pendingRequests.get(requestId);
    if (!request) return interaction.reply({ content: 'Invalid or expired request.', ephemeral: true });

    pendingRequests.delete(requestId);

    if (action === 'deny') {
      await interaction.reply({ content: 'Request denied.', ephemeral: true });
      try {
        const user = await client.users.fetch(request.userId);
        await user.send('Your role request has been denied.');
      } catch (err) {
        console.error('Error notifying user:', err);
      }
      return;
    }

    // Approve
    try {
      const guild = await client.guilds.fetch(request.guildId);
      const member = await guild.members.fetch(request.userId);
      await member.roles.add(request.roleId);
      await interaction.reply({ content: 'Request approved.', ephemeral: true });
      await member.send('Your role request has been approved!');
    } catch (err) {
      console.error('Error approving role:', err);
      await interaction.reply({ content: 'Error approving request.', ephemeral: true });
    }
  } else if (customId.startsWith('confirm_event_')) {
    // ... (giữ nguyên code gốc cho group flight)
    const eventId = customId.split('_')[2];
    const event = events.get(eventId);
    if (!event || event.creator !== interaction.user.id) return interaction.reply({ content: 'Không tìm thấy sự kiện hoặc bạn không phải người tạo.', ephemeral: true });

    const embed = new EmbedBuilder().setTitle('Group Flight').addFields(
      { name: 'Departure', value: event.dep, inline: true },
      { name: 'Arrival', value: event.arr, inline: true },
      { name: 'Route', value: event.route },
      { name: 'Giờ bắt đầu', value: new Date(event.startTime).toUTCString() }
    );

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`group_join_${eventId}`).setLabel('Tham gia').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`group_canceljoin_${eventId}`).setLabel('Hủy tham gia').setStyle(ButtonStyle.Secondary)
    );

    const hasDev = interaction.member.roles.cache.has(roles.devRoleId);
    const hasAdmin = interaction.member.roles.cache.has(roles.adminRoleId);
    if (hasDev || hasAdmin || interaction.user.id === event.creator) {
      row.addComponents(new ButtonBuilder().setCustomId(`group_cancelevent_${eventId}`).setLabel('Hủy sự kiện').setStyle(ButtonStyle.Danger));
    }

    const channel = client.channels.cache.get(GROUP_FLIGHT_CHANNEL_ID) || interaction.channel;
    const message = await channel.send({ embeds: [embed], components: [row] });

    event.messageId = message.id;
    event.channelId = message.channel.id;

    const now = Date.now();
    const remindTime = event.startTime - 15 * 60 * 1000 - now;
    if (remindTime > 0) event.timeoutRemind = setTimeout(() => remindParticipants(eventId), remindTime);
    const startTimeDiff = event.startTime - now;
    if (startTimeDiff > 0) event.timeoutStart = setTimeout(() => startEvent(eventId), startTimeDiff);

    await interaction.update({ content: 'Sự kiện đã được công bố!', components: [] });

  } else if (customId.startsWith('group_')) {
    const parts = customId.split('_');
    const action = parts[1];
    const eventId = parts.slice(2).join('_');
    const event = events.get(eventId);
    if (!event) return interaction.reply({ content: 'Không tìm thấy sự kiện.', ephemeral: true });

    if (action === 'join') {
      if (!event.participants.includes(interaction.user.id)) event.participants.push(interaction.user.id);
      await interaction.reply({ content: 'Đã tham gia!', ephemeral: true });
    } else if (action === 'canceljoin') {
      event.participants = event.participants.filter(id => id !== interaction.user.id);
      await interaction.reply({ content: 'Đã hủy tham gia!', ephemeral: true });
    } else if (action === 'cancelevent') {
      const hasDev = interaction.member.roles.cache.has(roles.devRoleId);
      const hasAdmin = interaction.member.roles.cache.has(roles.adminRoleId);
      if (hasDev || hasAdmin || interaction.user.id === event.creator) {
        if (event.timeoutRemind) clearTimeout(event.timeoutRemind);
        if (event.timeoutStart) clearTimeout(event.timeoutStart);
        try { await interaction.message.delete(); } catch(e){}
        events.delete(eventId);
        await interaction.reply({ content: 'Sự kiện đã bị hủy!', ephemeral: true });
      } else {
        await interaction.reply({ content: 'Bạn không có quyền hủy sự kiện.', ephemeral: true });
      }
    }
  }
}

async function handleGroupFlight(interaction) {
  const modal = new ModalBuilder().setCustomId('group_modal').setTitle('Tạo Group Flight');
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('dep').setLabel('Departure (ICAO)').setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('arr').setLabel('Arrival (ICAO)').setStyle(TextInputStyle.Short).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('route').setLabel('Route').setStyle(TextInputStyle.Paragraph).setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('time').setLabel('Giờ bắt đầu (UTC, YYYY-MM-DD HH:MM)').setStyle(TextInputStyle.Short).setRequired(true)
    )
  );
  await interaction.showModal(modal);
}

function parseUTCDateTime(timeStr) {
  // expects 'YYYY-MM-DD HH:MM' (24h), returns epoch ms or NaN
  const m = timeStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) return NaN;
  const [_, Y, Mo, D, H, Min] = m;
  const ms = Date.UTC(Number(Y), Number(Mo) - 1, Number(D), Number(H), Number(Min), 0);
  return ms;
}

async function handleModal(interaction) {
  if (interaction.customId === 'group_modal') {
    const dep = interaction.fields.getTextInputValue('dep');
    const arr = interaction.fields.getTextInputValue('arr');
    const route = interaction.fields.getTextInputValue('route');
    const timeStr = interaction.fields.getTextInputValue('time');
    const startTime = parseUTCDateTime(timeStr);
    if (isNaN(startTime)) return interaction.reply({ content: 'Giờ không hợp lệ. Vui lòng dùng định dạng YYYY-MM-DD HH:MM (UTC).', ephemeral: true });

    const eventId = Date.now().toString();
    events.set(eventId, { dep, arr, route, startTime, creator: interaction.user.id, participants: [], messageId: null, channelId: null, timeoutRemind: null, timeoutStart: null });

    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_event_${eventId}`).setLabel('Xác nhận và công bố').setStyle(ButtonStyle.Success));

    await interaction.reply({ content: `Xem trước:\nDeparture: ${dep}\nArrival: ${arr}\nRoute: ${route}\nGiờ bắt đầu (UTC): ${timeStr}`, components: [row], ephemeral: true });
  }
}

async function remindParticipants(eventId) {
  const event = events.get(eventId);
  if (!event) return;
  for (const userId of event.participants) {
    try {
      const user = await client.users.fetch(userId);
      await user.send(`Group flight của bạn sẽ bắt đầu sau 15 phút! Departure: ${event.dep}, Arrival: ${event.arr}`);
    } catch (err) {
      console.error(`Không gửi DM cho ${userId}: ${err}`);
    }
  }
}

async function startEvent(eventId) {
  const event = events.get(eventId);
  if (!event) return;
  try {
    const channel = await client.channels.fetch(event.channelId);
    const message = await channel.messages.fetch(event.messageId);
    const embed = EmbedBuilder.from(message.embeds[0]);
    embed.setDescription('Sự kiện đang diễn ra!');
    await message.edit({ embeds: [embed], components: [] });
  } catch (err) {
    console.error(`Lỗi khi bắt đầu sự kiện ${eventId}: ${err}`);
  }
}

async function handleAnnouncement(interaction) {
  const hasDev = interaction.member.roles.cache.has(roles.devRoleId);
  const hasAdmin = interaction.member.roles.cache.has(roles.adminRoleId);
  if (!hasDev && !hasAdmin) return interaction.reply({ content: 'Bạn không có quyền.', ephemeral: true });

  const channel = interaction.options.getChannel('channel');
  const messageContent = interaction.options.getString('message');
  await channel.send(messageContent);
  await interaction.reply({ content: 'Đã gửi thông báo!', ephemeral: true });
}

async function handleBan(interaction) {
  const hasDev = interaction.member.roles.cache.has(roles.devRoleId);
  const hasAdmin = interaction.member.roles.cache.has(roles.adminRoleId);
  if (!hasDev && !hasAdmin) return interaction.reply({ content: 'Bạn không có quyền.', ephemeral: true });

  const user = interaction.options.getUser('user');
  const duration = interaction.options.getInteger('duration');
  const endTime = Date.now() + duration * 60 * 1000;

  bans.users[user.id] = { endTime };
  fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2));

  try {
    const member = await interaction.guild.members.fetch(user.id);
    if (member.roles.cache.has(roles.memberRoleId)) await member.roles.remove(roles.memberRoleId);
    await member.roles.add(roles.banRoleId);
  } catch (err) {
    console.warn('Could not modify member roles for ban:', err.message || err);
  }

  setTimeout(() => unbanUser(user.id), duration * 60 * 1000);

  await interaction.reply({ content: `Đã ban ${user.tag} trong ${duration} phút (đã thêm ban role).`, ephemeral: true });
}

async function unbanUser(userId) {
  delete bans.users[userId];
  try { fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2)); } catch(e){}

  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(userId).catch(()=>null);
    if (member && member.roles.cache.has(roles.banRoleId)) await member.roles.remove(roles.banRoleId);
  } catch (err) {
    console.error(`Lỗi khi unban ${userId}: ${err}`);
  }

  try {
    const channel = await client.channels.fetch(REPENT_CHANNEL_ID);
    if (channel) await channel.send(`<@${userId}> có thể hoạt động lại rồi! (hãy xin role member lại)`);
  } catch (e) {
    console.warn('Không thể gửi tin nhắn repent:', e.message || e);
  }
}

async function ensureVatsimMessageExists() {
  try {
    if (vatsimMessageStore.messageId && vatsimMessageStore.channelId) {
      const channel = await client.channels.fetch(vatsimMessageStore.channelId);
      if (!channel) throw new Error('channel not found');
      const msg = await channel.messages.fetch(vatsimMessageStore.messageId);
      if (!msg) throw new Error('message not found');
      console.log('Found existing VATSIM message to edit.');
      return;
    }
  } catch (err) {
    console.warn('Stored VATSIM message invalid -> will create new:', err.message || err);
  }

  try {
    const channel = await client.channels.fetch(VATSIM_CHANNEL_ID);
    const embed = new EmbedBuilder().setTitle('VATSIM Online Update').setDescription('Đang tải...').setTimestamp();
    const sent = await channel.send({ embeds: [embed] });
    vatsimMessageStore = { messageId: sent.id, channelId: channel.id };
    fs.writeFileSync(VATSIM_MSG_FILE, JSON.stringify(vatsimMessageStore, null, 2));
    console.log('Created initial VATSIM message and saved its id.');
  } catch (err) {
    console.error('Cannot create initial VATSIM message:', err);
  }
}

client.login(TOKEN);

// Tạo server HTTP đơn giản để Render ping giữ bot online
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive!');
}).listen(port, () => {
  console.log(`HTTP server listening on port ${port} for Render keep-alive`);
});
