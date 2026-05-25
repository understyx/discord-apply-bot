import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';
import {
  APPLICATION_BUTTON_ID,
  createPendingApplicationChannel,
  getQuestionsText,
  moveApplicationChannelToStatus,
  parseStatusCommand,
} from './application-flow.js';

const config = {
  token: process.env.DISCORD_TOKEN,
  officerRoleName: process.env.OFFICER_ROLE_NAME || 'Officer',
  pendingCategoryName: process.env.APPLICATIONS_PENDING_CATEGORY || 'Applications (Pending)',
  approvedCategoryName: process.env.APPLICATIONS_APPROVED_CATEGORY || 'Applications (Approved)',
  deniedCategoryName: process.env.APPLICATIONS_DENIED_CATEGORY || 'Applications (Denied)',
  defaultQuestions: process.env.APPLY_QUESTIONS || 'Tell us your character name, class/spec, and raid experience.',
};

if (!config.token) {
  throw new Error('Missing DISCORD_TOKEN in environment.');
}

const guildQuestions = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function hasOfficerPermissions(member, officerRole) {
  if (!member) {
    return false;
  }

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  return Boolean(officerRole && member.roles.cache.has(officerRole.id));
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) {
    return;
  }

  const officerRole = message.guild.roles.cache.find((role) => role.name === config.officerRoleName);

  if (message.content.startsWith('!setquestions')) {
    if (!hasOfficerPermissions(message.member, officerRole)) {
      await message.reply('Only officers can configure application questions.');
      return;
    }

    const questions = message.content.replace('!setquestions', '').trim();
    if (!questions) {
      await message.reply('Usage: `!setquestions <question text>`');
      return;
    }

    guildQuestions.set(message.guild.id, questions);
    await message.reply('Application questions have been updated.');
    return;
  }

  if (message.content === '!postapply') {
    if (!hasOfficerPermissions(message.member, officerRole)) {
      await message.reply('Only officers can post the application message.');
      return;
    }

    const questionsText = getQuestionsText(guildQuestions.get(message.guild.id), config.defaultQuestions);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(APPLICATION_BUTTON_ID)
        .setLabel('Apply')
        .setStyle(ButtonStyle.Primary),
    );

    await message.channel.send({
      content: [
        'Click **Apply** to start your guild application.',
        '',
        '**Questions:**',
        questionsText,
      ].join('\n'),
      components: [row],
    });
    return;
  }

  const status = parseStatusCommand(message.content);
  if (!status) {
    return;
  }

  if (message.channel.type !== ChannelType.GuildText) {
    return;
  }

  if (!hasOfficerPermissions(message.member, officerRole)) {
    await message.reply('Only officers can approve or deny applications.');
    return;
  }

  await moveApplicationChannelToStatus({
    guild: message.guild,
    channel: message.channel,
    status,
    approvedCategoryName: config.approvedCategoryName,
    deniedCategoryName: config.deniedCategoryName,
  });

  await message.channel.send(`Application has been ${status}.`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton() || interaction.customId !== APPLICATION_BUTTON_ID) {
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: 'Applications can only be created in a server.', ephemeral: true });
    return;
  }

  const officerRole = interaction.guild.roles.cache.find((role) => role.name === config.officerRoleName);
  const questionsText = getQuestionsText(guildQuestions.get(interaction.guild.id), config.defaultQuestions);

  const { channel, created } = await createPendingApplicationChannel({
    guild: interaction.guild,
    user: interaction.user,
    officerRole,
    pendingCategoryName: config.pendingCategoryName,
    questionsText,
  });

  const response = created
    ? `Your application channel is ready: <#${channel.id}>`
    : `You already have a pending application: <#${channel.id}>`;

  await interaction.reply({ content: response, ephemeral: true });
});

client.login(config.token);
