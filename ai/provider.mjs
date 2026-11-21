import { BridgeError } from '../bridge/errors.mjs';
const statusReasons = {
  400: '请求参数或上下文不被上游接受', 401: 'API 密钥无效或已失效',
  402: '上游账户余额不足', 403: 'API 权限不足', 404: '模型或接口路径不存在',
  408: '上游请求超时', 429: '上游限流或额度不足',
  500: '上游内部错误', 502: '上游网关错误', 503: '上游暂时不可用', 504: '上游网关超时',
};
const networkCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
async function readJson(response) {
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new BridgeError('AI_PROTOCOL', '上游回复超过大小限制');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); }
  catch { throw new BridgeError('AI_PROTOCOL', '上游返回无效 JSON'); }
}
export class ChatProvider {
  constructor(apiKey) { this.apiKey = apiKey; }
  async chat({ endpoint, model, messages, maxTokens, signal }) {
    let response;
    try {
      response = await fetch(endpoint.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST', redirect: 'error', signal,
        headers: { authorization: 'Bearer ' + this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model, messages, stream: false, max_tokens: maxTokens,
          ...(endpoint.thinkingDisabled ? { thinking: { type: 'disabled' } } : {}),
        }),
      });
    } catch (error) {
      if (signal?.aborted) throw new BridgeError('AI_TIMEOUT', 'AI 请求已超时或取消');
      const code = networkCodes.has(error.cause?.code) ? '（' + error.cause.code + '）' : '';
      throw new BridgeError('AI_NETWORK', '无法连接上游 AI 服务' + code);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BridgeError('AI_UPSTREAM', 'HTTP ' + response.status + '：' + (statusReasons[response.status] ?? '上游请求失败'), { status: response.status });
    }
    const body = await readJson(response);
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new BridgeError('AI_EMPTY_REPLY', '上游未返回可用的文字答案');
    let text = content.trim();
    if (text.length > 3900) {
      text = text.slice(0, 3800);
      const last = text.charCodeAt(text.length - 1);
      if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
      text += '\n（回复过长，已截短）';
    }
    return text;
  }
}
