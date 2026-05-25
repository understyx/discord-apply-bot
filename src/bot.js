import 'dotenv/config';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  buildApplicationButtonId,
  createPendingApplicationChannel,
  moveApplicationChannelToStatus,
  parseApplicationButtonId,
  parseStatusCommand,
} from './application-flow.js';
import {
  getApplicationById,
  getApplicationByName,
  getGuildSettings,
  initDatabase,
  listGuildApplications,
  setGuildOfficerRole,
  upsertApplication,
} from './storage.js';

const DEFAULT_PENDING_CATEGORY_NAME = 'Applications (Pending)';
const DEFAULT_APPROVED_CATEGORY_NAME = 'Applications (Approved)';
const DEFAULT_DENIED_CATEGORY_NAME = 'Applications (Denied)';
const DEFAULT_APPLICATION_NAME = 'Guild Application';
const DEFAULT_QUESTIONS = 'Tell us your character name, class/spec, and raid experience.';

const config = {
  token: process.env.DISCORD_TOKEN,
  mysqlHost: process.env.MYSQL_HOST,
  mysqlPort: Number(process.env.MYSQL_PORT || 3306),
  mysqlUser: process.env.MYSQL_USER,
  mysqlPassword: process.env.MYSQL_PASSWORD,
  mysqlDatabase: process.env.MYSQL_DATABASE,
};

const missingConfig = [
  ['DISCORD_TOKEN', config.token],
  ['MYSQL_HOST', config.mysqlHost],
  ['MYSQL_USER', config.mysqlUser],
  ['MYSQL_PASSWORD', config.mysqlPassword],
  ['MYSQL_DATABASE', config.mysqlDatabase],
].filter(([, value]) => !value).map(([key]) => key);

if (missingConfig.length) {
  throw new Error(`Missing required environment variables: ${missingConfig.join(', ')}`);
}

if (!Number.isInteger(config.mysqlPort) || config.mysqlPort < 1) {
  throw new Error('MYSQL_PORT must be a valid positive integer.');
}

const SET_QUESTIONS_MODAL_ID = 'guild-application:set-questions';
const SET_QUESTIONS_APPLICATION_NAME_OPTION_ID = 'application';
const SET_OFFICER_ROLE_OPTION_ID = 'role';
const APPLICATION_QUESTIONS_INPUT_ID = 'application-questions';

const pendingSetQuestionsContext = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function getSetQuestionsContextKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function hasOfficerPermissions(member, officerRole) {
  if (!member) {
    return false;
  }

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  return Boolean(officerRole && member.roles.cache.has(officerRole.id));
}

async function replyEphemeral(interaction, payload) {
  const responsePayload = typeof payload === 'string'
    ? { content: payload }
    : payload;

  await interaction.reply({
    ...responsePayload,
    flags: MessageFlags.Ephemeral,
  });
}

function buildApplicationButtonRows(applications) {
  const rows = [];

  for (let i = 0; i < applications.length; i += 5) {
    const rowApplications = applications.slice(i, i + 5);
    const row = new ActionRowBuilder().addComponents(
      rowApplications.map((application) => (
        new ButtonBuilder()
          .setCustomId(buildApplicationButtonId(application.id))
          .setLabel(application.display_name)
          .setStyle(ButtonStyle.Primary)
      )),
    );

    rows.push(row);
  }

  return rows;
}

async function applyApplicationStatus({
  guild,
  channel,
  member,
  status,
  officerRole,
  respond,
}) {
  if (channel?.type !== ChannelType.GuildText) {
    await respond('This command must be used in an application text channel.');
    return;
  }

  if (!hasOfficerPermissions(member, officerRole)) {
    await respond('Only officers can approve or deny applications.');
    return;
  }

  await moveApplicationChannelToStatus({
    guild,
    channel,
    status,
    approvedCategoryName: DEFAULT_APPROVED_CATEGORY_NAME,
    deniedCategoryName: DEFAULT_DENIED_CATEGORY_NAME,
    officerRole,
  });

  await respond(`Application has been ${status}.`);
}

async function getOfficerRoleForGuild(guild) {
  const settings = await getGuildSettings(guild.id);
  if (!settings.officerRoleId) {
    return null;
  }

  return guild.roles.cache.get(settings.officerRoleId)
    || await guild.roles.fetch(settings.officerRoleId).catch(() => null);
}

async function registerSlashCommands(guild) {
  const commands = [
    new SlashCommandBuilder()
      .setName('setquestions')
      .setDescription('Set questions for a specific application')
      .addStringOption((option) => option
        .setName(SET_QUESTIONS_APPLICATION_NAME_OPTION_ID)
        .setDescription('Which application to edit or create')
        .setRequired(true)
        .setMaxLength(80)),
    new SlashCommandBuilder()
      .setName('setofficerrole')
      .setDescription('Set which role can manage applications')
      .addRoleOption((option) => option
        .setName(SET_OFFICER_ROLE_OPTION_ID)
        .setDescription('Officer role')
        .setRequired(true)),
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

client.once('clientReady', async () => {
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
      await replyEphemeral(interaction, 'This command can only be used in a server.');
      return;
    }

    const officerRole = await getOfficerRoleForGuild(interaction.guild);

    if (interaction.commandName === 'setquestions') {
      if (!hasOfficerPermissions(interaction.member, officerRole)) {
        await replyEphemeral(interaction, 'Only officers can configure applications.');
        return;
      }

      const requestedApplicationName = interaction.options
        .getString(SET_QUESTIONS_APPLICATION_NAME_OPTION_ID, true)
        .trim();

      if (!requestedApplicationName) {
        await replyEphemeral(interaction, 'Application name is required.');
        return;
      }

      const existingApplication = await getApplicationByName(interaction.guild.id, requestedApplicationName);

      const modal = new ModalBuilder()
        .setCustomId(SET_QUESTIONS_MODAL_ID)
        .setTitle(`Questions: ${requestedApplicationName}`.slice(0, 45));

      const questionsInput = new TextInputBuilder()
        .setCustomId(APPLICATION_QUESTIONS_INPUT_ID)
        .setLabel('Application questions')
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(3500)
        .setRequired(true)
        .setValue(existingApplication?.questions_text || DEFAULT_QUESTIONS);

      modal.addComponents(
        new ActionRowBuilder().addComponents(questionsInput),
      );

      pendingSetQuestionsContext.set(
        getSetQuestionsContextKey(interaction.guild.id, interaction.user.id),
        requestedApplicationName,
      );

      await interaction.showModal(modal);
      return;
    }

    if (interaction.commandName === 'setofficerrole') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await replyEphemeral(interaction, 'You need Manage Server permission to set the officer role.');
        return;
      }

      const role = interaction.options.getRole(SET_OFFICER_ROLE_OPTION_ID, true);
      await setGuildOfficerRole(interaction.guild.id, role.id);

      await replyEphemeral(interaction, `Officer role updated to <@&${role.id}>.`);
      return;
    }

    if (interaction.commandName === 'postapply') {
      if (!hasOfficerPermissions(interaction.member, officerRole)) {
        await replyEphemeral(interaction, 'Only officers can post the application message.');
        return;
      }

      let applications = await listGuildApplications(interaction.guild.id);
      if (!applications.length) {
        const application = await upsertApplication({
          guildId: interaction.guild.id,
          applicationName: DEFAULT_APPLICATION_NAME,
          questionsText: DEFAULT_QUESTIONS,
        });

        applications = [application];
      }

      const maxApplicationsInMessage = 25;
      const visibleApplications = applications.slice(0, maxApplicationsInMessage);
      const hasHiddenApplications = applications.length > maxApplicationsInMessage;

      const embedDescription = hasHiddenApplications
        ? `Hello! Thank you for showing interest in our guild. Choose an application below to get started. Showing first ${maxApplicationsInMessage} applications.`
        : 'Hello! Thank you for showing interest in our guild. Choose an application below to get started.';

      const embed = new EmbedBuilder()
        .setTitle('Guild Applications')
        .setDescription(embedDescription)
        .setColor(0x5865f2);

      await interaction.channel.send({
        embeds: [embed],
        components: buildApplicationButtonRows(visibleApplications),
      });

      await replyEphemeral(interaction, 'Application embed posted.');
      return;
    }

    if (interaction.commandName === 'approve' || interaction.commandName === 'deny') {
      const status = interaction.commandName === 'approve' ? 'approved' : 'denied';
      await applyApplicationStatus({
        guild: interaction.guild,
        channel: interaction.channel,
        member: interaction.member,
        status,
        officerRole,
        respond: async (content) => {
          await interaction.reply(content);
        },
      });
      return;
    }

    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === SET_QUESTIONS_MODAL_ID) {
    if (!interaction.guild) {
      await replyEphemeral(interaction, 'This action can only be used in a server.');
      return;
    }

    const officerRole = await getOfficerRoleForGuild(interaction.guild);
    if (!hasOfficerPermissions(interaction.member, officerRole)) {
      await replyEphemeral(interaction, 'Only officers can configure applications.');
      return;
    }

    const contextKey = getSetQuestionsContextKey(interaction.guild.id, interaction.user.id);
    const applicationName = pendingSetQuestionsContext.get(contextKey);
    pendingSetQuestionsContext.delete(contextKey);

    if (!applicationName) {
      await replyEphemeral(interaction, 'Application context expired. Please run /setquestions again.');
      return;
    }

    const questionsText = interaction.fields.getTextInputValue(APPLICATION_QUESTIONS_INPUT_ID).trim();

    if (!questionsText) {
      await replyEphemeral(interaction, 'Application questions are required.');
      return;
    }

    await upsertApplication({
      guildId: interaction.guild.id,
      applicationName,
      questionsText,
    });

    await replyEphemeral(interaction, {
      content: `Application settings saved for **${applicationName}**.`,
    });
    return;
  }

  if (!interaction.isButton()) {
    return;
  }

  const applicationId = parseApplicationButtonId(interaction.customId);
  if (!applicationId) {
    return;
  }

  if (!interaction.guild) {
    await replyEphemeral(interaction, 'Applications can only be created in a server.');
    return;
  }

  const application = await getApplicationById(interaction.guild.id, applicationId);
  if (!application) {
    await replyEphemeral(interaction, 'This application is no longer available.');
    return;
  }

  const officerRole = await getOfficerRoleForGuild(interaction.guild);

  const { channel, created } = await createPendingApplicationChannel({
    guild: interaction.guild,
    user: interaction.user,
    botUserId: interaction.client.user.id,
    officerRole,
    pendingCategoryName: DEFAULT_PENDING_CATEGORY_NAME,
    questionsText: application.questions_text,
  });

  const response = created
    ? `Your **${application.display_name}** application channel is ready: <#${channel.id}>`
    : `You already have a pending application: <#${channel.id}>`;

  await replyEphemeral(interaction, response);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) {
    return;
  }

  const status = parseStatusCommand(message.content);
  if (!status) {
    return;
  }

  const officerRole = await getOfficerRoleForGuild(message.guild);
  await applyApplicationStatus({
    guild: message.guild,
    channel: message.channel,
    member: message.member,
    status,
    officerRole,
    respond: async (content) => {
      await message.reply(content);
    },
  });
});

async function startBot() {
  await initDatabase({
    host: config.mysqlHost,
    port: config.mysqlPort,
    user: config.mysqlUser,
    password: config.mysqlPassword,
    database: config.mysqlDatabase,
  });

  await client.login(config.token);
}

startBot().catch((error) => {
  console.error('Failed to start bot:', error);
  process.exit(1);
});
