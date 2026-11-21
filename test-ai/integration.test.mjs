import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testConfig } from './fixture.mjs';
import { ChatProvider } from '../ai/provider.mjs';
import { ChatService } from '../ai/chat.mjs';
import { startServer } from '../ai/server.mjs';
import { AiClient } from '../bridge/client.mjs';
import { Bridge } from '../bridge/core.mjs';
import { State } from '../bridge/state.mjs';

test('private bridge talks over UDS to AI and compatible upstream, including admin/error paths', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'na-full-')), socket = join(directory, 'ai.sock');
  let status = 200; const upstreamCalls = [];
  const upstream = http.createServer((req, res) => {
    const parts = []; req.on('data', p => parts.push(p)); req.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts)); upstreamCalls.push(body);
      if (status !== 200) { res.writeHead(status).end('sk-FAKE_DONT_OUTPUT'); return; }
      res.end(JSON.stringify({ choices: [{ message: { content: '真正的接口格式测试回复' } }] }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const config = testConfig({ endpoint: { baseUrl: 'http://127.0.0.1:' + upstream.address().port } });
  const service = new ChatService({ config, provider: new ChatProvider(config.apiKey) });
  const server = await startServer({ service, socketPath: socket });
  t.after(async () => {
    await server.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(statSync(socket).mode & 0o777, 0o600);
  const state = new State(join(directory, 'bridge-state'));
  const sent = [];
  const bridge = new Bridge({ state, client: new AiClient(socket), send: async (peer, text) => sent.push({ peer, text }), ttlMs: 3000 });
  bridge.online();
  assert.deepEqual(await bridge.client.settings(), { groupsEnabled: true });
  const message = (peer, text) => ({ kind: 'text', id: crypto.randomUUID(), senderId: peer, selfId: 'bot', text, timestamp: Math.floor(Date.now() / 1000) });
  await bridge.accept(message('parent-id', '!ai status'));
  assert.match(sent.at(-1).text, /deepseek/); assert.equal(upstreamCalls.length, 0);
  await bridge.accept(message('alice', 'hello'));
  assert.equal(sent.at(-1).text, '真正的接口格式测试回复'); assert.equal(upstreamCalls.length, 1);
  await bridge.accept(message('parent-id', '!ai model another'));
  assert.match(sent.at(-1).text, /config\.json/);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(config.model, 'deepseek-flash');
  status = 429;
  await bridge.accept(message('alice', 'hidden private question'));
  assert(sent.some(s => s.peer === 'alice' && s.text === 'AI 暂时不可用，请稍后再试。'));
  assert(!JSON.stringify(sent).includes('sk-FAKE'));
  await bridge.offline();
});

test('invalid actor/conversation shapes are rejected before calling AI', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'na-invalid-')), socket = join(directory, 'ai.sock');
  let calls = 0;
  const fake = { handle: async () => { calls++; return {}; }, reset() {} };
  const server = await startServer({ service: fake, socketPath: socket });
  t.after(async () => { await server.close(); rmSync(directory, { recursive: true, force: true }); });
  const body = { version: 1, requestId: 'test', deadlineAt: Date.now() + 3000,
    conversation: { kind: 'private', id: 'alice' }, actor: { id: 'bob', isAdmin: true },
    message: { id: '1', text: 'hello', timestamp: Date.now() / 1000 } };
  const response = await new Promise(resolve => {
    const req = http.request({ socketPath: socket, path: '/v1/respond', method: 'POST' }, res => { res.resume(); resolve(res.statusCode); });
    req.end(JSON.stringify(body));
  });
  assert.equal(response, 400); assert.equal(calls, 0);
});
