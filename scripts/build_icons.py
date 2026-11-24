"""Rasterize the repository's vector application icon for PWA installers."""
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.test-deps'))
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    candidates = [os.environ.get('BROWSER_EXECUTABLE'), r'C:\Program Files\Google\Chrome\Application\chrome.exe', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe']
    executable = next((path for path in candidates if path and Path(path).exists()), None)
    browser = p.chromium.launch(headless=True, executable_path=executable)
    page = browser.new_page(device_scale_factor=1)
    svg = (ROOT / 'icons/app-icon.svg').read_text(encoding='utf-8')
    for size in (192, 512):
        page.set_viewport_size({'width': size, 'height': size})
        page.set_content(f'<style>body{{margin:0}}svg{{width:{size}px;height:{size}px;display:block}}</style>{svg}')
        page.locator('svg').screenshot(path=str(ROOT / f'icons/icon-{size}.png'))
    browser.close()
