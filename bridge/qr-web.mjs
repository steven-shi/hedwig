import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';

const PAGE = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hedwig · 微信登录</title>
<style>
body { margin:0; min-height:100vh; display:grid; place-items:center; background:#f5f3ef;
  color:#232a2a; font:16px system-ui,sans-serif; }
main { box-sizing:border-box; width:min(420px,calc(100% - 32px)); padding:32px;
  border-radius:18px; background:white; box-shadow:0 8px 35px #172e2914; }
h1 { margin:0; font-size:24px; }
p { min-height:2.8em; line-height:1.5; }
button { min-height:44px; width:100%; border:0; border-radius:9px; color:white;
  background:#275949; font:inherit; cursor:pointer; }
button:disabled { opacity:.55; cursor:default; }
img { width:min(250px,100%); margin:16px auto; }
img:not([hidden]) { display:block; }
</style>
<main><h1>Hedwig · 微信登录</h1>
<p id="status" role="status">正在读取状态…</p>
<img id="qr" alt="微信测试账号登录二维码" hidden>
<button id="start" disabled>获取登录二维码</button></main>
<script src="/page.js" defer></script></html>`;
const SCRIPT = `
const status = document.querySelector('#status');
const qr = document.querySelector('#qr');
const button = document.querySelector('#start');
const messages = {
  online: '微信已登录，Hedwig 正在运行。',
  reconnecting: '微信连接中断，正在尝试恢复会话…',
  offline: '微信已离线。准备好扫码后，再点下面的按钮。',
  waiting: '请用微信测试小号扫码，并在手机上确认登录。',
  starting: '正在向微信申请二维码…',
  scanned: '已扫码，请在手机上确认。',
  confirmed: '手机已确认，正在连接微信…',
  closing: '正在结束上一轮登录…',
  expiring: '这张码已过期，正在结束这一轮登录…',
  expired: '二维码已过期。准备好时可以重新获取。',
  cancelled: '你已取消扫码，可以重新获取二维码。',
  failed: '这轮登录没有成功，可以重新获取二维码。',
  stop_failed: '本轮会话无法安全结束，请检查桥接日志。',
  unavailable: '暂时无法加载。请稍后再试。',
};
let timer;
async function refresh(start = false) {
  clearTimeout(timer);
  button.disabled = true;
  try {
    const response = await fetch(start ? '/start' : '/state', { method: start ? 'POST' : 'GET', cache: 'no-store' });
    if (!response.ok) throw new Error();
    const { state } = await response.json();
    status.textContent = messages[state] ?? messages.unavailable;
    const visible = ['waiting', 'scanned'].includes(state);
    qr.hidden = !visible;
    if (visible && !qr.hasAttribute('src')) qr.src = '/qr.png';
    if (!visible) qr.removeAttribute('src');
    button.textContent = state === 'online' ? '刷新状态' : '获取登录二维码';
    const pending = ['starting', 'waiting', 'scanned', 'confirmed', 'reconnecting', 'closing', 'expiring'].includes(state);
    button.disabled = pending || state === 'stop_failed';
    if (pending) timer = setTimeout(refresh, 1500);
  } catch {
    status.textContent = messages.unavailable;
    qr.hidden = true;
    qr.removeAttribute('src');
    button.disabled = false;
  }
}
qr.addEventListener('error', () => qr.removeAttribute('src'));
button.addEventListener('click', () => refresh(button.textContent !== '刷新状态'));
refresh();
`;

function ipv4Number(address) {
  return address.split('.').reduce((number, part) => number * 256 + Number(part), 0);
}

function addressRange(cidr) {
  if (typeof cidr !== 'string' || !/^\d+\.\d+\.\d+\.\d+\/\d{1,2}$/u.test(cidr)) return;
  const [address, prefix] = cidr.split('/');
  if (!isIPv4(address) || Number(prefix) > 32) return;
  const size = 2 ** (32 - Number(prefix));
  const first = Math.floor(ipv4Number(address) / size) * size;
  return { first, last: first + size - 1 };
}

const privateRanges = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'].map(addressRange);

function includesAddress({ first, last }, address) {
  return first <= address && address <= last;
}

export function readQrWebConfig(file = 'local/bridge.json') {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const { qrWeb } = JSON.parse(raw);
  if (qrWeb === undefined || qrWeb === false) return;
  const origin = new URL(qrWeb?.origin);
  if (origin.protocol !== 'http:' || origin.origin !== qrWeb.origin || !isIPv4(origin.hostname)) {
    throw new Error('qrWeb requires an HTTP origin with a private IPv4 address');
  }
  const range = addressRange(qrWeb.network);
  if (qrWeb.network !== undefined && (!range || !privateRanges.some(privateRange =>
    includesAddress(privateRange, range.first) && includesAddress(privateRange, range.last)))) {
    throw new Error('qrWeb.network must be a private IPv4 subnet when specified');
  }
  const ranges = range ? [range] : privateRanges;
  const host = ipv4Number(origin.hostname);
  if (!ranges.some(allowed => includesAddress(allowed, host))) {
    throw new Error('qrWeb origin must be inside an allowed private IPv4 subnet');
  }
  return { origin: origin.origin, authority: origin.host, ranges };
}

export async function startQrWeb(config, login, { port = 8765, host = '0.0.0.0' } = {}) {
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    const respond = (code, body, mime = 'text/plain') => {
      res.writeHead(code, {
        'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      }).end(body);
    };
    const peer = req.socket.remoteAddress?.replace(/^::ffff:/u, '');
    const address = isIPv4(peer ?? '') ? ipv4Number(peer) : -1;
    if (req.headers.host !== config.authority || !config.ranges.some(range => includesAddress(range, address))) {
      return respond(403, 'Forbidden');
    }
    const state = ({ phase }) => respond(200, JSON.stringify({ state: phase }), 'application/json');
    if (req.method === 'POST' && req.url === '/start') {
      if (req.headers.origin !== config.origin) return respond(403, 'Forbidden');
      return state(login.begin());
    }
    if (req.method === 'GET') {
      if (req.url === '/') return respond(200, PAGE, 'text/html; charset=utf-8');
      if (req.url === '/page.js') return respond(200, SCRIPT, 'text/javascript; charset=utf-8');
      if (req.url === '/state') return state(login.status());
      if (req.url === '/qr.png') {
        const { png } = login.status();
        return png ? respond(200, png, 'image/png') : respond(404, 'No current QR');
      }
    }
    return respond(404, 'Not found');
  });
  server.setTimeout(10000, socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
