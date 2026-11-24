"""Browser regression suite. All Apps Script requests use an in-memory fake server.

Run: python tests/browser_check.py
Install: python -m pip install -r requirements-dev.txt
Chrome/Edge on Windows is reused; otherwise run python -m playwright install chromium.
"""
import copy
import json
import os
from pathlib import Path
import re
import sys
import threading
import unittest
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.test-deps'))
from playwright.sync_api import sync_playwright

TX_KEYS = ['No Invoice', 'Nama Tamu', 'No KTP', 'No HP', 'Alamat', 'No Kamar', 'Tgl Check-in', 'Tgl Check-out', 'Lama Menginap', 'Biaya Kamar', 'Laundry', 'Makanan', 'Minibar', 'Denda', 'Diskon', 'DP', 'Total Tagihan', 'Sudah Dibayar', 'Sisa', 'Metode Bayar', 'Status Transaksi']
ROOM_KEYS = ['No Kamar', 'Tipe', 'Harga', 'Lantai', 'Fasilitas', 'Keterangan', 'Status']
GUEST_KEYS = ['NIK', 'Nama Lengkap', 'Jenis Kelamin', 'Tanggal Lahir', 'No HP', 'Email', 'Alamat', 'Total Menginap', 'Total Pembayaran']
BOOK_KEYS = ['Kode Booking', 'Nama Pemesan', 'No HP', 'No Kamar', 'Tgl Check-in', 'Tgl Check-out', 'Jumlah Hari', 'Harga Total', 'DP', 'Metode Bayar', 'Catatan', 'Status Booking']


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass


class BrowserChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}/'
        cls.pw = sync_playwright().start()
        candidates = [os.environ.get('BROWSER_EXECUTABLE'), r'C:\Program Files\Google\Chrome\Application\chrome.exe', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe']
        executable = next((p for p in candidates if p and Path(p).exists()), None)
        cls.browser = cls.pw.chromium.launch(headless=True, executable_path=executable)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.db = {
            'getUser': [{'Username': 'Admin', 'Password': '654321', 'Role': 'Super Admin', 'Hak Akses': 'Semua Akses', 'Status': 'Aktif'}, {'Username': 'Staff', 'Password': '112233', 'Role': 'Resepsionis', 'Hak Akses': 'Check In, Check Out', 'Status': 'Aktif'}],
            'getKamar': [dict(zip(ROOM_KEYS, [str(number), 'Standard', 200000, 'Lantai 1', 'Wifi, TV', '', status])) for number, status in [(101, 'Kosong'), (102, 'Cleaning'), (103, 'Maintenance'), (104, 'Kosong')]],
            'getTamu': [dict(zip(GUEST_KEYS, ['0012345678901234', "D'Angelo <Guest>", 'L', '1990-01-01', '081234567890', 'a@example.test', 'Jl. Uji', 3, 600000]))],
            'getReservasi': [], 'getTransaksi': [],
            'getPengaturan': [{'Item': 'Nama Penginapan', 'Nilai': 'Hotel Uji'}, {'Item': 'Alamat Lengkap', 'Nilai': 'Jl. Uji'}, {'Item': 'Nomor Telepon', 'Nilai': '081234'}],
        }
        self.calls = []
        self.errors = []
        self.failures = {}
        self.context = self.browser.new_context(service_workers='block', accept_downloads=True, timezone_id='Asia/Jakarta', viewport={'width': 1440, 'height': 1000})
        self.context.route('https://script.google.com/**', self.api)
        self.page = self.context.new_page()
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.add_init_script('window.print = () => { window.printCalls = (window.printCalls || 0) + 1; };')
        self.page.goto(self.url)
        self.page.wait_for_function('typeof submitPinLogin === "function"')

    def tearDown(self):
        try:
            self.assertEqual(self.errors, [], 'Unexpected JavaScript errors')
        finally:
            self.context.close()

    def api(self, route):
        request = route.request
        body = json.loads(request.post_data) if request.method == 'POST' else None
        action = body['action'] if body else parse_qs(urlparse(request.url).query)['action'][0]
        self.calls.append((action, copy.deepcopy(body)))
        if action in self.failures:
            failure = self.failures[action]
            if failure == 'network':
                route.abort('failed')
            elif failure == 'html':
                route.fulfill(status=200, content_type='text/html', body='<html>Not JSON</html>')
            else:
                route.fulfill(status=200, json={'status': 'error', 'message': failure})
            return
        if body:
            d = body['data']
            if action == 'addTamu':
                self.db['getTamu'].append(dict(zip(GUEST_KEYS, d)))
            elif action == 'addKamar':
                self.db['getKamar'].append(dict(zip(ROOM_KEYS, d)))
            elif action == 'addReservasi':
                self.db['getReservasi'].append(dict(zip(BOOK_KEYS, d)))
            elif action == 'checkIn':
                self.db['getTransaksi'].append(dict(zip(TX_KEYS, d['transaksiData'])))
                next(k for k in self.db['getKamar'] if k['No Kamar'] == str(d['noKamar']))['Status'] = 'Terisi'
                for r in self.db['getReservasi']:
                    if r['Kode Booking'] == d['kodeBooking']:
                        r['Status Booking'] = 'Selesai'
            elif action == 'checkOut':
                t = next(t for t in self.db['getTransaksi'] if t['No Invoice'] == d['noInvoice'])
                t.update(dict(zip(TX_KEYS, d['updateTransaksiData'])))
                next(k for k in self.db['getKamar'] if k['No Kamar'] == str(d['noKamar']))['Status'] = 'Cleaning'
            elif action == 'savePengaturan':
                self.db['getPengaturan'] = [{'Item': row[1], 'Nilai': row[2]} for row in d]
            elif action == 'updateStatusKamar':
                next(k for k in self.db['getKamar'] if k['No Kamar'] == str(d['noKamar']))['Status'] = d['statusBaru']
            elif action == 'updateData':
                table, keys = {'Data Kamar': ('getKamar', ROOM_KEYS), 'Data Tamu': ('getTamu', GUEST_KEYS), 'Reservasi': ('getReservasi', BOOK_KEYS)}[d['sheetName']]
                target = next(row for row in self.db[table] if str(row[keys[0]]) == str(d['searchValue']))
                target.update(dict(zip(keys, d['rowData'])))
            elif action == 'deleteData':
                table, key = {'Data Kamar': ('getKamar', 'No Kamar'), 'Data Tamu': ('getTamu', 'NIK'), 'Reservasi': ('getReservasi', 'Kode Booking'), 'Data User': ('getUser', 'Username')}[d['sheetName']]
                self.db[table] = [r for r in self.db[table] if str(r[key]) != str(d['searchValue'])]
            elif action == 'addUser':
                self.db['getUser'].append(dict(zip(['Username', 'Password', 'Role', 'Hak Akses', 'Status'], d)))
            else:
                raise AssertionError(f'Unexpected write: {action}')
            route.fulfill(status=200, json={'status': 'success', 'message': 'Tersimpan'})
        else:
            if action not in self.db:
                route.fulfill(status=200, json={'status': 'error', 'message': 'Action GET tidak ditemukan.'})
            else:
                route.fulfill(status=200, json={'status': 'success', 'data': self.db[action]})

    def login(self, pin='654321'):
        # Physical key events verify focus advances exactly one box per digit.
        self.page.locator('#pin1').click()
        self.page.keyboard.type(pin, delay=10)
        if pin in ('654321', '112233') and not self.failures:
            self.page.wait_for_function('activeUser !== null && dataFresh && !loggingIn')
        else:
            self.page.wait_for_selector('.swal2-icon-error, .swal2-icon-warning')

    def eval(self, expression):
        return self.page.evaluate(expression)

    def writes(self, action=None):
        return [body for name, body in self.calls if body is not None and (action is None or name == action)]

    def dismiss(self):
        self.eval('Swal.close()')
        self.page.wait_for_function('!busy && !loggingIn')
        self.page.wait_for_selector('.swal2-container', state='detached')

    def invoke(self, function):
        self.eval(f'window.pending = {function}; undefined')
        self.page.wait_for_function('!busy || document.querySelector(".swal2-icon-warning,.swal2-icon-error") !== null')

    def today(self):
        return self.eval('getTodayYMD()')

    def fill_ci(self, room='101', deposit=50000):
        self.eval('switchPage("checkin")')
        fields = {'ci_ktp': '0099999999999999', 'ci_nama': 'Tamu Uji', 'ci_hp': '08123456789'}
        for key, val in fields.items():
            self.page.locator('#' + key).fill(val)
        self.page.locator('#ci_kamar').select_option(room)
        self.page.locator('#ci_in').fill(self.today())
        self.page.locator('#ci_out').fill(self.today())
        self.eval(f'setRawNum("ci_bayar", {deposit}); calcCheckin()')

    def test_01_no_master_pin_or_storage_bypass(self):
        self.eval('localStorage.setItem("isLoggedIn", "true"); localStorage.setItem("activeAkses", "Semua Akses")')
        self.page.reload()
        self.assertTrue(self.page.locator('#login-screen').is_visible())
        self.login('123456')
        self.assertIsNone(self.eval('activeUser'))
        self.assertTrue(self.page.locator('#login-screen').is_visible())

    def test_02_keyboard_login_and_permissions(self):
        self.login('112233')
        self.assertEqual(self.page.locator('#sidebar-menu a').count(), 2)
        self.assertFalse(self.eval('switchPage("pengaturan")'))
        self.dismiss()
        self.assertIn('checkin', self.page.locator('.page-section.active').get_attribute('id'))
        self.assertFalse(self.eval('globalUsers.some(u => "Password" in u)'))

    def test_03_failed_login_fails_closed(self):
        self.failures['getUser'] = 'network'
        self.login('123456')
        self.assertIsNone(self.eval('activeUser'))
        self.assertIn('Login gagal', self.page.locator('.swal2-title').inner_text())

    def test_04_dates_currency_and_timezones(self):
        checks = self.eval('''() => [parseRpToNum('Rp 150.000,00'), parseRpToNum(150000.5), parseRpToNum('150000.00'), parseRpToNum('-25.000'), parseDateStandard('31/12/2026'), parseDateStandard('2026-02-30'), stayDays('2026-12-02','2026-12-01'), stayDays('2026-12-01','2026-12-01'), stayDays('2026-12-01','2026-12-03')]''')
        self.assertEqual(checks, [150000, 150001, 150000, -25000, '2026-12-31', '', 0, 1, 2])
        self.assertEqual(self.eval('parseDateStandard("2026-11-30T17:00:00.000Z")'), '2026-12-01')
        self.assertEqual(self.eval('parseDateStandard("2026-12-01T00:00:00+07:00")'), '2026-12-01')
        self.page.clock.install(time=__import__('datetime').datetime(2026, 12, 1, 0, 30, tzinfo=__import__('datetime').timezone.utc))
        self.assertEqual(self.today(), '2026-12-01')

    def test_05_only_ready_rooms_for_checkin(self):
        self.login()
        options = self.eval('[...$("ci_kamar").options].map(o=>o.value)')
        self.assertEqual(options, ['', '101', '104'])

    def test_06_reservation_validation_and_overlap(self):
        self.login()
        self.eval('switchPage("reservasi")')
        today = self.today()
        self.eval(f'''() => {{ $('r_nama').value='Pemesan'; $('r_hp').value='08123'; $('r_kamar').value='101'; $('r_in').value='{today}'; $('r_out').value='2020-01-01'; }}''')
        self.invoke('submitReservasi({preventDefault(){}, target:$("form-reservasi")})')
        self.assertEqual(self.writes(), [])
        self.dismiss()
        self.eval(f'$("r_out").value="{today}"; setRawNum("r_dp",50000)')
        self.invoke('submitReservasi({preventDefault(){}, target:$("form-reservasi")})')
        self.assertEqual(len(self.writes('addReservasi')), 1)
        self.eval(f'''() => {{ $('r_nama').value='Bentrok'; $('r_hp').value='08123'; $('r_kamar').value='101'; $('r_in').value='{today}'; $('r_out').value='{today}'; }}''')
        self.invoke('submitReservasi({preventDefault(){}, target:$("form-reservasi")})')
        self.assertEqual(len(self.writes('addReservasi')), 1)
        self.assertIn('bertabrakan', self.page.locator('.swal2-html-container').inner_text())

    def test_07_full_reservation_checkin_checkout_invoice_export(self):
        today = self.today()
        self.db['getKamar'][0]['Status'] = 'Booking'
        self.db['getReservasi'] = [dict(zip(BOOK_KEYS, ['BK-TEST', 'Tamu Uji', '081234', '101', today, today, 1, 200000, 50000, 'Transfer Bank', '', 'Menunggu']))]
        self.login()
        self.eval('switchPage("checkin"); $("ci_cari_resv").value="BK-TEST"; cariReservasiCI(); $("ci_ktp").value="0099999999999999"')
        self.assertEqual(self.eval('value("ci_kamar")'), '101')
        self.assertEqual(self.eval('value("ci_metode")'), 'Transfer Bank')
        self.invoke('submitCheckin({preventDefault(){}, target:$("form-checkin")})')
        self.page.wait_for_function('window.printCalls === 1')
        self.assertEqual([n for n, b in self.calls if b][:2], ['addTamu', 'checkIn'])
        self.assertEqual(self.db['getReservasi'][0]['Status Booking'], 'Selesai')
        self.assertEqual(self.page.locator('#pr_balance').inner_text(), 'Rp 150.000')
        self.eval('switchPage("checkout"); $("co_kamar").value="101"; loadTagihanCheckout(); setRawNum("co_laundry",25000); hitungTotalCO()')
        self.assertEqual(self.eval('hitungTotalCO().sisa'), 175000)
        self.eval('triggerPrint("checkout")')
        self.page.wait_for_function('window.printCalls === 2')
        self.assertEqual(self.page.locator('#pr_paid').inner_text(), 'Rp 0')
        self.assertEqual(self.page.locator('#pr_balance').inner_text(), 'Rp 175.000')
        self.eval('window.pending = submitCheckout(); undefined')
        self.page.locator('.swal2-confirm').click()
        self.page.wait_for_function('!busy')
        self.page.wait_for_function('window.printCalls === 3')
        self.assertEqual(self.page.locator('#pr_paid').inner_text(), 'Rp 175.000')
        self.assertEqual(self.page.locator('#pr_balance').inner_text(), 'Rp 0')
        self.assertEqual(self.db['getKamar'][0]['Status'], 'Cleaning')
        self.assertEqual(self.page.locator('#d_rev').inner_text(), 'Rp 225.000')
        self.assertEqual(self.page.locator('#lap_pendapatan').inner_text(), 'Rp 225.000')
        self.assertEqual(self.page.locator('#tbl-transaksi tr:first-child td').count(), 6)
        self.assertNotIn('101', self.eval('[...$("ci_kamar").options].map(o=>o.value)'))
        self.eval('switchPage("pembayaran")')
        with self.page.expect_download() as download_info:
            self.eval('exportTableToExcel("tbl-transaksi-full", "Riwayat")')
        self.assertEqual(download_info.value.suggested_filename, 'Riwayat.xlsx')
        self.assertGreater(Path(download_info.value.path()).stat().st_size, 1000)

    def test_08_payment_and_duplicate_submission(self):
        self.login(); self.fill_ci(deposit=250000)
        self.invoke('submitCheckin({preventDefault(){}, target:$("form-checkin")})')
        self.assertEqual(self.writes(), [])
        self.dismiss(); self.eval('setRawNum("ci_bayar",50000)')
        self.eval('submitCheckin({preventDefault(){}, target:$("form-checkin")}); submitCheckin({preventDefault(){}, target:$("form-checkin")}); undefined')
        self.page.wait_for_function('!busy')
        self.assertEqual(len(self.writes('checkIn')), 1)
        self.assertEqual(len(self.writes('addTamu')), 1)

    def test_09_failed_guest_write_stops_checkin(self):
        self.login(); self.fill_ci(); self.failures['addTamu'] = 'Penulisan ditolak'
        self.eval('submitCheckin({preventDefault(){}, target:$("form-checkin")}); undefined')
        self.page.wait_for_selector('.swal2-title')
        self.page.wait_for_function('$("swal2-title")?.textContent.includes("belum terkonfirmasi")')
        self.dismiss(); self.page.wait_for_function('!busy')
        self.assertEqual(self.writes('checkIn'), [])
        self.assertFalse(self.eval('dataFresh'))

    def test_10_snapshot_survives_partial_failure(self):
        self.login(); self.failures['getTransaksi'] = 'network'
        self.assertFalse(self.eval('loadAllData()'))
        self.assertEqual(self.eval('globalKamar.length'), 4)
        self.assertEqual(self.page.locator('#tbl-kamar tr').count(), 4)
        self.assertFalse(self.eval('dataFresh'))
        self.assertIn('Data terakhir', self.page.locator('#sync-status').inner_text())
        del self.failures['getTransaksi']
        self.assertTrue(self.eval('loadAllData()'))

    def test_11_xss_and_original_text_preserved(self):
        self.db['getKamar'][0]['No Kamar'] = "10'1<room>"
        self.db['getKamar'][0]['Tipe'] = '<img src=x onerror="window.pwned=true">'
        self.login()
        self.assertFalse(self.eval('!!window.pwned'))
        self.assertEqual(self.page.locator('#tbl-kamar img').count(), 0)
        self.assertIn("D'Angelo <Guest>", self.page.locator('#tbl-tamu').inner_text())
        self.eval('switchPage("kamar")')
        self.page.locator('[data-action="edit-room"]').first.click()
        self.assertEqual(self.eval('value("k_no")'), "10'1<room>")
        self.eval('$("k_f_custom").value="<img src=x onerror=alert(1)>"; tambahFasilitasManualInline()')
        self.assertEqual(self.page.locator('#fas_container img').count(), 0)
        self.eval('$("k_tipe").value="VIP"; otomatisFasilitas()')
        self.assertEqual(self.page.locator('#fas_container input:checked').count(), 4)

    def test_12_profile_saves_and_print_uses_it(self):
        self.login(); self.eval('switchPage("pengaturan"); $("set_hotel").value="Hotel Baru"')
        self.eval('simpanProfilPengaturan(); undefined')
        self.page.wait_for_function('$("swal2-title")?.textContent === "Tersimpan"')
        self.dismiss(); self.page.wait_for_function('!busy')
        self.assertEqual(self.db['getPengaturan'][0]['Nilai'], 'Hotel Baru')

    def test_13_zero_deposit_cross_period_cash(self):
        self.login()
        result = self.eval('''() => {
            const t={'Tgl Check-in':'2026-10-31','Tgl Check-out':'2026-11-01','Status Transaksi':'Selesai (Check-out)',DP:0,'Sudah Dibayar':200000,'Total Tagihan':200000};
            return [depositOf(t),cashForPeriod(t,d=>d.startsWith('2026-10')),cashForPeriod(t,d=>d.startsWith('2026-11'))];
        }''')
        self.assertEqual(result, [0, 0, 200000])

    def test_14_empty_search_and_reservation_status(self):
        self.login(); self.eval('switchPage("checkin"); cariTamuCI(); undefined')
        self.assertEqual(self.eval('value("ci_nama")'), '')
        self.dismiss(); self.eval('cariReservasiCI(); undefined')
        self.assertEqual(self.eval('value("ci_kode_booking")'), '')

    def test_15_currency_clearing_recalculates(self):
        self.login(); self.fill_ci()
        self.page.locator('#ci_diskon').fill('50000')
        self.assertEqual(self.eval('getRawNum("ci_biaya")'), 150000)
        self.page.locator('#ci_diskon').fill('')
        self.assertEqual(self.eval('getRawNum("ci_biaya")'), 200000)

    def test_16_logout_clears_data_and_stale_checkout(self):
        self.login(); self.fill_ci()
        self.eval('lockSession()')
        self.assertTrue(self.page.locator('#login-screen').is_visible())
        self.assertEqual(self.eval('globalTamu.length'), 0)
        self.assertEqual(self.eval('value("ci_nama")'), '')
        self.assertEqual(self.page.locator('#tbl-tamu tr').count(), 0)
        self.assertIsNone(self.eval('actTrx'))

    def test_17_guest_edit_preserves_history(self):
        self.login(); self.eval('editRowTamu("0012345678901234"); $("t_nama").value="Nama baru"')
        self.invoke('submitTamu({preventDefault(){},target:$("form-tamu")})')
        self.assertEqual(self.db['getTamu'][0]['Total Menginap'], 3)
        self.assertEqual(self.db['getTamu'][0]['Total Pembayaran'], 600000)
        self.assertEqual(self.db['getTamu'][0]['Email'], 'a@example.test')

    def test_18_export_preserves_identifiers(self):
        self.login()
        self.eval('window.savedBook=null; XLSX.writeFile = book => {window.savedBook=book}; exportTableToExcel("tbl-tamu","Tamu")')
        sheet = self.eval('XLSX.utils.sheet_to_json(savedBook.Sheets.Data,{header:1})')
        self.assertEqual(sheet[1][1], '0012345678901234')
        self.assertEqual(sheet[1][2], '081234567890')
        self.assertEqual(len(sheet[0]), 4)

    def test_19_mobile_pages_have_no_viewport_overflow(self):
        self.page.set_viewport_size({'width': 360, 'height': 800})
        self.assertLessEqual(self.eval('document.documentElement.scrollWidth'), 360)
        self.login()
        for page in ['dashboard', 'kamar', 'tamu', 'reservasi', 'checkin', 'checkout', 'pembayaran', 'laporan', 'pengaturan']:
            self.eval(f'switchPage("{page}")')
            self.assertLessEqual(self.eval('document.documentElement.scrollWidth'), 360, page)
        self.eval('toggleSidebar(true)')
        self.assertFalse(self.page.locator('#sidebar-overlay').is_hidden())
        self.eval('switchPage("dashboard")')
        self.assertTrue(self.page.locator('#sidebar-overlay').is_hidden())
        Path(ROOT / 'test-results').mkdir(exist_ok=True)
        self.page.screenshot(path=str(ROOT / 'test-results/mobile-dashboard.png'), full_page=True, animations='disabled')

    def test_20_service_worker_caches_shell_not_api(self):
        context = self.browser.new_context(service_workers='allow')
        try:
            page = context.new_page()
            page.goto(self.url)
            page.evaluate('navigator.serviceWorker.ready')
            page.wait_for_function('navigator.serviceWorker.controller !== null')
            cache_keys = page.evaluate('caches.keys()')
            self.assertIn('sanstech-penginapan-v3', cache_keys)
            cached = page.evaluate('''async () => { const c=await caches.open('sanstech-penginapan-v3'); return (await c.keys()).map(r=>r.url); }''')
            self.assertFalse(any('script.google' in u for u in cached))
            self.assertTrue(any('/app.js' in u for u in cached))
            context.set_offline(True)
            page.reload()
            self.assertTrue(page.locator('#login-screen').is_visible())
            self.assertTrue(page.evaluate('typeof Swal !== "undefined" && typeof XLSX !== "undefined"'))
        finally:
            context.close()

    def test_21_checkout_selection_change_clears_old_invoice(self):
        self.login(); self.fill_ci()
        self.invoke('submitCheckin({preventDefault(){},target:$("form-checkin")})')
        self.eval('switchPage("checkout"); $("co_kamar").value="101"; loadTagihanCheckout()')
        self.assertIsNotNone(self.eval('actTrx'))
        self.page.locator('#co_kamar').select_option('')
        self.assertIsNone(self.eval('actTrx'))
        self.assertTrue(self.page.locator('#co_area').is_hidden())

    def test_22_discount_cannot_erase_deposit(self):
        self.login(); self.fill_ci()
        self.invoke('submitCheckin({preventDefault(){},target:$("form-checkin")})')
        self.eval('switchPage("checkout"); $("co_kamar").value="101"; loadTagihanCheckout(); setRawNum("co_diskon",180000)')
        self.assertFalse(self.eval('hitungTotalCO().valid'))
        self.invoke('submitCheckout()')
        self.assertEqual(self.writes('checkOut'), [])

    def test_23_edit_reserved_room_retains_options_and_cancel_restores_facilities(self):
        self.login()
        self.eval('editRowKamar("101"); $("k_tipe").value="VIP"; otomatisFasilitas(); batalEdit("kamar"); $("k_tipe").value="Deluxe"; otomatisFasilitas()')
        self.assertEqual(self.page.locator('#fas_container input:checked').count(), 3)
        self.assertFalse(self.eval('$("k_no").readOnly'))
        self.eval('editRowKamar("101"); editRowTamu("0012345678901234")')
        self.assertFalse(self.eval('$("k_no").readOnly'))
        self.assertEqual(self.eval('editMode.type'), 'tamu')

    def test_24_print_media_shows_only_invoice(self):
        self.login(); self.fill_ci()
        self.invoke('submitCheckin({preventDefault(){},target:$("form-checkin")})')
        self.page.emulate_media(media='print')
        self.assertTrue(self.page.locator('#print-area').is_visible())
        self.assertFalse(self.page.locator('#app-container').is_visible())
        self.assertFalse(self.page.locator('#login-screen').is_visible())

    def test_25_user_form_requires_six_digits_and_access(self):
        self.login(); self.eval('tambahUserBaru(); undefined')
        self.page.locator('#swal-u').fill('Petugas Baru')
        self.page.locator('#swal-p').fill('1234')
        self.page.locator('.swal2-confirm').click()
        self.assertIn('6 digit', self.page.locator('.swal2-validation-message').inner_text())
        self.page.locator('#swal-p').fill('990011')
        self.page.locator('.swal2-confirm').click()
        self.assertIn('hak akses', self.page.locator('.swal2-validation-message').inner_text())
        self.page.locator('.menu-akses').first.check()
        self.page.locator('.swal2-confirm').click()
        self.page.wait_for_function('globalUsers.some(u => u.Username === "Petugas Baru")')
        self.assertEqual(len(self.writes('addUser')), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
