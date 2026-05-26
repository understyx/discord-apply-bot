import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApplicationButtonId,
  buildApplicationChannelName,
  findApplicationChannelByUser,
  getApplicationTopic,
  getQuestionsText,
  moveApplicationChannelToStatus,
  parseApplicationButtonId,
  parseApplicationTopic,
  parseStatusCommand,
} from '../src/application-flow.js';

test('parseStatusCommand handles approve and deny commands', () => {
  assert.equal(parseStatusCommand('!approve'), 'approved');
  assert.equal(parseStatusCommand('  !deny  '), 'denied');
  assert.equal(parseStatusCommand('!somethingElse'), null);
});

test('buildApplicationChannelName sanitizes username and keeps valid size', () => {
  const channelName = buildApplicationChannelName('My User.Name', '1234567890123');
  assert.match(channelName, /^application-/);
  assert.ok(channelName.length <= 100);
  assert.equal(channelName.includes('.'), false);
});

test('findApplicationChannelByUser matches by topic marker', () => {
  const userId = '987654321';
  const channels = [
    { topic: 'application:111' },
    { topic: getApplicationTopic(userId) },
  ];

  assert.deepEqual(findApplicationChannelByUser(channels, userId), channels[1]);
  assert.equal(findApplicationChannelByUser(channels, '000'), null);
});

test('findApplicationChannelByUser matches legacy and new topic formats', () => {
  const userId = '111222333';
  const legacyChannel = { topic: `application:${userId}` };
  const newChannel = { topic: `application:${userId}:42` };

  assert.deepEqual(findApplicationChannelByUser([legacyChannel], userId), legacyChannel);
  assert.deepEqual(findApplicationChannelByUser([newChannel], userId), newChannel);
  assert.equal(findApplicationChannelByUser([{ topic: `application:${userId}extra` }], userId), null);
});

test('parseApplicationTopic extracts userId and applicationId', () => {
  assert.deepEqual(parseApplicationTopic('application:123456:789'), { userId: '123456', applicationId: 789 });
  assert.deepEqual(parseApplicationTopic('application:123456'), { userId: '123456', applicationId: null });
  assert.equal(parseApplicationTopic(''), null);
  assert.equal(parseApplicationTopic(null), null);
  assert.equal(parseApplicationTopic('application:abc'), null);
  assert.equal(parseApplicationTopic('other:123'), null);
});

test('getQuestionsText prefers configured text and falls back safely', () => {
  assert.equal(getQuestionsText('  What class do you play?  ', 'Fallback'), 'What class do you play?');
  assert.equal(getQuestionsText('', 'Fallback'), 'Fallback');
  assert.equal(getQuestionsText('', ''), 'Please answer the guild application questions.');
});

test('application button IDs are built and parsed safely', () => {
  const customId = buildApplicationButtonId(42);
  assert.equal(customId, 'guild-application:apply:42');
  assert.equal(parseApplicationButtonId(customId), 42);
  assert.equal(parseApplicationButtonId('guild-application:apply:0'), null);
  assert.equal(parseApplicationButtonId('guild-application:apply:not-a-number'), null);
  assert.equal(parseApplicationButtonId('guild-application:other:42'), null);
});

test('moveApplicationChannelToStatus ensures officer role access on moved channel', async () => {
  let movedToCategoryId = null;
  let officerOverwrite = null;

  const channel = {
    async setParent(categoryId) {
      movedToCategoryId = categoryId;
    },
    permissionOverwrites: {
      async edit(roleId, permissions) {
        officerOverwrite = { roleId, permissions };
      },
    },
  };

  const guild = {
    channels: {
      cache: {
        find(fn) {
          const category = { id: 'approved-category-id', type: 4, name: 'Approved Apps' };
          return fn(category) ? category : undefined;
        },
      },
    },
  };

  await moveApplicationChannelToStatus({
    guild,
    channel,
    status: 'approved',
    approvedCategoryName: 'Approved Apps',
    deniedCategoryName: 'Denied Apps',
    officerRole: { id: 'officer-role-id' },
  });

  assert.equal(movedToCategoryId, 'approved-category-id');
  assert.deepEqual(officerOverwrite, {
    roleId: 'officer-role-id',
    permissions: {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      ManageChannels: true,
    },
  });
});

test('moveApplicationChannelToStatus ignores missing permissions when updating officer overwrite', async () => {
  let movedToCategoryId = null;

  const channel = {
    async setParent(categoryId) {
      movedToCategoryId = categoryId;
    },
    permissionOverwrites: {
      async edit() {
        const error = new Error('Missing Permissions');
        error.code = 50013;
        throw error;
      },
    },
  };

  const guild = {
    channels: {
      cache: {
        find(fn) {
          const category = { id: 'denied-category-id', type: 4, name: 'Denied Apps' };
          return fn(category) ? category : undefined;
        },
      },
    },
  };

  await assert.doesNotReject(async () => {
    await moveApplicationChannelToStatus({
      guild,
      channel,
      status: 'denied',
      approvedCategoryName: 'Approved Apps',
      deniedCategoryName: 'Denied Apps',
      officerRole: { id: 'officer-role-id' },
    });
  });

  assert.equal(movedToCategoryId, 'denied-category-id');
});

test('moveApplicationChannelToStatus ignores missing permissions when moving channel category', async () => {
  let officerOverwriteAttempted = false;

  const channel = {
    id: 'application-channel-id',
    async setParent() {
      const error = new Error('Missing Permissions');
      error.code = 50013;
      throw error;
    },
    permissionOverwrites: {
      async edit() {
        officerOverwriteAttempted = true;
      },
    },
  };

  const guild = {
    channels: {
      cache: {
        find(fn) {
          const category = { id: 'approved-category-id', type: 4, name: 'Approved Apps' };
          return fn(category) ? category : undefined;
        },
      },
    },
  };

  await assert.doesNotReject(async () => {
    await moveApplicationChannelToStatus({
      guild,
      channel,
      status: 'approved',
      approvedCategoryName: 'Approved Apps',
      deniedCategoryName: 'Denied Apps',
      officerRole: { id: 'officer-role-id' },
    });
  });

  assert.equal(officerOverwriteAttempted, false);
});
