const DEFAULT_CHANNEL_PREFIX = 'application';

const APPLICATION_BUTTON_PREFIX = 'guild-application:apply:';

const OFFICER_CHANNEL_ALLOW_PERMISSIONS = {
  ViewChannel: true,
  SendMessages: true,
  ReadMessageHistory: true,
  ManageChannels: true,
};

export function buildApplicationButtonId(applicationId) {
  return `${APPLICATION_BUTTON_PREFIX}${applicationId}`;
}

export function parseApplicationButtonId(customId) {
  if (!customId || !customId.startsWith(APPLICATION_BUTTON_PREFIX)) {
    return null;
  }

  const rawApplicationId = customId.slice(APPLICATION_BUTTON_PREFIX.length);
  const applicationId = Number(rawApplicationId);
  if (!Number.isInteger(applicationId) || applicationId < 1) {
    return null;
  }

  return applicationId;
}

export function parseStatusCommand(content) {
  if (!content) {
    return null;
  }

  const normalized = content.trim().toLowerCase();
  if (normalized === '!approve') {
    return 'approved';
  }

  if (normalized === '!deny') {
    return 'denied';
  }

  return null;
}

export function buildApplicationChannelName(username, userId) {
  const cleanName = (username || 'applicant')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);

  return `${DEFAULT_CHANNEL_PREFIX}-${cleanName || 'user'}-${String(userId).slice(-8)}`.slice(0, 100);
}

export function getApplicationTopic(userId) {
  return `application:${userId}`;
}

export function findApplicationChannelByUser(channels, userId) {
  const topic = getApplicationTopic(userId);
  return channels.find((channel) => channel.topic === topic) || null;
}

export function getQuestionsText(configuredQuestions, defaultQuestions) {
  const text = configuredQuestions?.trim();
  if (text) {
    return text;
  }

  return defaultQuestions || 'Please answer the guild application questions.';
}

export async function ensureCategory(guild, categoryName) {
  const existing = guild.channels.cache.find(
    (channel) => channel.type === 4 && channel.name === categoryName,
  );

  if (existing) {
    return existing;
  }

  return guild.channels.create({
    name: categoryName,
    type: 4,
  });
}

async function ensureOfficerRoleAccess(channel, officerRole) {
  if (!officerRole) {
    return;
  }

  try {
    await channel.permissionOverwrites.edit(officerRole.id, OFFICER_CHANNEL_ALLOW_PERMISSIONS);
  } catch (error) {
    if (error?.code === 50013 || error?.rawError?.code === 50013) {
      console.warn(
        `Missing permissions while updating officer role access for channel ${channel.id ?? 'unknown'}.`,
      );
      return;
    }

    throw error;
  }
}

export async function createPendingApplicationChannel({
  guild,
  user,
  botUserId,
  officerRole,
  pendingCategoryName,
  questionsText,
}) {
  const pendingCategory = await ensureCategory(guild, pendingCategoryName);
  const applicationChannels = guild.channels.cache.filter(
    (channel) => channel.parentId === pendingCategory.id,
  );

  const existing = findApplicationChannelByUser([...applicationChannels.values()], user.id);
  if (existing) {
    await ensureOfficerRoleAccess(existing, officerRole);
    return { channel: existing, created: false };
  }

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: ['ViewChannel'],
    },
    {
      id: user.id,
      allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
    },
  ];

  if (officerRole) {
    permissionOverwrites.push({
      id: officerRole.id,
      allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels'],
    });
  }

  if (botUserId) {
    permissionOverwrites.push({
      id: botUserId,
      allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
    });
  }

  const channel = await guild.channels.create({
    name: buildApplicationChannelName(user.username, user.id),
    type: 0,
    parent: pendingCategory.id,
    topic: getApplicationTopic(user.id),
    permissionOverwrites,
  });

  await ensureOfficerRoleAccess(channel, officerRole);

  await channel.send([
    `Application for <@${user.id}>`,
    '',
    'Please answer the following questions:',
    questionsText,
  ].join('\n'));

  return { channel, created: true };
}

export async function moveApplicationChannelToStatus({
  guild,
  channel,
  status,
  approvedCategoryName,
  deniedCategoryName,
  officerRole,
}) {
  const destinationName = status === 'approved' ? approvedCategoryName : deniedCategoryName;
  const destinationCategory = await ensureCategory(guild, destinationName);
  await channel.setParent(destinationCategory.id);
  await ensureOfficerRoleAccess(channel, officerRole);
}
