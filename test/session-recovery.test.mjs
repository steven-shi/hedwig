import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionRecovery } from '../bridge/session-recovery.mjs';

const unavailable = () => new Error('NEO_READ:read_unavailable');

test('retries the same read after an outage without another login', async () => {
  const reports = [], waits = [];
  const recovery = sessionRecovery(event => reports.push(event), async ms => {
    assert.equal(recovery.reconnecting, true);
    waits.push(ms);
  });
  let reads = 0;
  const page = { messages: [{ id: 'fixture' }], continuation: false };
  const result = await recovery.read('sync', async () => {
    if (++reads < 7) throw unavailable();
    return page;
  });
  assert.equal(result, page);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 15000, 30000]);
  assert.equal(recovery.reconnecting, false);
  assert.deepEqual(reports.at(-1), { event: 'wechat_reconnected', stage: 'sync', retries: 6 });
});

test('caps automatic retries and records the reason when the retry budget is exhausted', async () => {
  const reports = [], waits = [];
  const recovery = sessionRecovery(event => reports.push(event), async ms => { waits.push(ms); });
  await assert.rejects(recovery.read('heartbeat', async () => { throw unavailable(); }), /NEO_READ:read_unavailable/);
  assert.equal(waits.length, 9);
  assert.equal(waits.reduce((total, ms) => total + ms, 0), 150000);
  assert.equal(Math.max(...waits), 30000);
  assert.deepEqual(reports.at(-1), {
    event: 'wechat_read_failed', stage: 'heartbeat', retries: 9, category: 'read_unavailable',
  });
});

test('ends recovery on a typed rejection and logs only approved diagnostic fields', async () => {
  const reports = [];
  const recovery = sessionRecovery(event => reports.push(event), async () => {
    assert.fail('a terminal error must not trigger retries');
  });
  await assert.rejects(
    recovery.read('poll', async () => { throw new Error('NEO_READ:auth_required:-100'); }),
    { message: 'NEO_READ:auth_required:-100' },
  );
  await assert.rejects(
    recovery.read('sync', async () => { throw new Error('NEO_READ:service_rejected:-1'); }),
    { message: 'NEO_READ:service_rejected:-1' },
  );
  await assert.rejects(
    recovery.read('heartbeat', async () => { throw new Error('NEO_READ:read_unavailable:fixture private text'); }),
    /fixture private text/,
  );
  assert.deepEqual(reports, [
    { event: 'wechat_read_failed', stage: 'poll', retries: 0, category: 'auth_required', serviceCode: -100 },
    { event: 'wechat_read_failed', stage: 'sync', retries: 0, category: 'service_rejected', serviceCode: -1 },
    { event: 'wechat_read_failed', stage: 'heartbeat', retries: 0, category: 'unclassified' },
  ]);
});

test('stopping the bridge interrupts backoff without another read', async () => {
  let reads = 0;
  const recovery = sessionRecovery(event => {
    if (event.event === 'wechat_reconnecting') recovery.abort();
  });
  await assert.rejects(recovery.read('poll', async () => {
    reads++;
    throw unavailable();
  }), { name: 'AbortError' });
  assert.equal(reads, 1);
});
