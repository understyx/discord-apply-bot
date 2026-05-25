import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApplicationButtonId,
  buildApplicationChannelName,
  findApplicationChannelByUser,
  getApplicationTopic,
  getQuestionsText,
  parseApplicationButtonId,
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
