import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function runLogoutAlert(log, localDirectory = 'local') {
  let script;
  try {
    const config = JSON.parse(readFileSync(resolve(localDirectory, 'bridge.json'), 'utf8'));
    script = config.alertScript;
    if (script === undefined || script === '') return;
    if (typeof script !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(script)) {
      throw new Error('Expected a filename in local/');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') log({ event: 'logout_alert_config_invalid' });
    return;
  }
  const child = spawn(resolve(localDirectory, script), ['wechat_logout', new Date().toISOString()], { stdio: 'ignore' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 12000);
  timer.unref();
  // A failed launch still emits close. Keep child output out of bridge logs.
  child.on('error', () => {});
  child.once('close', code => {
    clearTimeout(timer);
    if (code !== 0) log({ event: 'logout_alert_failed' });
  });
}
