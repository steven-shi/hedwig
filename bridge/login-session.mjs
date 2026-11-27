import { unlinkSync, writeFileSync } from 'node:fs';
import { setImmediate as nextTick } from 'node:timers/promises';

const QR_LIFETIME = 120_000;

export function loginSession({ createAttempt, scanStatus, qrFile, log, onLogout, onEnd }) {
  let current;
  let phase;
  let png;
  let generatedAt = 0;
  let closing = false;

  function clearQr() {
    png = undefined;
    if (qrFile) {
      try { unlinkSync(qrFile); }
      catch (error) { if (error.code !== 'ENOENT') log({ event: 'qr_cleanup_failed' }); }
    }
  }

  function setPhase(next) {
    phase = next;
    if (qrFile) {
      try {
        writeFileSync(qrFile + '.status', ['waiting', 'scanned'].includes(next) ? 'waiting' : next, { mode: 0o600 });
      } catch { log({ event: 'qr_status_write_failed' }); }
    }
  }

  clearQr();
  setPhase('offline');

  function status() {
    if (png && Date.now() - generatedAt >= QR_LIFETIME) return { phase: 'expiring' };
    return { phase, png: ['waiting', 'scanned'].includes(phase) ? png : undefined };
  }

  function finish(attempt, result) {
    if (attempt.done) return attempt.done;
    attempt.ended = true;
    clearQr();
    setPhase('closing');
    const momentsDone = attempt.stopMoments?.();
    const offline = attempt.bridge?.offline();
    attempt.done = (async () => {
      // Neo waits for its own event loop in stop(); let the emitting callback return first.
      await nextTick();
      await attempt.started;
      await offline;
      await momentsDone;
      try { await attempt.puppet?.stop(); }
      catch {
        log({ event: 'wechat_stop_failed' });
        // Keep this attempt marked active when cleanup is uncertain.
        setPhase('stop_failed');
        onEnd();
        return;
      }
      current = undefined;
      setPhase(result);
      onEnd();
    })();
    return attempt.done;
  }

  function begin() {
    if (closing || current) return status();
    const attempt = { ended: false, authenticated: false, ready: false };
    current = attempt;
    clearQr();
    setPhase('starting');
    attempt.started = (async () => {
      const { puppet, bridge, groupsEnabled, receiveMessage, startMoments } = await createAttempt(data => {
        if (attempt.ended || attempt.authenticated) return;
        png = data;
        generatedAt = Date.now();
        if (qrFile) {
          try { writeFileSync(qrFile, png, { mode: 0o600 }); }
          catch { log({ event: 'qr_write_failed' }); }
        }
      }, event => {
        if (attempt.ended) return;
        log(event);
        if (event.event === 'wechat_reconnecting' && phase !== 'reconnecting') setPhase('reconnecting');
        if (event.event === 'wechat_reconnected' && phase === 'reconnecting') setPhase(attempt.ready ? 'online' : 'confirmed');
      });
      Object.assign(attempt, { puppet, bridge });
      puppet.on('error', () => {
        if (attempt.ended) return;
        log({ event: 'wechat_error' });
        if (!puppet.isLoggedIn) setImmediate(() => {
          if (!attempt.ended) void finish(attempt, 'failed');
        });
      });
      if (attempt.ended) return;
      puppet.on('scan', ({ status: code }) => {
        if (attempt.ended) return;
        log({ event: 'login_scan', status: scanStatus[code] });
        if (code === scanStatus.Waiting) setPhase('waiting');
        if (code === scanStatus.Scanned) setPhase('scanned');
        if (code === scanStatus.Confirmed) { clearQr(); setPhase('confirmed'); }
        if (code === scanStatus.Timeout) void finish(attempt, 'expired');
        if (code === scanStatus.Cancel) void finish(attempt, 'cancelled');
      });
      puppet.on('login', () => {
        if (attempt.ended) return;
        attempt.authenticated = true;
        clearQr();
        setPhase('confirmed');
        log({ event: 'wechat_login' });
      });
      puppet.on('ready', () => {
        if (attempt.ended || attempt.ready) return;
        attempt.ready = true;
        bridge.online();
        setPhase('online');
        log({ event: 'wechat_ready', supports: groupsEnabled ? ['private_text', 'group_text', 'group_mentions'] : ['private_text'] });
        attempt.stopMoments = startMoments?.(() => !attempt.ended && phase === 'online');
      });
      puppet.on('logout', () => {
        if (attempt.ended) return;
        log({ event: 'wechat_logout' });
        void finish(attempt, 'offline');
        if (attempt.authenticated) onLogout();
      });
      puppet.on('message', event => {
        if (!attempt.ended && phase === 'online') void receiveMessage(event, () => !attempt.ended);
      });
      await puppet.start();
    })().catch(() => {
      if (!attempt.ended) {
        log({ event: 'wechat_start_failed' });
        void finish(attempt, 'failed');
      }
    });
    return status();
  }

  return {
    begin,
    status,
    async close() {
      closing = true;
      if (current) await finish(current, 'offline');
      else { clearQr(); setPhase('offline'); }
    },
  };
}
