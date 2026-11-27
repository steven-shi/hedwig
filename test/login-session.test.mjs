import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';
import { test } from 'node:test';
import { loginSession } from '../bridge/login-session.mjs';
import { readQrWebConfig, startQrWeb } from '../bridge/qr-web.mjs';

const scanStatus = { Waiting: 1, Scanned: 2, Confirmed: 3, Timeout: 4, Cancel: 5 };
const png = Buffer.from('fixture');
const scan = (attempt, status) => attempt.emit('scan', { status: scanStatus[status] });

test('one active login at a time, offline alerts once, and later attempts keep the same web process', async () => {
  let alerts = 0;
  const attempts = [], ends = new EventEmitter();
  const login = loginSession({
    scanStatus, log: () => {}, onLogout: () => alerts++, onEnd: () => ends.emit('end'),
    async createAttempt(receiveQr) {
      const puppet = new EventEmitter();
      const bridge = { active: false, online() { this.active = true; }, async offline() { this.active = false; } };
      puppet.start = async () => { receiveQr(png); scan(puppet, 'Waiting'); };
      puppet.stop = async () => { puppet.stopped = true; puppet.emit('logout'); };
      attempts.push({ puppet, bridge, receiveQr });
      return { puppet, bridge };
    },
  });
  assert.equal(login.status().phase, 'offline');
  assert.equal(login.begin().phase, 'starting');
  login.begin();
  await nextTick();
  assert.equal(attempts.length, 1);
  const first = attempts[0].puppet;
  assert.equal(login.status().png, png);
  scan(first, 'Scanned');
  assert.equal(login.status().phase, 'scanned');
  scan(first, 'Confirmed');
  first.emit('login');
  assert.deepEqual(login.status(), { phase: 'confirmed', png: undefined });
  first.emit('ready');
  assert.equal(attempts[0].bridge.active, true);
  assert.equal(login.begin().phase, 'online');
  let ended = once(ends, 'end');
  first.emit('logout');
  first.emit('logout');
  assert.equal(login.begin().phase, 'closing');
  await ended;
  assert.equal(alerts, 1);
  assert.equal(attempts[0].bridge.active, false);
  assert.equal(first.stopped, true);
  assert.equal(login.status().phase, 'offline');
  login.begin();
  await nextTick();
  assert.equal(attempts.length, 2);
  ended = once(ends, 'end');
  scan(attempts[1].puppet, 'Timeout');
  await ended;
  assert.equal(login.status().phase, 'expired');
  assert.equal(alerts, 1);
  login.begin();
  await nextTick();
  scan(attempts[0].puppet, 'Confirmed');
  attempts[0].receiveQr(Buffer.from('stale'));
  assert.deepEqual(login.status(), { phase: 'waiting', png });
  await login.close();
  assert.equal(alerts, 1);
  assert.equal(login.begin().phase, 'offline');
  assert.equal(attempts.length, 3);
});

test('QR configuration defaults to private IPv4 across subnets', t => {
  const directory = mkdtempSync(join(tmpdir(), 'hedwig-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'bridge.json');
  const writeConfig = origin => writeFileSync(file, JSON.stringify({ qrWeb: { origin } }));
  writeConfig('http://192.168.1.20:8765');
  const { ranges } = readQrWebConfig(file);
  const allowed = host => {
    const address = host.split('.').reduce((value, part) => value * 256 + Number(part), 0);
    return ranges.some(({ first, last }) => first <= address && address <= last);
  };
  assert.equal(allowed('192.168.2.30'), true);
  assert.equal(allowed('10.0.0.5'), true);
  assert.equal(allowed('172.31.255.254'), true);
  assert.equal(allowed('172.32.0.1'), false);
  assert.equal(allowed('8.8.8.8'), false);
  writeConfig('http://8.8.8.8:8765');
  assert.throws(() => readQrWebConfig(file), /private IPv4/);
});

test('QR HTTP stays on its configured private network and starts only on a same-origin POST', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'hedwig-http-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'bridge.json');
  assert.equal(readQrWebConfig(file), undefined);
  writeFileSync(file, JSON.stringify({ qrWeb: { origin: 'http://127.0.0.1:8765', network: '0.0.0.0/0' } }));
  assert.throws(() => readQrWebConfig(file), /private IPv4/);
  writeFileSync(file, JSON.stringify({ qrWeb: { origin: 'http://127.0.0.1:8765', network: '127.0.0.0/8' } }));
  const config = readQrWebConfig(file);
  let starts = 0;
  const server = await startQrWeb(config, {
    status: () => ({ phase: 'offline' }),
    begin: () => { starts++; return { phase: 'starting' }; },
  }, { port: 0, host: '127.0.0.1' });
  t.after(() => new Promise(resolve => server.close(resolve)));
  config.authority = '127.0.0.1:' + server.address().port;
  config.origin = 'http://' + config.authority;
  assert.equal((await fetch(config.origin)).status, 200);
  assert.equal((await fetch(config.origin + '/qr.png')).status, 404);
  assert.equal((await fetch(config.origin + '/start', { method: 'POST' })).status, 403);
  assert.equal(starts, 0);
  assert.equal((await fetch(config.origin + '/start', {
    method: 'POST', headers: { Origin: config.origin },
  })).status, 200);
  assert.equal(starts, 1);
});
