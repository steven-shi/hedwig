import http from 'node:http';
import net from 'node:net';
import { lstatSync, unlinkSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

async function prepareSocket(path) {
  let stat;
  try { stat = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (!stat.isSocket()) throw new Error('Refusing to replace a non-socket path');
  const active = await new Promise((resolve, reject) => {
    const probe = net.createConnection(path);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', e => e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? resolve(false) : reject(e));
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('Socket probe timed out')); });
  });
  if (active) throw new Error('AI socket already has an active listener');
  try { unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
export async function startMock({ socketPath, mode = 'echo' }) {
  if (!['echo', 'error', 'hang'].includes(mode)) throw new Error('Unknown mock mode');
  await prepareSocket(socketPath);
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/respond') { res.writeHead(404).end(); return; }
    const parts = []; let length = 0;
    req.on('data', part => {
      length += part.length;
      if (length > 131072) { res.writeHead(413).end(); req.destroy(); return; }
      parts.push(part);
    });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(Buffer.concat(parts)); } catch { res.writeHead(400).end(); return; }
      if (body.version !== 1 || typeof body.requestId !== 'string' ||
          !Number.isFinite(body.deadlineAt) || body.deadlineAt <= Date.now() ||
          typeof body.message?.text !== 'string' || body.conversation?.kind !== 'private') {
        res.writeHead(400).end(); return;
      }
      if (mode === 'hang') return;
      const reply = mode === 'error'
        ? { version: 1, requestId: body.requestId, error: { code: 'AI_UPSTREAM', detail: '模拟上游限流', provider: 'mock', model: 'echo', status: 429 } }
        : { version: 1, requestId: body.requestId, text: body.message.text === 'ding' ? 'dong' : '[模拟 AI] ' + body.message.text };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  const inode = lstatSync(socketPath).ino;
  return {
    server,
    async close() {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      try { if (lstatSync(socketPath).ino === inode) unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const worker = await startMock({ socketPath: process.env.BRIDGE_SOCKET ?? '/run/neo/ai.sock', mode: process.env.MOCK_MODE ?? 'echo' });
  console.info(JSON.stringify({ event: 'mock_ready', mode: process.env.MOCK_MODE ?? 'echo' }));
  process.once('SIGTERM', () => { void worker.close(); });
  process.once('SIGINT', () => { void worker.close(); });
}
