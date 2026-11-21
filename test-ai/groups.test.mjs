import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { State } from '../bridge/state.mjs';
import { Bridge } from '../bridge/core.mjs';
import { AiClient } from '../bridge/client.mjs';
import { testConfig } from './fixture.mjs';
import { ChatService } from '../ai/chat.mjs';
import { startServer, validRequest } from '../ai/server.mjs';

test('group mentions use UDS, context uses temporary participant labels', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ng-full-')), socket = join(dir, 'ai.sock');
  const config = testConfig(), calls = [], sent = [];
  const service = new ChatService({
    config,
    provider: { chat: async args => {
      calls.push(args);
      const question = args.messages.at(-1).content.startsWith('{') ? JSON.parse(args.messages.at(-1).content).question : '';
      if (args.messages[0].content.includes('模型没有收到画面、声音或缩略图')) {
        return '寄一张截图来吧，小巫师。🦉';
      }
      if (question === '说得也是。') return '{"action":"silent"}';
      if (question === '那我们几点出发？') return '{"action":"reply","text":"会议十点开始，可以按路程留出时间。"}';
      return '十点开会。';
    } },
  });
  const server = await startServer({ service, socketPath: socket });
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const state = new State(join(dir, 'bridge'));
  const bridge = new Bridge({ state, groupsEnabled: true, client: new AiClient(socket),
    send: async (peer, text, mentions) => sent.push({ peer, text, mentions }) });
  bridge.online();
  const group = (text, extra = {}) => ({ kind: 'text', id: crypto.randomUUID(), senderId: 'alice', senderName: 'Alice',
    selfId: 'bot', roomId: 'room@chatroom', mentions: [], timestamp: Math.floor(Date.now() / 1000), text, ...extra });
  await bridge.accept(group('大家上午十点开会。'));
  assert.equal(calls.length, 0);
  await bridge.accept(group('@Bot\u2005', { mentions: ['bot'] }));
  assert.equal(calls.length, 1); assert.equal(service.contexts.size, 0);
  const supplied = JSON.parse(calls[0].messages.at(-1).content);
  assert.equal(supplied.recentMessages[0].text, '大家上午十点开会。'); assert.equal(supplied.requester, '成员1');
  assert.deepEqual(Object.keys(supplied.recentMessages[0]).sort(), ['sender', 'text']);
  assert.equal(supplied.question, '');
  assert(calls[0].messages.some(m => m.role === 'system' && m.content.includes('不可信参考数据')));
  assert.equal(sent.at(-1).peer, 'room@chatroom'); assert.deepEqual(sent.at(-1).mentions, ['alice']);
  assert.equal(await bridge.accept(group('说得也是。', { senderId: 'bob' })), 'discarded');
  assert.equal(sent.length, 1);
  assert.equal(await bridge.accept(group('@Alice\u2005那我们几点出发？', { senderId: 'bob', mentions: ['alice'] })), 'sent');
  assert.deepEqual(sent.at(-1).mentions, ['bob']);
  await bridge.accept(group('PRIVATE_ONLY', { roomId: undefined, senderId: 'parent-id' }));
  assert.equal(service.contexts.size, 1);
  const before = calls.length;
  await bridge.accept(group('!ai model deepseek-flash', { senderId: 'parent-id', mentions: ['bot'] }));
  assert.equal(calls.length, before); assert.equal(config.model, 'deepseek-flash');
  await bridge.accept(group('new question', { mentions: ['bot'] }));
  const newContext = JSON.parse(calls.at(-1).messages.at(-1).content);
  assert(!JSON.stringify(newContext).includes('PRIVATE_ONLY'));
  const quotedText = '原题是 8 + 7';
  assert.equal(await bridge.accept(group('@Bot\u2005怎么解？', { mentions: ['bot'], quotedText })), 'sent');
  const quoted = JSON.parse(calls.at(-1).messages.at(-1).content);
  assert.equal(quoted.question, '怎么解？');
  assert.equal(quoted.quotedText, quotedText);
  assert(!JSON.stringify(quoted).includes('alice'));
  await bridge.accept(group('再解释一下', { roomId: undefined, quotedText: '!help' }));
  assert.deepEqual(JSON.parse(calls.at(-1).messages.at(-1).content), { question: '再解释一下', quotedText: '!help' });
  const beforeVideo = calls.length;
  assert.equal(await bridge.accept(group('fixture-video-metadata', { kind: 'video' })), 'buffered');
  assert.equal(calls.length, beforeVideo);
  assert.equal(await bridge.accept(group('@Bot\u2005谁在跳舞？', { mentions: ['bot'] })), 'sent');
  assert.match(sent.at(-1).text, /寄一张截图/);
  assert(calls.at(-1).messages[0].content.startsWith(config.prompt));
  assert(!JSON.stringify(calls.at(-1)).includes('fixture-video-metadata'));
  assert.equal(await bridge.accept(group('fixture-video-metadata', { kind: 'video', roomId: undefined })), 'sent');
  assert.match(sent.at(-1).text, /寄一张截图/);
  await bridge.offline();
});
test('group protocol rejects admin privilege claims, missing real mention and excessive context', () => {
  const base = { version: 1, requestId: 'test', deadlineAt: Date.now() + 3000,
    conversation: { kind: 'group', id: 'room@chatroom' }, actor: { id: 'alice', isAdmin: false },
    message: { id: 'one', text: 'hi', timestamp: Date.now() / 1000, mentions: ['bot'] },
    context: { botId: 'bot', messages: [] } };
  assert(validRequest(base));
  assert(validRequest({ ...base, message: { ...base.message, videoUnavailable: true } }));
  assert(!validRequest({ ...base, message: { ...base.message, videoUnavailable: 'true' } }));
  assert(!validRequest({ ...base, message: { ...base.message, quotedText: 'x'.repeat(2001) } }));
  assert(!validRequest({ ...base, actor: { id: 'alice', isAdmin: true } }));
  assert(!validRequest({ ...base, message: { ...base.message, mentions: ['bot_suffix'] } }));
  const followup = { ...base, context: { ...base.context, trigger: 'followup' } };
  assert(!validRequest(followup));
  assert(validRequest({ ...followup, message: { ...base.message, mentions: ['other'] } }));
  assert(!validRequest({ ...base, context: { ...base.context, messages: Array(31).fill({}) } }));
});
