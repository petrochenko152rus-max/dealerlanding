import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startCatalogSync } from '../catalog-sync.mjs';

test('automatic refresh does not pass SMTP credentials to the importer', () => {
  let captured;
  let killed = false;
  const child = new EventEmitter();
  child.kill = () => { killed = true; };
  const stop = startCatalogSync({
    env: { PATH: '/test/bin', HTTPS_PROXY: 'http://proxy.invalid', SMTP_PASSWORD: 'not-for-child', MAIL_FROM: 'test@example.org' },
    run: (command, args, options) => { captured = { command, args, options }; return child; },
  });
  assert.equal(captured.command, 'python3');
  assert.match(captured.args[0], /scripts\/sync-catalog\.py$/);
  assert.equal(captured.options.env.PATH, '/test/bin');
  assert.equal(captured.options.env.HTTPS_PROXY, 'http://proxy.invalid');
  assert.equal(captured.options.env.SMTP_PASSWORD, undefined);
  assert.equal(captured.options.env.MAIL_FROM, undefined);
  stop();
  assert.equal(killed, true);
});

test('automatic refresh can be explicitly disabled', () => {
  let calls = 0;
  const stop = startCatalogSync({ env: { CATALOG_AUTO_SYNC: '0' }, run: () => { calls++; } });
  assert.equal(calls, 0);
  stop();
});
