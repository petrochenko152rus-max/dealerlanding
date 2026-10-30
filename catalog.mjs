import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('./data/catalog.json', import.meta.url));
const MAX_CATALOG_BYTES = 64 * 1024 * 1024;
const MAX_PRODUCTS = 50_000;
const MAX_PRICE = 1_000_000_000;
const MAX_SKUS = 50;
const MAX_QUANTITY = 999;
const ALLOWED_IMAGE_HOSTS = new Set(['stoolgroup.ru', 'www.stoolgroup.ru']);

export class CatalogUnavailable extends Error {
  constructor() { super('Каталог сейчас недоступен. Попробуйте позже или откройте исходные прайс-листы.'); this.status = 503; }
}
export class CatalogInputError extends Error {
  constructor(message) { super(message); this.status = 422; }
}

function safeText(value, max, { required = false } = {}) {
  if (value === null || value === undefined) {
    if (required) throw new CatalogUnavailable();
    return '';
  }
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new CatalogUnavailable();
  const text = value.trim();
  if (required && !text) throw new CatalogUnavailable();
  return text;
}
function safeSku(value) {
  const sku = safeText(value, 128, { required: true });
  if (sku !== value) throw new CatalogUnavailable();
  return sku;
}
function safePrice(value) {
  if (value === null || value === undefined || value === 0) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_PRICE || Math.abs(Math.round(value * 100) - value * 100) > 1e-6) throw new CatalogUnavailable();
  return value;
}
function safeImage(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    // The browser may only request local assets or the retailer's own HTTPS host.
    if (value.startsWith('/assets/') && !value.startsWith('//')) {
      const url = new URL(value, 'https://catalog.invalid');
      return url.origin === 'https://catalog.invalid' && url.pathname.startsWith('/assets/') ? url.pathname + url.search : null;
    }
    const url = new URL(value);
    if (url.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(url.hostname.toLowerCase()) || url.username || url.password || (url.port && url.port !== '443')) return null;
    return url.href;
  } catch { return null; }
}
function safeCharacteristics(value) {
  if (value === undefined || value === null) return [];
  let pairs;
  if (Array.isArray(value)) {
    pairs = value.map(item => typeof item === 'string' ? ['', item] : [item?.name ?? item?.label ?? '', item?.value ?? '']);
  } else if (typeof value === 'object') {
    pairs = Object.entries(value);
  } else throw new CatalogUnavailable();
  if (pairs.length > 100) throw new CatalogUnavailable();
  return pairs.slice(0, 30).map(([name, item]) => {
    const label = safeText(name, 100);
    // Numbers in source characteristics (e.g. 80 cm) are display data, not prices.
    const raw = typeof item === 'number' && Number.isFinite(item) ? String(item) : item;
    return { name: label, value: safeText(raw, 300) };
  }).filter(item => item.value);
}
function safeDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw new CatalogUnavailable();
  const datePart = value.slice(0, 10);
  const midnight = Date.parse(`${datePart}T00:00:00Z`);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== datePart || !Number.isFinite(Date.parse(value))) throw new CatalogUnavailable();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (datePart > today) throw new CatalogUnavailable();
  return value;
}

// Read one snapshot from a fixed, server-controlled path. Importers should write
// a temporary file and rename it atomically so requests never see partial JSON.
export async function readCatalog(path = DEFAULT_CATALOG_PATH) {
  let file;
  try {
    file = await open(resolve(path), 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CATALOG_BYTES) throw new CatalogUnavailable();
    const bytes = await file.readFile();
    if (bytes.length > MAX_CATALOG_BYTES) throw new CatalogUnavailable();
    const source = JSON.parse(bytes.toString('utf8'));
    if (!source || typeof source !== 'object' || Array.isArray(source) || !Array.isArray(source.products) || !source.products.length || source.products.length > MAX_PRODUCTS) throw new CatalogUnavailable();
    const updatedAt = safeDate(source.updatedAt);
    const products = [];
    const bySku = new Map();
    for (const raw of source.products) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CatalogUnavailable();
      const sku = safeSku(raw.sku);
      if (bySku.has(sku)) throw new CatalogUnavailable();
      const product = {
        sku,
        article: safeText(raw.article, 128),
        name: safeText(raw.name, 240, { required: true }),
        category: safeText(raw.category, 120),
        retailPrice: safePrice(raw.retailPrice),
        wholesalePrice: safePrice(raw.wholesalePrice),
        image: safeImage(raw.image),
        priceDate: raw.priceDate ? safeDate(raw.priceDate) : updatedAt,
        stockDate: raw.stockDate ? safeDate(raw.stockDate) : null,
        characteristics: safeCharacteristics(raw.characteristics),
      };
      products.push(product);
      bySku.set(sku, product);
    }
    return { products, bySku, updatedAt };
  } catch (error) {
    if (error instanceof CatalogUnavailable) throw error;
    throw new CatalogUnavailable();
  } finally {
    await file?.close();
  }
}

export function parseOrderItems(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_SKUS) throw new CatalogInputError('В предварительном заказе может быть не более 50 товаров.');
  const seen = new Set();
  return input.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.sku !== 'string' || !item.sku || item.sku !== item.sku.trim() || item.sku.length > 128 || /[\u0000-\u001f\u007f]/.test(item.sku) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > MAX_QUANTITY) throw new CatalogInputError('Проверьте артикулы и количество товаров в предварительном заказе.');
    if (seen.has(item.sku)) throw new CatalogInputError('Удалите повторяющиеся товары из предварительного заказа.');
    seen.add(item.sku);
    return { sku: item.sku, quantity: item.quantity };
  });
}

export function resolveOrderItems(items, catalog) {
  return items.map(item => {
    const product = catalog.bySku.get(item.sku);
    if (!product) throw new CatalogInputError('Некоторые товары больше не доступны в каталоге. Обновите страницу и проверьте предварительный заказ.');
    return { sku: product.sku, article: product.article, name: product.name, quantity: item.quantity, retailPrice: product.retailPrice, wholesalePrice: product.wholesalePrice };
  });
}
