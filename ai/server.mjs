import http from 'node:http';
import net from 'node:net';
import { lstatSync, unlinkSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { ChatProvider } from './provider.mjs';
import { ChatService } from './chat.mjs';
import { MAX_IMAGE_BASE64, validImage } from '../bridge/images.mjs';

async function prepare(path) {
  let stat;
  try { stat = lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return; throw new Error('AI socket is not accessible'); }
  if (!stat.isSocket()) throw new Error('AI socket path is not a socket');
  const active = await new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', e => ['ENOENT', 'ECONNREFUSED'].includes(e.code) ? resolve(false) : reject(new Error('Cannot probe AI socket')));
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('AI socket probe timed out')); });
  });
  if (active) throw new Error('AI socket already has a listener');
  try { unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
export function validRequest(b) {
  const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
  if (!b || b.version !== 1 || !id(b.requestId) || !Number.isFinite(b.deadlineAt) ||
      b.deadlineAt >= Date.now() + 300000 || !id(b.conversation?.id) ||
      !id(b.actor?.id) ||
      !id(b.message?.id) || !Number.isFinite(b.message.timestamp) ||
      typeof b.message.text !== 'string' || !b.message.text.trim() || b.message.text.length > 16000 ||
      (b.message.image !== undefined && !validImage(b.message.image))) return false;
  if (b.conversation.kind === 'private') return b.actor.id === b.conversation.id && !b.conversation.id.endsWith('@chatroom');
  if (b.conversation.kind !== 'group' || !b.conversation.id.endsWith('@chatroom') || b.actor.isAdmin === true ||
      !id(b.context?.botId) || !Array.isArray(b.message.mentions) ||
      b.message.mentions.length > 256 || !b.message.mentions.every(id) ||
      !Array.isArray(b.context.messages) || b.context.messages.length > 30 || JSON.stringify(b.context.messages).length > 12000) return false;
  if (!b.context.messages.every(m => m && id(m.id) && id(m.senderId) &&
    typeof m.senderName === 'string' && m.senderName.length <= 128 &&
    typeof m.text === 'string' && m.text.length <= 2000 && Number.isFinite(m.timestamp))) return false;
  const trigger = b.context.trigger ?? 'mention';
  if (trigger === 'followup') {
    return !b.message.mentions.includes(b.context.botId);
  }
  return (trigger === 'mention' || trigger === 'invite') && b.message.mentions.includes(b.context.botId);
}
export async function startServer({ service, socketPath }) {
  await prepare(socketPath);
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, groupsEnabled: service.config.groupsEnabled })); return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/respond') { res.writeHead(404).end(); return; }
    let size = 0; const parts = [], controller = new AbortController();
    req.on('aborted', () => controller.abort());
    req.on('error', () => controller.abort());
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 131072 + MAX_IMAGE_BASE64) { res.writeHead(413).end(); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on('end', async () => {
      if (res.destroyed || controller.signal.aborted) return;
      let body;
      try { body = JSON.parse(Buffer.concat(parts)); } catch { res.writeHead(400).end(); return; }
      if (!validRequest(body)) { res.writeHead(400).end(); return; }
      if (body.message.image === undefined && size > 131072) { res.writeHead(413).end(); return; }
      try {
        const result = await service.handle(body, controller.signal);
        if (!res.destroyed && !controller.signal.aborted) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      } catch {
        if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          version: 1, requestId: body.requestId, error: { code: 'AI_INTERNAL', detail: '独立 AI 服务发生内部错误' },
        }));
      }
    });
  });
  server.headersTimeout = 5000; server.requestTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);
  const inode = lstatSync(socketPath).ino;
  return {
    async close() {
      service.reset();
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      try { if (lstatSync(socketPath).ino === inode) unlinkSync(socketPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = data => console.info(JSON.stringify({ time: new Date().toISOString(), ...data }));
  let config;
  try { config = loadConfig(process.env.HEDWIG_CONFIG_FILE ?? '/config/config.json'); }
  catch (error) { console.error(error.message); process.exit(1); }
  const service = new ChatService({ config, provider: new ChatProvider(config.apiKey), log });
  const worker = await startServer({ service, socketPath: process.env.BRIDGE_SOCKET ?? '/run/neo/ai.sock' });
  log({ event: 'ai_ready', groupsEnabled: config.groupsEnabled });
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; void worker.close().catch(() => { process.exitCode = 1; }); } };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
