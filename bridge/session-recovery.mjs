import { setTimeout } from 'node:timers/promises';

const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000];
const READ_FAULT = /^NEO_READ:(read_unavailable|auth_required|account_interrupted|service_rejected)(?::(-?\d{1,10}))?$/u;

export function sessionRecovery(report, wait = (ms, signal) => setTimeout(ms, undefined, { signal })) {
  const controller = new AbortController();
  const { signal } = controller;
  let reconnecting = false;

  async function read(stage, operation) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let result;
      try { result = await operation(); }
      catch (error) {
        signal.throwIfAborted();
        const fault = error instanceof Error ? READ_FAULT.exec(error.message) : null;
        const category = fault?.[1] ?? 'unclassified';
        const serviceCode = fault?.[2] === undefined ? undefined : Number(fault[2]);
        const detail = { stage, category, ...(serviceCode === undefined ? {} : { serviceCode }) };
        const delayMs = RETRY_DELAYS[attempt];
        if (category !== 'read_unavailable' || delayMs === undefined) {
          report({ event: 'wechat_read_failed', ...detail, retries: attempt });
          throw error;
        }
        reconnecting = true;
        report({ event: 'wechat_reconnecting', ...detail, retry: attempt + 1, delayMs });
        await wait(delayMs, signal);
        continue;
      }
      signal.throwIfAborted();
      if (reconnecting) {
        reconnecting = false;
        report({ event: 'wechat_reconnected', stage, retries: attempt });
      }
      return result;
    }
  }

  return {
    read,
    get reconnecting() { return reconnecting; },
    abort() { controller.abort(); },
  };
}
