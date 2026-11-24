const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createBackend } = require('./gas_harness.cjs');

function initialized(options) {
    const b = createBackend(options); b.setup(); b.token = b.login().data.token; return b;
}
function booking(b, overrides = {}) {
    return b.objectRow('Reservasi', { 'Kode Booking': 'BK-TEST', 'Nama Pemesan': 'Tamu Uji', 'No HP': '08123', 'No Kamar': '101', 'Tgl Check-in': b.today(), 'Tgl Check-out': b.today(), 'Jumlah Hari': 1, 'Harga Total': 200000, DP: 50000, 'Metode Bayar': 'Tunai', Catatan: '', 'Status Booking': 'Menunggu', ...overrides });
}
function checkin(b, overrides = {}) {
    const row = b.objectRow('Transaksi (In-Out)', { 'No Invoice': 'INV-TEST', 'Nama Tamu': 'Tamu Uji', 'No KTP': '0012345678901234', 'No HP': '08123', Alamat: 'Alamat', 'No Kamar': '101', 'Tgl Check-in': b.today(), 'Tgl Check-out': b.today(), 'Lama Menginap': '1', 'Biaya Kamar': 200000, Laundry: 0, Makanan: 0, Minibar: 0, Denda: 0, Diskon: 0, DP: 50000, 'Total Tagihan': 200000, 'Sudah Dibayar': 50000, Sisa: 150000, 'Metode Bayar': 'Tunai', 'Status Transaksi': 'Aktif (Check-in)', ...overrides });
    return { transaksiData: row, noKamar: '101', kodeBooking: '' };
}
function write(b, action, data, requestId = b.id(), token = b.token) { return b.api(action, data, token, requestId); }

test('setup creates all ten sheets, exact headers and only two triggers', () => {
    const b = initialized(); assert.equal(Object.keys(b.schema).length, 10);
    for (const [name, headers] of Object.entries(b.schema)) assert.deepEqual(b.sheets.get(name).cells[0], headers);
    assert.equal(b.triggers.length, 2); b.setup(); assert.equal(b.triggers.length, 2);
    assert.equal(b.ss.timeZone, 'Asia/Jakarta'); assert.equal(b.rows('Data Kamar').length, 2);
});
test('setup maps old headers by name and preserves custom columns in a backup', () => {
    const b = createBackend(); b.seed('Data Kamar', [['Standard', '101', 200000, 'Kosong', 'extra']], ['Tipe', 'No Kamar', 'Harga', 'Status', 'Catatan Sendiri']);
    b.setup(); const row = b.rows('Data Kamar')[0]; assert.equal(row['No Kamar'], '101'); assert.equal(row.Tipe, 'Standard'); assert.equal(row['Catatan Sendiri'], 'extra');
    assert.ok([...b.sheets.keys()].some(name => name.startsWith('Cadangan Data Kamar')));
});
test('unknown and duplicate headers stop setup without overwriting data', () => {
    const b = createBackend(); b.seed('Data Tamu', [['keep']], ['Unknown']);
    assert.throws(() => b.setup(), /header yang dikenali/); assert.equal(b.sheets.get('Data Tamu').cells[1][0], 'keep');
    b.seed('Data Tamu', [['1', '2']], ['NIK', 'NIK']); assert.throws(() => b.setup(), /Header ganda/);
});
test('setup hashes existing PINs, never exposes them, and preserves leading-zero IDs', () => {
    const b = initialized(); assert.ok(b.rows('Data User').every(u => u.Password.startsWith('hmac-sha256$')));
    assert.equal(b.get('getUser').code, 'UNAUTHORIZED'); assert.equal(b.login('123456').code, 'INVALID_PIN');
    const snapshot = b.api('getSnapshot', undefined, b.token).data;
    assert.ok(snapshot.users.every(u => !Object.hasOwn(u, 'Password')));
    assert.equal(b.get('getCapabilities').data.serverAuth, true);
});
test('anonymous and forged sessions cannot read data or mutate', () => {
    const b = initialized(); assert.equal(b.api('getSnapshot').code, 'UNAUTHORIZED');
    assert.equal(write(b, 'addKamar', [], b.id(), 'forged').code, 'UNAUTHORIZED');
    assert.equal(b.get('getTamu').code, 'UNAUTHORIZED');
});
test('server permissions prevent employees from modifying rooms or users', () => {
    const b = initialized(), staff = b.login('112233').data.token;
    assert.equal(write(b, 'addKamar', [], b.id(), staff).code, 'FORBIDDEN');
    assert.equal(b.api('getUser', undefined, staff).code, 'FORBIDDEN');
    assert.equal(write(b, 'deleteData', { sheetName: 'Transaksi (In-Out)', searchColIndex: 1, searchValue: 'INV' }, b.id()).code, 'FORBIDDEN');
});
test('failed login attempts are throttled and lock released on failure', () => {
    const b = initialized(); for (let i = 0; i < 15; i++) assert.equal(b.login('000000').code, 'INVALID_PIN');
    assert.equal(b.login().code, 'RATE_LIMIT'); b.properties.delete('LOGIN_ATTEMPTS'); assert.equal(b.login().status, 'success');
});
test('logout and account deactivation revoke sessions immediately', () => {
    const b = initialized(); assert.equal(b.api('logout', undefined, b.token).status, 'success'); assert.equal(b.api('getSnapshot', undefined, b.token).code, 'UNAUTHORIZED');
    const token = b.login().data.token; b.sheets.get('Data User').cells[1][4] = 'Nonaktif'; assert.equal(b.api('getSnapshot', undefined, token).code, 'UNAUTHORIZED');
});
test('booking records an actual cash receipt and reserves the room', () => {
    const b = initialized(); assert.equal(write(b, 'addReservasi', booking(b)).status, 'success');
    assert.equal(b.rows('Data Kamar')[0].Status, 'Booking'); assert.equal(b.rows('Pembayaran')[0].Nominal, 50000);
    assert.equal(b.rows('Dashboard').find(r => r.Indikator === 'Penerimaan Hari Ini').Nilai, 50000);
});
test('server detects overlapping bookings and ignores client fabricated totals', () => {
    const b = initialized(); write(b, 'addReservasi', booking(b));
    assert.equal(write(b, 'addReservasi', booking(b, { 'Kode Booking': 'BK-OTHER' })).code, 'CONFLICT');
    const c = initialized(); assert.equal(write(c, 'addReservasi', booking(c, { 'Harga Total': 1 })).code, 'VALIDATION'); assert.equal(c.rows('Pembayaran').length, 0);
});
test('request IDs make a replay idempotent and reject changed payloads', () => {
    const b = initialized(), id = b.id(), row = booking(b);
    assert.equal(write(b, 'addReservasi', row, id).status, 'success'); assert.equal(write(b, 'addReservasi', row, id).status, 'success');
    assert.equal(b.rows('Reservasi').length, 1); assert.equal(b.rows('Pembayaran').length, 1);
    row[1] = 'Other'; assert.equal(write(b, 'addReservasi', row, id).code, 'CONFLICT');
});
test('check-in creates guest, invoice, payment and occupancy together', () => {
    const b = initialized(); assert.equal(write(b, 'checkIn', checkin(b)).status, 'success');
    assert.equal(b.rows('Data Tamu')[0].NIK, '0012345678901234'); assert.equal(b.rows('Data Tamu')[0]['Total Menginap'], 1);
    assert.equal(b.rows('Data Tamu')[0]['Total Pembayaran'], 50000); assert.equal(b.rows('Data Kamar')[0].Status, 'Terisi');
});
test('booking DP is not counted again at check-in, including top-ups', () => {
    const b = initialized(); write(b, 'addReservasi', booking(b));
    const ci = checkin(b, { DP: 75000, 'Sudah Dibayar': 75000, Sisa: 125000 }); ci.kodeBooking = 'BK-TEST';
    assert.equal(write(b, 'checkIn', ci).status, 'success');
    assert.equal(b.rows('Pembayaran').reduce((sum, p) => sum + p.Nominal, 0), 75000);
    assert.equal(b.rows('Reservasi')[0]['Status Booking'], 'Selesai'); assert.equal(b.rows('Transaksi (In-Out)')[0]['Kode Booking'], 'BK-TEST');
});
test('second device cannot check-in an already occupied room', () => {
    const b = initialized(); write(b, 'checkIn', checkin(b));
    assert.equal(write(b, 'checkIn', checkin(b, { 'No Invoice': 'INV-DEVICE2' })).code, 'CONFLICT');
    assert.equal(b.rows('Transaksi (In-Out)').length, 1);
});
test('checkout updates guest totals, room, balance, ledger and dashboard', () => {
    const b = initialized(); write(b, 'checkIn', checkin(b));
    const original = b.rows('Transaksi (In-Out)')[0];
    Object.assign(original, { Laundry: 25000, 'Total Tagihan': 225000, 'Sudah Dibayar': 225000, Sisa: 0, 'Status Transaksi': 'Selesai (Check-out)' });
    const payload = { noInvoice: original['No Invoice'], noKamar: '101', updateTransaksiData: b.objectRow('Transaksi (In-Out)', original).slice(0, 21) };
    assert.equal(write(b, 'checkOut', payload).status, 'success');
    assert.equal(b.rows('Data Kamar')[0].Status, 'Cleaning'); assert.equal(b.rows('Data Tamu')[0]['Total Pembayaran'], 225000);
    assert.equal(b.rows('Pembayaran').reduce((sum, p) => sum + p.Nominal, 0), 225000);
    assert.equal(write(b, 'checkOut', payload).code, 'CONFLICT');
});
test('failure while saving rolls back already written sheets', () => {
    const b = initialized(), before = b.rows('Data Kamar'); b.faults.set('Transaksi (In-Out)', 1);
    assert.equal(write(b, 'checkIn', checkin(b)).status, 'error');
    assert.deepEqual(b.rows('Data Kamar'), before); assert.equal(b.rows('Data Tamu').length, 0); assert.equal(b.rows('Transaksi (In-Out)').length, 0); assert.equal(b.rows('Pembayaran').length, 0);
});
test('script lock blocks writes while another operation holds it', () => {
    const b = initialized(); b.blockLock(true); assert.equal(write(b, 'checkIn', checkin(b)).code, 'BUSY'); b.blockLock(false); assert.equal(write(b, 'checkIn', checkin(b)).status, 'success');
});
test('profile upsert preserves unrelated settings', () => {
    const b = initialized(); b.sheets.get('Pengaturan').cells.push(['Other', 'Keep', 'Value', 'Comment']);
    assert.equal(write(b, 'savePengaturan', [['Profil Invoice', 'Nama Penginapan', 'Hotel Baru', 'Invoice']]).status, 'success');
    assert.equal(b.rows('Pengaturan').find(p => p.Item === 'Keep').Nilai, 'Value');
});
test('repeated setup never duplicates receipts for new or historical transactions', () => {
    const b = initialized(); write(b, 'checkIn', checkin(b)); const sum = () => b.rows('Pembayaran').reduce((a, p) => a + p.Nominal, 0);
    assert.equal(sum(), 50000); b.setup(); b.setup(); assert.equal(sum(), 50000);
});
test('user input is escaped before reaching spreadsheet formulas', () => {
    const b = initialized(); const data = b.objectRow('Data Tamu', { NIK: '001', 'Nama Lengkap': '=IMPORTXML("evil")', 'No HP': '08123' });
    assert.equal(write(b, 'addTamu', data).status, 'success');
    // Service mock removes the apostrophe, as getValues does; no executable input is passed to setValues.
    assert.equal(b.rows('Data Tamu')[0]['Nama Lengkap'], '=IMPORTXML("evil")');
    assert.equal(b.sheets.get('Data Tamu').getDataRange().getFormulas()[1][1], '');
});
test('scheduled synchronization repairs reordered headers without losing rows', () => {
    const b = initialized(); b.seed('Data Kamar', [['Standard', '101', 200000, 'Kosong']], ['Tipe', 'No Kamar', 'Harga', 'Status']);
    b.context.sinkronkanSistemPenginapan(); assert.equal(b.rows('Data Kamar')[0]['No Kamar'], '101'); assert.equal(b.rows('Data Kamar')[0].Harga, 200000);
});
test('limited administrators cannot elevate permissions using a mixed access list', () => {
    const b = initialized({ users: [{ Username: 'Admin', Password: '654321', Role: 'Super Admin', 'Hak Akses': 'Semua Akses', Status: 'Aktif' }, { Username: 'Limited', Password: '112233', Role: 'Custom', 'Hak Akses': 'Pengaturan', Status: 'Aktif' }] });
    const token = b.login('112233').data.token;
    assert.equal(write(b, 'addUser', ['New', '998877', 'Custom', 'Pengaturan, Semua Akses', 'Aktif'], b.id(), token).code, 'FORBIDDEN');
    assert.equal(write(b, 'addUser', ['New', '998877', 'Custom', 'Check Out', 'Aktif'], b.id(), token).code, 'FORBIDDEN');
    assert.equal(write(b, 'deleteData', { sheetName: 'Data User', searchColIndex: 1, searchValue: 'Admin' }, b.id(), token).code, 'FORBIDDEN');
});
test('rollback preserves literal formula-looking input and existing custom formulas', () => {
    const b = initialized();
    write(b, 'addTamu', b.objectRow('Data Tamu', { NIK: '001', 'Nama Lengkap': '=1+1', 'No HP': '08123' }));
    const sheet = b.sheets.get('Data Tamu'); sheet.cells[0].push('Custom Calculation'); sheet.cells[1].push('=SUM(1,2)');
    b.faults.set('Transaksi (In-Out)', 1); assert.equal(write(b, 'checkIn', checkin(b)).status, 'error');
    assert.equal(sheet.getDataRange().getFormulas()[1][1], '');
    assert.equal(sheet.getDataRange().getFormulas()[1][9], '=SUM(1,2)');
    assert.equal(b.rows('Data Tamu')[0]['Nama Lengkap'], '=1+1');
});
test('setup keeps zeros from formatted numeric identifiers before changing column formats', () => {
    const b = createBackend(); const sheet = b.sheets.get('Data Kamar'); sheet.cells[1][0] = 101; sheet.displays.set('1:0', '00101');
    b.setup(); assert.equal(b.rows('Data Kamar')[0]['No Kamar'], '00101');
});
test('new empty spreadsheets bootstrap an admin from the owner property only', () => {
    const b = createBackend({ users: [] }); assert.throws(() => b.setup(), /PIN_ADMIN_AWAL/);
    b.properties.set('PIN_ADMIN_AWAL', '887766'); b.setup();
    assert.equal(b.login('887766').data.user.Username, 'admin');
    assert.equal(b.properties.has('PIN_ADMIN_AWAL'), false); assert.equal(b.login('123456').code, 'INVALID_PIN');
});
