import { isAbsolute } from 'node:path';
import PuppetNeo from 'wechaty-puppet-neo';
import { types } from 'wechaty-puppet';
import { Bridge } from './core.mjs';
import { State } from './state.mjs';
import { AiClient } from './client.mjs';
import { eventLogger } from './log.mjs';
import { runLogoutAlert } from './logout-alert.mjs';
import { loginSession } from './login-session.mjs';
import { readQrWebConfig, startQrWeb } from './qr-web.mjs';

const socketPath = process.env.BRIDGE_SOCKET ?? '/run/neo/ai.sock';
const directory = process.env.BRIDGE_STATE_DIR ?? '/state';
const qrFile = process.env.BRIDGE_QR_FILE ?? '/run/neo/login.png';
if (!isAbsolute(socketPath) || !isAbsolute(directory) || (qrFile && !isAbsolute(qrFile))) throw new Error('Bridge paths must be absolute');
const integer = (name, fallback, min, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid setting: ' + name);
  return value;
};
const log = eventLogger('bridge');
const state = new State(directory);
const webConfig = readQrWebConfig();
const limits = {
  ttlMs: integer('BRIDGE_TTL_MS', 30000, 100, 300000),
  concurrency: integer('BRIDGE_CONCURRENCY', 4, 1, 16),
  maxPending: integer('BRIDGE_MAX_PENDING', 100, 1, 1000),
  maxPerPeer: integer('BRIDGE_MAX_PER_PEER', 5, 1, 100),
};
class PuppetBridge extends PuppetNeo {
  constructor(receiveQr) {
    super();
    this.receiveQr = receiveQr;
  }

  createSession() {
    const session = super.createSession();
    const sync = session.sync;
    session.sync = async scene => {
      const result = await sync(scene);
      if (result.groupDropped) log({ event: 'group_messages_unresolved', count: result.groupDropped });
      return result;
    };
    const start = session.startLogin;
    session.startLogin = async () => {
      const result = await start();
      this.receiveQr(Buffer.from(result.png, 'base64'));
      return result;
    };
    return session;
  }
}

async function createAttempt(receiveQr) {
  const client = new AiClient(socketPath);
  const { groupsEnabled } = await client.settings();
  if (groupsEnabled && PuppetNeo.GROUP_TEXT !== true) throw new Error('Group mode requires the group-capable Neo build');
  const puppet = new PuppetBridge(receiveQr);
  const bridge = new Bridge({
    state, client, log, groupsEnabled, ...limits,
    send: (peer, text, mentions) => puppet.messageSendText(peer, text, mentions),
    loadImage: typeof puppet.downloadImage === 'function' ? id => puppet.downloadImage(id).catch(() => undefined) : undefined,
  });
  const receiveMessage = async ({ messageId }, active) => {
    try {
      const message = await puppet.messagePayload(messageId);
      if (!active() || ![types.Message.Text, types.Message.Image, types.Message.Video].includes(message.type)) return;
      await bridge.accept({
        kind: message.type === types.Message.Image ? 'image' : message.type === types.Message.Video ? 'video' : 'text',
        id: messageId, senderId: message.talkerId,
        selfId: puppet.currentUserId, roomId: message.roomId,
        text: message.text, timestamp: message.timestamp, mentions: message.mentionIdList, senderName: message.neoSenderName,
        quotedText: message.neoQuotedText,
      });
    } catch { log({ event: 'bridge_receive_failed' }); }
  };
  return { puppet, bridge, groupsEnabled, receiveMessage };
}

let stopping = false;
const login = loginSession({
  createAttempt, scanStatus: types.ScanStatus, qrFile, log,
  onLogout: () => runLogoutAlert(log),
  onEnd: () => { if (!webConfig && !stopping) process.exitCode = 1; },
});
const web = webConfig && await startQrWeb(webConfig, login);
if (web) log({ event: 'qr_web_ready' });

async function shutdown() {
  if (stopping) return;
  stopping = true;
  web?.close();
  await login.close();
  process.exitCode = 0;
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
if (!web) login.begin();
