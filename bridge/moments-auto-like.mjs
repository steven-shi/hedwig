import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const INTERVAL = 12 * 60 * 60 * 1000;
const STATE_FILE = 'moments-auto-like.json';
const isId = value => typeof value === 'string' && /^[1-9]\d{0,19}$/u.test(value);

export function readMomentsAutoLikeConfig(file = 'local/bridge.json') {
  try {
    const { momentsAutoLike = false } = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof momentsAutoLike !== 'boolean') throw new Error('Invalid momentsAutoLike setting');
    return momentsAutoLike;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function validCursor(cursor) {
  return cursor?.version === 1 && /^[a-f0-9]{64}$/u.test(cursor.account) &&
    Number.isSafeInteger(cursor.nextAt) && cursor.nextAt >= 0 &&
    (cursor.baselineAt === null || (Number.isSafeInteger(cursor.baselineAt) && cursor.baselineAt >= 0)) &&
    Array.isArray(cursor.finished) && cursor.finished.every(isId);
}

function validateFeed(posts) {
  if (!Array.isArray(posts) || posts.length > 10 || posts.some(post =>
    !isId(post?.id) || !Number.isSafeInteger(post.createdAt) || post.createdAt <= 0 ||
    ![true, false, null].includes(post.liked) || ![true, false, null].includes(post.isSelf)) ||
    new Set(posts.map(post => post.id)).size !== posts.length) throw new Error('Invalid Moments homepage');
}

export function startMomentsAutoLike({ state, accountId, available, homepage, like, log,
  now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  let cursor;
  if (typeof accountId !== 'string' || !accountId) {
    log({ event: 'moments_auto_like_account_unavailable' });
    return;
  }
  const account = createHash('sha256').update(accountId).digest('hex');
  try {
    cursor = state.read(STATE_FILE, null);
    if (cursor === null) cursor = { version: 1, account, nextAt: 0, baselineAt: null, finished: [] };
    if (!validCursor(cursor)) throw new Error('Invalid Moments state');
  } catch {
    log({ event: 'moments_auto_like_state_invalid' });
    return;
  }
  if (cursor.account !== account) {
    log({ event: 'moments_auto_like_account_mismatch' });
    return;
  }

  let wakeAt = cursor.nextAt;
  let timer;
  let running;
  let stopped = false;
  const active = () => !stopped && available();

  function persist(next) {
    state.write(STATE_FILE, next);
    cursor = next;
  }

  async function run() {
    const startedAt = now();
    wakeAt = startedAt + INTERVAL;
    persist({ ...cursor, nextAt: wakeAt });
    if (!active()) return;
    const posts = await homepage();
    if (!active()) return;
    validateFeed(posts);
    if (cursor.baselineAt === null) {
      persist({ ...cursor, baselineAt: Math.floor(startedAt / 1000), finished: posts.map(post => post.id) });
      log({ event: 'moments_auto_like_baseline', count: posts.length });
      return;
    }

    const finished = new Set(cursor.finished);
    let accepted = 0;
    let skipped = 0;
    let uncertain = 0;
    let rejected = 0;
    for (const post of posts) {
      if (!active()) break;
      if (finished.has(post.id) || post.createdAt < cursor.baselineAt) continue;
      if (post.isSelf === true || post.liked === true) {
        finished.add(post.id);
        skipped += 1;
        continue;
      }
      if (post.isSelf !== false || post.liked !== false) continue;
      finished.add(post.id);
      // Claim before transport. After a crash or uncertain send the claim remains final.
      persist({ ...cursor, finished: [...finished] });
      let result;
      try { result = await like(post.id); }
      catch { uncertain += 1; break; }
      if (result?.status === 'accepted') accepted += 1;
      else if (result?.status === 'rejected') { rejected += 1; break; }
      else { uncertain += 1; break; }
    }
    if (cursor.finished.length < finished.size) persist({ ...cursor, finished: [...finished] });
    log({ event: 'moments_auto_like_round', count: posts.length, accepted, skipped, rejected, uncertain });
  }

  function arm() {
    if (stopped) return;
    timer = schedule(() => {
      if (stopped || wakeAt > now()) return arm();
      return running = run().catch(() => log({ event: 'moments_auto_like_round_failed' })).finally(arm);
    }, Math.min(INTERVAL, Math.max(0, wakeAt - now())));
    timer?.unref?.();
  }
  arm();

  return () => {
    stopped = true;
    cancel(timer);
    return running;
  };
}
