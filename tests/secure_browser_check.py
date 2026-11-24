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
        self.assertEqual(self.page.locator('#d_rev_count').inner_text(), '1')
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
        self.assertEqual(self.page.locator('#d_rev_count').inner_text(), '2')
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
        self.login(); self.fill_ci()
        self.invoke('submitCheckin({preventDefault(){},target:$("form-checkin")})')
        self.eval('switchPage("checkout"); $("co_kamar").value="101"; loadTagihanCheckout()')
        self.assertEqual(self.page.locator('#lbl_co_nama').inner_text(), 'Tamu Uji')
        self.assertEqual(self.page.locator('#lbl_co_biaya').inner_text(), 'Rp 200.000')

    def test_secure_master_data_crud_and_room_status_sync(self):
        self.login()
        self.eval('switchPage("kamar"); $("k_no").value="201"; $("k_tipe").value="Deluxe"; setRawNum("k_harga",275000); otomatisFasilitas()')
        self.invoke('submitKamar({preventDefault(){},target:$("form-kamar")})')
        self.assertEqual(self.eval('globalKamar.length'), 3)
        self.assertEqual(self.page.locator('#d_tot').inner_text(), '3')
        self.eval('editRowKamar("201"); $("k_status").value="Maintenance"; $("k_ket").value="Perbaikan AC"')
        self.invoke('submitKamar({preventDefault(){},target:$("form-kamar")})')
        self.assertNotIn('201', self.eval('[...$("ci_kamar").options].map(o=>o.value)'))
        self.eval('klikKamarDashboard("201"); undefined')
        self.page.locator('.swal2-confirm').click()
        self.page.wait_for_function('!busy && roomById("201").Status === "Kosong"')
        self.assertIn('201', self.eval('[...$("ci_kamar").options].map(o=>o.value)'))
        self.eval('switchPage("tamu"); $("t_nik").value="000777"; $("t_nama").value="Tamu Baru"; $("t_hp").value="081111"')
        self.invoke('submitTamu({preventDefault(){},target:$("form-tamu")})')
        self.eval('editRowTamu("000777"); $("t_hp").value="082222"')
        self.invoke('submitTamu({preventDefault(){},target:$("form-tamu")})')
        self.assertEqual(self.eval('globalTamu[0]["No HP"]'), '082222')
        self.eval('hapusData("Data Tamu",1,"000777"); undefined')
        self.page.locator('.swal2-confirm').click()
        self.page.wait_for_function('!busy && globalTamu.length === 0')
        self.eval('switchPage("kamar"); hapusData("Data Kamar",1,"201"); undefined')
        self.page.locator('.swal2-confirm').click()
        self.page.wait_for_function('!busy && globalKamar.length === 2')
        self.assertEqual(self.page.locator('#d_tot').inner_text(), '2')

    def test_secure_booking_edit_keeps_agreed_price_then_checkin_and_reports_match(self):
        self.login(); today = self.today()
        self.eval(f'''() => {{ switchPage('reservasi'); $('r_nama').value='Tamu Uji'; $('r_hp').value='08123'; $('r_kamar').value='101'; $('r_in').value='{today}'; $('r_out').value='{today}'; setRawNum('r_dp',50000); }}''')
        self.invoke('submitReservasi({preventDefault(){},target:$("form-reservasi")})')
        self.eval('switchPage("kamar"); editRowKamar("101"); setRawNum("k_harga",350000)')
        self.invoke('submitKamar({preventDefault(){},target:$("form-kamar")})')
        self.eval('switchPage("reservasi"); editRowReservasi(globalReservasi[0]["Kode Booking"]); $("r_catatan").value="Datang sore"')
        self.assertIn('200.000', self.page.locator('#r_info').input_value())
        self.invoke('submitReservasi({preventDefault(){},target:$("form-reservasi")})')
        self.assertEqual(self.eval('globalReservasi[0]["Harga Total"]'), 200000)
        self.assertEqual(self.eval('globalPembayaran.length'), 1)
        self.eval('switchPage("checkin"); $("ci_cari_resv").value=globalReservasi[0]["Kode Booking"]; cariReservasiCI(); $("ci_ktp").value="000888"')
        self.assertEqual(self.eval('getRawNum("ci_biaya")'), 200000)
        self.invoke('submitCheckin({preventDefault(){},target:$("form-checkin")})')
        self.assertEqual(self.eval('globalTransaksi[0]["Total Tagihan"]'), 200000)
        self.assertEqual(self.page.locator('#d_rev').inner_text(), 'Rp 50.000')
        self.assertEqual(self.page.locator('#lap_pendapatan').inner_text(), 'Rp 50.000')

    def test_secure_settings_saved_profile_prints_in_history(self):
        self.login(); self.eval('switchPage("pengaturan")')
        self.page.locator('#set_hotel').fill('Hotel Terintegrasi')
        self.page.locator('#set_alamat').fill('Jalan Integrasi 12')
        self.page.locator('#set_telp').fill('0812345')
        self.eval('simpanProfilPengaturan(); undefined')
        self.page.wait_for_function('$("swal2-title")?.textContent === "Tersimpan"')
        self.dismiss(); self.fill_ci()
        self.invoke('submitCheckin({preventDefault(){},target:$("form-checkin")})')
        self.eval('switchPage("pembayaran"); triggerPrint("riwayat",globalTransaksi[0]["No Invoice"])')
        self.assertEqual(self.page.locator('#pr_hotel_name').inner_text(), 'Hotel Terintegrasi')
        self.assertEqual(self.page.locator('#pr_hotel_address').inner_text(), 'Jalan Integrasi 12')
        self.assertEqual(self.page.locator('#pr_balance').inner_text(), 'Rp 150.000')
        self.eval('switchPage("laporan"); $("filter_lap_tgl").value="2000-01-01"; renderLaporanData()')
        self.assertEqual(self.page.locator('#lap_pendapatan').inner_text(), 'Rp 0')
        self.eval('$("filter_lap_tgl").value=""; renderLaporanData()')
        self.assertEqual(self.page.locator('#lap_pendapatan').inner_text(), 'Rp 50.000')

    def test_secure_cancel_zero_deposit_booking_releases_room(self):
        self.login(); today = self.today()
        self.eval(f'''() => {{ switchPage('reservasi'); $('r_nama').value='Booking Tanpa DP'; $('r_hp').value='08123'; $('r_kamar').value='101'; $('r_in').value='{today}'; $('r_out').value='{today}'; }}''')
        self.invoke('submitReservasi({preventDefault(){},target:$("form-reservasi")})')
        self.assertEqual(self.eval('roomById("101").Status'), 'Booking')
        self.eval('hapusData("Reservasi",1,globalReservasi[0]["Kode Booking"]); undefined')
        self.page.locator('.swal2-confirm').click()
        self.page.wait_for_function('!busy && globalReservasi.length === 0')
        self.assertEqual(self.eval('roomById("101").Status'), 'Kosong')
        self.assertEqual(self.eval('globalPembayaran.length'), 0)

    def test_secure_recovery_status_blocks_new_writes_after_refresh(self):
        self.login()
        self.eval('''() => {
            const read=fetchAPI;
            fetchAPI=async action=>{ const result=await read(action); if(action==='getSnapshot') result.data.recoveryRequired=true; return result; };
        }''')
        self.assertFalse(self.eval('loadAllData()'))
        self.assertFalse(self.eval('dataFresh'))
        self.assertIn('pemulihan', self.page.locator('#sync-status').inner_text())


# Inherit helpers and fixture behavior, but run only these integrated secure cases.
if __name__ == '__main__':
    names = [name for name in unittest.defaultTestLoader.getTestCaseNames(SecureBrowserChecks) if name.startswith('test_secure_')]
    suite = unittest.TestSuite(SecureBrowserChecks(name) for name in names)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    raise SystemExit(not result.wasSuccessful())
