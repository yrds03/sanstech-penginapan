'use strict';

const SS_ID = '1Z2iCSjdW2oi5dEucNR34mD-U2TEHi779OfbKgm11vwA';
const API_VERSION = '2.0.0';
const HOTEL_TZ = 'Asia/Jakarta';
const SHEET_SCHEMA = {
  'Dashboard': ['Indikator', 'Nilai', 'Keterangan'],
  'Data Kamar': ['No Kamar', 'Tipe', 'Harga', 'Lantai', 'Fasilitas', 'Keterangan', 'Status'],
  'Data Tamu': ['NIK', 'Nama Lengkap', 'Jenis Kelamin', 'Tanggal Lahir', 'No HP', 'Email', 'Alamat', 'Total Menginap', 'Total Pembayaran'],
  'Reservasi': ['Kode Booking', 'Nama Pemesan', 'No HP', 'No Kamar', 'Tgl Check-in', 'Tgl Check-out', 'Jumlah Hari', 'Harga Total', 'DP', 'Metode Bayar', 'Catatan', 'Status Booking'],
  'Transaksi (In-Out)': ['No Invoice', 'Nama Tamu', 'No KTP', 'No HP', 'Alamat', 'No Kamar', 'Tgl Check-in', 'Tgl Check-out', 'Lama Menginap', 'Biaya Kamar', 'Laundry', 'Makanan', 'Minibar', 'Denda', 'Diskon', 'DP', 'Total Tagihan', 'Sudah Dibayar', 'Sisa', 'Metode Bayar', 'Status Transaksi', 'Kode Booking'],
  'Pengaturan': ['Kategori', 'Item', 'Nilai', 'Keterangan'],
  'Data User': ['Username', 'Password', 'Role', 'Hak Akses', 'Status'],
  'Pembayaran': ['ID Pembayaran', 'No Invoice', 'Kode Booking', 'Tanggal', 'Jenis', 'Nominal', 'Metode Bayar', 'Petugas', 'Keterangan'],
  'Log Aktivitas': ['ID Log', 'Waktu', 'Petugas', 'Aksi', 'Referensi', 'Keterangan'],
  'Permintaan API': ['ID Permintaan', 'Username', 'Aksi', 'Payload Hash', 'Status', 'Hasil', 'Waktu']
};
const MONEY_COLUMNS = ['Harga', 'Harga Total', 'Biaya Kamar', 'Laundry', 'Makanan', 'Minibar', 'Denda', 'Diskon', 'DP', 'Total Tagihan', 'Sudah Dibayar', 'Sisa', 'Total Pembayaran', 'Nominal'];
const DATE_COLUMNS = ['Tgl Check-in', 'Tgl Check-out', 'Tanggal Lahir'];
const TEXT_COLUMNS = ['No Kamar', 'NIK', 'No KTP', 'No HP', 'Username', 'Password', 'Kode Booking', 'No Invoice', 'Nomor Telepon'];
const MENUS = ['Dashboard', 'Data Kamar', 'Data Tamu', 'Reservasi', 'Check In', 'Check Out', 'Pembayaran', 'Laporan', 'Pengaturan'];

function fail_(code, message) { const error = new Error(message); error.code = code; throw error; }
function str_(v) { return String(v === null || v === undefined ? '' : v).trim(); }
function now_() { return new Date().toISOString(); }
function today_() { return Utilities.formatDate(new Date(), HOTEL_TZ, 'yyyy-MM-dd'); }
function id_(prefix) { return prefix + '-' + Utilities.getUuid(); }
function number_(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : 0;
  let s = str_(v).replace(/Rp\s*/gi, '').replace(/\s/g, '');
  if (!s) return 0;
  if (!/^-?[\d.,]+$/.test(s)) fail_('VALIDATION', 'Nilai uang tidak valid.');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Math.round(Number(s));
  if (!Number.isSafeInteger(n) || Math.abs(n) > 1000000000000) fail_('VALIDATION', 'Nilai uang di luar batas.');
  return n;
}
function date_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, HOTEL_TZ, 'yyyy-MM-dd');
  const s = str_(v);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const parsed = new Date(s); return Number.isFinite(parsed.getTime()) ? Utilities.formatDate(parsed, HOTEL_TZ, 'yyyy-MM-dd') : '';
  }
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) { const p = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); if (p) m = [p[0], p[3], p[2], p[1]]; }
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return '';
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}
function days_(a, b) { a = date_(a); b = date_(b); if (!a || !b || b < a) fail_('VALIDATION', 'Tanggal menginap tidak valid.'); return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000)); }
function active_(t) { return /^Aktif(?:\s|$|\()/i.test(str_(t['Status Transaksi'])); }
function finished_(t) { return /^Selesai(?:\s|$|\()/i.test(str_(t['Status Transaksi'])); }
function waiting_(r) { return str_(r['Status Booking']).toLowerCase() === 'menunggu'; }
function allowed_(user, menu) { const access = str_(user['Hak Akses']).split(',').map(str_); return access.includes('Semua Akses') || access.includes(menu); }
function require_(user, menus) { if (!menus.some(menu => allowed_(user, menu))) fail_('FORBIDDEN', 'Anda tidak memiliki izin untuk operasi ini.'); }
function safeCell_(v) { return typeof v === 'string' && /^\s*[=+@]/.test(v) ? "'" + v : v; }
function required_(v, field) { const s = str_(v); if (!s || s.length > 2000) fail_('VALIDATION', field + ' wajib diisi dengan benar.'); return s; }
function rowObject_(name, row) {
  if (!Array.isArray(row) || (row.length !== SHEET_SCHEMA[name].length && !(name === 'Transaksi (In-Out)' && row.length === 21))) fail_('VALIDATION', 'Jumlah kolom ' + name + ' tidak sesuai.');
  const result = {}; SHEET_SCHEMA[name].forEach((header, i) => { result[header] = MONEY_COLUMNS.includes(header) ? number_(row[i]) : str_(row[i]); }); return result;
}
function byId_(rows, key, value) { return rows.find(row => str_(row[key]) === str_(value)); }
function sheet_(name) { const sheet = SpreadsheetApp.openById(SS_ID).getSheetByName(name); if (!sheet) fail_('SETUP_REQUIRED', 'Sheet ' + name + ' belum tersedia. Jalankan setupSistemPenginapan.'); return sheet; }
function readRows_(name) {
  const sheet = sheet_(name); const values = sheet.getDataRange().getValues(); const display = sheet.getDataRange().getDisplayValues();
  if (!values.length) return [];
  const headers = values[0].map(str_);
  if (SHEET_SCHEMA[name].some((h, i) => headers[i] !== h)) fail_('SCHEMA_MISMATCH', 'Header ' + name + ' perlu diperbaiki melalui setupSistemPenginapan.');
  return values.slice(1).map((row, index) => {
    const result = {}; headers.forEach((header, i) => {
      const v = row[i];
      result[header] = v instanceof Date ? (DATE_COLUMNS.includes(header) ? date_(v) : v.toISOString()) : TEXT_COLUMNS.includes(header) ? str_(display[index + 1][i]) : v;
    }); return result;
  }).filter(row => Object.values(row).some(v => v !== '' && v !== null));
}
function writeRows_(name, rows) {
  const sheet = sheet_(name), headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(str_);
  const oldValues = sheet.getDataRange().getValues(), oldFormulas = sheet.getDataRange().getFormulas(), extras = {};
  oldValues.slice(1).forEach((row, index) => { extras[str_(row[0])] = headers.map((h, col) => oldFormulas[index + 1][col] || safeCell_(row[col])); });
  const last = sheet.getLastRow();
  if (rows.length + 1 > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows.map(row => headers.map((h, col) => {
    if (!SHEET_SCHEMA[name].includes(h) && extras[str_(row[headers[0]])]) return extras[str_(row[headers[0]])][col];
    return safeCell_(row[h] === undefined ? '' : row[h]);
  })));
  if (last > rows.length + 1) sheet.getRange(rows.length + 2, 1, last - rows.length - 1, headers.length).clearContent();
}
function state_() {
  const state = {}; Object.keys(SHEET_SCHEMA).forEach(name => { if (name !== 'Permintaan API') state[name] = readRows_(name); }); return state;
}
function persist_(before, after) {
  const changed = Object.keys(after).filter(name => JSON.stringify(before[name]) !== JSON.stringify(after[name])); const written = [], backups = {};
  changed.forEach(name => { const sheet = sheet_(name), values = sheet.getDataRange().getValues(), formulas = sheet.getDataRange().getFormulas(); backups[name] = values.map((row, i) => row.map((v, col) => formulas[i][col] || safeCell_(v))); });
  try {
    changed.forEach(name => { written.push(name); writeRows_(name, after[name]); }); SpreadsheetApp.flush();
  } catch (error) {
    let rollbackFailed = false;
    written.reverse().forEach(name => { try { const sheet = sheet_(name), values = backups[name]; sheet.getDataRange().clearContent(); sheet.getRange(1, 1, values.length, values[0].length).setValues(values); } catch (_) { rollbackFailed = true; } });
    if (rollbackFailed) { PropertiesService.getScriptProperties().setProperty('RECOVERY_REQUIRED', now_()); fail_('RECOVERY_REQUIRED', 'Pemulihan otomatis belum selesai. Periksa sheet dan jalankan setup sebelum melanjutkan.'); }
    throw error;
  }
}
function lock_(operation) {
  const lock = LockService.getScriptLock(); if (!lock.tryLock(20000)) fail_('BUSY', 'Sistem sedang memproses transaksi lain. Coba lagi setelah sinkronisasi.');
  try { return operation(); } finally { lock.releaseLock(); }
}
function response_(data, message) { return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: data === undefined ? null : data, message: message || 'Berhasil', apiVersion: API_VERSION })).setMimeType(ContentService.MimeType.JSON); }
function errorResponse_(error) { return ContentService.createTextOutput(JSON.stringify({ status: 'error', code: error.code || 'SERVER_ERROR', message: error.code ? error.message : 'Operasi belum berhasil. Periksa log Apps Script.', apiVersion: API_VERSION })).setMimeType(ContentService.MimeType.JSON); }

// Run once from the editor. Safe to repeat: existing data and extra columns survive.
function setupSistemPenginapan() {
  return lock_(function () {
    const ss = SpreadsheetApp.openById(SS_ID); ss.setSpreadsheetTimeZone(HOTEL_TZ);
    Object.keys(SHEET_SCHEMA).forEach(name => ensureSheet_(ss, name));
    const before = state_(), next = JSON.parse(JSON.stringify(before));
    migrateUsers_(next);
    if (!next['Data User'].some(u => str_(u.Status) === 'Aktif' && allowed_(u, 'Pengaturan'))) fail_('SETUP_REQUIRED', 'Sediakan admin aktif pada Data User. Untuk sheet baru, isi PIN_ADMIN_AWAL pada Script Properties sebelum setup.');
    if (!next.Pengaturan.length) next.Pengaturan = [
      { Kategori: 'Profil Invoice', Item: 'Nama Penginapan', Nilai: 'SANSTECH PENGINAPAN', Keterangan: 'Profil invoice' },
      { Kategori: 'Profil Invoice', Item: 'Alamat Lengkap', Nilai: '', Keterangan: 'Profil invoice' },
      { Kategori: 'Profil Invoice', Item: 'Nomor Telepon', Nilai: '', Keterangan: 'Profil invoice' }
    ];
    if (!PropertiesService.getScriptProperties().getProperty('PAYMENTS_MIGRATED')) backfillPayments_(next);
    reconcile_(next); persist_(before, next); installTriggers_();
    PropertiesService.getScriptProperties().deleteProperty('PIN_ADMIN_AWAL');
    PropertiesService.getScriptProperties().setProperty('PAYMENTS_MIGRATED', now_());
    PropertiesService.getScriptProperties().setProperty('SCHEMA_VERSION', API_VERSION);
    return { spreadsheetId: SS_ID, sheets: Object.keys(SHEET_SCHEMA), apiVersion: API_VERSION, message: 'Sheet, header, format, dan trigger tersinkronisasi.' };
  });
}
function ensureSheet_(ss, name) {
  let sheet = ss.getSheetByName(name); const canonical = SHEET_SCHEMA[name];
  if (!sheet) sheet = ss.insertSheet(name);
  const rows = sheet.getDataRange().getValues(), displayed = sheet.getDataRange().getDisplayValues();
  const oldHeaders = (rows[0] || []).map(str_); const nonempty = oldHeaders.filter(Boolean);
  if (new Set(nonempty).size !== nonempty.length) fail_('SCHEMA_MISMATCH', 'Header ganda pada ' + name + '. Periksa sebelum setup.');
  const hasData = sheet.getLastRow() > 0 && rows.some(row => row.some(v => v !== ''));
  if (hasData && !oldHeaders.some(h => canonical.includes(h))) fail_('SCHEMA_MISMATCH', 'Sheet ' + name + ' tidak memiliki header yang dikenali. Data tidak ditimpa.');
  if (hasData && sheet.getLastRow() > 1 && !oldHeaders.includes(canonical[0])) fail_('SCHEMA_MISMATCH', 'Header identitas ' + canonical[0] + ' hilang pada ' + name + '. Periksa nama header sebelum setup.');
  const extras = oldHeaders.filter(h => h && !canonical.includes(h)), headers = canonical.concat(extras);
  if (hasData && headers.some((h, i) => oldHeaders[i] !== h)) {
    const backupName = ('Cadangan ' + name).slice(0, 65) + ' ' + Utilities.formatDate(new Date(), HOTEL_TZ, 'yyyyMMdd-HHmmss');
    sheet.copyTo(ss).setName(backupName);
    const formulas = sheet.getDataRange().getFormulas();
    const mapped = rows.slice(1).map((row, index) => headers.map(h => { const col = oldHeaders.indexOf(h); return col < 0 ? '' : TEXT_COLUMNS.includes(h) ? safeCell_(displayed[index + 1][col]) : formulas[index + 1][col] || safeCell_(row[col]); }));
    sheet.getDataRange().clearContent();
    if (mapped.length) sheet.getRange(2, 1, mapped.length, headers.length).setValues(mapped);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setBackground('#0b2136').setFontColor('#ffffff').setFontWeight('bold').setHorizontalAlignment('center');
  sheet.setFrozenRows(1);
  headers.forEach((h, i) => {
    if (TEXT_COLUMNS.includes(h)) sheet.getRange(2, i + 1, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('@');
    if (MONEY_COLUMNS.includes(h)) sheet.getRange(2, i + 1, Math.max(1, sheet.getMaxRows() - 1), 1).setNumberFormat('#,##0');
  });
  // Capture displayed IDs before changing formats, including zeros provided by a custom format.
  if (hasData && rows.length > 1 && headers.every((h, i) => oldHeaders[i] === h)) headers.forEach((h, col) => {
    if (TEXT_COLUMNS.includes(h)) sheet.getRange(2, col + 1, rows.length - 1, 1).setValues(displayed.slice(1).map(row => [safeCell_(row[col])]));
  });
  sheet.autoResizeColumns(1, headers.length);
}
function installTriggers_() {
  const handlers = ['sinkronkanSistemPenginapan', 'saatSheetDiubah'];
  handlers.forEach(handler => {
    const existing = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === handler);
    existing.slice(1).forEach(t => ScriptApp.deleteTrigger(t));
    if (!existing.length) {
      const builder = ScriptApp.newTrigger(handler);
      if (handler === 'saatSheetDiubah') builder.forSpreadsheet(SS_ID).onEdit().create();
      else builder.timeBased().everyMinutes(5).create();
    }
  });
}
function sinkronkanSistemPenginapan() {
  return lock_(function () {
    if (PropertiesService.getScriptProperties().getProperty('RECOVERY_REQUIRED')) return { status: 'blocked', code: 'RECOVERY_REQUIRED' };
    const ss = SpreadsheetApp.openById(SS_ID);
    Object.keys(SHEET_SCHEMA).forEach(name => {
      const sheet = ss.getSheetByName(name), expected = SHEET_SCHEMA[name];
      const headers = sheet ? sheet.getRange(1, 1, 1, expected.length).getValues()[0] : [];
      if (!sheet || expected.some((h, i) => h !== headers[i])) ensureSheet_(ss, name);
    });
    const before = state_(), next = JSON.parse(JSON.stringify(before)); migrateUsers_(next); reconcile_(next); persist_(before, next);
  });
}
function saatSheetDiubah(e) {
  if (!e || !e.range || !e.source || e.source.getId() !== SS_ID) return;
  if (!SHEET_SCHEMA[e.range.getSheet().getName()]) return;
  sinkronkanSistemPenginapan();
}

function secret_() {
  const properties = PropertiesService.getScriptProperties(); let secret = properties.getProperty('AUTH_PEPPER');
  if (!secret) { secret = Utilities.getUuid() + Utilities.getUuid(); properties.setProperty('AUTH_PEPPER', secret); } return secret;
}
function hmac_(value) { return Utilities.computeHmacSha256Signature(value, secret_()).map(b => (b & 255).toString(16).padStart(2, '0')).join(''); }
function pinHash_(pin) { const salt = Utilities.getUuid(); return 'hmac-sha256$' + salt + '$' + hmac_(salt + ':' + pin); }
function pinMatches_(pin, stored) {
  const parts = str_(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'hmac-sha256') return false;
  const expected = hmac_(parts[1] + ':' + pin), actual = parts[2];
  let different = expected.length ^ actual.length; for (let i = 0; i < expected.length; i++) different |= expected.charCodeAt(i) ^ (actual.charCodeAt(i) || 0); return different === 0;
}
function migrateUsers_(state) {
  const users = state['Data User']; const properties = PropertiesService.getScriptProperties();
  if (!users.length) {
    const pin = properties.getProperty('PIN_ADMIN_AWAL');
    if (!pin || !/^\d{6}$/.test(pin)) fail_('SETUP_REQUIRED', 'Isi PIN_ADMIN_AWAL enam angka pada Script Properties untuk membuat admin pertama.');
    users.push({ Username: 'admin', Password: pin, Role: 'Super Admin', 'Hak Akses': 'Semua Akses', Status: 'Aktif' });
  }
  users.forEach(u => {
    if (!str_(u.Password).startsWith('hmac-sha256$')) {
      const pin = str_(u.Password).padStart(6, '0');
      if (!/^\d{6}$/.test(pin)) fail_('VALIDATION', 'PIN lama harus terdiri dari enam angka sebelum migrasi.');
      u.Password = pinHash_(pin);
    }
  });
}
function publicUser_(u) { const profile = {}; ['Username', 'Role', 'Hak Akses', 'Status'].forEach(key => { profile[key] = u[key]; }); return profile; }
function login_(data) {
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty('SCHEMA_VERSION') !== API_VERSION) fail_('SETUP_REQUIRED', 'Jalankan setupSistemPenginapan di editor Apps Script terlebih dahulu.');
  let attempts; try { attempts = JSON.parse(properties.getProperty('LOGIN_ATTEMPTS') || '{}'); } catch (_) { attempts = {}; }
  const now = Date.now(); if (!attempts.start || now - attempts.start > 300000) attempts = { start: now, failures: 0 };
  if (attempts.failures >= 15) fail_('RATE_LIMIT', 'Terlalu banyak PIN salah. Tunggu lima menit sebelum mencoba lagi.');
  const pin = str_(data && data.pin);
  const matches = /^\d{6}$/.test(pin) ? readRows_('Data User').filter(u => str_(u.Status) === 'Aktif' && pinMatches_(pin, u.Password)) : [];
  if (matches.length !== 1) { attempts.failures++; properties.setProperty('LOGIN_ATTEMPTS', JSON.stringify(attempts)); fail_('INVALID_PIN', 'PIN tidak terdaftar, tidak unik, atau akun nonaktif.'); }
  // Do not reset the global failure counter on success: a valid PIN cannot bypass throttling.
  const user = matches[0], token = Utilities.getUuid() + Utilities.getUuid(), expiresAt = now + 14400000;
  CacheService.getScriptCache().put('session:' + hmac_(token), JSON.stringify({ username: user.Username, fingerprint: hmac_(user.Password), expiresAt: expiresAt }), 14400);
  return { token: token, user: publicUser_(user), expiresAt: expiresAt };
}
function authenticate_(token) {
  const raw = CacheService.getScriptCache().get('session:' + hmac_(str_(token))); let session;
  try { session = JSON.parse(raw || 'null'); } catch (_) { session = null; }
  if (!session || session.expiresAt <= Date.now()) fail_('UNAUTHORIZED', 'Sesi berakhir. Masuk kembali menggunakan PIN.');
  const user = byId_(readRows_('Data User'), 'Username', session.username);
  if (!user || str_(user.Status) !== 'Aktif' || hmac_(user.Password) !== session.fingerprint) fail_('UNAUTHORIZED', 'Akun atau PIN berubah. Masuk kembali.'); return user;
}
function doGet(e) {
  try {
    const action = str_(e && e.parameter && e.parameter.action);
    if (!action || action === 'getCapabilities') return response_({ apiVersion: API_VERSION, serverAuth: true, snapshot: true, paymentLedger: true, spreadsheetId: SS_ID });
    fail_('UNAUTHORIZED', 'Gunakan endpoint POST dengan sesi login; data dan PIN tidak tersedia melalui URL publik.');
  } catch (error) { return errorResponse_(error); }
}
function doPost(e) {
  try {
    if (!e || !e.postData || str_(e.postData.contents).length > 200000) fail_('VALIDATION', 'Permintaan tidak valid.');
    const body = JSON.parse(e.postData.contents);
    return lock_(function () {
      if (body.action === 'login') return response_(login_(body.data));
      const user = authenticate_(body.token);
      if (body.action === 'logout') { CacheService.getScriptCache().remove('session:' + hmac_(body.token)); return response_(null); }
      if (body.action === 'getSnapshot') return response_(snapshot_(user));
      if (body.action === 'getUser') { require_(user, ['Pengaturan']); return response_(readRows_('Data User').map(publicUser_)); }
      const readMap = { getKamar: ['Data Kamar', ['Dashboard', 'Data Kamar', 'Reservasi', 'Check In', 'Check Out', 'Laporan']], getTamu: ['Data Tamu', ['Data Tamu', 'Check In']], getReservasi: ['Reservasi', ['Dashboard', 'Reservasi', 'Check In']], getTransaksi: ['Transaksi (In-Out)', ['Pembayaran', 'Laporan', 'Check Out']], getPengaturan: ['Pengaturan', MENUS], getPembayaran: ['Pembayaran', ['Dashboard', 'Pembayaran', 'Laporan']] };
      if (readMap[body.action]) {
        require_(user, readMap[body.action][1]);
        let rows = readRows_(readMap[body.action][0]);
        if (body.action === 'getTransaksi' && !['Pembayaran', 'Laporan', 'Dashboard'].some(menu => allowed_(user, menu))) rows = rows.filter(active_);
        return response_(rows);
      }
      return response_(mutate_(user, body), 'Data tersimpan dan sheet tersinkronisasi.');
    });
  } catch (error) { return errorResponse_(error); }
}

function snapshot_(user) {
  require_(user, MENUS);
  const state = state_();
  const can = menus => menus.some(menu => allowed_(user, menu));
  const financial = can(['Dashboard', 'Pembayaran', 'Laporan']);
  const transactions = financial ? state['Transaksi (In-Out)'] : can(['Check In', 'Check Out']) ? state['Transaksi (In-Out)'].filter(active_) : can(['Data Kamar']) ? state['Transaksi (In-Out)'].filter(active_).map(t => ({ 'No Invoice': t['No Invoice'], 'No Kamar': t['No Kamar'], 'Tgl Check-in': t['Tgl Check-in'], 'Tgl Check-out': t['Tgl Check-out'], 'Status Transaksi': t['Status Transaksi'] })) : [];
  return {
    kamar: state['Data Kamar'], tamu: can(['Data Tamu', 'Check In']) ? state['Data Tamu'] : [],
    reservasi: can(['Dashboard', 'Reservasi', 'Check In']) ? state.Reservasi : [], transaksi: transactions,
    users: allowed_(user, 'Pengaturan') ? state['Data User'].map(publicUser_) : [publicUser_(user)],
    pengaturan: state.Pengaturan, pembayaran: can(['Dashboard', 'Pembayaran', 'Laporan']) ? state.Pembayaran : [],
    user: publicUser_(user), syncedAt: now_(), apiVersion: API_VERSION
  };
}
function overlap_(a, b, c, d) {
  a = date_(a); b = date_(b); c = date_(c); d = date_(d);
  if (!a || !b || !c || !d) fail_('VALIDATION', 'Terdapat tanggal tidak valid pada jadwal kamar.');
  const end = (start, stop) => stop > start ? stop : new Date(Date.parse(start) + 86400000).toISOString().slice(0, 10);
  return a < end(c, d) && c < end(a, b);
}
function conflict_(state, room, start, end, exceptBooking) {
  if (state.Reservasi.some(r => waiting_(r) && str_(r['No Kamar']) === str_(room) && str_(r['Kode Booking']) !== str_(exceptBooking) && overlap_(start, end, r['Tgl Check-in'], r['Tgl Check-out']))) fail_('CONFLICT', 'Jadwal bertabrakan dengan reservasi lain.');
  if (state['Transaksi (In-Out)'].some(t => active_(t) && str_(t['No Kamar']) === str_(room) && overlap_(start, end, t['Tgl Check-in'], t['Tgl Check-out']))) fail_('CONFLICT', 'Kamar masih digunakan pada jadwal tersebut.');
}
function payment_(state, data) {
  const amount = number_(data.amount); if (amount <= 0) return;
  state.Pembayaran.push({ 'ID Pembayaran': data.id || id_('PAY'), 'No Invoice': data.invoice || '', 'Kode Booking': data.booking || '', Tanggal: data.date || now_(), Jenis: data.kind, Nominal: amount, 'Metode Bayar': data.method, Petugas: data.user || 'Migrasi', Keterangan: data.note || '' });
}
function backfillPayments_(state) {
  const existing = new Set(state.Pembayaran.map(p => str_(p['ID Pembayaran'])));
  const note = 'Migrasi data lama: tanggal penerimaan asli belum tersedia; memakai tanggal transaksi.';
  state['Transaksi (In-Out)'].forEach(t => {
    const inv = str_(t['No Invoice']); const dp = number_(t.DP), paid = number_(t['Sudah Dibayar']);
    if (!inv || (!active_(t) && !finished_(t))) return;
    const base = { invoice: inv, booking: str_(t['Kode Booking']), method: t['Metode Bayar'], note: note };
    if (!existing.has('LEGACY-DP-' + inv)) payment_(state, Object.assign({}, base, { id: 'LEGACY-DP-' + inv, amount: dp, date: date_(t['Tgl Check-in']), kind: 'DP Migrasi' }));
    if (finished_(t) && !existing.has('LEGACY-CO-' + inv)) payment_(state, Object.assign({}, base, { id: 'LEGACY-CO-' + inv, amount: Math.max(0, paid - dp), date: date_(t['Tgl Check-out']), kind: 'Pelunasan Migrasi' }));
  });
  state.Reservasi.filter(waiting_).forEach(r => {
    const code = str_(r['Kode Booking']);
    if (!existing.has('LEGACY-BK-' + code)) payment_(state, { id: 'LEGACY-BK-' + code, booking: code, amount: r.DP, kind: 'DP Reservasi Migrasi', method: r['Metode Bayar'], note: 'Migrasi reservasi: tanggal penerimaan asli belum tersedia; dicatat pada waktu migrasi.' });
  });
}
function reconcile_(state) {
  ['Data Kamar', 'Data Tamu', 'Reservasi', 'Transaksi (In-Out)', 'Data User'].forEach(name => {
    const key = SHEET_SCHEMA[name][0], seen = new Set();
    state[name].forEach(row => {
      const identifier = required_(row[key], key); const normalized = name === 'Data User' ? identifier.toLowerCase() : identifier;
      if (seen.has(normalized)) fail_('DATA_CONFLICT', 'Identitas ganda pada sheet ' + name + ': ' + identifier); seen.add(normalized);
    });
  });
  const rooms = state['Data Kamar'], transactions = state['Transaksi (In-Out)'];
  const occupied = new Set();
  transactions.filter(active_).forEach(t => {
    const room = str_(t['No Kamar']); if (occupied.has(room)) fail_('DATA_CONFLICT', 'Terdapat lebih dari satu transaksi aktif untuk kamar ' + room + '.'); occupied.add(room);
  });
  rooms.forEach(k => {
    const room = str_(k['No Kamar']);
    if (occupied.has(room)) k.Status = 'Terisi';
    else if (['Cleaning', 'Maintenance'].includes(str_(k.Status))) return;
    else if (state.Reservasi.some(r => waiting_(r) && str_(r['No Kamar']) === room && date_(r['Tgl Check-in']) <= today_() && date_(r['Tgl Check-out']) >= today_())) k.Status = 'Booking';
    else k.Status = 'Kosong';
  });
  state['Data Tamu'].forEach(guest => {
    const stays = transactions.filter(t => str_(t['No KTP']) === str_(guest.NIK) && (active_(t) || finished_(t)));
    guest['Total Menginap'] = stays.length; guest['Total Pembayaran'] = stays.reduce((sum, t) => sum + number_(t['Sudah Dibayar']), 0);
  });
  const period = today_().slice(0, 7); const income = state.Pembayaran.reduce((sum, p) => sum + (date_(p.Tanggal) === today_() ? number_(p.Nominal) : 0), 0);
  const monthly = state.Pembayaran.reduce((sum, p) => sum + (date_(p.Tanggal).slice(0, 7) === period ? number_(p.Nominal) : 0), 0);
  state.Dashboard = [
    ['Total Kamar', rooms.length, 'Jumlah kamar terdaftar'], ['Terisi', rooms.filter(k => k.Status === 'Terisi').length, 'Transaksi aktif'],
    ['Kosong', rooms.filter(k => k.Status === 'Kosong').length, 'Kamar siap digunakan'], ['Booking', rooms.filter(k => k.Status === 'Booking').length, 'Reservasi pada hari ini'],
    ['Cleaning', rooms.filter(k => k.Status === 'Cleaning').length, 'Menunggu pembersihan'], ['Maintenance', rooms.filter(k => k.Status === 'Maintenance').length, 'Dalam perbaikan'],
    ['Penerimaan Hari Ini', income, 'Berdasarkan jurnal pembayaran'], ['Penerimaan Bulan Ini', monthly, 'Berdasarkan jurnal pembayaran'], ['Sinkronisasi Terakhir', now_(), HOTEL_TZ]
  ].map(row => ({ Indikator: row[0], Nilai: row[1], Keterangan: row[2] }));
}
function mutationAccess_(user, action, data) {
  const menus = { addKamar: ['Data Kamar'], addTamu: ['Data Tamu', 'Check In'], addReservasi: ['Reservasi'], addUser: ['Pengaturan'], updateStatusKamar: ['Data Kamar'], checkIn: ['Check In'], checkOut: ['Check Out'], savePengaturan: ['Pengaturan'] };
  if (action === 'updateData' || action === 'deleteData') {
    if (!data || Number(data.searchColIndex) !== 1) fail_('VALIDATION', 'Pencarian harus menggunakan kolom identitas pertama.');
    const sheetMenus = { 'Data Kamar': 'Data Kamar', 'Data Tamu': 'Data Tamu', Reservasi: 'Reservasi', 'Data User': 'Pengaturan' };
    if (!sheetMenus[data.sheetName] || (action === 'updateData' && data.sheetName === 'Data User')) fail_('FORBIDDEN', 'Sheet tersebut tidak dapat diubah melalui operasi ini.');
    require_(user, [sheetMenus[data.sheetName]]); return;
  }
  if (!menus[action]) fail_('ACTION_NOT_FOUND', 'Operasi tidak ditemukan.'); require_(user, menus[action]);
}
function mutate_(user, body) {
  mutationAccess_(user, body.action, body.data);
  if (PropertiesService.getScriptProperties().getProperty('RECOVERY_REQUIRED')) fail_('RECOVERY_REQUIRED', 'Penyimpanan diblokir sampai admin memeriksa pemulihan sheet.');
  const requestId = str_(body.requestId); if (!/^[A-Za-z0-9_-]{12,120}$/.test(requestId)) fail_('VALIDATION', 'ID permintaan diperlukan untuk mencegah transaksi ganda.');
  const requests = readRows_('Permintaan API'); const existing = byId_(requests, 'ID Permintaan', requestId); const hash = hmac_(JSON.stringify({ action: body.action, data: body.data }));
  if (existing) {
    if (str_(existing.Username) !== str_(user.Username) || existing['Payload Hash'] !== hash) fail_('CONFLICT', 'ID permintaan sudah digunakan untuk data berbeda.');
    if (existing.Status === 'BERHASIL') return JSON.parse(existing.Hasil);
    fail_('UNCERTAIN_RESULT', 'Permintaan ini pernah diproses. Periksa sheet dan hasil sinkronisasi sebelum mencoba lagi.');
  }
  const before = state_(), next = JSON.parse(JSON.stringify(before));
  const result = applyMutation_(next, user, body.action, body.data);
  reconcile_(next);
  next['Log Aktivitas'].push({ 'ID Log': id_('LOG'), Waktu: now_(), Petugas: user.Username, Aksi: body.action, Referensi: result.reference || '', Keterangan: 'Berhasil melalui aplikasi' });
  const receipt = { 'ID Permintaan': requestId, Username: user.Username, Aksi: body.action, 'Payload Hash': hash, Status: 'DIPROSES', Hasil: '', Waktu: now_() };
  requests.push(receipt); writeRows_('Permintaan API', requests); SpreadsheetApp.flush();
  try { persist_(before, next); }
  catch (error) { receipt.Status = 'GAGAL'; receipt.Hasil = JSON.stringify({ code: error.code || 'SERVER_ERROR' }); try { writeRows_('Permintaan API', requests); } catch (_) {} throw error; }
  receipt.Status = 'BERHASIL'; receipt.Hasil = JSON.stringify(result); writeRows_('Permintaan API', requests); SpreadsheetApp.flush();
  return result;
}
function applyMutation_(state, user, action, data) {
  if (action === 'addKamar') {
    const k = rowObject_('Data Kamar', data); required_(k['No Kamar'], 'Nomor kamar'); required_(k.Tipe, 'Tipe kamar');
    if (byId_(state['Data Kamar'], 'No Kamar', k['No Kamar'])) fail_('CONFLICT', 'Nomor kamar sudah terdaftar.');
    if (k.Harga <= 0 || !['Kosong', 'Cleaning', 'Maintenance'].includes(k.Status)) fail_('VALIDATION', 'Harga atau status kamar tidak valid.');
    state['Data Kamar'].push(k); return { reference: k['No Kamar'] };
  }
  if (action === 'addTamu') {
    const t = rowObject_('Data Tamu', data); validateGuest_(t);
    if (byId_(state['Data Tamu'], 'NIK', t.NIK)) fail_('CONFLICT', 'Identitas tamu sudah terdaftar.');
    t['Total Menginap'] = 0; t['Total Pembayaran'] = 0; state['Data Tamu'].push(t); return { reference: t.NIK };
  }
  if (action === 'addReservasi') {
    const r = rowObject_('Reservasi', data); if (byId_(state.Reservasi, 'Kode Booking', r['Kode Booking'])) fail_('CONFLICT', 'Kode booking sudah ada.');
    saveBooking_(state, r, null, user); state.Reservasi.push(r); return { reference: r['Kode Booking'] };
  }
  if (action === 'checkIn') return checkIn_(state, data, user);
  if (action === 'checkOut') return checkOut_(state, data, user);
  if (action === 'updateData') {
    const name = data.sheetName, key = SHEET_SCHEMA[name][0], original = byId_(state[name], key, data.searchValue);
    if (!original) fail_('NOT_FOUND', 'Data yang akan diubah tidak ditemukan.');
    const replacement = rowObject_(name, data.rowData);
    if (str_(replacement[key]) !== str_(original[key])) fail_('VALIDATION', 'Identitas data tidak dapat diganti.');
    if (name === 'Data Kamar') {
      required_(replacement.Tipe, 'Tipe kamar'); if (replacement.Harga <= 0) fail_('VALIDATION', 'Harga harus lebih dari nol.');
      if (!['Kosong', 'Cleaning', 'Maintenance'].includes(replacement.Status) && replacement.Status !== original.Status) fail_('VALIDATION', 'Status kamar tidak valid.');
      if ((state['Transaksi (In-Out)'].some(t => active_(t) && str_(t['No Kamar']) === str_(original[key])) || original.Status === 'Booking') && replacement.Status !== original.Status) fail_('CONFLICT', 'Status kamar aktif harus diubah melalui alur transaksi.');
    } else if (name === 'Data Tamu') { validateGuest_(replacement); ['Jenis Kelamin', 'Tanggal Lahir', 'Email', 'Total Menginap', 'Total Pembayaran'].forEach(h => { replacement[h] = original[h]; }); }
    else if (name === 'Reservasi') saveBooking_(state, replacement, original, user);
    Object.assign(original, replacement); return { reference: original[key] };
  }
  if (action === 'updateStatusKamar') {
    const room = byId_(state['Data Kamar'], 'No Kamar', data.noKamar); if (!room) fail_('NOT_FOUND', 'Kamar tidak ditemukan.');
    if (state['Transaksi (In-Out)'].some(t => active_(t) && str_(t['No Kamar']) === str_(data.noKamar)) || !['Kosong', 'Cleaning', 'Maintenance'].includes(data.statusBaru)) fail_('CONFLICT', 'Status kamar tidak dapat diubah.');
    room.Status = data.statusBaru; return { reference: room['No Kamar'] };
  }
  if (action === 'savePengaturan') {
    if (!Array.isArray(data)) fail_('VALIDATION', 'Profil tidak valid.');
    data.forEach(row => {
      const setting = rowObject_('Pengaturan', row); required_(setting.Item, 'Item pengaturan');
      const old = state.Pengaturan.find(p => p.Kategori === setting.Kategori && p.Item === setting.Item);
      if (old) Object.assign(old, setting); else state.Pengaturan.push(setting);
    }); return { reference: 'Profil Penginapan' };
  }
  if (action === 'addUser') {
    const u = rowObject_('Data User', data); required_(u.Username, 'Nama pengguna'); required_(u.Role, 'Jabatan');
    if (!/^\d{6}$/.test(u.Password) || u.Status !== 'Aktif') fail_('VALIDATION', 'PIN harus enam angka dan status pengguna harus Aktif.');
    const accesses = u['Hak Akses'].split(',').map(str_); if (!accesses.length || accesses.some(a => a !== 'Semua Akses' && !MENUS.includes(a))) fail_('VALIDATION', 'Hak akses tidak valid.');
    if (accesses.includes('Semua Akses') && (accesses.length !== 1 || !str_(user['Hak Akses']).split(',').map(str_).includes('Semua Akses'))) fail_('FORBIDDEN', 'Pemberian semua akses hanya dapat dilakukan admin penuh.');
    if (!str_(user['Hak Akses']).split(',').map(str_).includes('Semua Akses') && accesses.some(menu => !allowed_(user, menu))) fail_('FORBIDDEN', 'Tidak dapat memberikan hak akses di luar izin sendiri.');
    if (state['Data User'].some(x => str_(x.Username).toLowerCase() === u.Username.toLowerCase() || pinMatches_(u.Password, x.Password))) fail_('CONFLICT', 'Nama atau PIN sudah digunakan.');
    u.Password = pinHash_(u.Password); state['Data User'].push(u); return { reference: u.Username };
  }
  if (action === 'deleteData') return deleteData_(state, user, data);
  fail_('ACTION_NOT_FOUND', 'Operasi tidak ditemukan.');
}
function validateGuest_(t) { required_(t.NIK, 'Identitas'); required_(t['Nama Lengkap'], 'Nama tamu'); required_(t['No HP'], 'Nomor HP'); }
function saveBooking_(state, r, old, user) {
  required_(r['Kode Booking'], 'Kode booking'); required_(r['Nama Pemesan'], 'Nama pemesan'); required_(r['No HP'], 'Nomor HP');
  const room = byId_(state['Data Kamar'], 'No Kamar', r['No Kamar']); if (!room || ['Cleaning', 'Maintenance'].includes(room.Status)) fail_('CONFLICT', 'Kamar belum tersedia.');
  if (old && !waiting_(old)) fail_('CONFLICT', 'Hanya reservasi menunggu yang dapat diedit.');
  const days = days_(r['Tgl Check-in'], r['Tgl Check-out']);
  if (date_(r['Tgl Check-in']) < today_() && (!old || date_(r['Tgl Check-in']) !== date_(old['Tgl Check-in']))) fail_('VALIDATION', 'Reservasi baru tidak dapat memakai tanggal lampau.');
  conflict_(state, r['No Kamar'], r['Tgl Check-in'], r['Tgl Check-out'], old ? old['Kode Booking'] : '');
  const total = days * number_(room.Harga); if (number_(r['Harga Total']) !== total || number_(r.DP) < 0 || number_(r.DP) > total) fail_('VALIDATION', 'Total harga atau DP reservasi tidak sesuai tarif.');
  if (old && number_(r.DP) < number_(old.DP)) fail_('VALIDATION', 'Pengurangan DP memerlukan pencatatan pengembalian dana.');
  r['Jumlah Hari'] = days; r['Harga Total'] = total; r['Tgl Check-in'] = date_(r['Tgl Check-in']); r['Tgl Check-out'] = date_(r['Tgl Check-out']); r['Status Booking'] = 'Menunggu';
  payment_(state, { booking: r['Kode Booking'], amount: number_(r.DP) - (old ? number_(old.DP) : 0), kind: 'DP Reservasi', method: r['Metode Bayar'], user: user.Username });
}
function checkIn_(state, data, user) {
  const t = rowObject_('Transaksi (In-Out)', data.transaksiData); const invoice = required_(t['No Invoice'], 'Invoice');
  if (byId_(state['Transaksi (In-Out)'], 'No Invoice', invoice)) fail_('CONFLICT', 'Invoice sudah ada.');
  const room = byId_(state['Data Kamar'], 'No Kamar', data.noKamar); const booking = data.kodeBooking ? byId_(state.Reservasi, 'Kode Booking', data.kodeBooking) : null;
  if (!room || str_(room['No Kamar']) !== str_(t['No Kamar']) || ['Cleaning', 'Maintenance'].includes(room.Status)) fail_('CONFLICT', 'Kamar belum siap untuk check-in.');
  if (state['Transaksi (In-Out)'].some(x => active_(x) && str_(x['No Kamar']) === str_(data.noKamar))) fail_('CONFLICT', 'Kamar sudah memiliki tamu aktif.');
  if (data.kodeBooking && (!booking || !waiting_(booking) || str_(booking['No Kamar']) !== str_(data.noKamar))) fail_('CONFLICT', 'Reservasi sudah digunakan atau kamar berbeda.');
  if (room.Status === 'Booking' && !booking) fail_('CONFLICT', 'Tarik kode booking sebelum check-in.');
  if (date_(t['Tgl Check-in']) !== today_()) fail_('VALIDATION', 'Check-in hanya dapat dicatat untuk hari ini.');
  const days = days_(t['Tgl Check-in'], t['Tgl Check-out']);
  if (booking && (date_(booking['Tgl Check-in']) !== date_(t['Tgl Check-in']) || date_(booking['Tgl Check-out']) !== date_(t['Tgl Check-out']))) fail_('CONFLICT', 'Ubah jadwal reservasi terlebih dahulu.');
  conflict_(state, data.noKamar, t['Tgl Check-in'], t['Tgl Check-out'], data.kodeBooking);
  const price = booking ? number_(booking['Harga Total']) : days * number_(room.Harga); const total = price - number_(t.Diskon), dp = number_(t.DP);
  if (price <= 0 || number_(t.Diskon) < 0 || total < 0 || dp < (booking ? number_(booking.DP) : 0) || dp > total || number_(t['Biaya Kamar']) !== price || number_(t['Total Tagihan']) !== total || number_(t['Sudah Dibayar']) !== dp) fail_('VALIDATION', 'Perhitungan tagihan check-in tidak sesuai.');
  required_(t['Nama Tamu'], 'Nama tamu'); required_(t['No KTP'], 'Identitas tamu'); required_(t['No HP'], 'Nomor HP');
  if (!byId_(state['Data Tamu'], 'NIK', t['No KTP'])) state['Data Tamu'].push({ NIK: t['No KTP'], 'Nama Lengkap': t['Nama Tamu'], 'Jenis Kelamin': '-', 'Tanggal Lahir': '', 'No HP': t['No HP'], Email: '', Alamat: t.Alamat, 'Total Menginap': 0, 'Total Pembayaran': 0 });
  ['Laundry', 'Makanan', 'Minibar', 'Denda'].forEach(key => { t[key] = 0; });
  t['Tgl Check-in'] = date_(t['Tgl Check-in']); t['Tgl Check-out'] = date_(t['Tgl Check-out']); t['Lama Menginap'] = days; t.Sisa = total - dp; t['Kode Booking'] = str_(data.kodeBooking); t['Status Transaksi'] = 'Aktif (Check-in)';
  state['Transaksi (In-Out)'].push(t); room.Status = 'Terisi'; if (booking) booking['Status Booking'] = 'Selesai';
  payment_(state, { invoice: invoice, booking: data.kodeBooking, amount: dp - (booking ? number_(booking.DP) : 0), kind: 'Pembayaran Check-in', method: t['Metode Bayar'], user: user.Username });
  return { reference: invoice, transaksi: t };
}
function checkOut_(state, data, user) {
  const original = byId_(state['Transaksi (In-Out)'], 'No Invoice', data.noInvoice); if (!original || !active_(original)) fail_('CONFLICT', 'Transaksi aktif tidak ditemukan atau sudah check-out.');
  const replacement = rowObject_('Transaksi (In-Out)', data.updateTransaksiData);
  ['No Invoice', 'No Kamar', 'Nama Tamu', 'No KTP', 'No HP', 'Alamat', 'Tgl Check-in', 'Lama Menginap', 'Metode Bayar'].forEach(key => { if (str_(original[key]) !== str_(replacement[key])) fail_('VALIDATION', 'Identitas transaksi tidak boleh diganti saat checkout.'); });
  if (str_(data.noKamar) !== str_(original['No Kamar']) || date_(replacement['Tgl Check-out']) !== today_()) fail_('VALIDATION', 'Kamar atau tanggal checkout tidak valid.');
  const paid = number_(original['Sudah Dibayar']), cost = number_(original['Biaya Kamar']); let extras = 0;
  ['Laundry', 'Makanan', 'Minibar', 'Denda'].forEach(key => { if (replacement[key] < 0) fail_('VALIDATION', 'Biaya tambahan tidak dapat negatif.'); extras += replacement[key]; });
  const total = cost + extras - replacement.Diskon;
  if (replacement.Diskon < number_(original.Diskon) || total < paid || number_(replacement['Total Tagihan']) !== total || number_(replacement['Sudah Dibayar']) !== total || number_(replacement.DP) !== number_(original.DP) || number_(replacement['Biaya Kamar']) !== cost) fail_('VALIDATION', 'Perhitungan pelunasan tidak sesuai.');
  const room = byId_(state['Data Kamar'], 'No Kamar', original['No Kamar']); if (!room) fail_('NOT_FOUND', 'Kamar tidak ditemukan.');
  replacement['Status Transaksi'] = 'Selesai (Check-out)'; replacement.Sisa = 0; replacement['Kode Booking'] = original['Kode Booking'];
  Object.assign(original, replacement); room.Status = 'Cleaning';
  payment_(state, { invoice: original['No Invoice'], booking: original['Kode Booking'], amount: total - paid, kind: 'Pelunasan Check-out', method: original['Metode Bayar'], user: user.Username });
  return { reference: original['No Invoice'], transaksi: original };
}
function deleteData_(state, user, data) {
  const name = data.sheetName, key = SHEET_SCHEMA[name][0], row = byId_(state[name], key, data.searchValue); if (!row) fail_('NOT_FOUND', 'Data tidak ditemukan.');
  const id = str_(row[key]);
  if (name === 'Data Kamar' && (state['Transaksi (In-Out)'].some(t => str_(t['No Kamar']) === id) || state.Reservasi.some(r => str_(r['No Kamar']) === id))) fail_('CONFLICT', 'Kamar memiliki referensi transaksi atau reservasi.');
  if (name === 'Data Tamu' && state['Transaksi (In-Out)'].some(t => str_(t['No KTP']) === id)) fail_('CONFLICT', 'Tamu memiliki riwayat transaksi.');
  if (name === 'Reservasi' && (!waiting_(row) || number_(row.DP) > 0)) fail_('CONFLICT', 'Reservasi selesai atau memiliki DP tidak dapat dihapus.');
  if (name === 'Data User') {
    if (id === str_(user.Username)) fail_('CONFLICT', 'Akun yang sedang digunakan tidak dapat dihapus.');
    if (allowed_(row, 'Pengaturan') && str_(row.Status) === 'Aktif' && state[name].filter(u => str_(u.Status) === 'Aktif' && allowed_(u, 'Pengaturan')).length <= 1) fail_('CONFLICT', 'Admin aktif terakhir tidak dapat dihapus.');
    const full = u => str_(u['Hak Akses']).split(',').map(str_).includes('Semua Akses');
    if (full(row) && (!full(user) || state[name].filter(u => str_(u.Status) === 'Aktif' && full(u)).length <= 1)) fail_('FORBIDDEN', 'Admin penuh terakhir atau admin di luar kewenangan tidak dapat dihapus.');
  }
  state[name].splice(state[name].indexOf(row), 1); return { reference: id };
}
