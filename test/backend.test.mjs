import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiClient } from '../bridge/client.mjs';
import { Bridge } from '../bridge/core.mjs';
import { State } from '../bridge/state.mjs';

const workerFile = fileURLToPath(new URL('../bridge/mock-worker.mjs', import.meta.url));
async function worker(socket, mode = 'echo') {
  const child = spawn(process.execPath, [workerFile], {
    env: { ...process.env, BRIDGE_SOCKET: socket, MOCK_MODE: mode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Worker startup timeout')); }, 5000);
    let output = '';
    child.stdout.on('data', data => { output += data; if (output.includes('mock_ready')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Worker exited during startup')); });
    child.once('error', reject);
  });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
}
function envelope(text = 'ding') {
  return { version: 1, requestId: crypto.randomUUID(), deadlineAt: Date.now() + 1000,
    conversation: { kind: 'private', id: 'peer' }, actor: { id: 'peer', isAdmin: false },
    message: { id: crypto.randomUUID(), text, timestamp: Math.floor(Date.now() / 1000) } };
}

test('an independent worker can crash and restart on the same Unix socket while bridge stays online', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nb-ipc-')), socket = join(directory, 'ai.sock');
  let child;
  t.after(async () => { await stop(child); rmSync(directory, { recursive: true, force: true }); });
  child = await worker(socket);
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  const sent = [];
  const bridge = new Bridge({
    state: new State(join(directory, 'state')), client: new AiClient(socket),
    send: async (peer, text) => sent.push(text), ttlMs: 150,
  });
  bridge.online(); const since = bridge.liveSince;
  const message = () => ({ kind: 'text', id: crypto.randomUUID(), senderId: 'peer', selfId: 'bot', text: 'ding', timestamp: Math.floor(Date.now() / 1000) });
  assert.equal(await bridge.accept(message()), 'sent'); assert.equal(sent.at(-1), 'dong');
  await stop(child);
  assert.equal(await bridge.accept(message()), 'failed');
  assert.equal(sent.at(-1), 'AI 暂时不可用，请稍后再试。');
  // SIGKILL leaves a stale UDS; restarting safely cleans it without touching bridge.
  child = await worker(socket, 'hang');
  assert.equal(await bridge.accept(message()), 'failed');
  await stop(child); child = await worker(socket);
  const count = sent.length;
  assert.equal(await bridge.accept(message()), 'sent'); assert.equal(sent.at(-1), 'dong');
  assert.equal(sent.length, count + 1); assert.equal(bridge.liveSince, since);
  await bridge.offline();
});

test('mismatched replies, raw error pages and oversized bodies are rejected', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nb-proto-')), socket = join(directory, 'ai.sock');
  let mode = 'mismatch';
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (mode === 'mismatch') res.end(JSON.stringify({ version: 1, requestId: 'wrong', text: 'oops' }));
      if (mode === 'html') { res.writeHead(502); res.end('sensitive raw backend page'); }
      if (mode === 'null') res.end('null');
      if (mode === 'big') res.end('x'.repeat(70000));
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); rmSync(directory, { recursive: true, force: true }); });
  const client = new AiClient(socket);
  for (mode of ['mismatch', 'html', 'null', 'big']) {
    await assert.rejects(client.request(envelope()), error => ['AI_PROTOCOL', 'AI_HTTP'].includes(error.code) && !error.message.includes('sensitive'));
  }
});

test('an active AI socket cannot be replaced by a second worker', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'nb-owner-')), socket = join(directory, 'ai.sock');
  const child = await worker(socket);
  t.after(async () => { await stop(child); rmSync(directory, { recursive: true, force: true }); });
  const other = spawn(process.execPath, [workerFile], { env: { ...process.env, BRIDGE_SOCKET: socket }, stdio: 'ignore' });
  const [code] = await once(other, 'exit'); assert.notEqual(code, 0);
  assert.equal(await new AiClient(socket).request(envelope()), 'dong');
});
