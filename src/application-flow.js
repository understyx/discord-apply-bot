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

export function buildApplicationChannelName(username, applicationName) {
  const cleanUsername = (username || 'applicant')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

  const cleanAppName = (applicationName || 'application')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

  return `${cleanUsername || 'user'}-${cleanAppName || 'application'}`.slice(0, 100);
}

export function getApplicationTopic(userId, applicationId) {
  if (applicationId != null) {
    return `application:${userId}:${applicationId}`;
  }
  return `application:${userId}`;
}

export function findApplicationChannelByUser(channels, userId) {
  const exactTopic = `application:${userId}`;
  const prefixTopic = `${exactTopic}:`;
  return channels.find(
    (channel) => channel.topic === exactTopic || channel.topic?.startsWith(prefixTopic),
  ) || null;
}

export function parseApplicationTopic(topic) {
  if (!topic) {
    return null;
  }

  const match = topic.match(/^application:(\d+)(?::(\d+))?$/);
  if (!match) {
    return null;
  }

  return {
    userId: match[1],
    applicationId: match[2] != null ? Number(match[2]) : null,
  };
}

export function getQuestionsText(configuredQuestions, defaultQuestions) {
  const text = configuredQuestions?.trim();
  if (text) {
    return text;
  }

  return defaultQuestions || 'Please answer the guild application questions.';
}

export async function ensureCategory(guild, categoryName, botUserId) {
  const existing = guild.channels.cache.find(
    (channel) => channel.type === 4 && channel.name === categoryName,
  );

  if (existing) {
    return existing;
  }

  const permissionOverwrites = botUserId
    ? [{ id: botUserId, allow: ['ViewChannel', 'ManageChannels'] }]
    : [];

  return guild.channels.create({
    name: categoryName,
    type: 4,
    permissionOverwrites,
  });
}

async function ensureOfficerRoleAccess(channel, officerRoles) {
  for (const officerRole of officerRoles) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await channel.permissionOverwrites.edit(officerRole.id, OFFICER_CHANNEL_ALLOW_PERMISSIONS);
    } catch (error) {
      if (isMissingPermissionsError(error)) {
        console.warn(
          `Missing permissions while updating officer role access for channel ${channel.id ?? 'unknown'}.`,
        );
        return;
      }

      throw error;
    }
  }
}

function isMissingPermissionsError(error) {
  return error?.code === 50013 || error?.rawError?.code === 50013;
}

export async function createPendingApplicationChannel({
  guild,
  user,
  botUserId,
  officerRoles,
  pendingCategoryName,
  questionsText,
  applicationId,
  applicationName,
}) {
  const pendingCategory = await ensureCategory(guild, pendingCategoryName, botUserId);
  const applicationChannels = guild.channels.cache.filter(
    (channel) => channel.parentId === pendingCategory.id,
  );

  const existing = findApplicationChannelByUser([...applicationChannels.values()], user.id);
  if (existing) {
    await ensureOfficerRoleAccess(existing, officerRoles);
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

  for (const officerRole of officerRoles) {
    permissionOverwrites.push({
      id: officerRole.id,
      allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels'],
    });
  }

  if (botUserId) {
    permissionOverwrites.push({
      id: botUserId,
      allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels'],
    });
  }

  const channel = await guild.channels.create({
    name: buildApplicationChannelName(user.username, applicationName),
    type: 0,
    parent: pendingCategory.id,
    topic: getApplicationTopic(user.id, applicationId),
    permissionOverwrites,
  });

  await ensureOfficerRoleAccess(channel, officerRoles);

  await channel.send([
    `<@${user.id}> applying for **${applicationName}**`,
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
  officerRoles,
  botUserId,
}) {
  const destinationName = status === 'approved' ? approvedCategoryName : deniedCategoryName;
  const destinationCategory = await ensureCategory(guild, destinationName, botUserId);

  try {
    await channel.setParent(destinationCategory.id);
  } catch (error) {
    if (isMissingPermissionsError(error)) {
      console.warn(
        `Missing permissions while moving application channel ${channel.id ?? 'unknown'} to category ${destinationCategory.id}.`,
      );
      return;
    }

    throw error;
  }

  await ensureOfficerRoleAccess(channel, officerRoles);
}
