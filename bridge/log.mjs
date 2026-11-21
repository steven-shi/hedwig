import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 1024 * 1024;

export function eventLogger(service, directory = process.env.HEDWIG_LOG_DIR) {
  const file = directory && join(directory, service + '.log');
  let reportFailure = true;
  return data => {
    const line = JSON.stringify({ time: new Date().toISOString(), ...data });
    console.info(line);
    if (!file) return;
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) + Buffer.byteLength(line) + 1 > MAX_BYTES) {
        renameSync(file, file + '.1');
      }
      appendFileSync(file, line + '\n', { mode: 0o600 });
      reportFailure = true;
    } catch {
      if (reportFailure) console.error(JSON.stringify({ event: 'event_log_write_failed', service }));
      reportFailure = false;
    }
  };
}
