import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { State } from '../bridge/state.mjs';
import { Bridge } from '../bridge/core.mjs';
import { AiClient } from '../bridge/client.mjs';
import { GroupBuffer } from '../bridge/groups.mjs';
import { testConfig } from './fixture.mjs';
import { ChatService } from '../ai/chat.mjs';
import { startServer } from '../ai/server.mjs';

const image = {
  mimeType: 'image/png',
  base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOIUAAAAASUVORK5CYII=',
};

test('a real group mention attaches the sender’s last recent photo in that room', async () => {
  let now = Date.now();
  const requests = [], downloads = [];
  const bridge = new Bridge({
    state: { claim: () => true },
    groupsEnabled: true,
    groupBuffer: new GroupBuffer({ now: () => now }),
    client: { request: async request => { requests.push(request); return '收到'; } },
    send: async () => {},
    loadImage: async id => { downloads.push(id); return image; },
  });
  bridge.online();
  const post = (id, fields = {}) => bridge.accept({
    id, kind: 'image', senderId: 'alice', selfId: 'bot', roomId: 'room@chatroom',
    timestamp: Math.floor(now / 1000), ...fields,
  });
  const mention = { kind: 'text', text: '@Bot 这是什么？', mentions: ['bot'] };
  assert.equal(await post('photo'), 'buffered');
  assert.equal(await post('other-sender-photo', { senderId: 'bob' }), 'buffered');
  assert.equal(await post('other-room-photo', { roomId: 'other@chatroom' }), 'buffered');
  assert.deepEqual(downloads, []);
  assert.equal(await post('ask', mention), 'sent');
  assert.deepEqual(downloads, ['photo']);
  assert.deepEqual(requests.at(-1).message.image, image);
  assert.equal(requests.at(-1).message.text, mention.text);

  assert.equal(await post('fresh-photo'), 'sent');
  assert.equal(await post('ask-again', { ...mention, text: '@Bot' }), 'sent');
  assert.equal(requests.at(-1).context.trigger, 'invite');
  assert.deepEqual(downloads.slice(-2), ['fresh-photo', 'fresh-photo']);
  assert.equal(await post('stop', { kind: 'text', text: '🤫' }), 'silenced');
  assert.equal(await post('old-photo'), 'buffered');
  now += 61_000;
  assert.equal(await post('expired-photo-ask', mention), 'sent');
  assert.equal(requests.at(-1).message.image, undefined);
  assert.deepEqual(downloads, ['photo', 'fresh-photo', 'fresh-photo']);
});

test('image bytes cross the socket for private or active group chat and stay out of history', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nv-')), socket = join(dir, 'ai.sock');
  const config = testConfig(), uploads = [], downloads = [];
  const service = new ChatService({
    config,
    provider: { chat: async ({ messages }) => {
      const content = messages.at(-1).content;
      if (!Array.isArray(content)) return '群聊已开启';
      uploads.push(content);
      return messages.some(message => message.role === 'system' && message.content.includes('"action":"silent"'))
        ? '{"action":"reply","text":"这是一张图片。"}' : '这是一张图片。';
    } },
  });
  const server = await startServer({ service, socketPath: socket });
  const bridge = new Bridge({
    state: new State(join(dir, 'bridge')), groupsEnabled: true, client: new AiClient(socket),
    send: async () => {}, loadImage: async id => {
      downloads.push(id);
      return id === 'bad' ? { ...image, mimeType: 'image/jpeg' } : image;
    },
  });
  bridge.online();
  t.after(async () => { await bridge.offline(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const message = (id, fields = {}) => ({
    id, kind: 'image', senderId: 'alice', selfId: 'bot',
    timestamp: Math.floor(Date.now() / 1000), ...fields,
  });
  const group = { roomId: 'room@chatroom' };
  assert.equal(await bridge.accept(message('asleep', group)), 'buffered');
  assert.deepEqual(downloads, []);
  assert.equal(await bridge.accept(message('private')), 'sent');
  assert.deepEqual(uploads[0][1], { type: 'image_url', image_url: { url: 'data:image/png;base64,' + image.base64 } });
  assert.equal(service.context('alice').at(-1).user, '[图片]');
  assert.equal(await bridge.accept(message('invite', { ...group, kind: 'text', text: '@Bot', mentions: ['bot'] })), 'sent');
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[1][1], uploads[0][1]);
  assert.equal(await bridge.accept(message('group-image', group)), 'sent');
  assert.equal(uploads.length, 3);
  assert(bridge.groupBuffer.snapshot(group.roomId).every(entry => !entry.text.includes(image.base64)));
  assert.equal(await bridge.accept(message('mute', { ...group, kind: 'text', text: '🤫' })), 'silenced');
  assert.equal(await bridge.accept(message('muted', group)), 'buffered');
  assert.equal(await bridge.accept(message('bad')), 'failed');
  assert.deepEqual(downloads, ['private', 'asleep', 'group-image', 'bad']);
  assert.equal(uploads.length, 3);
  config.model = 'deepseek-v4-pro';
  assert.equal(await bridge.accept(message('text-only-model')), 'sent');
  assert.equal(uploads.length, 3);
});
