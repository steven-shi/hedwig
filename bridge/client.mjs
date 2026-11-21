import http from 'node:http';
import { BridgeError } from './errors.mjs';

export class AiClient {
  constructor(socketPath) { this.socketPath = socketPath; }
  async settings() {
    return new Promise((resolve, reject) => {
      const req = http.get({ socketPath: this.socketPath, path: '/healthz',
        signal: AbortSignal.timeout(2000) }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', part => {
          body += part;
          if (body.length > 1024) res.destroy(new Error('Invalid AI settings'));
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const status = JSON.parse(body);
            if (res.statusCode !== 200 || status.ok !== true || typeof status.groupsEnabled !== 'boolean') {
              throw new Error('Invalid AI settings');
            }
            resolve({ groupsEnabled: status.groupsEnabled });
          } catch { reject(new Error('Cannot read AI settings')); }
        });
      });
      req.on('error', reject);
    });
  }
  request(envelope, signal) {
    return new Promise((resolve, reject) => {
      const remaining = envelope.deadlineAt - Date.now();
      if (remaining <= 0) return reject(new BridgeError('AI_TIMEOUT', '请求已过期'));
      let settled = false;
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      const req = http.request({
        socketPath: this.socketPath, path: '/v1/respond', method: 'POST', signal,
        headers: { 'content-type': 'application/json' },
      }, res => {
        let size = 0; const parts = [];
        res.on('data', part => {
          size += part.length;
          if (size > 65536) { finish(new BridgeError('AI_PROTOCOL', 'AI 回复超过长度限制')); res.destroy(); return; }
          parts.push(part);
        });
        res.on('error', () => finish(new BridgeError('AI_TRANSPORT', 'AI 回复连接中断')));
        res.on('end', () => {
          if (settled) return;
          let body;
          try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
          catch { return finish(new BridgeError(res.statusCode === 200 ? 'AI_PROTOCOL' : 'AI_HTTP', res.statusCode === 200 ? 'AI 返回了无效 JSON' : 'AI 服务返回非成功状态', { status: res.statusCode })); }
          if (!body || typeof body !== 'object' || Array.isArray(body) || body.version !== 1 || body.requestId !== envelope.requestId) return finish(new BridgeError('AI_PROTOCOL', 'AI 回复版本或请求编号不匹配'));
          if (res.statusCode === 200 && body.discard === true) return finish(null, null);
          if (body.error) {
            const e = body.error;
            const code = typeof e.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code) ? e.code : 'AI_UPSTREAM';
            return finish(new BridgeError(code, typeof e.detail === 'string' ? e.detail : 'AI 服务失败', {
              provider: typeof e.provider === 'string' ? e.provider : '',
              model: typeof e.model === 'string' ? e.model : '',
              status: Number.isInteger(e.status) ? e.status : res.statusCode,
            }));
          }
          if (res.statusCode !== 200) return finish(new BridgeError('AI_HTTP', 'AI 服务返回非成功状态', { status: res.statusCode }));
          if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) return finish(new BridgeError('AI_PROTOCOL', 'AI 回复必须为 1–4000 字符的文字'));
          finish(null, body.text);
        });
      });
      const timer = setTimeout(() => {
        finish(new BridgeError('AI_TIMEOUT', 'AI 请求超时，已丢弃')); req.destroy();
      }, remaining);
      req.on('error', error => finish(new BridgeError(
        error.name === 'AbortError' ? 'AI_CANCELLED' : 'AI_UNAVAILABLE',
        error.name === 'AbortError' ? '请求已取消' : '无法连接独立 AI 服务',
      )));
      req.end(JSON.stringify(envelope));
    });
  }
}
