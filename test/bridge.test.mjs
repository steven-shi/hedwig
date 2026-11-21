import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { State } from '../bridge/state.mjs';
import { Bridge } from '../bridge/core.mjs';
import { BridgeError } from '../bridge/errors.mjs';

function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nb-state-'));
  const state = new State(directory);
  const sent = [], calls = [], logs = [];
  const bridge = new Bridge({
    state, send: async (peer, text) => { sent.push({ peer, text }); },
    client: { request: async request => { calls.push(request); return 'reply:' + request.message.text; } },
    log: event => logs.push(event), ...options,
  });
  bridge.online();
  t.after(async () => { await bridge.offline(); rmSync(directory, { recursive: true, force: true }); });
  return { bridge, state, sent, calls, logs, directory };
}
let sequence = 0;
function msg(senderId = 'peer', text = 'hello', extra = {}) {
  return { kind: 'text', id: 'msg-' + (++sequence), senderId, selfId: 'bot', text, timestamp: Math.floor(Date.now() / 1000), ...extra };
}

test('only new private text is forwarded; self, groups and other media are silent', async t => {
  const { bridge, sent, calls } = setup(t);
  for (const m of [msg('peer', 'image', { kind: 'image' }), msg('peer', 'voice', { kind: 'voice' }),
    msg('bot'), msg('peer', 'group', { roomId: 'group@chatroom' }), msg('peer', 'old', { timestamp: 1 })]) {
    assert.notEqual(await bridge.accept(m), 'sent');
  }
  assert.equal(calls.length, 0); assert.equal(sent.length, 0);
  const current = msg(); assert.equal(await bridge.accept(current), 'sent');
  assert.equal(await bridge.accept(current), 'duplicate');
  assert.equal(calls.length, 1); assert.equal(sent.length, 1);
  assert.deepEqual(calls[0].actor, { id: current.senderId });
});

test('dedup survives a bridge restart and stores IDs as hashes, without message text', async t => {
  const first = setup(t); const m = msg('peer', 'PRIVATE_CONTENT_NOT_FOR_STORAGE');
  await first.bridge.accept(m);
  const restored = new State(first.directory);
  let invoked = false;
  const second = new Bridge({ state: restored, client: { request: async () => { invoked = true; return 'wrong'; } }, send: async () => {} });
  second.online();
  assert.equal(await second.accept(m), 'duplicate'); assert.equal(invoked, false);
  const { readFileSync } = await import('node:fs');
  assert(!readFileSync(join(first.directory, 'seen.json'), 'utf8').includes(m.text));
  assert.equal(statSync(join(first.directory, 'seen.json')).mode & 0o777, 0o600);
  await second.offline();
});

test('identity check reports the verified sender locally with no AI call', async t => {
  const { state, bridge, calls } = setup(t);
  const token = state.beginIdentityCheck();
  await bridge.accept(msg('visitor', '!identify wrong'));
  assert.equal(state.identifiedSender(), null);
  assert.equal(await bridge.accept(msg('parent-id', '!identify ' + token)), 'identity');
  assert.equal(state.identifiedSender(), 'parent-id');
  await bridge.accept(msg('visitor', '!identify ' + token));
  assert.equal(state.identifiedSender(), 'parent-id');
  assert.equal(calls.length, 0);
});

test('a peer is sequential while another peer can receive a reply during its wait', async t => {
  const order = [];
  const { bridge, sent } = setup(t, { client: { request: async request => {
    order.push('start:' + request.message.text);
    if (request.message.text === 'slow') await delay(70);
    order.push('end:' + request.message.text); return request.message.text;
  } } });
  const one = bridge.accept(msg('a', 'slow'));
  const two = bridge.accept(msg('a', 'next'));
  const three = bridge.accept(msg('b', 'fast'));
  await Promise.all([one, two, three]);
  assert(order.indexOf('start:next') > order.indexOf('end:slow'));
  assert(sent.findIndex(s => s.text === 'fast') < sent.findIndex(s => s.text === 'slow'));
  assert.deepEqual(sent.filter(s => s.peer === 'a').map(s => s.text), ['slow', 'next']);
});

test('late AI answers and queued expired requests are discarded without replay', async t => {
  let count = 0;
  const { bridge, sent } = setup(t, { ttlMs: 25, client: { request: async () => { count++; await delay(80); return 'too late'; } } });
  const outcomes = await Promise.all([bridge.accept(msg('a', 'one')), bridge.accept(msg('a', 'two'))]);
  assert.deepEqual(outcomes, ['expired', 'expired']);
  assert.equal(count, 1); assert.equal(sent.length, 0);
});

test('bridge sends a generic AI error without exposing provider diagnostics', async t => {
  const { bridge, sent } = setup(t, { client: { request: async () => {
    throw new BridgeError('AI_UPSTREAM', 'test-secret-diagnostic', { status: 401 });
  } } });
  await bridge.accept(msg('alice', 'private question'));
  assert.deepEqual(sent, [{ peer: 'alice', text: 'AI 暂时不可用，请稍后再试。' }]);
});

test('an uncertain WeChat send is not submitted again or replaced by another reply', async t => {
  let sends = 0;
  const { bridge } = setup(t, { send: async () => { sends++; throw new Error('uncertain'); } });
  assert.equal(await bridge.accept(msg()), 'send_failed'); assert.equal(sends, 1);
});

test('offline clears pending requests and prevents late replies', async t => {
  const { bridge, sent } = setup(t, { client: { request: async () => { await delay(40); return 'late'; } } });
  const one = bridge.accept(msg('a')), two = bridge.accept(msg('a'));
  await bridge.offline();
  assert.deepEqual(await Promise.all([one, two]), ['expired', 'discarded']);
  assert.equal(sent.length, 0);
});

test('corrupt persisted dedup state fails closed', t => {
  const directory = mkdtempSync(join(tmpdir(), 'nb-corrupt-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'seen.json'), '{broken');
  assert.throws(() => new State(directory));
});

test('a completed answer expiring behind a slow WeChat send is never submitted', async t => {
  const delivered = [];
  const { bridge } = setup(t, { ttlMs: 30,
    send: async (peer, text) => { if (peer === 'slow') await delay(90); delivered.push(peer); },
  });
  const first = bridge.accept(msg('slow'));
  const second = bridge.accept(msg('other'));
  assert.deepEqual(await Promise.all([first, second]), ['sent', 'expired']);
  assert.deepEqual(delivered, ['slow']);
});

test('AI can explicitly discard a superseded answer without a user reply or alert', async t => {
  const { bridge, sent } = setup(t, { client: { request: async () => null } });
  assert.equal(await bridge.accept(msg()), 'discarded');
  assert.equal(sent.length, 0);
});
