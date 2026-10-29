import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createTLSServer } from 'node:tls';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { smtpOptions } from '../smtp.mjs';
import { createServer } from '../server.mjs';
import { checkSmtp } from '../scripts/check-mail.mjs';

const configured = { MAIL_TRANSPORT: 'smtp', SMTP_USER: 'dealers@example.org', SMTP_PASSWORD: 'local-test-password', MAIL_FROM: 'Stool Group <dealers@example.org>' };
const valid = { type: 'project', contactName: 'Иван Иванов', email: 'client@example.org', phone: '+7 999 123-45-67', company: 'ООО Мебель', city: 'Москва', requisites: 'Расчётный счёт 1234567890', termsAccepted: true, consent: true };
const pdf = { name: 'company.pdf', type: 'application/pdf', purpose: 'requisites', data: Buffer.from('%PDF-1.4\nlocal test attachment').toString('base64') };

async function appFor(t, options = {}) {
  const server = createServer({ env: configured, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, submit: data => fetch(`${url}/api/applications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? valid) }) };
}

test('SMTP defaults to Mail.ru implicit TLS and 587 requires STARTTLS', () => {
  const tls = smtpOptions(configured);
  assert.equal(tls.host, 'smtp.mail.ru');
  assert.equal(tls.port, 465);
  assert.equal(tls.secure, true);
  assert.equal(tls.tls.rejectUnauthorized, true);
  assert.equal(tls.tls.minVersion, 'TLSv1.2');
  assert.equal(tls.tls.servername, 'smtp.mail.ru');
  for (const key of ['connectionTimeout', 'greetingTimeout', 'socketTimeout', 'dnsTimeout']) assert.ok(tls[key] > 0 && tls[key] <= 15_000);
  const starttls = smtpOptions({ ...configured, SMTP_PORT: '587' });
  assert.equal(starttls.secure, false);
  assert.equal(starttls.requireTLS, true);
  assert.equal(starttls.tls.rejectUnauthorized, true);
  for (const env of [{ SMTP_PORT: '25' }, { SMTP_PORT: '465x' }, { SMTP_HOST: 'smtp://mail.ru' }, { SMTP_HOST: 'smtp.mail.ru:465' }, { SMTP_USER: 'bad\r\nuser' }, { SMTP_PASSWORD: '' }, { MAIL_FROM: 'a@example.org\r\nBcc: b@example.org' }]) assert.throws(() => smtpOptions({ ...configured, ...env }));
});

test('Nodemailer factory receives secure options and manager/client payloads map correctly', async t => {
  const sent = [];
  let options;
  const app = await appFor(t, { smtpTransportFactory: config => { options = config; return { sendMail: async message => { sent.push(message); return { accepted: message.to, rejected: [] }; } }; }, fetchImpl: () => assert.fail('SMTP must not fall back to Resend') });
  assert.equal((await app.submit({ ...valid, attachments: [pdf] })).status, 200);
  assert.equal(options.auth.user, configured.SMTP_USER);
  assert.equal(options.auth.pass, configured.SMTP_PASSWORD);
  assert.deepEqual(sent[0].to, ['petrochenko_s@stoolgroup.ru']);
  assert.equal(sent[0].replyTo, valid.email);
  assert.equal(sent[1].replyTo, 'petrochenko_s@stoolgroup.ru');
  assert.deepEqual(sent[1].to, [valid.email]);
  assert.match(sent[1].text, /100 SKU/);
  assert.equal(Buffer.isBuffer(sent[0].attachments[0].content), true);
  assert.equal(sent[0].attachments[0].content.toString(), Buffer.from(pdf.data, 'base64').toString());
  assert.equal(sent[0].attachments[0].contentType, 'application/pdf');
  assert.equal(sent[0].attachments[0].purpose, undefined);
  assert.match(sent[0].messageId, /^<dealer-manager-[a-f0-9]{64}@example.org>$/);
});

test('explicit SMTP never falls back when credentials or TLS configuration are invalid', async t => {
  for (const env of [{ ...configured, RESEND_API_KEY: 'do-not-use', SMTP_PASSWORD: '' }, { ...configured, SMTP_PORT: '25' }, { ...configured, MAIL_TRANSPORT: 'smpt', RESEND_API_KEY: 'do-not-use' }]) {
    const app = await appFor(t, { env, smtpTransportFactory: () => assert.fail('Invalid SMTP config'), fetchImpl: () => assert.fail('No Resend fallback') });
    const response = await app.submit();
    assert.equal(response.status, 503);
    const health = await (await fetch(`${app.url}/api/health`)).json();
    assert.deepEqual(health, { status: 'ok', mailConfigured: false });
    assert.equal(JSON.stringify(health).includes(configured.SMTP_PASSWORD), false);
  }
});

test('SMTP rejected recipient and provider failures are sanitized with no false success', async t => {
  for (const sendMail of [async () => ({ accepted: [], rejected: ['client@example.org'] }), async () => { throw new Error(`auth secret ${configured.SMTP_PASSWORD}`); }]) {
    const app = await appFor(t, { smtpTransportFactory: () => ({ sendMail }) });
    const response = await app.submit();
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.equal(text.includes(configured.SMTP_PASSWORD), false);
    assert.equal(text.includes('"success":false'), true);
  }
});

test('SMTP partial failure retry skips manager and complete retry skips both messages', async t => {
  const sent = [];
  const app = await appFor(t, { smtpTransportFactory: () => ({ sendMail: async message => { sent.push(message); if (sent.length === 2) return { accepted: [], rejected: message.to }; return { accepted: message.to, rejected: [] }; } }) });
  const response = await app.submit();
  assert.equal(response.status, 502);
  assert.match((await response.json()).message, /Заявка передана Семёну/);
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 200);
  assert.equal(sent.length, 3);
  assert.equal(sent.filter(message => message.to[0] === 'petrochenko_s@stoolgroup.ru').length, 1);
  assert.equal(sent[1].messageId, sent[2].messageId);
});

test('SMTP concurrent duplicate is locked and stages expire after 24 hours', async t => {
  let timestamp = 1;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  let sends = 0;
  const app = await appFor(t, { now: () => timestamp, smtpTransportFactory: () => ({ sendMail: async message => { sends++; if (sends === 1) { firstStarted(); await blocked; } return { accepted: message.to, rejected: [] }; } }) });
  const first = app.submit();
  await started;
  assert.equal((await app.submit()).status, 409);
  release();
  assert.equal((await first).status, 200);
  timestamp += 24 * 60 * 60_000;
  assert.equal((await app.submit()).status, 200);
  assert.equal(sends, 4);
});

test('mail:check verifies without sending and exposes only sanitized flags', async () => {
  let sends = 0;
  const factory = () => ({ verify: async () => true, sendMail: () => { sends++; } });
  assert.deepEqual(await checkSmtp({ env: configured, transportFactory: factory }), { configured: true, verified: true });
  assert.equal(sends, 0);
  assert.deepEqual(await checkSmtp({ env: { ...configured, SMTP_PASSWORD: '' } }), { configured: false, verified: false, error: 'configuration' });
  for (const [error, category] of [[{ code: 'EAUTH', message: configured.SMTP_PASSWORD }, 'authentication'], [{ code: 'ESOCKET', message: 'self signed certificate' }, 'tls'], [{ code: 'ETIMEDOUT', message: 'connection timeout' }, 'connection']]) {
    const result = await checkSmtp({ env: configured, transportFactory: () => ({ verify: async () => { throw error; } }) });
    assert.deepEqual(result, { configured: true, verified: false, error: category });
    assert.equal(JSON.stringify(result).includes(configured.SMTP_PASSWORD), false);
  }
});

async function localSMTP(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dealer-smtp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=smtp.local.test', '-addext', 'subjectAltName=DNS:smtp.local.test'], { stdio: 'ignore' });
  const key = await readFile(keyPath);
  const cert = await readFile(certPath);
  const messages = [];
  const authenticated = [];
  const sockets = new Set();
  const server = createTLSServer({ key, cert }, socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('220 smtp.local.test ESMTP test-only\r\n');
    let buffer = '';
    let data = null;
    socket.on('data', chunk => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data) {
          if (line === '.') { messages.push(data.join('\r\n')); data = null; socket.write('250 2.0.0 queued locally\r\n'); }
          else data.push(line.replace(/^\.\./, '.'));
        } else if (/^EHLO /i.test(line)) socket.write('250-smtp.local.test\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /i.test(line)) { authenticated.push(Buffer.from(line.slice(11), 'base64').toString()); socket.write('235 2.7.0 authenticated\r\n'); }
        else if (/^(MAIL FROM:|RCPT TO:)/i.test(line)) socket.write('250 2.1.0 accepted\r\n');
        else if (line === 'DATA') { data = []; socket.write('354 End with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { messages, authenticated, factory: options => nodemailer.createTransport({ ...options, host: '127.0.0.1', port: server.address().port, tls: { ...options.tls, servername: 'smtp.local.test', ca: cert } }) };
}

test('actual Nodemailer authenticates over verified local TLS, serializes attachments, and sends both emails locally', async t => {
  const smtp = await localSMTP(t);
  const checked = await checkSmtp({ env: configured, transportFactory: smtp.factory });
  assert.deepEqual(checked, { configured: true, verified: true });
  assert.equal(smtp.messages.length, 0);
  const app = await appFor(t, { smtpTransportFactory: smtp.factory });
  assert.equal((await app.submit({ ...valid, attachments: [pdf] })).status, 200);
  assert.equal(smtp.messages.length, 2);
  assert.ok(smtp.authenticated.every(value => value === `\0${configured.SMTP_USER}\0${configured.SMTP_PASSWORD}`));
  assert.match(smtp.messages[0], /Content-Type: application\/pdf/);
  assert.match(smtp.messages[0], /filename=company.pdf/);
  assert.ok(smtp.messages[0].includes(pdf.data));
  assert.match(smtp.messages[0], /To: petrochenko_s@stoolgroup.ru/);
  assert.match(smtp.messages[1], /To: client@example.org/);
});
