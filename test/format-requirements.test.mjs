import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.mjs';

const base = {
  type: 'project', contactName: 'Иван Иванов', email: 'ivan@example.org',
  phone: '+7 999 123-45-67', company: 'ООО Мебель', city: 'Москва',
  website: '', requisites: 'Расчётный счёт 1234567890', termsAccepted: true, consent: true,
};
const pdf = purpose => ({ name: 'file.pdf', type: 'application/pdf', purpose, data: Buffer.from('%PDF-1.4\nfixture').toString('base64') });
const photo = (purpose = 'photo', name = 'photo.jpg') => ({ name, type: 'image/jpeg', purpose, data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') });

async function setup(t) {
  const sent = [];
  const server = createServer({ env: { RESEND_API_KEY: 'test-only', MAIL_FROM: 'Dealers <dealers@example.org>' }, fetchImpl: async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true };
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/applications`;
  return { sent, submit: body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
}

test('проектной организации достаточно сайта или отдельного файла завершённого проекта', async t => {
  const app = await setup(t);
  assert.equal((await app.submit({ ...base, website: 'studio.example.org' })).status, 200);
  assert.equal((await app.submit({ ...base, attachments: [pdf('project')] })).status, 200);
  assert.equal(app.sent[2].attachments[0].content, pdf('project').data);
  assert.equal(app.sent[2].attachments[0].purpose, undefined);
  assert.match(app.sent[2].text, /file\.pdf — завершённый проект/);
  assert.equal((await app.submit({ ...base, attachments: [photo('project')] })).status, 200);
  assert.equal((await app.submit({ ...base, website: 'studio.example.org', attachments: [pdf('project')] })).status, 200);
});

test('реквизиты и фотографии магазина не заменяют завершённый проект', async t => {
  const app = await setup(t);
  for (const data of [base, { ...base, attachments: [pdf('requisites')] }, { ...base, attachments: [photo('photo')] }, { ...base, website: 'not a valid link', attachments: [pdf('project')] }]) {
    assert.equal((await app.submit(data)).status, 422);
  }
  assert.equal(app.sent.length, 0);
});

test('интернет-магазину нужен сайт даже при наличии проекта', async t => {
  const app = await setup(t);
  assert.equal((await app.submit({ ...base, type: 'online', attachments: [pdf('project')] })).status, 422);
  assert.equal((await app.submit({ ...base, type: 'online', website: 'store.example.org' })).status, 200);
});

test('салону нужны адрес и две фотографии, файл проекта не считается фото', async t => {
  const app = await setup(t);
  assert.equal((await app.submit({ ...base, type: 'showroom', address: '', attachments: [photo(), photo('photo', 'inside.jpg')] })).status, 422);
  assert.equal((await app.submit({ ...base, type: 'showroom', address: 'Москва, улица Ленина, 1', attachments: [photo(), photo('project', 'project.jpg')] })).status, 422);
  assert.equal((await app.submit({ ...base, type: 'showroom', address: 'Москва, улица Ленина, 1', attachments: [photo(), photo('photo', 'inside.jpg')] })).status, 200);
});

test('файлы проектов проходят обычную проверку типа и подписи', async t => {
  const app = await setup(t);
  const unsupported = { name: 'project.txt', type: 'text/plain', purpose: 'project', data: Buffer.from('not an allowed file').toString('base64') };
  const spoofed = { ...pdf('project'), type: 'image/jpeg' };
  assert.equal((await app.submit({ ...base, attachments: [unsupported] })).status, 422);
  assert.equal((await app.submit({ ...base, attachments: [spoofed] })).status, 422);
  assert.equal(app.sent.length, 0);
});
