import { writeFileSync, unlinkSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import PuppetNeo from 'wechaty-puppet-neo';
import { types } from 'wechaty-puppet';
import { Bridge } from './core.mjs';
import { State } from './state.mjs';
import { AiClient } from './client.mjs';

const socketPath = process.env.BRIDGE_SOCKET ?? '/run/neo/ai.sock';
const directory = process.env.BRIDGE_STATE_DIR ?? '/state';
const qrFile = process.env.BRIDGE_QR_FILE ?? '/run/neo/login.png';
const statusFile = qrFile + '.status';
if (!isAbsolute(socketPath) || !isAbsolute(directory) || (qrFile && !isAbsolute(qrFile))) throw new Error('Bridge paths must be absolute');
const integer = (name, fallback, min, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid setting: ' + name);
  return value;
};
const log = data => console.info(JSON.stringify({ time: new Date().toISOString(), ...data }));
const clearQr = () => { if (qrFile) try { unlinkSync(qrFile); } catch (e) { if (e.code !== 'ENOENT') log({ event: 'qr_cleanup_failed' }); } };
const writeStatus = status => writeFileSync(statusFile, status, { mode: 0o600 });
clearQr();
writeStatus('starting');
class PuppetBridge extends PuppetNeo {
  createSession() {
    const session = super.createSession();
    const sync = session.sync;
    session.sync = async scene => {
      const result = await sync(scene);
      if (result.groupDropped) log({ event: 'group_messages_unresolved', count: result.groupDropped });
      return result;
    };
    if (qrFile) {
      const start = session.startLogin;
      session.startLogin = async () => {
        const result = await start();
        writeFileSync(qrFile, Buffer.from(result.png, 'base64'), { mode: 0o600 });
        return result;
      };
    }
    return session;
  }
}
const client = new AiClient(socketPath);
const { groupsEnabled } = await client.settings();
if (groupsEnabled && PuppetNeo.GROUP_TEXT !== true) throw new Error('Group mode requires the group-capable Neo build');
const puppet = new PuppetBridge();
const bridge = new Bridge({
  state: new State(directory), client,
  send: (peer, text, mentions) => puppet.messageSendText(peer, text, mentions), log, groupsEnabled,
  loadImage: typeof puppet.downloadImage === 'function' ? id => puppet.downloadImage(id).catch(() => undefined) : undefined,
  ttlMs: integer('BRIDGE_TTL_MS', 30000, 100, 300000),
  concurrency: integer('BRIDGE_CONCURRENCY', 4, 1, 16),
  maxPending: integer('BRIDGE_MAX_PENDING', 100, 1, 1000),
  maxPerPeer: integer('BRIDGE_MAX_PER_PEER', 5, 1, 100),
});
let stopping = false;
async function shutdown(code) {
  if (stopping) return; stopping = true;
  await bridge.offline(); clearQr(); writeStatus('offline');
  try { await puppet.stop(); } catch { log({ event: 'wechat_stop_failed' }); }
  process.exitCode = code;
}
puppet.on('scan', ({ status }) => {
  writeStatus(status === types.ScanStatus.Waiting || status === types.ScanStatus.Scanned ? 'waiting' : 'starting');
  log({ event: 'login_scan', status: types.ScanStatus[status] });
});
puppet.on('login', () => { clearQr(); writeStatus('online'); log({ event: 'wechat_login' }); });
puppet.on('ready', () => { bridge.online(); log({ event: 'wechat_ready', supports: groupsEnabled ? ['private_text', 'group_text', 'group_mentions'] : ['private_text'] }); });
puppet.on('logout', () => {
  log({ event: 'wechat_logout' });
  void bridge.offline();
  setImmediate(() => { void shutdown(1); });
});
puppet.on('error', () => {
  // Never stringify native exceptions or protocol state into general logs.
  log({ event: 'wechat_error' });
  if (!puppet.isLoggedIn) setImmediate(() => { void shutdown(1); });
});
puppet.on('message', async ({ messageId }) => {
  if (stopping) return;
  try {
    const message = await puppet.messagePayload(messageId);
    if (message.type !== types.Message.Text && message.type !== types.Message.Image) return;
    await bridge.accept({
      kind: message.type === types.Message.Image ? 'image' : 'text', id: messageId, senderId: message.talkerId,
      selfId: puppet.currentUserId, roomId: message.roomId,
      text: message.text, timestamp: message.timestamp, mentions: message.mentionIdList, senderName: message.neoSenderName,
    });
  } catch { log({ event: 'bridge_receive_failed' }); }
});
process.once('SIGINT', () => { void shutdown(0); });
process.once('SIGTERM', () => { void shutdown(0); });
await puppet.start();
