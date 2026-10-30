import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./scripts/sync-catalog.py', import.meta.url));
const SIX_HOURS = 6 * 60 * 60 * 1000;

// This is deliberately opt-out: a running production server checks the
// public source on startup, every six hours, and shortly after Moscow midnight.
// A failed update leaves the last successful catalog untouched.
export function startCatalogSync({ env = process.env, run = spawn, logger = console, interval = SIX_HOURS } = {}) {
  if (env.CATALOG_AUTO_SYNC === '0') return () => {};
  let stopped = false;
  let child = null;
  let timer = null;
  function nextDelay() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const get = type => Number(parts.find(x => x.type === type)?.value || 0);
    const seconds = get('hour') * 3600 + get('minute') * 60 + get('second');
    return Math.min(interval, (86400 - seconds + 60) * 1000);
  }
  function schedule() {
    if (!stopped) { timer = setTimeout(check, nextDelay()); timer.unref?.(); }
  }
  function check() {
    if (stopped || child) return;
    // Inherited proxy and trust configuration are kept. SMTP credentials and
    // unrelated environment variables are not passed to the catalog worker.
    const safeEnv = {};
    for (const name of ['PATH', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE']) {
      if (typeof env[name] === 'string') safeEnv[name] = env[name];
    }
    try {
      child = run('python3', [script], { env: safeEnv, stdio: ['ignore', 'ignore', 'ignore'] });
      let finished = false;
      const done = code => {
        if (finished) return;
        finished = true;
        child = null;
        if (code !== 0) logger.warn('Не удалось полностью обновить прайс; проверьте дату данных на сайте.');
        schedule();
      };
      child.once('error', () => done(1));
      child.once('exit', code => done(code));
    } catch {
      child = null;
      logger.warn('Не удалось запустить обновление прайса; проверьте дату данных на сайте.');
      schedule();
    }
  }
  check();
  return () => { stopped = true; clearTimeout(timer); child?.kill(); };
}
