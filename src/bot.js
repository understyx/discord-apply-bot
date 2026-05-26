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
  parseApplicationTopic,
  parseStatusCommand,
} from './application-flow.js';
import {
  deleteApplicationByName,
  getApplicationById,
  getApplicationByName,
  getGuildSettings,
  initDatabase,
  listGuildApplications,
  setGuildOfficerRoles,
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

const CREATE_APPLICATION_MODAL_ID = 'guild-application:create-application';
const CREATE_APPLICATION_NAME_OPTION_ID = 'application';
const CREATE_APPLICATION_APPROVE_ROLE_OPTION_ID = 'approve_role';
const CREATE_APPLICATION_DENY_ROLE_OPTION_ID = 'deny_role';
const SET_OFFICER_ROLE_OPTION_IDS = ['role', 'role2', 'role3', 'role4', 'role5'];
const APPLICATION_QUESTIONS_INPUT_ID = 'application-questions';

const pendingCreateApplicationContext = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function getCreateApplicationContextKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function hasOfficerPermissions(member, officerRoles) {
  if (!member) {
    return false;
  }

  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  return officerRoles.some((role) => member.roles.cache.has(role.id));
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
  officerRoles,
  botUserId,
  respond,
}) {
  if (channel?.type !== ChannelType.GuildText) {
    await respond('This command must be used in an application text channel.');
    return;
  }

  if (!hasOfficerPermissions(member, officerRoles)) {
    await respond('Only officers can approve or deny applications.');
    return;
  }

  await moveApplicationChannelToStatus({
    guild,
    channel,
    status,
    approvedCategoryName: DEFAULT_APPROVED_CATEGORY_NAME,
    deniedCategoryName: DEFAULT_DENIED_CATEGORY_NAME,
    officerRoles,
    botUserId,
  });

  const parsed = parseApplicationTopic(channel.topic);
  if (parsed?.applicationId) {
    const application = await getApplicationById(guild.id, parsed.applicationId);
    const roleId = status === 'approved' ? application?.approve_role_id : application?.deny_role_id;
    if (roleId) {
      try {
        const applicant = guild.members.cache.get(parsed.userId)
          || await guild.members.fetch(parsed.userId).catch(() => null);
        if (applicant) {
          await applicant.roles.add(roleId);
        }
      } catch (error) {
        console.warn(`Failed to assign role ${roleId} to user ${parsed.userId}:`, error);
      }
    }
  }

  await respond(`Application has been ${status}.`);
}

async function getOfficerRolesForGuild(guild) {
  const settings = await getGuildSettings(guild.id);
  if (!settings.officerRoleIds.length) {
    return [];
  }

  const roles = await Promise.all(
    settings.officerRoleIds.map((roleId) => (
      guild.roles.cache.get(roleId)
        || guild.roles.fetch(roleId).catch(() => null)
    )),
  );

  return roles.filter(Boolean);
}

async function registerSlashCommands(guild) {
  const commands = [
    new SlashCommandBuilder()
      .setName('createapplication')
      .setDescription('Create or update an application')
      .addStringOption((option) => option
        .setName(CREATE_APPLICATION_NAME_OPTION_ID)
        .setDescription('Application name to create or update')
        .setRequired(true)
        .setMaxLength(80))
      .addRoleOption((option) => option
        .setName(CREATE_APPLICATION_APPROVE_ROLE_OPTION_ID)
        .setDescription('Role to assign to applicant on approve (optional)')
        .setRequired(false))
      .addRoleOption((option) => option
        .setName(CREATE_APPLICATION_DENY_ROLE_OPTION_ID)
        .setDescription('Role to assign to applicant on deny (optional)')
        .setRequired(false)),
    new SlashCommandBuilder()
      .setName('setofficerrole')
      .setDescription('Set which roles can manage applications')
      .addRoleOption((option) => option
        .setName(SET_OFFICER_ROLE_OPTION_IDS[0])
        .setDescription('Officer role')
        .setRequired(true))
      .addRoleOption((option) => option
        .setName(SET_OFFICER_ROLE_OPTION_IDS[1])
        .setDescription('Additional officer role (optional)')
        .setRequired(false))
      .addRoleOption((option) => option
        .setName(SET_OFFICER_ROLE_OPTION_IDS[2])
        .setDescription('Additional officer role (optional)')
        .setRequired(false))
      .addRoleOption((option) => option
        .setName(SET_OFFICER_ROLE_OPTION_IDS[3])
        .setDescription('Additional officer role (optional)')
        .setRequired(false))
      .addRoleOption((option) => option
        .setName(SET_OFFICER_ROLE_OPTION_IDS[4])
        .setDescription('Additional officer role (optional)')
        .setRequired(false)),
    new SlashCommandBuilder()
      .setName('postapply')
      .setDescription('Post the application embed with apply buttons'),
    new SlashCommandBuilder()
      .setName('deleteapplication')
      .setDescription('Delete an existing application')
      .addStringOption((option) => option
        .setName('application')
        .setDescription('Application name to delete')
        .setRequired(true)
        .setAutocomplete(true)),
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
  if (interaction.isAutocomplete()) {
    if (!interaction.guild) {
      await interaction.respond([]);
      return;
    }

    if (interaction.commandName === 'deleteapplication') {
      const focusedValue = interaction.options.getFocused().toLowerCase();
      const applications = await listGuildApplications(interaction.guild.id);
      const filtered = applications
        .filter((app) => app.display_name.toLowerCase().includes(focusedValue))
        .slice(0, 25)
        .map((app) => ({ name: app.display_name, value: app.display_name }));
      await interaction.respond(filtered);
    }

    return;
  }

  if (interaction.isChatInputCommand()) {
    if (!interaction.guild) {
      await replyEphemeral(interaction, 'This command can only be used in a server.');
      return;
    }

    const officerRoles = await getOfficerRolesForGuild(interaction.guild);

    if (interaction.commandName === 'createapplication') {
      if (!hasOfficerPermissions(interaction.member, officerRoles)) {
        await replyEphemeral(interaction, 'Only officers can configure applications.');
        return;
      }

      const requestedApplicationName = interaction.options
        .getString(CREATE_APPLICATION_NAME_OPTION_ID, true)
        .trim();

      if (!requestedApplicationName) {
        await replyEphemeral(interaction, 'Application name is required.');
        return;
      }

      const approveRole = interaction.options.getRole(CREATE_APPLICATION_APPROVE_ROLE_OPTION_ID);
      const denyRole = interaction.options.getRole(CREATE_APPLICATION_DENY_ROLE_OPTION_ID);

      const existingApplication = await getApplicationByName(interaction.guild.id, requestedApplicationName);

      const modal = new ModalBuilder()
        .setCustomId(CREATE_APPLICATION_MODAL_ID)
        .setTitle(`Application: ${requestedApplicationName}`.slice(0, 45));

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

      pendingCreateApplicationContext.set(
        getCreateApplicationContextKey(interaction.guild.id, interaction.user.id),
        {
          applicationName: requestedApplicationName,
          approveRoleId: approveRole?.id ?? existingApplication?.approve_role_id ?? null,
          denyRoleId: denyRole?.id ?? existingApplication?.deny_role_id ?? null,
        },
      );

      await interaction.showModal(modal);
      return;
    }

    if (interaction.commandName === 'setofficerrole') {
      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        await replyEphemeral(interaction, 'You need Manage Server permission to set the officer role.');
        return;
      }

      const roles = SET_OFFICER_ROLE_OPTION_IDS
        .map((name) => interaction.options.getRole(name))
        .filter(Boolean);
      const uniqueRoleIds = [...new Set(roles.map((r) => r.id))];
      await setGuildOfficerRoles(interaction.guild.id, uniqueRoleIds);

      const rolesMentions = uniqueRoleIds.map((id) => `<@&${id}>`).join(', ');
      await replyEphemeral(interaction, `Officer roles updated to ${rolesMentions}.`);
      return;
    }

    if (interaction.commandName === 'postapply') {
      if (!hasOfficerPermissions(interaction.member, officerRoles)) {
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

    if (interaction.commandName === 'deleteapplication') {
      if (!hasOfficerPermissions(interaction.member, officerRoles)) {
        await replyEphemeral(interaction, 'Only officers can delete applications.');
        return;
      }

      const applicationName = interaction.options.getString('application', true).trim();
      const deleted = await deleteApplicationByName(interaction.guild.id, applicationName);

      if (!deleted) {
        await replyEphemeral(interaction, `No application found with name **${applicationName}**.`);
        return;
      }

      await replyEphemeral(interaction, `Application **${applicationName}** has been deleted.`);
      return;
    }

    if (interaction.commandName === 'approve' || interaction.commandName === 'deny') {
      const status = interaction.commandName === 'approve' ? 'approved' : 'denied';
      await applyApplicationStatus({
        guild: interaction.guild,
        channel: interaction.channel,
        member: interaction.member,
        status,
        officerRoles,
        botUserId: interaction.client.user.id,
        respond: async (content) => {
          await interaction.reply(content);
        },
      });
      return;
    }

    return;
  }

  if (interaction.isModalSubmit() && interaction.customId === CREATE_APPLICATION_MODAL_ID) {
    if (!interaction.guild) {
      await replyEphemeral(interaction, 'This action can only be used in a server.');
      return;
    }

    const officerRoles = await getOfficerRolesForGuild(interaction.guild);
    if (!hasOfficerPermissions(interaction.member, officerRoles)) {
      await replyEphemeral(interaction, 'Only officers can configure applications.');
      return;
    }

    const contextKey = getCreateApplicationContextKey(interaction.guild.id, interaction.user.id);
    const context = pendingCreateApplicationContext.get(contextKey);
    pendingCreateApplicationContext.delete(contextKey);

    if (!context) {
      await replyEphemeral(interaction, 'Application context expired. Please run /createapplication again.');
      return;
    }

    const questionsText = interaction.fields.getTextInputValue(APPLICATION_QUESTIONS_INPUT_ID).trim();

    if (!questionsText) {
      await replyEphemeral(interaction, 'Application questions are required.');
      return;
    }

    await upsertApplication({
      guildId: interaction.guild.id,
      applicationName: context.applicationName,
      questionsText,
      approveRoleId: context.approveRoleId,
      denyRoleId: context.denyRoleId,
    });

    await replyEphemeral(interaction, {
      content: `Application settings saved for **${context.applicationName}**.`,
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

  const officerRoles = await getOfficerRolesForGuild(interaction.guild);

  const { channel, created } = await createPendingApplicationChannel({
    guild: interaction.guild,
    user: interaction.user,
    botUserId: interaction.client.user.id,
    officerRoles,
    pendingCategoryName: DEFAULT_PENDING_CATEGORY_NAME,
    questionsText: application.questions_text,
    applicationId: application.id,
    applicationName: application.display_name,
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

  const officerRoles = await getOfficerRolesForGuild(message.guild);
  await applyApplicationStatus({
    guild: message.guild,
    channel: message.channel,
    member: message.member,
    status,
    officerRoles,
    botUserId: message.client.user.id,
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
