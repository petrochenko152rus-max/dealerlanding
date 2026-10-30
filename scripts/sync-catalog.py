#!/usr/bin/env python3
"""Refresh public dealer catalog from the published Mail.ru spreadsheets and CSVs.

Only fixed public share paths are accepted. New assets are content-addressed and
installed before catalog.json is atomically replaced. If any stage fails, the
previous catalog remains available. No SMTP credentials are read or logged.
"""
from __future__ import annotations

import csv
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'data'
CACHE = DATA / 'source-cache'
ASSETS = ROOT / 'public' / 'assets' / 'products'
SHARE = 'ED7Y/Ep5TKqaGm'
BASE_URL = 'https://cloud.mail.ru/public/'
MAX_HTML = 4 * 1024 * 1024
MAX_DOWNLOAD = 150 * 1024 * 1024
MAX_ZIP_UNCOMPRESSED = 350 * 1024 * 1024
SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
DRAW_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
ART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
PACKAGE_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'


def checked_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or '').lower()
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443):
        raise ValueError('Недопустимый адрес источника')
    if host != 'cloud.mail.ru' and not re.fullmatch(r'cloclo\d+\.(?:cloud\.mail\.ru|datacloudmail\.ru)', host):
        raise ValueError('Источник перенаправил запрос на неизвестный домен')
    return url


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return super().redirect_request(req, fp, code, msg, headers, checked_url(newurl))


OPENER = urllib.request.build_opener(SafeRedirect())


def fetch(url: str, limit: int) -> bytes:
    req = urllib.request.Request(checked_url(url), headers={'User-Agent': 'StoolGroupDealerCatalog/1.0'})
    with OPENER.open(req, timeout=60) as response:
        checked_url(response.url)
        result = response.read(limit + 1)
    if len(result) > limit:
        raise ValueError('Ответ источника превышает ограничение размера')
    return result


def folder(weblink: str):
    if not (weblink == SHARE or weblink.startswith(SHARE + '/')) or '..' in weblink.split('/'):
        raise ValueError('Недопустимая папка')
    html = fetch(BASE_URL + urllib.parse.quote(weblink, safe='/'), MAX_HTML).decode('utf-8')
    marker = '"serverSideFolders":'
    pos = html.find(marker)
    if pos < 0:
        raise ValueError('Источник не предоставил данные папки')
    data, _ = json.JSONDecoder().raw_decode(html[pos + len(marker):])
    match = re.search(r'"weblink_get":\{"count":"\d+","url":"([^\"]+)"', html)
    if not match or not isinstance(data, dict) or not isinstance(data.get('list'), list):
        raise ValueError('Источник не предоставил список файлов')
    return data, checked_url(match.group(1))


def source_files(items, pattern: str):
    result = []
    for entry in items:
        if not isinstance(entry, dict) or entry.get('kind') != 'file':
            continue
        match = re.fullmatch(pattern, str(entry.get('name', '')), flags=re.I)
        if not match:
            continue
        try:
            date = dt.datetime.strptime(match.group(1), '%d.%m.%Y').date()
        except ValueError:
            continue
        link = entry.get('weblink')
        filehash = entry.get('hash')
        size = entry.get('size')
        if not isinstance(link, str) or not link.startswith(SHARE + '/') or '..' in link.split('/') or not re.fullmatch(r'[a-fA-F0-9]{40}', str(filehash)) or not isinstance(size, int) or not 0 < size <= MAX_DOWNLOAD:
            raise ValueError('Некорректные метаданные файла источника')
        result.append({'name': entry['name'], 'link': link, 'hash': filehash.upper(), 'size': size, 'date': date.isoformat()})
    return sorted(result, key=lambda v: (v['date'], v['name']))


def choose(files, today):
    current = [f for f in files if f['date'] <= today.isoformat()]
    future = [f for f in files if f['date'] > today.isoformat()]
    if not current:
        raise ValueError('Не найден действующий файл источника')
    return current[-1], future[0] if future else None


def digest_file(path: Path):
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def download(entry, dispatcher, seed=None):
    CACHE.mkdir(parents=True, exist_ok=True)
    suffix = Path(entry['name']).suffix.lower()
    if suffix not in ('.xlsx', '.csv'):
        raise ValueError('Недопустимое расширение файла источника')
    path = CACHE / (entry['hash'] + suffix)
    digest_path = CACHE / (entry['hash'] + suffix + '.sha256')
    if path.is_file() and digest_path.is_file() and path.stat().st_size == entry['size']:
        expected = digest_path.read_text(encoding='ascii').strip()
        if re.fullmatch(r'[a-f0-9]{64}', expected) and digest_file(path) == expected:
            return path
    # A caller may seed files already downloaded over verified HTTPS. This never
    # trusts filename alone: size is checked, and a local SHA-256 is persisted.
    fd, tmp_name = tempfile.mkstemp(prefix='.source-', dir=CACHE)
    temp = Path(tmp_name)
    try:
        with os.fdopen(fd, 'wb') as output:
            if seed and Path(seed).is_file() and Path(seed).stat().st_size == entry['size']:
                with open(seed, 'rb') as stream:
                    shutil.copyfileobj(stream, output, 1024 * 1024)
            else:
                # Some Mail.ru shards accept a folder token only for nested
                # files; others require the individual file's dispatcher.
                # These are distinct documented public download routes, not
                # retries against an unchanged failed request.
                candidates = [(dispatcher, '' if entry['link'].count('/') > 2 else '/')]
                file_page = fetch(BASE_URL + urllib.parse.quote(entry['link'], safe='/'), MAX_HTML).decode('utf-8')
                marker = '"serverSideFolders":'
                offset = file_page.find(marker)
                match = re.search(r'"weblink_get":\{"count":"\d+","url":"([^\"]+)"', file_page)
                if offset < 0 or not match:
                    raise ValueError('Источник не подтвердил файл')
                metadata, _ = json.JSONDecoder().raw_decode(file_page[offset + len(marker):])
                if metadata.get('weblink') != entry['link'] or metadata.get('hash', '').upper() != entry['hash'] or metadata.get('size') != entry['size']:
                    raise ValueError('Файл источника изменился во время загрузки')
                individual = checked_url(match.group(1))
                candidates.extend([(individual, '/'), (individual, '')])
                last_error = None
                for endpoint, safe in dict.fromkeys(candidates):
                    url = checked_url(endpoint.rstrip('/') + '/' + urllib.parse.quote(entry['link'], safe=safe))
                    req = urllib.request.Request(url, headers={'User-Agent': 'StoolGroupDealerCatalog/1.0'})
                    try:
                        with OPENER.open(req, timeout=120) as response:
                            checked_url(response.url)
                            count = 0
                            while True:
                                chunk = response.read(1024 * 1024)
                                if not chunk:
                                    break
                                count += len(chunk)
                                if count > entry['size'] or count > MAX_DOWNLOAD:
                                    raise ValueError('Размер файла источника превышен')
                                output.write(chunk)
                        break
                    except urllib.error.HTTPError as error:
                        if error.code != 404:
                            raise
                        last_error = error
                        output.seek(0)
                        output.truncate()
                else:
                    raise last_error or ValueError('Файл источника недоступен')
        if temp.stat().st_size != entry['size']:
            raise ValueError('Файл источника скачан не полностью')
        checksum = digest_file(temp)
        os.replace(temp, path)
        digest_path.write_text(checksum, encoding='ascii')
        return path
    finally:
        temp.unlink(missing_ok=True)


def clean(value, limit=300):
    if value is None:
        return ''
    result = re.sub(r'[\x00-\x1f\x7f]+', ' ', str(value)).strip()
    return result[:limit]


def price(value):
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(str(value).replace('\u00a0', '').replace(' ', '').replace(',', '.'))
    except (ValueError, TypeError):
        return None
    if not (0 < number <= 1_000_000_000):
        return None
    return round(number + 1e-9, 2)


def read_stock(path, date):
    # Official source is Windows-1251 and uses tilde delimiters.
    with path.open(encoding='cp1251', newline='') as fh:
        reader = csv.DictReader(fh, delimiter='~')
        needed = {'НоменклатураКод', 'НоменклатураАртикул', 'Номенклатура', 'КоличествоСУчетомРезерва', 'ОПТ_Действующая', 'РРЦ_Действующая'}
        if not needed.issubset(reader.fieldnames or []):
            raise ValueError('Изменился формат файла остатков')
        products = {}
        for row in reader:
            sku = clean(row.get('НоменклатураКод'), 128)
            if not sku:
                continue
            values = (price(row.get('ОПТ_Действующая')), price(row.get('РРЦ_Действующая')))
            if sku not in products:
                products[sku] = {'sku': sku, 'article': clean(row.get('НоменклатураАртикул'), 128), 'name': clean(row.get('НаименованиеДляСайта') or row.get('Номенклатура'), 240), 'prices': values, 'date': date, 'stocks': []}
            if products[sku]['prices'] != values:
                # A mismatch is deliberately not resolved by guessing a price.
                products[sku]['prices'] = (None, None)
            amount = clean(row.get('КоличествоСУчетомРезерва'), 40)
            warehouse = clean(row.get('Склад'), 80)
            if amount:
                products[sku]['stocks'].append((warehouse, amount))
        if not products:
            raise ValueError('Файл остатков пуст')
        return products


def zip_relations(z, file):
    try:
        root = ET.fromstring(z.read(file))
    except KeyError:
        return {}
    return {x.get('Id'): x.get('Target') for x in root if x.get('TargetMode') != 'External'}


def zip_path(base, target, prefix):
    import posixpath
    path = posixpath.normpath(posixpath.join(base, target.lstrip('/') if not target.startswith('/') else target))
    path = path.lstrip('/')
    if not path.startswith(prefix) or '..' in path.split('/'):
        raise ValueError('Некорректная внутренняя ссылка таблицы')
    return path


def shared_strings(z):
    if 'xl/sharedStrings.xml' not in z.namelist():
        return []
    result = []
    with z.open('xl/sharedStrings.xml') as f:
        for _, el in ET.iterparse(f, events=('end',)):
            if el.tag == f'{{{SHEET_NS}}}si':
                result.append(''.join(t.text or '' for t in el.iter(f'{{{SHEET_NS}}}t')))
                el.clear()
    return result


def cell_value(cell, shared):
    typ = cell.get('t', '')
    v = cell.find(f'{{{SHEET_NS}}}v')
    if typ == 'inlineStr':
        return ''.join(t.text or '' for t in cell.iter(f'{{{SHEET_NS}}}t'))
    if v is None or v.text is None or typ == 'e':
        return None
    if typ == 's':
        try:
            return shared[int(v.text)]
        except (ValueError, IndexError):
            raise ValueError('Некорректный текст в таблице')
    if typ in ('str', 'd'):
        return v.text
    if typ == 'b':
        return v.text == '1'
    try:
        return float(v.text)
    except ValueError:
        return v.text


def rows_and_drawing(z, sheet, shared):
    rows = []
    drawing = None
    with z.open(sheet) as fh:
        for _, el in ET.iterparse(fh, events=('end',)):
            if el.tag == f'{{{SHEET_NS}}}row':
                values = {}
                for cell in el.findall(f'{{{SHEET_NS}}}c'):
                    reference = cell.get('r', '')
                    m = re.match(r'^([A-Z]+)', reference)
                    if not m:
                        continue
                    n = 0
                    for c in m.group(1): n = n * 26 + ord(c) - 64
                    if n <= 40:
                        values[n] = cell_value(cell, shared)
                rows.append((int(el.get('r', '0')), values))
                el.clear()
            elif el.tag == f'{{{SHEET_NS}}}drawing':
                drawing = el.get(f'{{{REL_NS}}}id')
    return rows, drawing


def images_for_sheet(z, sheet, drawing_id):
    if not drawing_id:
        return {}
    from posixpath import dirname, basename, join
    relfile = join(dirname(sheet), '_rels', basename(sheet) + '.rels')
    target = zip_relations(z, relfile).get(drawing_id)
    if not target:
        return {}
    drawing = zip_path(dirname(sheet), target, 'xl/drawings/')
    relfile = join(dirname(drawing), '_rels', basename(drawing) + '.rels')
    links = zip_relations(z, relfile)
    root = ET.fromstring(z.read(drawing))
    images = {}
    for anchor in root:
        start = anchor.find(f'{{{DRAW_NS}}}from')
        end = anchor.find(f'{{{DRAW_NS}}}to')
        blip = anchor.find(f'.//{{{ART_NS}}}blip')
        if start is None or end is None or blip is None:
            continue
        try:
            a = {el.tag.split('}')[-1]: int(el.text) for el in start}
            b = {el.tag.split('}')[-1]: int(el.text) for el in end}
            # Product photos are in H, and a visible image must be confined to
            # the product row. Legacy zero-height/stale Excel shapes are ignored.
            if not (a['col'] <= 7 <= b['col'] and (b['row'] == a['row'] and b['rowOff'] > a['rowOff'] or b['row'] == a['row'] + 1 and b['rowOff'] == 0)):
                continue
            target = links.get(blip.get(f'{{{REL_NS}}}embed'))
            if target:
                images[a['row'] + 1] = zip_path(dirname(drawing), target, 'xl/media/')
        except (ValueError, KeyError, TypeError):
            continue
    return images


def install_image(z, path):
    if not path:
        return None
    info = z.getinfo(path)
    if info.file_size < 10 or info.file_size > 5 * 1024 * 1024:
        return None
    data = z.read(info)
    if data.startswith(b'\xff\xd8\xff'):
        ext = '.jpg'
    elif data.startswith(b'\x89PNG\r\n\x1a\n'):
        ext = '.png'
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        ext = '.webp'
    else:
        return None
    name = hashlib.sha256(data).hexdigest() + ext
    ASSETS.mkdir(parents=True, exist_ok=True)
    dest = ASSETS / name
    if not dest.exists():
        fd, tmp = tempfile.mkstemp(prefix='.asset-', dir=ASSETS)
        try:
            with os.fdopen(fd, 'wb') as f: f.write(data)
            os.replace(tmp, dest)
        finally:
            Path(tmp).unlink(missing_ok=True)
    return '/assets/products/' + name


def normal_header(value):
    return re.sub(r'[^а-яa-z0-9]+', '', str(value or '').lower().replace('ё', 'е'))


def workbook(path, brand, source_date):
    result = {}
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        if len(infos) > 20000 or sum(i.file_size for i in infos) > MAX_ZIP_UNCOMPRESSED or any(i.file_size > 40 * 1024 * 1024 for i in infos):
            raise ValueError('Таблица превышает допустимый размер')
        shared = shared_strings(z)
        root = ET.fromstring(z.read('xl/workbook.xml'))
        rels = zip_relations(z, 'xl/_rels/workbook.xml.rels')
        for sheet in root.findall(f'.//{{{SHEET_NS}}}sheet'):
            name = clean(sheet.get('name'), 120)
            target = rels.get(sheet.get(f'{{{REL_NS}}}id'))
            if not target:
                continue
            path_in_zip = zip_path('xl', target, 'xl/worksheets/')
            rows, drawing = rows_and_drawing(z, path_in_zip, shared)
            if not rows:
                continue
            headers = {normal_header(v): k for k, v in rows[0][1].items() if v is not None}
            def column(*keys):
                for key in keys:
                    if key in headers: return headers[key]
                return None
            name_col = column('наименование')
            sku_col = column('кодкоддвойногоартикула')
            article_col = column('артикул')
            wholesale_col = column('оптдействующая', 'действующаяценаопт')
            retail_col = column('ррцдействующая', 'действующаяценаррц')
            details_col = next((n for key, n in headers.items() if key.startswith('характеристики')), None)
            category_col = column('категории')
            if not all((name_col, sku_col, article_col, wholesale_col, retail_col)):
                raise ValueError(f'В листе {name} не найдены необходимые столбцы')
            images = images_for_sheet(z, path_in_zip, drawing)
            for number, values in rows[1:]:
                sku = clean(values.get(sku_col), 128)
                title = clean(values.get(name_col), 240)
                if not sku or not title:
                    continue
                if sku in result:
                    raise ValueError('Повторяющийся код товара в прайсе')
                category = clean(values.get(category_col), 120) if category_col else ''
                if not category or category.lower() in ('да', 'нет'):
                    category = 'Комплекты' if 'набор' in name.lower() else brand
                details = []
                text = str(values.get(details_col) or '')
                for line in text.replace('\r', '\n').split('\n'):
                    line = clean(line, 390)
                    if not line: continue
                    key, sep, value = line.partition(':')
                    if sep and clean(value): details.append({'name': clean(key, 100), 'value': clean(value, 300)})
                    elif not sep: details.append({'name': '', 'value': clean(line, 300)})
                    if len(details) >= 22: break
                result[sku] = {'sku': sku, 'article': clean(values.get(article_col), 128), 'name': title, 'category': category, 'retailPrice': price(values.get(retail_col)), 'wholesalePrice': price(values.get(wholesale_col)), 'priceDate': source_date, 'image': install_image(z, images.get(number)), 'characteristics': details}
    if not result:
        raise ValueError('В прайсе нет товаров')
    return result


def merge(products, stocks, brand, stock_date):
    for sku, stock in stocks.items():
        if sku not in products:
            products[sku] = {'sku': sku, 'article': stock['article'], 'name': stock['name'], 'category': brand, 'retailPrice': None, 'wholesalePrice': None, 'priceDate': stock_date, 'image': None, 'characteristics': []}
        product = products[sku]
        if stock_date >= product['priceDate']:
            product['wholesalePrice'], product['retailPrice'] = stock['prices']
            product['priceDate'] = stock_date
        date = dt.date.fromisoformat(stock_date).strftime('%d.%m.%Y')
        stock_fields = []
        for warehouse, amount in stock['stocks'][:6]:
            label = 'Остаток' + (f' · {warehouse}' if warehouse else '') + f' · {date}'
            value = amount + (' шт.' if re.fullmatch(r'-?\d+|>\d+', amount) else '')
            stock_fields.append({'name': clean(label, 100), 'value': clean(value, 300)})
        product['characteristics'] = (stock_fields + product['characteristics'])[:30]
        product['stockDate'] = stock_date
    for sku, product in products.items():
        if sku not in stocks:
            product['characteristics'] = [{'name': 'Остаток', 'value': 'Уточняется'}] + product['characteristics'][:29]
    return products


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.catalog-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(value, f, ensure_ascii=False, separators=(',', ':'))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def main():
    today = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=3)).date()
    parent, dispatcher = folder(SHARE)
    stock_folder = next((x for x in parent['list'] if x.get('name') == 'Остатки Stool Group' and x.get('kind') == 'folder'), None)
    if not stock_folder:
        raise ValueError('В источнике не найдена папка остатков')
    stocks, _ = folder(stock_folder['weblink'])
    patterns = {
        'stool': (parent['list'], r'Прайс-лист Stool Group от (\d{2}\.\d{2}\.\d{4})\.xlsx'),
        'moderli': (parent['list'], r'Прайс-лист Moderli от (\d{2}\.\d{2}\.\d{4})\.xlsx'),
        'stock_stool': (stocks['list'], r'Товарные остатки (\d{2}\.\d{2}\.\d{4})\.csv'),
        'stock_moderli': (stocks['list'], r'Остатки Moderli CSV (\d{2}\.\d{2}\.\d{4})\.csv'),
    }
    selected = {}
    upcoming = []
    for key, (entries, pattern) in patterns.items():
        current, future = choose(source_files(entries, pattern), today)
        selected[key] = current
        if future and key in ('stool', 'moderli'): upcoming.append(future)
    fingerprint = {k: {'name': v['name'], 'hash': v['hash'], 'date': v['date']} for k, v in selected.items()}
    manifest = DATA / 'catalog-source.json'
    try:
        unchanged = json.loads(manifest.read_text(encoding='utf-8')) == fingerprint and (DATA / 'catalog.json').is_file()
    except (OSError, ValueError):
        unchanged = False
    if not unchanged:
        sources = {key: download(entry, dispatcher) for key, entry in selected.items()}
        stool = workbook(sources['stool'], 'Stool Group', selected['stool']['date'])
        moderli = workbook(sources['moderli'], 'Moderli', selected['moderli']['date'])
        if set(stool) & set(moderli):
            raise ValueError('Одинаковый код товара в прайсах разных брендов')
        products = merge(stool, read_stock(sources['stock_stool'], selected['stock_stool']['date']), 'Stool Group', selected['stock_stool']['date'])
        products.update(merge(moderli, read_stock(sources['stock_moderli'], selected['stock_moderli']['date']), 'Moderli', selected['stock_moderli']['date']))
        updated = min(selected['stock_stool']['date'], selected['stock_moderli']['date'])
        # Lead with products that have verified source photos. Python's stable
        # sort preserves the original price-list order within each group.
        ordered = sorted(products.values(), key=lambda product: not bool(product.get('image')))
        atomic_json(DATA / 'catalog.json', {'updatedAt': updated, 'products': ordered})
        atomic_json(manifest, fingerprint)
        print(f'Каталог обновлён: {len(products)} товаров, остатки от {updated}.')
    else:
        print('Каталог соответствует последним действующим файлам.')
    # Prepare the next month's price lists in advance, but never expose them
    # until their effective date. Failure here leaves the current catalog intact.
    for entry in upcoming:
        try:
            download(entry, dispatcher)
            print(f'Подготовлен будущий прайс: {entry["date"]}.')
        except Exception as error:
            detail = f', HTTP {error.code}' if isinstance(error, urllib.error.HTTPError) else ''
            print(f'Не удалось заранее загрузить будущий прайс {entry["date"]} ({type(error).__name__}{detail}); повторим при следующей проверке.', file=sys.stderr)


if __name__ == '__main__':
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        with (DATA / '.catalog-sync.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('Проверка каталога уже выполняется.')
                sys.exit(0)
            main()
    except Exception as error:
        # Paths/tokens/headers/credentials are deliberately not emitted.
        print(f'Обновление каталога завершилось с ошибкой ({type(error).__name__}); проверьте дату данных на сайте.', file=sys.stderr)
        sys.exit(1)
