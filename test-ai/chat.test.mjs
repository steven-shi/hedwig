import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../ai/config.mjs';
import { ChatService } from '../ai/chat.mjs';
import { testConfig } from './fixture.mjs';

function request(peer = 'alice', text = 'hello', claimsAdmin = false) {
  return { version: 1, requestId: crypto.randomUUID(), deadlineAt: Date.now() + 30000,
    conversation: { kind: 'private', id: peer }, actor: { id: peer, isAdmin: claimsAdmin },
    message: { id: crypto.randomUUID(), text, timestamp: Math.floor(Date.now() / 1000) } };
}
function setup(options = {}) {
  const config = testConfig(), calls = [];
  const provider = { chat: async args => { calls.push(args); return 'answer-' + calls.length; } };
  const service = new ChatService({ config, provider, ...options });
  return { config, calls, service };
}

test('startup reads one config and defaults groups to off; validation omits secrets', t => {
  const dir = mkdtempSync(join(tmpdir(), 'hedwig-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts', 'role.txt'), 'example role');
  const file = join(dir, 'config.json');
  const source = { endpoint: 'https://example.test/v1/', apiKey: 'sample-only-key', model: 'test-model', promptFile: 'prompts/role.txt' };
  writeFileSync(file, JSON.stringify(source));
  const c = loadConfig(file, dir);
  assert.equal(c.endpoint.baseUrl, 'https://example.test/v1');
  assert.equal(c.apiKey, source.apiKey);
  assert.equal(c.groupsEnabled, false);
  assert.equal(c.adminWechatId, '');
  assert.match(c.prompt, /example role/);
  for (const invalid of [{ endpoint: 'http://example.test' }, { endpoint: 'https://example.test/?token=example' },
    { promptFile: 'other.txt' }, { apiKey: 'replace-with-your-api-key' }, { groupsEnabled: 'yes' }]) {
    writeFileSync(file, JSON.stringify({ ...source, ...invalid }));
    assert.throws(() => loadConfig(file, dir), error => !error.message.includes(source.apiKey));
  }
});

test('private conversations are isolated and share the system prompt', async () => {
  const { service, calls, config } = setup();
  await service.handle(request('alice', 'A1')); await service.handle(request('bob', 'B1')); await service.handle(request('alice', 'A2'));
  assert.deepEqual(calls[1].messages.map(m => m.content), [config.prompt, 'B1']);
  assert.deepEqual(calls[2].messages.map(m => m.content), [config.prompt, 'A1', 'answer-1', 'A2']);
});
test('status and help require the configured sender even if another actor claims privilege', async () => {
  const { service, config, calls } = setup();
  assert.match((await service.handle(request('parent-id', '!status'))).text, /deepseek-flash/);
  assert.match((await service.handle(request('parent-id', '!help'))).text, /!status/);
  assert.match((await service.handle(request('someone-else', '!status', true))).text, /仅配置文件/);
  for (const text of ['!ai model another', '!prompt changed', '!endpoint add example https://example.test', '!clear']) {
    const reply = await service.handle(request('parent-id', text));
    assert.match(reply.text, /config\.json/);
    assert(!reply.text.includes(config.apiKey));
  }
  const group = request('parent-id', '!status');
  group.conversation = { kind: 'group', id: 'room@chatroom' };
  assert.equal((await service.handle(group)).discard, true);
  assert.equal(calls.length, 0);
  assert.equal(config.model, 'deepseek-flash');
});
test('AI discards group requests while disabled and blocks a late answer when closing', async () => {
  let release;
  const config = testConfig({ groupsEnabled: false });
  const { service } = setup({ config, provider: { chat: () => new Promise(resolve => { release = resolve; }) } });
  const group = request();
  group.conversation = { kind: 'group', id: 'room@chatroom' };
  assert.equal((await service.handle(group)).discard, true);
  assert.equal(release, undefined);
  const pending = service.handle(request());
  service.reset(); release('late result');
  assert.equal((await pending).discard, true);
});
test('context memory is bounded by turns, users and idle expiry', async () => {
  let now = Date.now();
  const { service, config } = setup({ now: () => now });
  Object.assign(config.limits, { users: 2, turns: 2, idleMs: 1000 });
  await service.handle(request('alice', 'one')); await service.handle(request('alice', 'two')); await service.handle(request('alice', 'three'));
  assert.deepEqual(service.context('alice').map(t => t.user), ['two', 'three']);
  await service.handle(request('bob')); await service.handle(request('carol')); assert.equal(service.contexts.size, 2);
  assert(!service.contexts.has('alice'));
  now += 2000; service.prune(); assert.equal(service.contexts.size, 0);
});
test('expired requests and model timeouts avoid leaking diagnostics', async () => {
  const { service, calls } = setup();
  const old = request(); old.deadlineAt = Date.now() - 1;
  assert.equal((await service.handle(old)).discard, true); assert.equal(calls.length, 0);
  service.timeoutMs = 15;
  service.provider = { chat: ({ signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('test-secret-diagnostic')), { once: true });
  }) };
  const result = await service.handle(request());
  assert.equal(result.error.code, 'AI_TIMEOUT');
  assert.equal(result.error.model, 'deepseek-flash');
  assert(!JSON.stringify(result).includes('test-secret-diagnostic'));
});
