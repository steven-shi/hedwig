import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class State {
  constructor(directory, { now = Date.now, limit = 10000, ttlMs = 48 * 3600000 } = {}) {
    this.directory = directory; this.now = now; this.limit = limit; this.ttlMs = ttlMs;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error('State path must be a directory');
    chmodSync(directory, 0o700);
    const saved = this.read('seen.json', { version: 1, entries: [] });
    if (saved.version !== 1 || !Array.isArray(saved.entries) ||
        saved.entries.some(e => !Array.isArray(e) || !/^[a-f0-9]{64}$/.test(e[0]) || !Number.isFinite(e[1]))) throw new Error('Invalid dedup state');
    this.seen = new Map(saved.entries); this.prune();
  }
  read(name, fallback) {
    try { return JSON.parse(readFileSync(join(this.directory, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  }
  write(name, data) {
    const destination = join(this.directory, name);
    const temporary = destination + '.' + randomBytes(8).toString('hex') + '.tmp';
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, destination);
  }
  prune() {
    for (const [key, time] of this.seen) if (time < this.now() - this.ttlMs) this.seen.delete(key);
    while (this.seen.size > this.limit) this.seen.delete(this.seen.keys().next().value);
  }
  claim(sender, messageId) {
    const key = createHash('sha256').update(JSON.stringify([sender, messageId])).digest('hex');
    this.prune();
    if (this.seen.has(key)) return false;
    this.seen.set(key, this.now()); this.prune();
    this.write('seen.json', { version: 1, entries: [...this.seen] });
    return true;
  }
  beginIdentityCheck() {
    const token = randomBytes(24).toString('base64url');
    this.write('identity-check.json', {
      version: 1, hash: createHash('sha256').update(token).digest('hex'),
      expiresAt: this.now() + 600000, senderId: null,
    });
    return token;
  }
  proposeIdentity(senderId, token) {
    const pending = this.read('identity-check.json', null);
    if (!pending || pending.expiresAt <= this.now() || pending.senderId ||
        typeof pending.hash !== 'string' || !/^[a-f0-9]{64}$/.test(pending.hash)) return false;
    const digest = createHash('sha256').update(token).digest();
    if (!timingSafeEqual(Buffer.from(pending.hash, 'hex'), digest)) return false;
    this.write('identity-check.json', { ...pending, hash: '', senderId });
    return true;
  }
  identifiedSender() {
    const result = this.read('identity-check.json', null);
    return result && result.expiresAt > this.now() ? result.senderId : null;
  }
}
