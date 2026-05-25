import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  APPLICATION_BUTTON_ID,
  createPendingApplicationChannel,
  getQuestionsText,
  moveApplicationChannelToStatus,
} from './application-flow.js';

const config = {
  token: process.env.DISCORD_TOKEN,
  officerRoleName: process.env.OFFICER_ROLE_NAME || 'Officer',
  pendingCategoryName: process.env.APPLICATIONS_PENDING_CATEGORY || 'Applications (Pending)',
  approvedCategoryName: process.env.APPLICATIONS_APPROVED_CATEGORY || 'Applications (Approved)',
  deniedCategoryName: process.env.APPLICATIONS_DENIED_CATEGORY || 'Applications (Denied)',
  defaultApplicationName: process.env.APPLY_APPLICATION_NAME || 'Guild Application',
  defaultQuestions: process.env.APPLY_QUESTIONS || 'Tell us your character name, class/spec, and raid experience.',
};

if (!config.token) {
  throw new Error('Missing DISCORD_TOKEN in environment.');
}

const SET_QUESTIONS_MODAL_ID = 'guild-application:set-questions';
const APPLICATION_NAME_INPUT_ID = 'application-name';
const APPLICATION_QUESTIONS_INPUT_ID = 'application-questions';

const guildApplicationConfig = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
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

function getGuildApplicationConfig(guildId) {
  const configured = guildApplicationConfig.get(guildId);
  return {
    applicationName: configured?.applicationName?.trim() || config.defaultApplicationName,
    questionsText: getQuestionsText(configured?.questionsText, config.defaultQuestions),
  };
}

async function registerSlashCommands(guild) {
  const commands = [
    new SlashCommandBuilder()
      .setName('setquestions')
      .setDescription('Set the application name and application questions'),
    new SlashCommandBuilder()
      .setName('postapply')
      .setDescription('Post the application embed with apply buttons'),
    new SlashCommandBuilder()
      .setName('approve')
      .setDescription('Mark the current application as approved'),
    new SlashCommandBuilder()
      .setName('deny')
      .setDescription('Mark the current application as denied'),
  ];

  await guild.commands.set(commands.map((command) => command.toJSON()));
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    try {
      await registerSlashCommands(guild);
    } catch (error) {
      console.error(`Failed to register slash commands for guild ${guild.id}:`, error);
    }
  }
});

client.on('guildCreate', async (guild) => {
  try {
    await registerSlashCommands(guild);
  } catch (error) {
    console.error(`Failed to register slash commands for guild ${guild.id}:`, error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    const officerRole = interaction.guild.roles.cache.find((role) => role.name === config.officerRoleName);

    if (interaction.commandName === 'setquestions') {
      if (!hasOfficerPermissions(interaction.member, officerRole)) {
        await interaction.reply({ content: 'Only officers can configure applications.', ephemeral: true });
        return;
      }

      const currentConfig = getGuildApplicationConfig(interaction.guild.id);
      const modal = new ModalBuilder()
        .setCustomId(SET_QUESTIONS_MODAL_ID)
        .setTitle('Configure Application');

      const applicationNameInput = new TextInputBuilder()
        .setCustomId(APPLICATION_NAME_INPUT_ID)
        .setLabel('Application name')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(80)
        .setRequired(true)
        .setValue(currentConfig.applicationName);

      const questionsInput = new TextInputBuilder()
        .setCustomId(APPLICATION_QUESTIONS_INPUT_ID)
        .setLabel('Application questions')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(3500)
        .setRequired(true)
        .setValue(currentConfig.questionsText);

      modal.addComponents(
        new ActionRowBuilder().addComponents(applicationNameInput),
        new ActionRowBuilder().addComponents(questionsInput),
      );

      await interaction.showModal(modal);
      return;
    }

    if (interaction.commandName === 'postapply') {
      if (!hasOfficerPermissions(interaction.member, officerRole)) {
        await interaction.reply({ content: 'Only officers can post the application message.', ephemeral: true });
        return;
      }

      const currentConfig = getGuildApplicationConfig(interaction.guild.id);
      const embed = new EmbedBuilder()
        .setTitle(currentConfig.applicationName)
        .setDescription('Hello! Thank you for showing interest in our guild. Choose an application below to get started.')
        .setColor(0x5865f2);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(APPLICATION_BUTTON_ID)
          .setLabel(currentConfig.applicationName)
          .setStyle(ButtonStyle.Primary),
      );

      await interaction.channel.send({
        embeds: [embed],
        components: [row],
      });

      await interaction.reply({ content: 'Application embed posted.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'approve' || interaction.commandName === 'deny') {
      if (interaction.channel?.type !== ChannelType.GuildText) {
        await interaction.reply({ content: 'This command must be used in an application text channel.', ephemeral: true });
        return;
      }

      if (!hasOfficerPermissions(interaction.member, officerRole)) {
        await interaction.reply({ content: 'Only officers can approve or deny applications.', ephemeral: true });
        return;
      }

      const status = interaction.commandName === 'approve' ? 'approved' : 'denied';
      await moveApplicationChannelToStatus({
        guild: interaction.guild,
        channel: interaction.channel,
        status,
        approvedCategoryName: config.approvedCategoryName,
        deniedCategoryName: config.deniedCategoryName,
      });

      await interaction.reply(`Application has been ${status}.`);
      return;
    }

    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === SET_QUESTIONS_MODAL_ID) {
    if (!interaction.guild) {
      await interaction.reply({ content: 'This action can only be used in a server.', ephemeral: true });
      return;
    }

    const officerRole = interaction.guild.roles.cache.find((role) => role.name === config.officerRoleName);
    if (!hasOfficerPermissions(interaction.member, officerRole)) {
      await interaction.reply({ content: 'Only officers can configure applications.', ephemeral: true });
      return;
    }

    const applicationName = interaction.fields.getTextInputValue(APPLICATION_NAME_INPUT_ID).trim();
    const questionsText = interaction.fields.getTextInputValue(APPLICATION_QUESTIONS_INPUT_ID).trim();

    if (!applicationName || !questionsText) {
      await interaction.reply({ content: 'Both application name and questions are required.', ephemeral: true });
      return;
    }

    guildApplicationConfig.set(interaction.guild.id, {
      applicationName,
      questionsText,
    });

    await interaction.reply({ content: 'Application settings have been updated.', ephemeral: true });
    return;
  }

  if (!interaction.isButton() || interaction.customId !== APPLICATION_BUTTON_ID) {
    return;
  }

  if (!interaction.guild) {
    await interaction.reply({ content: 'Applications can only be created in a server.', ephemeral: true });
    return;
  }

  const officerRole = interaction.guild.roles.cache.find((role) => role.name === config.officerRoleName);
  const { questionsText } = getGuildApplicationConfig(interaction.guild.id);

  const { channel, created } = await createPendingApplicationChannel({
    guild: interaction.guild,
    user: interaction.user,
    botUserId: interaction.client.user.id,
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
