import { randomUUID } from 'node:crypto';
import { BridgeError, describe } from './errors.mjs';
import { GroupBuffer, cleanLabel, hasFollowupContent, hasQuestion, precedingPhoto } from './groups.mjs';
import { validImage } from './images.mjs';

const UNAVAILABLE = 'AI 暂时不可用，请稍后再试。';
export class Bridge {
  constructor({ state, client, send, loadImage, log = () => {}, ttlMs = 30000, concurrency = 4, maxPending = 100, maxPerPeer = 5, groupsEnabled = false, groupBuffer = new GroupBuffer() }) {
    Object.assign(this, { state, client, send, loadImage, log, ttlMs, concurrency, maxPending, maxPerPeer, groupsEnabled, groupBuffer });
    this.queues = new Map(); this.busy = new Set(); this.counts = new Map();
    this.controllers = new Map();
    this.active = 0; this.pending = 0; this.liveSince = null; this.groupEpoch = 0;
    this.outbound = Promise.resolve();
  }
  resetGroups() { this.groupEpoch++; this.groupBuffer.clear(); }
  online(at = Date.now()) { this.liveSince = Math.floor(at / 1000); }
  async offline() {
    this.liveSince = null; this.resetGroups();
    for (const controller of this.controllers.values()) controller.abort();
    for (const queue of this.queues.values()) for (const job of queue) { this.release(job); job.resolve('discarded'); }
    this.queues.clear();
  }
  silenceGroup(route) {
    this.groupBuffer.deactivate(route);
    this.controllers.get(route)?.abort();
    const queue = this.queues.get(route) ?? [];
    this.queues.delete(route);
    for (const job of queue) {
      this.release(job);
      job.resolve('discarded');
    }
  }
  async sendOnce(peer, text, deadlineAt, options = {}) {
    const work = this.outbound.then(() => {
      if (this.liveSince === null) throw new BridgeError('WECHAT_OFFLINE', '微信会话已离线');
      if (options.signal?.aborted || (deadlineAt !== undefined && Date.now() >= deadlineAt) ||
          (options.groupEpoch !== undefined && options.groupEpoch !== this.groupEpoch)) throw new BridgeError('REPLY_EXPIRED', '回复已经失效');
      return this.send(peer, text, options.mentions);
    });
    this.outbound = work.catch(() => {});
    return work;
  }
  render(text, options) {
    return options.mentions?.length ? '@' + cleanLabel(options.label || options.mentions[0]) + '\u2005' + text : text;
  }
  async failure(peer, error, options = {}) {
    const info = describe(error);
    this.log({ event: 'request_failed', code: info.code, status: info.status });
    if (!options.silentFailure) {
      try { await this.sendOnce(peer, this.render(UNAVAILABLE, options), undefined, options); }
      catch { this.log({ event: 'user_notice_send_failed' }); }
    }
  }
  async accept(message) {
    const group = !!message.roomId;
    const image = message.kind === 'image' && typeof this.loadImage === 'function';
    let imageId = image ? message.id : undefined;
    if (this.liveSince === null || (message.kind !== 'text' && !image) ||
        (group && (!this.groupsEnabled || typeof message.roomId !== 'string' || !message.roomId.endsWith('@chatroom'))) ||
        message.senderId === message.selfId || !message.senderId || !message.id) return 'ignored';
    if (image) message = { ...message, text: '[图片]' };
    if (typeof message.text !== 'string' || !message.text.trim()) return 'ignored';
    if (!Number.isFinite(message.timestamp) || message.timestamp < this.liveSince) return 'history';
    const identify = message.kind === 'text' && /^!identify\s+(\S+)$/i.exec(message.text.trim());
    if (group && identify) return 'ignored';
    const route = group ? message.roomId : message.senderId;
    const receivedAt = group ? this.groupBuffer.now() : Date.now();
    const options = group ? { mentions: [message.senderId], label: message.senderName || message.senderId, groupEpoch: this.groupEpoch } : {};
    let groupContext;
    if (group) {
      if (/^🤫[\uFE0E\uFE0F]?$/u.test(message.text.trim())) {
        if (!this.state.claim(JSON.stringify([route, message.senderId]), message.id)) return 'duplicate';
        this.silenceGroup(route);
        return 'silenced';
      }
      if (!this.groupBuffer.add(route, message)) return 'duplicate';
      if (!message.selfId) return 'buffered';
      const mentions = message.mentions ?? [];
      const explicit = mentions.includes(message.selfId);
      if (!explicit && (!this.groupBuffer.isActive(route, receivedAt) || (!image && !hasFollowupContent(message.text)))) return 'buffered';
      const messages = this.groupBuffer.snapshot(route, message.id);
      if (!this.state.claim(JSON.stringify([route, message.senderId]), message.id)) return 'duplicate';
      const trigger = explicit ? (hasQuestion(message.text) ? 'mention' : 'invite') : 'followup';
      if (explicit && !image && typeof this.loadImage === 'function') {
        imageId = precedingPhoto(messages, message.senderId, receivedAt);
      }
      groupContext = { botId: message.selfId, messages, trigger };
      options.silentFailure = trigger === 'followup';
    } else {
      if (!this.state.claim(message.senderId, message.id)) return 'duplicate';
      if (identify) {
        const accepted = this.state.proposeIdentity(message.senderId, identify[1]);
        await this.sendOnce(message.senderId, accepted ? '核验成功，请在部署终端查看内部 ID。' : '核验码无效或已过期。').catch(() => {});
        return 'identity';
      }
    }
    if (message.text.length > 16000) { await this.failure(route, new BridgeError('INPUT_TOO_LONG', '输入超过桥接文字长度限制'), options); return 'rejected'; }
    if (this.pending >= this.maxPending || (this.counts.get(route) ?? 0) >= this.maxPerPeer) {
      await this.failure(route, new BridgeError('AI_BUSY', 'AI 请求队列已满'), options); return 'busy';
    }
    if (group && !options.silentFailure) this.groupBuffer.activate(route, receivedAt);
    return new Promise(resolve => {
      const job = { message, route, options, groupContext, imageId, receivedAt, deadlineAt: Date.now() + this.ttlMs, resolve };
      if (!this.queues.has(route)) this.queues.set(route, []);
      this.queues.get(route).push(job); this.pending++;
      this.counts.set(route, (this.counts.get(route) ?? 0) + 1); this.pump();
    });
  }
  release(job) {
    this.pending--; const count = (this.counts.get(job.route) ?? 1) - 1;
    count ? this.counts.set(job.route, count) : this.counts.delete(job.route);
  }
  pump() {
    if (this.liveSince === null) return;
    for (const [peer, queue] of this.queues) {
      if (this.active >= this.concurrency) break;
      if (this.busy.has(peer) || !queue.length) continue;
      const job = queue.shift();
      if (!queue.length) this.queues.delete(peer);
      this.busy.add(peer); this.active++;
      void this.run(job).then(job.resolve, () => job.resolve('failed')).finally(() => {
        this.release(job); this.busy.delete(peer); this.active--; this.pump();
      });
    }
  }
  async run(job) {
    if (Date.now() >= job.deadlineAt || this.liveSince === null ||
        (job.options.groupEpoch !== undefined && job.options.groupEpoch !== this.groupEpoch)) return 'expired';
    const controller = new AbortController();
    this.controllers.set(job.route, controller);
    job.options.signal = controller.signal;
    const { message } = job, group = !!message.roomId;
    const request = {
      version: 1, requestId: randomUUID(), deadlineAt: job.deadlineAt,
      conversation: { kind: group ? 'group' : 'private', id: job.route },
      actor: { id: message.senderId },
      message: { id: message.id, text: message.text, timestamp: message.timestamp,
        ...(group ? { mentions: message.mentions ?? [], senderName: cleanLabel(message.senderName || message.senderId) } : {}) },
      ...(group ? { context: job.groupContext } : {}),
    };
    try {
      if (job.imageId) {
        const image = await this.loadImage(job.imageId);
        if (Date.now() >= job.deadlineAt || this.liveSince === null || controller.signal.aborted ||
            (group && job.options.groupEpoch !== this.groupEpoch)) return 'expired';
        if (!validImage(image)) throw new BridgeError('IMAGE_UNAVAILABLE', '微信图片无法读取、过大或格式不支持');
        request.message.image = { mimeType: image.mimeType, base64: image.base64 };
      }
      const text = await this.client.request(request, controller.signal);
      if (Date.now() >= job.deadlineAt || this.liveSince === null || controller.signal.aborted) return 'expired';
      if (text === null) return 'discarded';
      const rendered = this.render(text, job.options);
      try { await this.sendOnce(job.route, rendered, job.deadlineAt, job.options); }
      catch (error) {
        if (error.code === 'REPLY_EXPIRED') return 'expired';
        this.log({ event: 'wechat_send_failed_or_uncertain' }); return 'send_failed';
      }
      if (group && this.liveSince !== null && !controller.signal.aborted && job.options.groupEpoch === this.groupEpoch) {
        this.groupBuffer.add(job.route, {
          id: 'reply:' + message.id, senderId: message.selfId, senderName: '机器人',
          text: rendered, timestamp: Math.floor(this.groupBuffer.now() / 1000),
        });
        if (job.options.silentFailure) this.groupBuffer.activate(job.route, job.receivedAt);
      }
      this.log({ event: 'reply_sent', kind: group ? 'group' : 'private' }); return 'sent';
    } catch (error) {
      if (this.liveSince === null || controller.signal.aborted ||
          (group && job.options.groupEpoch !== this.groupEpoch)) return 'discarded';
      await this.failure(job.route, error, job.options); return 'failed';
    } finally { this.controllers.delete(job.route); }
  }
}
