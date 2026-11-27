import test from 'node:test';
import assert from 'node:assert/strict';
import { startMomentsAutoLike } from '../bridge/moments-auto-like.mjs';

const HALF_DAY = 12 * 3600_000;
const START = 1_800_000_000_000;
const post = (id, changes = {}) => ({ id, createdAt: START / 1000 + 1, liked: false, isSelf: false, ...changes });

function fixture() {
  let now = START;
  let timer;
  let saved = null;
  const events = [];
  const state = {
    read: () => structuredClone(saved),
    write: (_file, value) => { saved = structuredClone(value); },
  };
  const defaults = { state, accountId: 'fixture', available: () => true, log: event => events.push(event),
    now: () => now, schedule: (run, delay) => { timer = { run, delay }; return timer; },
    cancel: () => { timer = undefined; } };
  return { state, events, start: options => startMomentsAutoLike({ ...defaults, ...options }),
    get delay() { return timer?.delay; },
    async fire() { const next = timer; now += next.delay; await next.run(); },
  };
}

test('baselines once, then reads one page per half day and claims only new unliked friend posts', async () => {
  const f = fixture();
  const sent = [];
  let reads = 0;
  const big = '18446744073709551615';
  const options = {
    homepage: async () => ++reads === 1 ? [post('1')] : [post('1'), post(big), post('2', { liked: true }),
      post('3', { isSelf: true }), post('4', { liked: null }), post('5', { createdAt: START / 1000 - 1 })],
    like: async id => { assert.ok(f.state.read().finished.includes(id)); sent.push(id); return { status: 'accepted' }; },
  };
  const stop = f.start(options);
  assert.equal(f.delay, 0);
  await f.fire();
  assert.deepEqual(sent, []);
  assert.equal(f.delay, HALF_DAY);
  await f.fire();
  assert.equal(reads, 2);
  assert.deepEqual(sent, [big]);
  assert.deepEqual(f.state.read().finished, ['1', big, '2', '3']);
  assert.deepEqual(f.events.at(-1), { event: 'moments_auto_like_round', count: 6, accepted: 1, skipped: 2, rejected: 0, uncertain: 0 });
  await stop();
  f.start(options);
  assert.equal(f.delay, HALF_DAY);
  await f.fire();
  assert.equal(reads, 3);
  assert.deepEqual(sent, [big]);
});

test('an uncertain submit keeps its claim after restart, and an account change stays inactive', async () => {
  const f = fixture();
  const sent = [];
  let reads = 0;
  const options = {
    homepage: async () => ++reads === 1 ? [] : [post('1')],
    like: async id => { sent.push(id); throw new Error('fixture transport failure'); },
  };
  let stop = f.start(options);
  await f.fire();
  await f.fire();
  assert.equal(f.events.at(-1).uncertain, 1);
  await stop();
  assert.equal(f.start({ ...options, accountId: 'another-fixture' }), undefined);
  assert.equal(f.events.at(-1).event, 'moments_auto_like_account_mismatch');
  assert.equal(f.delay, undefined);
  stop = f.start(options);
  await f.fire();
  assert.deepEqual(sent, ['1']);
  await stop();
});

test('a failed state write blocks submission and a stopped session ignores its in-flight homepage', async () => {
  const f = fixture();
  let finish;
  let reads = 0;
  let sends = 0;
  const options = { homepage: async () => ++reads === 1 ? [] : [post('1')], like: async () => { sends += 1; } };
  let stop = f.start(options);
  await f.fire();
  const write = f.state.write;
  f.state.write = (key, cursor) => { if (cursor.finished.length) throw new Error('fixture disk error'); write(key, cursor); };
  await f.fire();
  assert.equal(f.events.at(-1).event, 'moments_auto_like_round_failed');
  assert.equal(sends, 0);
  await stop();

  f.state.write = write;
  stop = f.start({ ...options, homepage: () => new Promise(resolve => { finish = resolve; }) });
  const running = f.fire();
  const stopped = stop();
  finish([post('1')]);
  await Promise.all([running, stopped]);
  assert.equal(sends, 0);
  assert.equal(f.delay, undefined);
});
