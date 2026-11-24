"""Run the frontend against the actual Code.gs with fake Sheets services."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path
from browser_check import BrowserChecks, ROOT


class SecureBrowserChecks(BrowserChecks):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()

    def setUp(self):
        super().setUp()
        node = shutil.which('node') or str(ROOT / '.test-deps/playwright/driver/node.exe')
        self.backend = subprocess.Popen([node, str(ROOT / 'tests/backend_server.cjs')], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=ROOT)
        port = json.loads(self.backend.stdout.readline())['port']
        self.context.unroute('https://script.google.com/**')
        self.context.route('https://script.google.com/**', lambda route: route.fulfill(response=route.fetch(url=f'http://127.0.0.1:{port}/api' + ('?' + route.request.url.split('?', 1)[1] if '?' in route.request.url else ''))))

    def tearDown(self):
        super().tearDown()
        self.backend.terminate()
        self.backend.wait(timeout=10)
        self.backend.stdout.close()
        self.backend.stderr.close()

    def test_secure_complete_workflow(self):
        self.login()
        self.assertEqual(self.eval('backendMode'), 'secure')
        self.assertTrue(self.eval('authToken.length > 40'))
        self.assertFalse(self.eval('globalUsers.some(u => "Password" in u)'))
        today = self.today()
        self.eval(f'''() => {{ switchPage('reservasi'); $('r_nama').value='Tamu Uji'; $('r_hp').value='08123'; $('r_kamar').value='101'; $('r_in').value='{today}'; $('r_out').value='{today}'; setRawNum('r_dp',50000); }}''')
        self.invoke('submitReservasi({preventDefault(){},target:$("form-reservasi")})')
        self.assertEqual(self.eval('globalReservasi.length'), 1)
        self.assertEqual(self.eval('globalPembayaran.length'), 1)
        self.assertEqual(self.page.locator('#d_rev').inner_text(), 'Rp 50.000')
        self.eval('switchPage("checkin"); $("ci_cari_resv").value=globalReservasi[0]["Kode Booking"]; cariReservasiCI(); $("ci_ktp").value="0012345678901234"')
        self.invoke('submitCheckin({preventDefault(){},target:$("form-checkin")})')
        self.assertEqual(self.eval('globalTransaksi.length'), 1)
        self.assertEqual(self.eval('globalTamu.length'), 1)
        self.assertEqual(self.eval('globalPembayaran.length'), 1)
        self.assertEqual(self.eval('globalTamu[0]["Total Menginap"]'), 1)
        self.assertEqual(self.page.locator('#pr_balance').inner_text(), 'Rp 150.000')
        self.eval('switchPage("checkout"); $("co_kamar").value="101"; loadTagihanCheckout(); setRawNum("co_laundry",25000)')
        self.eval('submitCheckout(); undefined')
        self.page.locator('.swal2-confirm').click()
        self.page.wait_for_function('!busy')
        self.assertEqual(self.eval('globalTransaksi[0]["Status Transaksi"]'), 'Selesai (Check-out)')
        self.assertEqual(self.eval('globalKamar[0].Status'), 'Cleaning')
        self.assertEqual(self.eval('globalTamu[0]["Total Pembayaran"]'), 225000)
        self.assertEqual(self.page.locator('#d_rev').inner_text(), 'Rp 225.000')
        self.assertEqual(self.page.locator('#lap_pendapatan').inner_text(), 'Rp 225.000')
        self.assertEqual(self.page.locator('#pr_paid').inner_text(), 'Rp 175.000')

    def test_secure_role_restriction_and_logout(self):
        self.login('112233')
        self.assertEqual(self.page.locator('#sidebar-menu a').count(), 2)
        response = self.eval('requestAPI("getUser").catch(e => ({code:e.code}))')
        self.assertEqual(response['code'], 'FORBIDDEN')
        self.eval('lockSession()')
        self.assertEqual(self.eval('authToken'), '')
        self.assertTrue(self.page.locator('#login-screen').is_visible())


# Inherit helpers and fixture behavior, but run only these integrated secure cases.
if __name__ == '__main__':
    suite = unittest.TestSuite(SecureBrowserChecks(name) for name in ['test_secure_complete_workflow', 'test_secure_role_restriction_and_logout'])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
