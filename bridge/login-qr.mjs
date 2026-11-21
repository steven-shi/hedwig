import { readFileSync, statSync } from 'node:fs';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import terminal from 'qrcode-terminal';

const path = process.env.BRIDGE_QR_FILE ?? '/run/neo/login.png';
try {
  const status = readFileSync(path + '.status', 'utf8').trim();
  if (status === 'online') {
    console.log('微信已登录。');
  } else if (status !== 'waiting') {
    console.error(status === 'offline' ? '桥接已离线。' : '二维码还在准备中，请稍后再试。');
    process.exitCode = 1;
  } else {
    const { mtimeMs, size } = statSync(path);
    if (Date.now() - mtimeMs >= 120000) throw new Error('expired');
    if (size > 1024 * 1024) throw new Error('invalid');
    const png = PNG.sync.read(readFileSync(path));
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    if (!code?.data) throw new Error('invalid');
    terminal.generate(code.data, { small: true });
  }
} catch (error) {
  console.error(error.message === 'expired' ? '二维码已过期。请重新启动桥接生成新码。' :
    '当前没有可显示的二维码，请检查桥接状态。');
  process.exitCode = 1;
}
