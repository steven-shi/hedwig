import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ChatProvider } from '../ai/provider.mjs';

async function fixture(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
  return 'http://127.0.0.1:' + server.address().port;
}
test('compatible API sends correct path, key and messages; ignores reasoning output', async t => {
  let body, auth, path;
  const base = await fixture(t, (req, res) => {
    path = req.url; auth = req.headers.authorization; const parts = [];
    req.on('data', p => parts.push(p)); req.on('end', () => {
      body = JSON.parse(Buffer.concat(parts));
      res.end(JSON.stringify({ choices: [{ message: { content: '你好', reasoning_content: 'PRIVATE_REASONING' } }] }));
    });
  });
  const provider = new ChatProvider('dummy-secret-for-test');
  const text = await provider.chat({ endpoint: { baseUrl: base + '/v1/', keyRef: 'test', thinkingDisabled: true },
    model: 'model-a', messages: [{ role: 'user', content: 'hi' }], maxTokens: 1000 });
  assert.equal(path, '/v1/chat/completions'); assert.equal(auth, 'Bearer dummy-secret-for-test');
  assert.equal(body.model, 'model-a'); assert.equal(body.thinking.type, 'disabled'); assert.equal(body.stream, false);
  assert.equal(text, '你好'); assert(!text.includes('PRIVATE_REASONING'));
});
test('HTTP errors provide specific status without echoing upstream body, keys or prompts', async t => {
  const base = await fixture(t, (req, res) => { req.resume(); res.writeHead(401); res.end('api_key=sk-DUMMY request=PRIVATE_PROMPT'); });
  const provider = new ChatProvider('dummy-key');
  await assert.rejects(provider.chat({ endpoint: { baseUrl: base, keyRef: 'x' }, model: 'm', messages: [], maxTokens: 10 }), e => {
    assert.equal(e.meta.status, 401); assert.match(e.message, /密钥无效/);
    assert(!e.message.includes('sk-DUMMY')); assert(!e.message.includes('PRIVATE_PROMPT')); return true;
  });
});
test('redirects are not followed with authorization headers', async t => {
  let leaked = false;
  const base = await fixture(t, (req, res) => {
    req.resume();
    if (req.url === '/capture') { leaked = true; res.end('{}'); }
    else { res.writeHead(302, { location: '/capture' }); res.end(); }
  });
  await assert.rejects(new ChatProvider('dummy').chat({ endpoint: { baseUrl: base, keyRef: 'x' }, model: 'm', messages: [], maxTokens: 10 }), e => e.code === 'AI_NETWORK');
  assert.equal(leaked, false);
});
test('missing text is rejected; long text is truncated within WeChat bridge limits', async t => {
  let mode = 'empty';
  const base = await fixture(t, (req, res) => { req.resume(); res.end(JSON.stringify({ choices: [{ message: mode === 'empty' ? { reasoning_content: 'hidden' } : { content: '你好'.repeat(3000) } }] })); });
  const provider = new ChatProvider('dummy'), args = { endpoint: { baseUrl: base, keyRef: 'x' }, model: 'm', messages: [], maxTokens: 1000 };
  await assert.rejects(provider.chat(args), e => e.code === 'AI_EMPTY_REPLY');
  mode = 'long'; const text = await provider.chat(args); assert(text.length <= 4000); assert.match(text, /已截短/);
});
