import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GroupBuffer } from '../bridge/groups.mjs';
import { Bridge } from '../bridge/core.mjs';
import { State } from '../bridge/state.mjs';
import { BridgeError } from '../bridge/errors.mjs';

function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ng-core-'));
  const state = new State(directory), sent = [], calls = [];
  const bridge = new Bridge({
    state, groupsEnabled: true,
    client: { request: async envelope => { calls.push(envelope); return '群回答'; } },
    send: async (peer, text, mentions) => sent.push({ peer, text, mentions }), ...options,
  });
  bridge.online();
  t.after(async () => { await bridge.offline(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, state, sent, calls };
}
const group = (text, extra = {}) => ({
  kind: 'text', id: crypto.randomUUID(), roomId: 'room@chatroom', senderId: 'alice', senderName: 'Alice',
  selfId: 'bot', text, timestamp: Math.floor(Date.now() / 1000), mentions: [], ...extra,
});
test('ordinary group text is local-only and does not write durable dedup state', async t => {
  const { bridge, state, calls, sent } = setup(t);
  assert.equal(await bridge.accept(group('明天上午十点开会。')), 'buffered');
  assert.equal(await bridge.accept(group('@Bot 手写昵称', { mentions: [] })), 'buffered');
  assert.equal(await bridge.accept(group('@所有人', { mentions: ['notify@all'] })), 'buffered');
  assert.equal(await bridge.accept(group('@Bot hi', { mentions: ['bot_suffix'] })), 'buffered');
  assert.equal(calls.length, 0); assert.equal(sent.length, 0); assert.equal(state.seen.size, 0);
});
test('a true mention sends only this room context and replies with native mention IDs', async t => {
  const { bridge, calls, sent } = setup(t);
  await bridge.accept(group('别的群的秘密', { roomId: 'other@chatroom' }));
  await bridge.accept(group('上午十点开会。', { senderId: 'bob', senderName: 'Bob' }));
  const m = group('@Bot\u2005几点开会？', { mentions: ['bot'] });
  assert.equal(await bridge.accept(m), 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].conversation.kind, 'group'); assert.equal(calls[0].conversation.id, 'room@chatroom');
  assert.equal(calls[0].actor.id, 'alice'); assert.equal(calls[0].actor.isAdmin, undefined);
  assert.equal(calls[0].context.messages.length, 1);
  assert.equal(calls[0].context.messages[0].senderId, 'bob');
  assert(!JSON.stringify(calls[0]).includes('别的群的秘密'));
  assert.deepEqual(sent, [{ peer: 'room@chatroom', text: '@Alice\u2005群回答', mentions: ['alice'] }]);
  assert.equal(await bridge.accept(m), 'duplicate'); assert.equal(calls.length, 1);
});
test('non-text, self and history are ignored; a bare native mention invites a reply', async t => {
  const { bridge, calls, sent } = setup(t);
  await bridge.accept(group('image', { kind: 'image', mentions: ['bot'] }));
  await bridge.accept(group('voice', { kind: 'voice', mentions: ['bot'] }));
  await bridge.accept(group('old', { timestamp: 1, mentions: ['bot'] }));
  await bridge.accept(group('self', { senderId: 'bot', mentions: ['bot'] }));
  assert.equal(calls.length, 0); assert.equal(sent.length, 0);
  await bridge.accept(group('我们在讨论要不要出门。'));
  assert.equal(await bridge.accept(group('@Bot\u2005', { mentions: ['bot'] })), 'sent');
  assert.equal(calls[0].context.trigger, 'invite');
  assert.equal(calls[0].context.messages[0].text, '我们在讨论要不要出门。');
});
test('a group window considers substantive messages throughout and renews only after replies', async t => {
  let now = Date.now();
  const groupBuffer = new GroupBuffer({ now: () => now });
  const { bridge, sent } = setup(t, { groupBuffer, client: { request: async request => {
    if (request.message.text === '说得也是。') return null;
    if (request.message.text.includes('模拟失败')) throw new BridgeError('AI_TIMEOUT', '模拟失败');
    return '群回答';
  } } });
  const post = (text, extra) => bridge.accept(group(text, { timestamp: Math.floor(now / 1000), ...extra }));
  const minutes = n => { now += n * 60000; };
  assert.equal(await post('@Bot\u2005', { mentions: ['bot'] }), 'sent');
  for (const filler of ['😂👍', '……', '哈 哈哈！', '嗯。']) {
    assert.equal(await post(filler, { senderId: 'bob' }), 'buffered');
  }
  assert.equal(await post('模拟失败'), 'failed');
  assert.equal(sent.length, 1);
  assert.equal(await post('你刚说的体感？', { roomId: 'other@chatroom' }), 'buffered');
  minutes(9);
  assert.equal(await post('室外体感怎么算？', { senderId: 'bob' }), 'sent');
  assert.deepEqual(sent.at(-1).mentions, ['bob']);
  minutes(9);
  assert.equal(await post('说得也是。'), 'discarded');
  assert.equal(await post('哈哈'), 'buffered');
  minutes(1);
  assert.equal(await post('Hedwig，继续说一下。'), 'buffered');
  assert.equal(sent.length, 2);
  assert.equal(await post('@Bot\u2005', { mentions: ['bot'] }), 'sent');
});
test('group context uses bounded age/count/bytes and does not leak between rooms', () => {
  let now = Date.now();
  const buffer = new GroupBuffer({ now: () => now, messages: 2, rooms: 2, chars: 1000, ageMs: 1000 });
  const add = (room, text) => buffer.add(room, group(text, { timestamp: now / 1000 }));
  add('one', 'one'); add('one', 'two'); add('one', 'three');
  assert.deepEqual(buffer.snapshot('one').map(m => m.text), ['two', 'three']);
  add('two', 'other'); add('three', 'third'); assert.equal(buffer.rooms.size, 2);
  assert.equal(buffer.snapshot('one').length, 0);
  now += 2000; assert.equal(buffer.snapshot('two').length, 0);
  add('huge', 'x'.repeat(5000)); assert(JSON.stringify(buffer.snapshot('huge')).length <= 1000);
});
test('standalone shush closes only its room and cancels active and queued requests', async t => {
  let activeSignal, finishActive;
  const { bridge, sent, calls } = setup(t, { client: { request: async (request, signal) => {
    calls.push(request.message.text);
    if (request.message.text === '还在生成的回复') {
      activeSignal = signal;
      // Simulate a late result even after the request is cancelled.
      return new Promise(resolve => { finishActive = resolve; });
    }
    return '群回答';
  } } });
  const other = { roomId: 'other@chatroom' };
  await bridge.accept(group('@Bot', { mentions: ['bot'], ...other }));
  await bridge.accept(group('@Bot', { mentions: ['bot'] }));
  const active = bridge.accept(group('还在生成的回复'));
  const queued = bridge.accept(group('还在排队的回复'));
  const stop = group(' 🤫\uFE0F ', { senderId: 'bob' });
  assert.equal(await bridge.accept(stop), 'silenced');
  assert.equal(activeSignal.aborted, true);
  assert.equal(await queued, 'discarded');
  finishActive('晚到的回复');
  assert.equal(await active, 'expired');
  assert.equal(sent.length, 2);
  assert.deepEqual(calls, ['@Bot', '@Bot', '还在生成的回复']);
  assert.equal(await bridge.accept(group('群里继续讨论')), 'buffered');
  assert.equal(await bridge.accept(group('另一个群继续讨论', other)), 'sent');
  assert.equal(await bridge.accept(group('@Bot', { mentions: ['bot'] })), 'sent');
  assert.equal(await bridge.accept(stop), 'duplicate');
  assert.equal(await bridge.accept(group('表演结束前请保持安静 🤫')), 'sent');
  assert(bridge.groupBuffer.snapshot('room@chatroom').every(entry => entry.text !== stop.text));
});
test('shush suppresses a completed response still waiting for the WeChat send queue', async t => {
  let releaseSend, markSending, markAnswered;
  const sending = new Promise(resolve => { markSending = resolve; });
  const answered = new Promise(resolve => { markAnswered = resolve; });
  const { bridge, sent } = setup(t, {
    client: { request: async request => {
      if (request.conversation.kind === 'group') markAnswered();
      return '回答';
    } },
    send: async peer => {
      sent.push(peer);
      if (peer === 'alice') {
        markSending();
        await new Promise(resolve => { releaseSend = resolve; });
      }
    },
  });
  const privateReply = bridge.accept(group('占用发送队列', { roomId: undefined }));
  await sending;
  const privateOutbound = bridge.outbound;
  const groupReply = bridge.accept(group('@Bot', { mentions: ['bot'] }));
  await answered;
  await new Promise(resolve => setImmediate(resolve));
  assert.notEqual(bridge.outbound, privateOutbound);
  assert.equal(await bridge.accept(group('🤫')), 'silenced');
  releaseSend();
  await privateReply;
  assert.equal(await groupReply, 'expired');
  assert.deepEqual(sent, ['alice']);
});
test('group failure mentions the asker with a generic message', async t => {
  const { bridge, sent } = setup(t, { client: { request: async () => {
    throw new BridgeError('AI_UPSTREAM', 'test-secret-diagnostic', { status: 503 });
  } } });
  await bridge.accept(group('群里的问题', { mentions: ['bot'] }));
  assert.deepEqual(sent, [{ peer: 'room@chatroom', text: '@Alice\u2005AI 暂时不可用，请稍后再试。', mentions: ['alice'] }]);
});
test('a global reset discards queued/in-flight group answers and clears raw group history', async t => {
  let release;
  const { bridge, sent } = setup(t, { client: { request: async () => new Promise(resolve => { release = resolve; }) } });
  await bridge.accept(group('old room context'));
  const one = bridge.accept(group('first question', { mentions: ['bot'] }));
  const two = bridge.accept(group('second question', { mentions: ['bot'] }));
  bridge.resetGroups(); release('obsolete');
  assert.deepEqual(await Promise.all([one, two]), ['expired', 'expired']);
  assert.equal(sent.length, 0); assert.equal(bridge.groupBuffer.snapshot('room@chatroom').length, 0);
});
test('bot replies enter local context once without causing another model call', async t => {
  const { bridge, calls } = setup(t);
  await bridge.accept(group('question one', { mentions: ['bot'] }));
  await bridge.accept(group('echo', { senderId: 'bot', mentions: ['bot'] }));
  await bridge.accept(group('question two', { mentions: ['bot'] }));
  const botReplies = calls[1].context.messages.filter(m => m.senderId === 'bot');
  assert.equal(botReplies.length, 1); assert.equal(calls.length, 2);
});
