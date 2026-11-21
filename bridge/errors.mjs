export class BridgeError extends Error {
  constructor(code, detail, meta = {}) {
    super(detail); this.code = code; this.meta = meta;
  }
}
export function redact(value = '') {
  return String(value)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL REDACTED]')
    .replace(/[\r\n]/g, ' ').slice(0, 500);
}
export function describe(error) {
  const known = error instanceof BridgeError;
  return {
    code: known ? error.code : 'AI_INTERNAL',
    detail: known ? redact(error.message) : 'AI 通信发生未分类错误',
    provider: redact(error?.meta?.provider ?? ''),
    model: redact(error?.meta?.model ?? ''),
    status: Number.isInteger(error?.meta?.status) ? error.meta.status : undefined,
  };
}
