import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, OFFER } from '../server.mjs';

const valid = { type: 'online', contactName: 'Иван Иванов', email: 'ivan@example.org', phone: '+7 999 123-45-67', company: 'ООО Мебель', city: 'Москва', website: 'shop.example.org', requisites: 'Расчётный счёт 1234567890', termsAccepted: true, consent: true };
const configured = { RESEND_API_KEY: 'test-only', MAIL_FROM: 'Dealers <dealers@example.org>' };

async function setup(t, options = {}) {
  const server = createServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, submit: body => fetch(`${url}/api/applications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
}

test('application sends manager details and a receipt confirmation to the client', async t => {
  const sent = [];
  const app = await setup(t, { env: configured, fetchImpl: async (url, options) => { sent.push({ url, options, body: JSON.parse(options.body) }); return { ok: true }; } });
  const pdf = { name: 'requisites.pdf', type: 'application/pdf', purpose: 'requisites', data: Buffer.from('%PDF-1.4\nfixture').toString('base64') };
  const response = await app.submit({ ...valid, requisites: 'Расчётный счёт 123', attachments: [pdf] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].body.to, ['petrochenko_s@stoolgroup.ru']);
  assert.equal(sent[0].body.reply_to, valid.email);
  assert.match(sent[0].body.text, /Расчётный счёт 123/);
  assert.equal(sent[0].body.attachments[0].content, pdf.data);
  assert.equal(sent[0].body.attachments[0].purpose, undefined);
  assert.match(sent[0].body.text, /requisites.pdf — реквизиты компании/);
  assert.deepEqual(sent[1].body.to, [valid.email]);
  assert.match(sent[1].body.subject, /заявка получена/i);
  assert.match(sent[1].body.text, /заявку по формату.*получили/i);
  assert.match(sent[1].body.text, /скоро свяжусь с вами/i);
  assert.match(sent[1].body.text, /cloud\.mail\.ru\/public\/ED7Y\/Ep5TKqaGm/);
  assert.equal(sent[1].body.text.includes(OFFER), false);
  assert.doesNotMatch(sent[1].body.text, /127\.0\.0\.1|localhost|ССЫЛКА НА ЛЕНДИНГ/);
  assert.match(OFFER, /100 SKU/);
  assert.match(OFFER, /300 000 ₽/);
  assert.match(OFFER, /до 20%/);
  assert.match(OFFER, /рассчитывается отдельно, индивидуально для каждого артикула/);
  assert.equal(sent[0].options.headers['Idempotency-Key'].length, 79);
});

test('confirmation includes only a configured public HTTPS landing URL', async t => {
  for (const [configuredUrl, expectedUrl] of [
    ['https://dealer.stoolgroup.ru/', 'https://dealer.stoolgroup.ru/'],
    ['', null],
    ['http://dealer.stoolgroup.ru/', null],
    ['https://localhost:3000/', null],
    ['https://127.0.0.1/', null],
    ['https://example.test/', null],
    ['https://user:pass@dealer.stoolgroup.ru/', null],
  ]) {
    const sent = [];
    const app = await setup(t, { env: { ...configured, PUBLIC_SITE_URL: configuredUrl }, fetchImpl: async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true }; } });
    assert.equal((await app.submit(valid)).status, 200);
    const confirmation = sent[1].text;
    if (expectedUrl) assert.ok(confirmation.includes(expectedUrl));
    else assert.doesNotMatch(confirmation, /Условия сотрудничества и каталог:/);
  }
});

test('format-specific requirements and consent are enforced before sending', async t => {
  let sends = 0;
  const app = await setup(t, { env: configured, fetchImpl: async () => { sends++; return { ok: true }; } });
  for (const input of [ { ...valid, website: '' }, { ...valid, type: 'showroom', address: '' }, { ...valid, consent: false }, { ...valid, termsAccepted: false }, { ...valid, inn: '123' }, { ...valid, email: 'victim@example.org\r\nBcc: attacker@example.org' } ]) {
    assert.equal((await app.submit(input)).status, 422);
  }
  assert.equal(sends, 0);
});

test('showroom address and project with a website are accepted', async t => {
  const app = await setup(t, { env: configured, fetchImpl: async () => ({ ok: true }) });
  const photo = name => ({ name, type: 'image/jpeg', purpose: 'photo', data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') });
  assert.equal((await app.submit({ ...valid, type: 'showroom', address: 'Москва, улица Ленина, 1', website: '', attachments: [photo('front.jpg'), photo('inside.jpg')] })).status, 200);
  assert.equal((await app.submit({ ...valid, type: 'project', website: 'studio.example.org' })).status, 200);
});

test('company requisites and at least two showroom photos are required', async t => {
  const app = await setup(t, { env: configured, fetchImpl: async () => ({ ok: true }) });
  assert.equal((await app.submit({ ...valid, requisites: '' })).status, 422);
  const pdf = { name: 'company.pdf', type: 'application/pdf', purpose: 'requisites', data: Buffer.from('%PDF-1.4\nfixture').toString('base64') };
  assert.equal((await app.submit({ ...valid, requisites: '', attachments: [pdf] })).status, 200);
  assert.equal((await app.submit({ ...valid, type: 'showroom', address: 'Адрес магазина 123' })).status, 422);
  assert.equal((await app.submit({ ...valid, type: 'showroom', address: 'Адрес магазина 123', attachments: [{ ...pdf, purpose: 'photo' }, { ...pdf, purpose: 'photo' }] })).status, 422);
});

test('unconfigured mail truthfully reports unavailable and health shows configuration state', async t => {
  const app = await setup(t, { env: {} });
  assert.equal((await app.submit(valid)).status, 503);
  const health = await fetch(`${app.url}/api/health`);
  assert.deepEqual(await health.json(), { status: 'ok', mailConfigured: false });
});

test('provider failures never return success and partial failure is explained', async t => {
  let count = 0;
  const app = await setup(t, { env: configured, fetchImpl: async () => ({ ok: ++count === 1 }) });
  const response = await app.submit(valid);
  assert.equal(response.status, 502);
  assert.match((await response.json()).message, /Заявка передана Семёну/);
});

test('attachment content and per-file size are validated', async t => {
  const app = await setup(t, { env: configured, fetchImpl: async () => ({ ok: true }) });
  assert.equal((await app.submit({ ...valid, attachments: [{ name: 'fake.pdf', type: 'application/pdf', purpose: 'requisites', data: Buffer.from('not PDF').toString('base64') }] })).status, 422);
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
  assert.equal((await app.submit({ ...valid, attachments: [{ name: 'big.pdf', type: 'application/pdf', purpose: 'requisites', data: big }] })).status, 422);
});

test('rate limiting, cross-site requests, malformed JSON and private paths are rejected', async t => {
  const app = await setup(t, { env: {} });
  const crossSite = await fetch(`${app.url}/api/applications`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403);
  const malformed = await fetch(`${app.url}/api/applications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  for (let n = 0; n < 9; n++) assert.equal((await app.submit(valid)).status, 503);
  assert.equal((await app.submit(valid)).status, 429);
  assert.equal((await fetch(`${app.url}/.env`)).status, 404);
  assert.equal((await fetch(`${app.url}/%2e%2e%2fserver.mjs`)).status, 404);
});

test('invalid payload shapes, field types, header injection and unsafe URLs are rejected', async t => {
  let sends = 0;
  const app = await setup(t, { env: configured, fetchImpl: async () => { sends++; return { ok: true }; } });
  for (const [input, status] of [
    [null, 400], [[], 400],
    [{ ...valid, contactName: { text: 'Иван' } }, 422],
    [{ ...valid, type: 'constructor' }, 422],
    [{ ...valid, company: 'Company\r\nBcc: attacker@example.org' }, 422],
    [{ ...valid, website: 'https://user:password@example.org' }, 422],
    [{ ...valid, phone: '+7 123' }, 422],
    [{ ...valid, requisites: 'x'.repeat(5001) }, 422],
    [{ ...valid, companyWebsite: 'https://spam.example.org' }, 400],
  ]) assert.equal((await app.submit(input)).status, status);
  assert.equal(sends, 0);
});

test('unsupported content types and oversized JSON bodies are rejected', async t => {
  const app = await setup(t, { env: configured, fetchImpl: async () => { assert.fail('Must not send invalid requests'); } });
  const unsupported = await fetch(`${app.url}/api/applications`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(valid) });
  assert.equal(unsupported.status, 415);
  const oversized = await app.submit({ ...valid, comment: 'x'.repeat(12 * 1024 * 1024) });
  assert.equal(oversized.status, 413);
});

test('invalid attachment purpose, MIME, filename, base64 and file count are rejected', async t => {
  const app = await setup(t, { env: configured, fetchImpl: async () => { assert.fail('Must not send invalid files'); } });
  const pdf = { name: 'company.pdf', type: 'application/pdf', purpose: 'requisites', data: Buffer.from('%PDF-1.4\nfixture').toString('base64') };
  for (const attachments of [
    [{ ...pdf, purpose: 'unknown' }],
    [{ ...pdf, type: '__proto__' }],
    [{ ...pdf, type: {} }],
    [{ ...pdf, name: '../company.pdf' }],
    [{ ...pdf, name: 'company\u0007.pdf' }],
    [{ ...pdf, data: 'not base64!' }],
    Array(6).fill(pdf),
  ]) assert.equal((await app.submit({ ...valid, attachments })).status, 422);
});

test('total attachment size is enforced independently of per-file size', async t => {
  const app = await setup(t, { env: configured, fetchImpl: async () => { assert.fail('Must not send oversized attachments'); } });
  const buffer = Buffer.alloc(2 * 1024 * 1024);
  buffer.write('%PDF-1.4');
  const attachments = Array.from({ length: 4 }, (_, i) => ({ name: `company-${i}.pdf`, type: 'application/pdf', purpose: 'requisites', data: buffer.toString('base64') }));
  const response = await app.submit({ ...valid, attachments });
  assert.equal(response.status, 422);
  assert.match((await response.json()).message, /Общий размер/);
});

test('static server serves only public files and applies browser security headers', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'dealer-static-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const publicDir = join(temp, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><h1>Dealer landing</h1>');
  await writeFile(join(temp, 'private.txt'), 'private configuration');
  await symlink(join(temp, 'private.txt'), join(publicDir, 'leak.txt'));
  const app = await setup(t, { env: {}, publicDir });
  const response = await fetch(app.url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Dealer landing/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal((await fetch(`${app.url}/leak.txt`)).status, 404);
  assert.equal((await fetch(`${app.url}/%2e%2e%2fprivate.txt`)).status, 404);
  assert.equal((await fetch(`${app.url}/.env`)).status, 404);
});
