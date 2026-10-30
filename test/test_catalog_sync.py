import csv
import datetime as dt
import importlib.util
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('dealer_catalog_sync', ROOT / 'scripts' / 'sync-catalog.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

class CatalogImportTests(unittest.TestCase):
    def test_future_prices_are_never_selected_early(self):
        files = [{'date':'2026-10-01'}, {'date':'2026-11-02'}, {'date':'2026-12-01'}]
        current, future = sync.choose(files, dt.date(2026,10,30))
        self.assertEqual(current['date'],'2026-10-01')
        self.assertEqual(future['date'],'2026-11-02')
        self.assertEqual(sync.choose(files, dt.date(2026,11,2))[0]['date'],'2026-11-02')
        with self.assertRaises(ValueError): sync.choose(files, dt.date(2026,9,30))

    def test_official_stock_csv_keeps_warehouse_and_does_not_guess_prices(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'stock.csv'
            columns = ['НоменклатураКод','НоменклатураАртикул','Номенклатура','КоличествоСУчетомРезерва','ОПТ_Действующая','РРЦ_Действующая','Склад']
            with p.open('w',encoding='cp1251',newline='') as f:
                w=csv.DictWriter(f,fieldnames=columns,delimiter='~');w.writeheader()
                w.writerow(dict(zip(columns,['UT1','A1','Стул','>100','2\u00a0100','3\u00a0500','A20'])))
                w.writerow(dict(zip(columns,['UT1','A1','Стул','2','2\u00a0100','3\u00a0500','Магазин'])))
                w.writerow(dict(zip(columns,['UT2','A2','Бра','0','100','200','A20'])))
                w.writerow(dict(zip(columns,['UT2','A2','Бра','1','120','200','Другой'])))
            result=sync.read_stock(p,'2026-10-30')
            self.assertEqual(result['UT1']['prices'],(2100,3500))
            self.assertEqual(result['UT1']['stocks'],[('A20','>100'),('Магазин','2')])
            self.assertEqual(result['UT2']['prices'],(None,None))

    def test_newer_stock_prices_override_older_workbook_and_not_reverse(self):
        product={'sku':'UT1','article':'A1','name':'Стул','category':'Стулья','wholesalePrice':100,'retailPrice':200,'priceDate':'2026-10-01','image':None,'characteristics':[]}
        stock={'UT1':{'sku':'UT1','article':'A1','name':'Стул','prices':(150,250),'date':'2026-10-30','stocks':[('A20','>100')]}}
        merged=sync.merge({'UT1':product.copy()},stock,'Stool Group','2026-10-30')['UT1']
        self.assertEqual((merged['wholesalePrice'],merged['retailPrice']),(150,250))
        self.assertEqual(merged['stockDate'],'2026-10-30')
        self.assertIn('>100',merged['characteristics'][0]['value'])
        newer=dict(product,priceDate='2026-11-02',wholesalePrice=170,retailPrice=270)
        merged=sync.merge({'UT1':newer},stock,'Stool Group','2026-10-30')['UT1']
        self.assertEqual((merged['wholesalePrice'],merged['retailPrice']),(170,270))
        self.assertEqual(merged['priceDate'],'2026-11-02')

    def test_only_official_https_download_hosts_are_allowed(self):
        self.assertTrue(sync.checked_url('https://cloclo65.datacloudmail.ru/public/get/test'))
        for value in ['http://cloud.mail.ru/public/file','https://evil.example/file','https://cloud.mail.ru.evil.example/a','https://user:pass@cloud.mail.ru/x','https://cloclo1.cloud.mail.ru:444/x']:
            with self.assertRaises(ValueError): sync.checked_url(value)

    def test_workbook_uses_actual_current_columns_and_visible_photo(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'price.xlsx';old=sync.ASSETS;sync.ASSETS=Path(d)/'assets'
            try:
                header={5:'Наименование',6:'Артикул',7:'Код/Код двойного артикула',10:'Характеристики',12:'Категории',19:'ОПТ\nДействующая',20:'РРЦ\nДействующая'}
                data={5:'Стул проверка',6:'TEST-ARTICLE',7:'UT1',10:'Материал: дерево',12:'Стулья'}
                def cell(col,row,value):
                    name=chr(64+col)+str(row)
                    return f'<c r="{name}" t="inlineStr"><is><t>{value}</t></is></c>'
                def line(row,items):return f'<row r="{row}">'+''.join(cell(c,row,v) for c,v in items.items())+'</row>'
                sheet=line(1,header)+line(2,data).replace('</row>','<c r="S2"><v>1234</v></c><c r="T2"><v>2345</v></c></row>')
                spreadsheet='http://schemas.openxmlformats.org/spreadsheetml/2006/main';rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships'
                draw='http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';art='http://schemas.openxmlformats.org/drawingml/2006/main'
                png=b'\x89PNG\r\n\x1a\n' + b'test image data'
                with ZipFile(p,'w') as z:
                    z.writestr('xl/workbook.xml',f'<workbook xmlns="{spreadsheet}" xmlns:r="{rel}"><sheets><sheet name="Каталог" r:id="r1"/></sheets></workbook>')
                    z.writestr('xl/_rels/workbook.xml.rels','<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>')
                    z.writestr('xl/worksheets/sheet1.xml',f'<worksheet xmlns="{spreadsheet}" xmlns:r="{rel}"><sheetData>{sheet}</sheetData><drawing r:id="d1"/></worksheet>')
                    z.writestr('xl/worksheets/_rels/sheet1.xml.rels','<Relationships><Relationship Id="d1" Target="../drawings/drawing1.xml"/></Relationships>')
                    z.writestr('xl/drawings/drawing1.xml',f'<x:wsDr xmlns:x="{draw}" xmlns:a="{art}" xmlns:r="{rel}"><x:twoCellAnchor><x:from><x:col>7</x:col><x:row>1</x:row><x:rowOff>1</x:rowOff></x:from><x:to><x:col>7</x:col><x:row>1</x:row><x:rowOff>99</x:rowOff></x:to><x:pic><a:blip r:embed="img1"/></x:pic></x:twoCellAnchor></x:wsDr>')
                    z.writestr('xl/drawings/_rels/drawing1.xml.rels','<Relationships><Relationship Id="img1" Target="../media/picture.png"/></Relationships>')
                    z.writestr('xl/media/picture.png',png)
                item=sync.workbook(p,'Stool Group','2026-10-01')['UT1']
                self.assertEqual((item['article'],item['wholesalePrice'],item['retailPrice']),('TEST-ARTICLE',1234,2345))
                self.assertEqual(item['characteristics'],[{'name':'Материал','value':'дерево'}])
                self.assertTrue(item['image'].startswith('/assets/products/'))
                self.assertEqual(len(list(sync.ASSETS.iterdir())),1)
            finally:sync.ASSETS=old

if __name__ == '__main__': unittest.main()
