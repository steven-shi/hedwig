export const cleanLabel = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 64).trim();
function withoutMentions(text) {
  return text.replace(/(?:^|\s)@[^\u2005\n]+\u2005\s*/gu, ' ').replace(/^\s*@\S+\s*$/, '').trim();
}
export const hasQuestion = text => !!withoutMentions(text);
export function hasFollowupContent(text) {
  const words = withoutMentions(text).replace(/[^\p{L}\p{N}]/gu, '');
  return !!words && !/^(?:哈{2,}|呵{2,}|嘿{2,}|嗯+|哦+|喔+|额+|呃+|lol|lmao|(?:ha){2,})$/iu.test(words);
}
export function precedingPhoto(messages, senderId, receivedAt) {
  const previous = messages.findLast(entry => entry.senderId === senderId);
  if (previous?.image !== true) return undefined;
  const age = receivedAt - previous.timestamp * 1000;
  return age >= 0 && age <= 60_000 ? previous.id : undefined;
}
export function asksAboutVideo(text, messages, senderId, receivedAt) {
  const question = withoutMentions(text);
  if (/(?:看|播放|识别|分析|总结|描述).{0,8}(?:视频|影片|短片)|(?:视频|影片|短片)(?:里|中)|(?:watch|play|analyse|analyze|describe|summari[sz]e).{0,20}\b(?:video|clip)\b|\bin (?:this|the) (?:video|clip)\b/iu.test(question)) return true;
  const previous = messages.findLast(entry => entry.senderId === senderId);
  if (previous?.video !== true) return false;
  const age = receivedAt - previous.timestamp * 1000;
  return age >= 0 && age <= 120_000 && (
    !question || /谁.{0,5}(?:跳舞|唱歌)|(?:在|干|做)什么|看看|看一下|who.{0,20}(?:danc|sing)|take a look/iu.test(question)
  );
}
const PARTICIPATION_MS = 10 * 60 * 1000;
export class GroupBuffer {
  constructor({ now = Date.now, rooms = 100, messages = 50, chars = 12000, ageMs = 1800000 } = {}) {
    Object.assign(this, { now, maxRooms: rooms, maxMessages: messages, maxChars: chars, ageMs });
    this.rooms = new Map(); this.seen = new Map();
  }
  clear() { this.rooms.clear(); /* Keep recent delivery IDs; context reset must not replay a mention. */ }
  add(roomId, message) {
    const now = this.now();
    for (const [id, at] of this.seen) if (now - at > 7200000) this.seen.delete(id);
    const key = JSON.stringify([roomId, message.id]);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    while (this.seen.size > 20000) this.seen.delete(this.seen.keys().next().value);
    for (const [id, room] of this.rooms) if (now - room.at > this.ageMs) this.rooms.delete(id);
    const entry = {
      id: String(message.id).slice(0, 128), senderId: String(message.senderId).slice(0, 256),
      senderName: cleanLabel(message.senderName || message.senderId), text: message.text.slice(0, 2000),
      timestamp: message.timestamp,
      ...(message.kind === 'image' ? { image: true } : {}),
      ...(message.kind === 'video' ? { video: true } : {}),
      ...(message.quotedText ? { quotedText: message.quotedText } : {}),
    };
    const previous = this.rooms.get(roomId);
    const entries = (previous?.entries ?? []).filter(e => e.timestamp * 1000 >= now - this.ageMs);
    entries.push(entry);
    while (entries.length > this.maxMessages || JSON.stringify(entries).length > this.maxChars) entries.shift();
    this.rooms.delete(roomId); this.rooms.set(roomId, { entries, at: now, activeUntil: previous?.activeUntil ?? 0 });
    while (this.rooms.size > this.maxRooms) this.rooms.delete(this.rooms.keys().next().value);
    return true;
  }
  activate(roomId, receivedAt) {
    const room = this.rooms.get(roomId);
    if (room) room.activeUntil = Math.max(room.activeUntil, receivedAt + PARTICIPATION_MS);
  }
  deactivate(roomId) {
    const room = this.rooms.get(roomId);
    if (room) room.activeUntil = 0;
  }
  isActive(roomId, receivedAt) {
    return receivedAt < (this.rooms.get(roomId)?.activeUntil ?? 0);
  }
  snapshot(roomId, excludeId) {
    const now = this.now();
    return structuredClone((this.rooms.get(roomId)?.entries ?? [])
      .filter(e => e.id !== excludeId && e.timestamp * 1000 >= now - this.ageMs).slice(-30));
  }
}
