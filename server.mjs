import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createSmtpSender, smtpConfigured } from './smtp.mjs';
import { startCatalogSync } from './catalog-sync.mjs';
import { readCatalog, parseOrderItems, resolveOrderItems, CatalogInputError, CatalogUnavailable } from './catalog.mjs';

const ROOT = resolve(fileURLToPath(new URL('./public', import.meta.url)));
const RECIPIENT = 'petrochenko_s@stoolgroup.ru';
const MAX_BODY = 12 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL_FILES = 7 * 1024 * 1024;
const TYPES = {
  online: 'Интернет-магазин',
  showroom: 'Салон / шоурум',
  project: 'Проектная / комплектующая организация',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

export const OFFER = `Добрый день!

Меня зовут Семён, я руководитель отдела развития Stool Group / Moderli.
Предлагаю вашей компании стать нашим дилером и получить доступ к оптовым ценам на нашу продукцию.

ФОРМАТЫ СОТРУДНИЧЕСТВА

Интернет-магазины
• Необходимо разместить от 100 SKU (товаров) на сайте.
• Предоставляем фото, описания, характеристики, выгрузки YML/CSV и 3D-модели.
• При размещении продукции на сайте закупка — от 1 единицы, минимальной суммы заказа нет.
• Ваша цена в прайс-листе — колонка «Действующая опт».

Салоны / шоурумы
• Необходимо разместить от 5 моделей (разных артикулов) на экспозицию.
• Дополнительная скидка до 20% на выставочные образцы рассчитывается отдельно, индивидуально для каждого артикула.
• Ваша цена в прайс-листе — «Действующая опт».

Проектные / комплектующие организации
• Размещение товара не требуется.
• Минимальный ориентир по закупкам — от 300 000 ₽ в квартал.
• Ваша цена в прайс-листе — «Действующая опт» + 10%.

ЦЕНЫ И ОСТАТКИ
Актуальные прайс-листы и складские остатки: https://cloud.mail.ru/public/ED7Y/Ep5TKqaGm
Информация обновляется ежедневно.

ЛОГИСТИКА И СКЛАД
Самовывоз: 141580, Московская область, г. Химки, д. Чёрная Грязь, Сходненская улица, строение 1, корпус А.
«Многофункциональный Логистический Парк». Склад: Логистическое агентство 20А.
Время работы: круглосуточно, без выходных.

Мы бесплатно доставляем до терминалов ТК в Москве.
Работаем с ТК ПЭК, КИТ, БАЙКАЛ, ДЕЛОВЫЕ ЛИНИИ.

ДЛЯ СТАРТА РАБОТЫ НЕОБХОДИМО ПРИСЛАТЬ
1. Реквизиты компании — подготовим договор. Работаем с юридическими лицами с НДС и без НДС, стоимость товара не меняется.
2. Для салона / шоурума — адрес и несколько фотографий магазина; для интернет-магазина — ссылка на сайт; для проектной / комплектующей организации — сайт или файлы завершённых проектов.

Если условия подходят, присылайте реквизиты — подключим вас к дилерской программе.

Петроченко Семён
Руководитель отдела развития Stool Group / Moderli
Моб.: +7 926 009-01-50
E-mail: petrochenko_s@stoolgroup.ru
Web: https://www.stoolgroup.ru/
Telegram: https://t.me/stoolgroup
ВКонтакте: https://vk.com/stool_group
Дзен: https://dzen.ru/stoolgroup

ШОУРУМ И АУТЛЕТ
Москва, м. Сокол, Ленинградский пр-т, д. 80, корп. 16.
Карта: https://yandex.ru/maps/org/stul_grup/40256023504/`;

class RequestError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; }
}

function isEmail(value) {
  return typeof value === 'string' && value.length <= 254 && !/[\r\n]/.test(value) && /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/.test(value);
}

function mailConfigured(env) {
  const mode = env.MAIL_TRANSPORT?.toLowerCase().trim();
  if (mode === 'smtp') return smtpConfigured(env);
  if (mode && mode !== 'resend') return false;
  return Boolean(env.RESEND_API_KEY?.trim() && env.MAIL_FROM?.trim() && !/[\r\n]/.test(env.MAIL_FROM));
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RequestError(400, 'Некорректный формат заявки.');
  if (input.companyWebsite) throw new RequestError(400, 'Не удалось принять заявку. Свяжитесь с нами по почте.');
  const errors = {};
  const data = {};
  for (const [key, max] of Object.entries({ type: 30, contactName: 120, email: 254, phone: 40, company: 250, inn: 12, city: 150, website: 500, address: 500, requisites: 5000, comment: 3000 })) {
    if (input[key] != null && typeof input[key] !== 'string') errors[key] = 'Укажите текстовое значение.';
    data[key] = typeof input[key] === 'string' ? input[key].trim() : '';
    if (data[key].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data[key])) errors[key] = 'Проверьте длину и содержимое поля.';
  }
  for (const key of ['contactName', 'company', 'city']) if (data[key].length < 2) errors[key] = 'Заполните поле (не менее 2 символов).';
  if (!Object.hasOwn(TYPES, data.type)) errors.type = 'Выберите формат сотрудничества.';
  if (!isEmail(data.email)) errors.email = 'Укажите корректный email.';
  if (!/^[+()\d\s.-]+$/.test(data.phone) || data.phone.replace(/\D/g, '').length < 10 || data.phone.replace(/\D/g, '').length > 15) errors.phone = 'Укажите корректный номер телефона.';
  if (data.inn && !/^\d{10}(\d{2})?$/.test(data.inn)) errors.inn = 'ИНН должен содержать 10 или 12 цифр.';
  if (data.type === 'online' && !data.website) errors.website = 'Укажите ссылку на интернет-магазин.';
  if (data.website) {
    try {
      const url = new URL(/^https?:\/\//i.test(data.website) ? data.website : `https://${data.website}`);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password || /\s/.test(data.website)) throw new Error();
      data.website = url.href;
    } catch { errors.website = 'Укажите корректную ссылку на сайт.'; }
  }
  if (data.type === 'showroom' && data.address.length < 5) errors.address = 'Укажите адрес магазина / шоурума.';
  if (input.termsAccepted !== true) errors.termsAccepted = 'Подтвердите выбранные условия сотрудничества.';
  if (input.consent !== true) errors.consent = 'Необходимо согласие на обработку персональных данных.';
  // Single-line fields are also used in email headers, so reject injected line breaks.
  for (const key of ['contactName', 'company', 'city', 'phone']) if (/[\r\n]/.test(data[key])) errors[key] = 'Поле должно содержать одну строку.';
  if (Object.keys(errors).length) throw new RequestError(422, 'Проверьте поля формы.', errors);
  const files = input.attachments ?? [];
  if (!Array.isArray(files) || files.length > 5) throw new RequestError(422, 'Можно приложить не более 5 файлов.');
  let total = 0;
  data.attachments = files.map(file => {
    if (!file || typeof file !== 'object' || !['requisites', 'photo', 'project'].includes(file.purpose) || typeof file.type !== 'string' || typeof file.name !== 'string' || file.name.length > 150 || /[\u0000-\u001f\u007f/\\]/.test(file.name) || !file.name.trim() || typeof file.data !== 'string' || !file.data.length || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) throw new RequestError(422, 'Некорректный файл вложения.');
    const buffer = Buffer.from(file.data, 'base64');
    const allowed = {
      'application/pdf': buffer.subarray(0, 5).toString() === '%PDF-',
      'image/jpeg': buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
      'image/png': buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
      'image/webp': buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP',
    };
    if (!Object.hasOwn(allowed, file.type) || allowed[file.type] !== true) throw new RequestError(422, 'Принимаются PDF, JPG, PNG и WebP. Проверьте формат файлов.');
    if (file.purpose === 'photo' && !file.type.startsWith('image/')) throw new RequestError(422, 'Фотографии магазина должны быть в формате JPG, PNG или WebP.');
    if (buffer.length > MAX_FILE) throw new RequestError(422, 'Размер каждого файла — не более 2 МБ.');
    total += buffer.length;
    if (total > MAX_TOTAL_FILES) throw new RequestError(422, 'Общий размер вложений — не более 7 МБ.');
    return { filename: file.name.trim(), content: file.data, content_type: file.type, purpose: file.purpose };
  });
  if (data.requisites.length < 10 && !data.attachments.some(file => file.purpose === 'requisites')) throw new RequestError(422, 'Укажите реквизиты компании (не менее 10 символов) или приложите файл с реквизитами.', { requisites: 'Нужны реквизиты компании или файл с реквизитами.' });
  if (data.type === 'showroom' && data.attachments.filter(file => file.purpose === 'photo').length < 2) throw new RequestError(422, 'Приложите не менее двух фотографий магазина / шоурума.', { attachments: 'Нужны минимум две фотографии магазина / шоурума.' });
  if (data.type === 'project' && !data.website && !data.attachments.some(file => file.purpose === 'project')) throw new RequestError(422, 'Укажите сайт компании или приложите хотя бы один файл завершённого проекта.');
  return data;
}

async function readJSON(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new RequestError(415, 'Отправьте форму в формате JSON.');
  if (Number(req.headers['content-length']) > MAX_BODY) throw new RequestError(413, 'Слишком большой размер заявки.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RequestError(413, 'Слишком большой размер заявки.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RequestError(400, 'Не удалось прочитать заявку. Повторите отправку.'); }
}

function managerText(data) {
  const fileList = data.attachments.map(file => `• ${file.filename} — ${file.purpose === 'requisites' ? 'реквизиты компании' : file.purpose === 'project' ? 'завершённый проект' : 'фотография магазина'}`).join('\n');
  const price = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ₽`
    : 'уточняется';
  // The handler must resolve each item from the server-side catalog, never from
  // client-submitted names or prices, before calling this formatter.
  const order = Array.isArray(data.orderItems) && data.orderItems.length
    ? `\n\nПРЕДВАРИТЕЛЬНЫЙ ЗАКАЗ (не является резервом)\n${data.orderItems.map(item => `• ${item.name} · артикул ${item.article || item.sku}${item.article ? ` · код ${item.sku}` : ''} · ${item.quantity} шт.\n  РРЦ действующая: ${price(item.retailPrice)}; опт действующая (базовая колонка): ${price(item.wholesalePrice)}`).join('\n')}\nЦены и остатки уточняются менеджером; условия выбранного формата применяются отдельно.`
    : '';
  return `Новая заявка в дилерскую программу Stool Group / Moderli\n\nФормат: ${TYPES[data.type]}\nКомпания: ${data.company}\nИНН: ${data.inn || 'не указан'}\nКонтакт: ${data.contactName}\nEmail: ${data.email}\nТелефон: ${data.phone}\nГород: ${data.city}\nСайт: ${data.website || 'не указан'}\nАдрес: ${data.address || 'не указан'}${order}\n\nРеквизиты:\n${data.requisites || 'во вложении'}\n\nКомментарий:\n${data.comment || 'нет'}\n\nУсловия выбранного формата подтверждены. Согласие на обработку персональных данных получено.\nВложения: ${data.attachments.length}.\n${fileList}\n\nУсловия программы:\n${OFFER}`;
}

// Never manufacture a public link from the local request Host header. Only an
// explicitly configured HTTPS site address may appear in an outgoing email.
function publicSiteUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(host)) return null;
    if (/^\d+(?:\.\d+){3}$/.test(host) || /\.(?:localhost|local|internal|invalid|test|example)$/.test(host)) return null;
    return url.href;
  } catch { return null; }
}

function confirmationText(data, env) {
  const url = publicSiteUrl(env.PUBLIC_SITE_URL);
  const site = url ? `\n\nУсловия сотрудничества и каталог: ${url}` : '';
  return `${data.contactName}, добрый день!\n\nСпасибо за интерес к сотрудничеству со Stool Group / Moderli.\n\nВашу заявку по формату «${TYPES[data.type]}» получили. Я изучу информацию и скоро свяжусь с вами, чтобы обсудить дальнейшие шаги.${site}\n\nАктуальные прайс-листы и остатки:\nhttps://cloud.mail.ru/public/ED7Y/Ep5TKqaGm\n\nЕсли у вас появились вопросы, ответьте на это письмо или позвоните мне.\n\nС уважением,\nСемён Петроченко\nРуководитель отдела развития Stool Group / Moderli\n+7 926 009-01-50\npetrochenko_s@stoolgroup.ru`;
}

async function sendMail(fetchImpl, env, message, key) {
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ from: env.MAIL_FROM, ...message }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Mail provider did not accept the message.');
}

export function createServer({ env = process.env, fetchImpl = globalThis.fetch, smtpTransportFactory, publicDir = ROOT, catalogPath, now = Date.now } = {}) {
  const attempts = new Map();
  // Retain hashes and delivery stages only; retries across processes or restarts
  // still require external delivery tracking if stronger guarantees are needed.
  const smtpStages = new Map();
  let smtpSend;
  const smtpMode = env.MAIL_TRANSPORT?.toLowerCase().trim() === 'smtp';
  const stageFor = id => {
    for (const [key, value] of smtpStages) if (!value.sending && now() - value.createdAt >= 24 * 60 * 60_000) smtpStages.delete(key);
    if (smtpStages.has(id)) return smtpStages.get(id);
    if (smtpStages.size >= 1000) {
      const oldest = [...smtpStages].find(([, value]) => !value.sending);
      if (!oldest) throw new RequestError(503, 'Сервис занят. Повторите отправку позже.');
      smtpStages.delete(oldest[0]);
    }
    const stage = { createdAt: now(), managerSent: false, clientSent: false, sending: false };
    smtpStages.set(id, stage);
    return stage;
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://stoolgroup.ru https://www.stoolgroup.ru; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname === '/api/health' && req.method === 'GET') return json(200, { status: 'ok', mailConfigured: mailConfigured(env) });
      if (pathname === '/api/catalog' && req.method === 'GET') {
        const { products, updatedAt } = await readCatalog(catalogPath);
        return json(200, { products, updatedAt });
      }
      if (pathname === '/api/applications' && req.method === 'POST') {
        if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'Отправьте заявку со страницы сайта.');
        const timestamp = now();
        for (const [key, value] of attempts) if (timestamp - value.start >= 15 * 60_000) attempts.delete(key);
        // Use the real socket address; trusting arbitrary forwarded headers allows limit bypass.
        const ip = req.socket.remoteAddress;
        const record = attempts.get(ip) ?? { start: timestamp, count: 0 };
        record.count += 1;
        attempts.set(ip, record);
        if (record.count > 10) {
          res.setHeader('Retry-After', '900');
          throw new RequestError(429, 'Слишком много попыток. Повторите через 15 минут или свяжитесь с нами по телефону.');
        }
        const input = await readJSON(req);
        const data = validate(input);
        const items = parseOrderItems(input.orderItems);
        // Only authoritative server-side catalog names and prices may enter
        // email or idempotency state; client price/name fields are ignored.
        data.orderItems = items.length ? resolveOrderItems(items, await readCatalog(catalogPath)) : [];
        if (!mailConfigured(env)) throw new RequestError(503, 'Отправка заявок пока не подключена. Напишите Семёну: petrochenko_s@stoolgroup.ru или позвоните +7 926 009-01-50.');
        const id = createHash('sha256').update(JSON.stringify(data)).digest('hex');
        const stage = smtpMode ? stageFor(id) : { managerSent: false, clientSent: false };
        if (stage.sending) throw new RequestError(409, 'Эта заявка уже отправляется. Подождите немного и повторите попытку.');
        stage.sending = true;
        try {
          const send = smtpMode ? (smtpSend ??= createSmtpSender(env, smtpTransportFactory)) : (message, key) => sendMail(fetchImpl, env, message, key);
          if (!stage.managerSent) {
            await send({ to: [RECIPIENT], reply_to: data.email, subject: `Заявка дилера · ${TYPES[data.type]} · ${data.company}`, text: managerText(data), attachments: data.attachments.map(({ purpose, ...attachment }) => attachment) }, `dealer-manager-${id}`);
            stage.managerSent = true;
          }
          if (!stage.clientSent) {
            await send({ to: [data.email], reply_to: RECIPIENT, subject: 'Ваша заявка получена · Stool Group / Moderli', text: confirmationText(data, env) }, `dealer-client-${id}`);
            stage.clientSent = true;
          }
        } catch (error) {
          // Mail provider responses can contain addresses and credentials.
          // Log only an allowlisted error category and numeric SMTP status.
          const allowedCodes = new Set(['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'EENVELOPE', 'EMESSAGE', 'EPROTOCOL', 'ETLS', 'ECONFIG']);
          const code = allowedCodes.has(error?.code) ? error.code : 'UNKNOWN';
          const status = Number.isInteger(error?.responseCode) && error.responseCode >= 400 && error.responseCode <= 599 ? ` SMTP ${error.responseCode}` : '';
          console.error(`Ошибка почты (${stage.managerSent ? 'подтверждение' : 'заявка'}): ${code}${status}`);
          throw new RequestError(502, stage.managerSent ? 'Заявка передана Семёну, но письмо с подтверждением не удалось отправить вам. Повторите отправку или свяжитесь с Семёном.' : 'Не удалось передать заявку. Повторите позже или напишите на petrochenko_s@stoolgroup.ru.');
        } finally {
          stage.sending = false;
        }
        return json(200, { success: true, message: 'Заявка передана Семёну. Подтверждение отправлено на вашу почту.' });
      }
      if (pathname.startsWith('/api/')) throw new RequestError(404, 'Не найдено.');
      if (!['GET', 'HEAD'].includes(req.method)) throw new RequestError(405, 'Метод не поддерживается.');
      let decoded;
      try { decoded = decodeURIComponent(pathname); } catch { throw new RequestError(400, 'Некорректный адрес.'); }
      if (decoded.split('/').some(part => part.startsWith('.')) || decoded.includes('\0') || decoded.includes('\\')) throw new RequestError(404, 'Не найдено.');
      const root = resolve(publicDir);
      const path = resolve(root, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!path.startsWith(root + sep)) throw new RequestError(404, 'Не найдено.');
      let file;
      try {
        // Resolve symlinks too: a file under public must never expose files outside it.
        const [actualPath, actualRoot] = await Promise.all([realpath(path), realpath(root)]);
        if (!actualPath.startsWith(actualRoot + sep)) throw new Error('Outside public directory.');
        file = await readFile(actualPath);
      } catch { throw new RequestError(404, 'Не найдено.'); }
      res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (res.headersSent) return res.end();
      const expected = error instanceof RequestError || error instanceof CatalogUnavailable || error instanceof CatalogInputError;
      json(expected ? error.status : 500, { success: false, message: expected ? error.message : 'Внутренняя ошибка. Попробуйте позже.', ...(error.fields ? { fields: error.fields } : {}) });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const server = createServer();
  const stopCatalogSync = startCatalogSync();
  server.on('close', stopCatalogSync);
  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Dealer landing listening on port ${port}. Mail ${mailConfigured(process.env) ? 'configured' : 'not configured'}.`);
  });
}
