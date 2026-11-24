"""Check the published static bundle using only the Python standard library."""
import json
from html.parser import HTMLParser
from pathlib import Path
import re
import struct
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]

class Check(HTMLParser):
    ids = set()
    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        if 'id' in data:
            assert data['id'] not in self.ids, f'Duplicate ID: {data["id"]}'
            self.ids.add(data['id'])
        if tag in ('script', 'link', 'img'):
            src = data.get('src') if tag != 'link' else data.get('href')
            if src:
                assert not urlsplit(src).netloc, f'Runtime CDN dependency: {src}'
                assert (ROOT / unquote(src)).is_file(), f'Missing HTML asset: {src}'

Check().feed((ROOT / 'index.html').read_text(encoding='utf-8'))
manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
for icon in manifest['icons']:
    path = ROOT / unquote(icon['src'])
    width, height = struct.unpack('>II', path.read_bytes()[16:24])
    assert icon['sizes'] == f'{width}x{height}', 'Manifest icon dimensions do not match the image'
worker = (ROOT / 'sw.js').read_text(encoding='utf-8')
assets = re.search(r'const APP_FILES = \[(.*?)\];', worker).group(1)
for asset in re.findall(r"'([^']+)'", assets):
    assert (ROOT / unquote(asset)).exists(), f'Missing offline asset: {asset}'
print('PASS: HTML IDs, local assets, manifest icon sizes, and offline bundle')
