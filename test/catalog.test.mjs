import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.mjs';
import { readCatalog, CatalogUnavailable } from '../catalog.mjs';

const valid = {
  type: 'project', contactName: 'Иван Иванов', email: 'ivan@example.org',
  phone: '+7 999 123-45-67', company: 'ООО Мебель', city: 'Москва',
  website: 'studio.example.org', requisites: 'Расчётный счёт 1234567890', termsAccepted: true, consent: true,
};
const product = { sku: 'УТ00001', name: 'Стул тестовый', category: 'Стулья', retailPrice: 1999.99, wholesalePrice: 1200, image: 'https://stoolgroup.ru/images/1.webp', characteristics: { Материал: 'Букле', Высота: '80 см' } };

async function setup(t, source = { updatedAt: '2020-10-01', products: [product] }) {
  const dir = await mkdtemp(join(tmpdir(), 'dealer-catalog-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'catalog.json');
  if (source !== null) await writeFile(path, JSON.stringify(source));
  const sent = [];
  const server = createServer({ catalogPath: path, env: { RESEND_API_KEY: 'test-only', MAIL_FROM: 'Dealers <dealers@example.org>' }, fetchImpl: async (_url, options) => {
    sent.push(JSON.parse(options.body));
    return { ok: true };
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { path, sent, base, get: () => fetch(`${base}/api/catalog`), submit: body => fetch(`${base}/api/applications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
}

test('catalog API returns normalized server prices and reloads an atomically replaced snapshot', async t => {
  const app = await setup(t, { updatedAt: '2020-10-01', products: [{ ...product, hiddenCost: 55, image: 'https://evil.example/a.png' }] });
  const response = await app.get();
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.updatedAt, '2020-10-01');
  assert.equal(result.products.length, 1);
  assert.equal(result.products[0].retailPrice, 1999.99);
  assert.equal(result.products[0].wholesalePrice, 1200);
  assert.equal(result.products[0].image, null);
  assert.equal(result.products[0].hiddenCost, undefined);
  assert.deepEqual(result.products[0].characteristics, [{ name: 'Материал', value: 'Букле' }, { name: 'Высота', value: '80 см' }]);
  const nextPath = app.path + '.new';
  await writeFile(nextPath, JSON.stringify({ updatedAt: '2020-11-01', products: [{ ...product, wholesalePrice: 1350 }] }));
  await rename(nextPath, app.path);
  const next = await (await app.get()).json();
  assert.equal(next.updatedAt, '2020-11-01');
  assert.equal(next.products[0].wholesalePrice, 1350);
  assert.equal(next.products[0].image, product.image);
});

test('preorder email uses canonical product name and prices, ignoring client tampering', async t => {
  const app = await setup(t);
  const response = await app.submit({ ...valid, orderItems: [{ sku: product.sku, quantity: 2, name: 'Fake name', wholesalePrice: 1, retailPrice: 1 }] });
  assert.equal(response.status, 200);
  assert.equal(app.sent.length, 2);
  assert.match(app.sent[0].text, /ПРЕДВАРИТЕЛЬНЫЙ ЗАКАЗ/);
  assert.match(app.sent[0].text, /Стул тестовый · артикул УТ00001 · 2 шт/);
  assert.match(app.sent[0].text, /1\s?999,99 ₽/);
  assert.match(app.sent[0].text, /1\s?200 ₽/);
  assert.doesNotMatch(app.sent[0].text, /Fake name/);
  assert.match(app.sent[0].text, /не является резервом/);
  assert.match(app.sent[1].text, /Вашу заявку/);
});

test('invalid, repeated, oversized or unknown SKU selections never send any emails', async t => {
  const app = await setup(t);
  for (const orderItems of [
    'not-an-array', [{ sku: 'missing', quantity: 1 }], [{ sku: product.sku, quantity: 0 }],
    [{ sku: product.sku, quantity: 1000 }], [{ sku: product.sku, quantity: 1.5 }], [{ sku: product.sku, quantity: '1' }],
    [{ sku: product.sku, quantity: 1 }, { sku: product.sku, quantity: 1 }], [{ sku: `${product.sku}\n`, quantity: 1 }],
    Array.from({ length: 51 }, (_, i) => ({ sku: `sku${i}`, quantity: 1 })),
  ]) assert.equal((await app.submit({ ...valid, orderItems })).status, 422);
  assert.equal(app.sent.length, 0);
});

test('missing or malformed catalog returns 503, while applications without preorder still work', async t => {
  const app = await setup(t, null);
  assert.equal((await app.get()).status, 503);
  assert.equal((await app.submit({ ...valid, orderItems: [{ sku: product.sku, quantity: 1 }] })).status, 503);
  assert.equal(app.sent.length, 0);
  assert.equal((await app.submit({ ...valid, orderItems: [] })).status, 200);
  assert.equal(app.sent.length, 2);
  await writeFile(app.path, '{ broken json');
  assert.equal((await app.get()).status, 503);
});

test('future, invalid, duplicate and unsafe catalog records are rejected as a whole', async t => {
  const app = await setup(t);
  const invalid = [
    { updatedAt: '2999-01-01', products: [product] },
    { updatedAt: '2020-02-30', products: [product] },
    { updatedAt: '2020-10-01', products: [product, product] },
    { updatedAt: '2020-10-01', products: [{ ...product, wholesalePrice: '1' }] },
    { updatedAt: '2020-10-01', products: [{ ...product, retailPrice: -1 }] },
    { updatedAt: '2020-10-01', products: [{ ...product, name: 'Bad\nName' }] },
    { updatedAt: '2020-10-01', products: [] },
  ];
  for (const source of invalid) {
    await writeFile(app.path, JSON.stringify(source));
    await assert.rejects(readCatalog(app.path), CatalogUnavailable);
    assert.equal((await app.get()).status, 503);
  }
});
