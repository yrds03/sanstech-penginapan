'use strict';

// Keep the existing Google Apps Script contract and spreadsheet column order.
const API_URL = 'https://script.google.com/macros/s/AKfycbyjAptPUXrwxBve2yA6Px0KmCnhm5muxOoevwIlV6VkuqPpRCqDLR671TDoI2ePny_t/exec';
const HOTEL_TIMEZONE = 'Asia/Jakarta';
const TRANSACTION_COLUMNS = ['No Invoice', 'Nama Tamu', 'No KTP', 'No HP', 'Alamat', 'No Kamar', 'Tgl Check-in', 'Tgl Check-out', 'Lama Menginap', 'Biaya Kamar', 'Laundry', 'Makanan', 'Minibar', 'Denda', 'Diskon', 'DP', 'Total Tagihan', 'Sudah Dibayar', 'Sisa', 'Metode Bayar', 'Status Transaksi'];
let globalKamar = [], globalTamu = [], globalReservasi = [], globalTransaksi = [], globalUsers = [];
let editMode = { active: false, type: null, idVal: null };
let activeUser = null, actTrx = null, busy = false, loggingIn = false, dataFresh = false;
let loadPromise = null, sessionEpoch = 0;
const $ = id => document.getElementById(id);
const value = id => String($(id)?.value ?? '').trim();
const text = v => String(v ?? '').trim();
const safeStr = v => text(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function setElem(id, val, isHTML = false, isInput = false) {
    const el = $(id);
    if (!el) return;
    if (isInput) el.value = val ?? '';
    else if (isHTML) el.innerHTML = val;
    else el.textContent = val ?? '';
}
function notify(message, title = 'Periksa data', icon = 'warning') { return Swal.fire({ title, text: message, icon }); }

// Rupiah is stored as whole units. Parse spreadsheet numbers and Indonesian formats.
function parseRpToNum(input) {
    if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : 0;
    let s = text(input).replace(/Rp\s*/gi, '').replace(/\s/g, '');
    if (!s || !/^-?[\d.,]+$/.test(s)) return 0;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    const n = Number(s);
    return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? Math.round(n) : 0;
}
const formatRp = n => 'Rp ' + parseRpToNum(n).toLocaleString('id-ID');
function getRawNum(id) { return parseRpToNum($(id)?.value); }
function setRawNum(id, val) {
    if (!$(id)) return;
    $(id).dataset.raw = String(parseRpToNum(val));
    $(id).value = formatRp(val);
}
function formatInputUang(el) {
    const digits = el.value.replace(/[^0-9]/g, '').slice(0, 12);
    el.dataset.raw = digits || '0';
    el.value = digits ? formatRp(Number(digits)) : '';
    if (el.id.startsWith('co_')) hitungTotalCO();
    if (el.id === 'ci_diskon') calcCheckin();
}
function getTodayYMD() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: HOTEL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const fields = Object.fromEntries(parts.map(p => [p.type, p.value]));
    return `${fields.year}-${fields.month}-${fields.day}`;
}
function parseDateStandard(input) {
    const s = text(input);
    // Sheets serializes a local date as UTC (often 17:00Z on the previous day).
    if (/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(s)) {
        const instant = new Date(s);
        if (!Number.isFinite(instant.getTime())) return '';
        const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: HOTEL_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant).map(p => [p.type, p.value]));
        return `${parts.year}-${parts.month}-${parts.day}`;
    }
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/.exec(s);
    if (!m) {
        const parts = /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})$/.exec(s);
        if (parts) m = parts[1].length === 4 ? parts : [parts[0], parts[3], parts[2], parts[1]];
    }
    if (!m) return '';
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return '';
    return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const isToday = date => parseDateStandard(date) === getTodayYMD();
function stayDays(checkin, checkout) {
    const a = parseDateStandard(checkin), b = parseDateStandard(checkout);
    if (!a || !b || b < a) return 0;
    return Math.max(1, Math.round((Date.parse(b) - Date.parse(a)) / 86400000));
}
function uniqueId(prefix) {
    const suffix = globalThis.crypto?.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36).toUpperCase()}-${suffix.toUpperCase()}`;
}
const roomById = id => globalKamar.find(k => text(k['No Kamar']) === text(id));
const isActive = t => /^Aktif(?:\s|$|\()/i.test(text(t?.['Status Transaksi']));
const isCompleted = t => /^Selesai(?:\s|$|\()/i.test(text(t?.['Status Transaksi']));
const pendingBooking = r => text(r?.['Status Booking']).toLowerCase() === 'menunggu';
const transactionForRoom = id => globalTransaksi.find(t => text(t['No Kamar']) === text(id) && isActive(t));
function depositOf(t) {
    // Numeric zero is a real DP; do not replace it with final payment using ||.
    return parseRpToNum(t.DP !== undefined && t.DP !== null && t.DP !== '' ? t.DP : (isActive(t) ? t['Sudah Dibayar'] : 0));
}
function paidOf(t) { return parseRpToNum(t['Sudah Dibayar'] ?? depositOf(t)); }
function cashForPeriod(t, matches) {
    if (!isActive(t) && !isCompleted(t)) return 0;
    const dp = depositOf(t);
    return (matches(parseDateStandard(t['Tgl Check-in'])) ? dp : 0)
        + (isCompleted(t) && matches(parseDateStandard(t['Tgl Check-out'])) ? paidOf(t) - dp : 0);
}
function overlaps(a, b, c, d) {
    // Same-day stays reserve one night, consistent with the minimum charge.
    const end = (start, stop) => stop > start ? stop : new Date(Date.parse(start) + 86400000).toISOString().slice(0, 10);
    return a < end(c, d) && c < end(a, b);
}
function roomConflict(id, checkin, checkout, exceptBooking = '') {
    const a = parseDateStandard(checkin), b = parseDateStandard(checkout);
    if (!a || !b || b < a) return 'Tanggal menginap tidak valid.';
    const booking = globalReservasi.find(r => pendingBooking(r) && text(r['No Kamar']) === text(id)
        && text(r['Kode Booking']) !== text(exceptBooking) && overlaps(a, b, parseDateStandard(r['Tgl Check-in']), parseDateStandard(r['Tgl Check-out'])));
    if (booking) return `Jadwal kamar bertabrakan dengan reservasi ${text(booking['Kode Booking'])}.`;
    const trx = transactionForRoom(id);
    if (trx && overlaps(a, b, parseDateStandard(trx['Tgl Check-in']), parseDateStandard(trx['Tgl Check-out']))) return 'Kamar masih digunakan pada jadwal tersebut.';
    return '';
}

const pageTitles = {
    dashboard: { t: 'Dashboard', s: 'Ringkasan kondisi penginapan' }, kamar: { t: 'Data Kamar', s: 'Manajemen fasilitas dan harga kamar' },
    tamu: { t: 'Data Tamu', s: 'Database riwayat tamu pelanggan' }, reservasi: { t: 'Reservasi', s: 'Jadwal pemesanan kamar' },
    checkin: { t: 'Check In', s: 'Tamu masuk dan pembayaran awal' }, checkout: { t: 'Check Out', s: 'Tagihan akhir dan tamu keluar' },
    pembayaran: { t: 'Pembayaran', s: 'Riwayat invoice dan transaksi' }, laporan: { t: 'Laporan & Okupansi', s: 'Penerimaan pembayaran dan statistik kamar' },
    pengaturan: { t: 'Pengaturan Sistem', s: 'Profil penginapan dan hak akses' }
};
const allMenus = [
    { id: 'dashboard', icon: 'fa-house', text: 'Dashboard' }, { id: 'kamar', icon: 'fa-bed', text: 'Data Kamar' },
    { id: 'tamu', icon: 'fa-address-book', text: 'Data Tamu' }, { id: 'reservasi', icon: 'fa-calendar-check', text: 'Reservasi' },
    { id: 'checkin', icon: 'fa-sign-in-alt', text: 'Check In' }, { id: 'checkout', icon: 'fa-sign-out-alt', text: 'Check Out' },
    { id: 'pembayaran', icon: 'fa-file-invoice-dollar', text: 'Pembayaran' }, { id: 'laporan', icon: 'fa-chart-pie', text: 'Laporan' },
    { id: 'pengaturan', icon: 'fa-cog', text: 'Pengaturan' }
];
function canAccess(id) {
    if (!activeUser) return false;
    const allowed = text(activeUser['Hak Akses']).split(',').map(text);
    return allowed.includes('Semua Akses') || allowed.includes(allMenus.find(m => m.id === id)?.text);
}
function requireAccess(id) {
    if (canAccess(id)) return true;
    notify('Anda tidak memiliki akses ke menu ini.', 'Akses ditolak', 'error');
    return false;
}
function firstAllowedPage() { return allMenus.find(m => canAccess(m.id))?.id; }
function buildSidebarMenu() {
    $('sidebar-menu').innerHTML = allMenus.filter(m => canAccess(m.id)).map(m =>
        `<a href="#${m.id}" data-page="${m.id}" id="nav-${m.id}" class="menu-item flex items-center space-x-3 px-4 py-3 text-sm font-bold rounded-lg"><i class="fa-solid ${m.icon} w-5 text-blue-400"></i><span>${m.text}</span></a>`).join('');
    const first = firstAllowedPage();
    if (first) switchPage(first);
    else { document.querySelectorAll('.page-section').forEach(el => el.classList.remove('active')); notify('Akun ini belum memiliki hak akses. Hubungi admin.'); }
}
function toggleSidebar(force) {
    const open = force === undefined ? $('sidebar').classList.contains('-translate-x-full') : force;
    $('sidebar').classList.toggle('-translate-x-full', !open);
    $('sidebar-overlay').classList.toggle('hidden', !open);
    $('sidebar-overlay').classList.toggle('opacity-0', !open);
    document.querySelectorAll('[aria-controls="sidebar"]').forEach(b => b.setAttribute('aria-expanded', String(open)));
}
function switchPage(id) {
    if (!pageTitles[id] || !requireAccess(id)) return false;
    document.querySelectorAll('.page-section').forEach(el => el.classList.toggle('active', el.id === `page-${id}`));
    document.querySelectorAll('.menu-item').forEach(el => el.classList.toggle('menu-active', el.id === `nav-${id}`));
    setElem('page-title', pageTitles[id].t); setElem('page-subtitle', pageTitles[id].s);
    if (id === 'checkin') {
        if (!value('ci_in')) $('ci_in').value = getTodayYMD();
        if (!value('ci_out')) $('ci_out').value = value('ci_in');
        calcCheckin();
    }
    if (id === 'laporan') renderLaporanData();
    if (window.innerWidth < 768) toggleSidebar(false);
    $('main-content').scrollTop = 0;
    return true;
}

async function requestAPI(action, data) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const options = { signal: controller.signal, cache: 'no-store', redirect: 'follow' };
        let url = `${API_URL}?action=${encodeURIComponent(action)}`;
        if (data !== undefined) {
            url = API_URL;
            Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ action, data }) });
        }
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`Server merespons HTTP ${response.status}.`);
        const result = await response.json();
        if (!result || result.status !== 'success') throw new Error(result?.message || 'Respons database tidak valid.');
        return result;
    } catch (error) {
        if (error.name === 'AbortError') throw new Error('Koneksi melewati batas waktu.');
        if (error instanceof SyntaxError) throw new Error('Server tidak mengirim JSON. Periksa deployment Google Apps Script.');
        throw error;
    } finally { clearTimeout(timer); }
}
function syncStatus(message = '', error = false) {
    const el = $('sync-status');
    el.className = message ? `p-3 text-sm font-semibold ${error ? 'bg-red-100 text-red-800' : 'bg-blue-50 text-blue-800'}` : 'hidden';
    el.replaceChildren(document.createTextNode(message));
    if (error) {
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = 'Coba sinkronkan lagi'; button.className = 'ml-3 underline font-bold';
        button.addEventListener('click', () => loadAllData()); el.append(button);
    }
}
async function fetchAPI(action) { return requestAPI(action); }
async function postAPI(action, data) {
    if (!activeUser || !dataFresh) { await notify('Sinkronkan database sebelum menyimpan perubahan.', 'Data belum siap'); return false; }
    try {
        await requestAPI(action, data);
        return true;
    } catch (error) {
        dataFresh = false;
        syncStatus('Penyimpanan belum dapat dipastikan. Sinkronkan dan periksa data sebelum mencoba lagi.', true);
        await notify(`${error.message} Periksa hasil di database sebelum mengirim ulang.`, 'Penyimpanan belum terkonfirmasi', 'error');
        return false;
    }
}
async function runMutation(page, operation) {
    if (!requireAccess(page) || busy) return false;
    if (!dataFresh) { await notify('Data belum tersinkronisasi. Gunakan tombol sinkronkan lagi.'); return false; }
    busy = true;
    const buttons = [...document.querySelectorAll('#app-container button')];
    const disabled = buttons.map(b => b.disabled);
    buttons.forEach(b => { b.disabled = true; });
    try { return await operation(); }
    catch (error) { await notify(error.message || 'Gagal memproses data.', 'Terjadi kesalahan', 'error'); return false; }
    finally { busy = false; buttons.forEach((b, i) => { if (b.isConnected) b.disabled = disabled[i]; }); }
}
async function loadAllData() {
    if (!activeUser) return false;
    if (loadPromise) return loadPromise;
    const epoch = sessionEpoch;
    syncStatus('Menyinkronkan data…');
    loadPromise = (async () => {
        try {
            const actions = ['getKamar', 'getTamu', 'getReservasi', 'getTransaksi', 'getUser', 'getPengaturan'];
            const results = await Promise.allSettled(actions.map(fetchAPI));
            if (epoch !== sessionEpoch || !activeUser) return false;
            // Commit one complete operational snapshot. Never clear live data on a failed GET.
            const bad = results.slice(0, 4).find(r => r.status !== 'fulfilled' || !Array.isArray(r.value.data));
            if (bad) throw new Error(bad.status === 'rejected' ? bad.reason.message : 'Format data database tidak valid.');
            [globalKamar, globalTamu, globalReservasi, globalTransaksi] = results.slice(0, 4).map(r => r.value.data.filter(row => row && typeof row === 'object'));
            const usersResult = results[4];
            if (usersResult.status === 'fulfilled' && Array.isArray(usersResult.value.data)) {
                globalUsers = usersResult.value.data.filter(Boolean).map(({ Password, ...u }) => u);
                const current = globalUsers.find(u => text(u.Username) === text(activeUser.Username) && text(u.Status) === 'Aktif');
                if (!current) { lockSession(); await notify('Akun sudah dinonaktifkan atau dihapus.', 'Sesi berakhir'); return false; }
                const oldAccess = activeUser['Hak Akses']; activeUser = current;
                if (oldAccess !== current['Hak Akses']) buildSidebarMenu();
            }
            if (results[5].status === 'fulfilled' && Array.isArray(results[5].value.data)) {
                results[5].value.data.filter(Boolean).forEach(p => {
                    const id = { 'Nama Penginapan': 'set_hotel', 'Alamat Lengkap': 'set_alamat', 'Nomor Telepon': 'set_telp' }[p.Item];
                    if (id && document.activeElement !== $(id)) setElem(id, p.Nilai, false, true);
                });
            }
            if (actTrx) {
                const current = globalTransaksi.find(t => text(t['No Invoice']) === text(actTrx['No Invoice']) && isActive(t));
                if (!current || TRANSACTION_COLUMNS.some(key => text(current[key]) !== text(actTrx[key]))) clearCheckout();
            }
            updateDOMKamar(); updateDOMTamu(); updateDOMReservasi(); updateDOMTransaksi(); updateDOMUser(); renderDashboardUI(); renderLaporanData();
            dataFresh = true;
            const partial = results.slice(4).some(r => r.status === 'rejected' || !Array.isArray(r.value.data));
            syncStatus(partial ? 'Data operasional tersinkron. Pengguna atau profil belum dapat dimuat; coba sinkronkan lagi.' : '', partial);
            return true;
        } catch (error) {
            if (epoch === sessionEpoch) { dataFresh = false; syncStatus(`Sinkronisasi gagal: ${error.message} Data terakhir tetap ditampilkan.`, true); }
            return false;
        } finally { if (epoch === sessionEpoch) loadPromise = null; }
    })();
    return loadPromise;
}

function moveNext(el, nextId, event) {
    if (event.key === 'Backspace') { if (!el.value) el.previousElementSibling?.focus(); return; }
    if (event.key === 'Enter') { submitPinLogin(); return; }
}
function handlePaste(event) {
    event.preventDefault();
    const digits = (event.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
    document.querySelectorAll('.pin-box').forEach((el, i) => { el.value = digits[i] || ''; });
    $(`pin${Math.min(digits.length + 1, 6)}`).focus();
    if (digits.length === 6) submitPinLogin();
}
async function submitPinLogin() {
    if (loggingIn) return;
    const pin = [...document.querySelectorAll('.pin-box')].map(el => el.value).join('');
    if (!/^\d{6}$/.test(pin)) return notify('Masukkan tepat 6 digit angka.', 'PIN tidak lengkap');
    loggingIn = true;
    Swal.fire({ title: 'Memeriksa akses…', allowOutsideClick: false, allowEscapeKey: false, didOpen: () => Swal.showLoading() });
    try {
        const result = await fetchAPI('getUser');
        if (!Array.isArray(result.data)) throw new Error('Format pengguna tidak valid.');
        const user = result.data.find(u => u && String(u.Password).padStart(6, '0') === pin && text(u.Status) === 'Aktif');
        if (!user) { await notify('PIN tidak terdaftar atau akun nonaktif.', 'Akses ditolak', 'error'); return; }
        const { Password, ...profile } = user;
        activeUser = profile; sessionEpoch++; dataFresh = false;
        // A client-side localStorage flag must never restore an authenticated session.
        ['isLoggedIn', 'activeUser', 'activeRole', 'activeAkses'].forEach(key => localStorage.removeItem(key));
        $('login-screen').classList.add('hidden');
        $('app-container').classList.remove('hidden', 'opacity-0');
        setElem('top_user_name', profile.Username); setElem('top_user_role', profile.Role);
        buildSidebarMenu(); Swal.close(); await loadAllData();
    } catch (error) { await notify(`Database tidak dapat dihubungi. ${error.message}`, 'Login gagal', 'error'); }
    finally { loggingIn = false; document.querySelectorAll('.pin-box').forEach(el => { el.value = ''; }); if (!activeUser) $('pin1').focus(); }
}
function lockSession() {
    sessionEpoch++; activeUser = null; dataFresh = false; loadPromise = null; actTrx = null;
    globalKamar = []; globalTamu = []; globalReservasi = []; globalTransaksi = []; globalUsers = [];
    editMode = { active: false, type: null, idVal: null };
    document.querySelectorAll('#app-container form').forEach(form => form.reset());
    document.querySelectorAll('[data-raw]').forEach(el => { el.dataset.raw = '0'; el.value = ''; });
    document.querySelectorAll('#app-container tbody').forEach(el => { el.replaceChildren(); });
    document.querySelectorAll('#app-container select.option-kamar-kosong, #app-container select.option-kamar-terisi').forEach(el => { el.replaceChildren(); });
    ['k_no', 't_nik'].forEach(id => { $(id).readOnly = false; });
    ['kamar', 'tamu', 'reservasi'].forEach(type => batalEdit(type));
    $('room-grid').replaceChildren(); $('sidebar-menu').replaceChildren(); $('print-area').classList.add('hidden');
    $('co_area').classList.add('hidden'); $('app-container').classList.add('hidden');
    $('login-screen').classList.remove('hidden', 'opacity-0');
    toggleSidebar(false); syncStatus(); $('pin1').focus();
}
async function switchShift() {
    if (busy) return notify('Tunggu sampai penyimpanan selesai sebelum mengganti shift.');
    const result = await Swal.fire({ title: 'Kunci layar?', text: 'Shift berikutnya harus masuk menggunakan PIN sendiri.', icon: 'question', showCancelButton: true, confirmButtonText: 'Kunci layar', cancelButtonText: 'Batal' });
    if (result.isConfirmed) lockSession();
}

function actionButton(action, id, icon, label, extra = '') {
    return `<button type="button" data-action="${action}" data-id="${safeStr(id)}" aria-label="${safeStr(label)}" title="${safeStr(label)}" class="p-2 text-blue-700 hover:bg-blue-50 rounded ${extra}"><i class="fa-solid ${icon}" aria-hidden="true"></i></button>`;
}
function emptyRow(columns, label = 'Belum ada data') { return `<tr><td colspan="${columns}" class="text-center py-4 text-gray-500">${label}</td></tr>`; }
function optionForRoom(k) { return `<option value="${safeStr(k['No Kamar'])}">${safeStr(k['No Kamar'])} - ${safeStr(k.Tipe)} (${formatRp(k.Harga)})</option>`; }
function replaceOptions(id, html) {
    const current = value(id); $(id).innerHTML = '<option value="">-- Pilih kamar --</option>' + html;
    if ([...$(id).options].some(o => o.value === current)) $(id).value = current;
}
function updateDOMKamar() {
    setElem('tbl-kamar', globalKamar.map(k => `<tr class="border-b hover:bg-gray-50"><td class="p-4 font-bold">${safeStr(k['No Kamar'])}</td><td class="p-4">${safeStr(k.Tipe)}</td><td class="p-4">${formatRp(k.Harga)}</td><td class="p-4">${safeStr(k.Fasilitas)}</td><td class="p-4 font-semibold">${safeStr(k.Status)}</td><td class="p-4 text-center">${actionButton('edit-room', k['No Kamar'], 'fa-edit', 'Edit kamar')}${actionButton('delete-room', k['No Kamar'], 'fa-trash', 'Hapus kamar')}</td></tr>`).join('') || emptyRow(6), true);
    replaceOptions('r_kamar', globalKamar.filter(k => !['Maintenance', 'Cleaning'].includes(text(k.Status))).map(optionForRoom).join(''));
    const selectedBooking = globalReservasi.find(r => text(r['Kode Booking']) === value('ci_kode_booking') && pendingBooking(r));
    replaceOptions('ci_kamar', globalKamar.filter(k => !transactionForRoom(k['No Kamar']) && (text(k.Status) === 'Kosong' || (selectedBooking && text(k.Status) === 'Booking' && text(k['No Kamar']) === text(selectedBooking['No Kamar'])))).map(optionForRoom).join(''));
    replaceOptions('co_kamar', globalKamar.filter(k => transactionForRoom(k['No Kamar'])).map(optionForRoom).join(''));
}
function updateDOMTamu() {
    setElem('tbl-tamu', globalTamu.map(t => `<tr class="border-b"><td class="p-4 font-bold">${safeStr(t['Nama Lengkap'])}</td><td class="p-4">${safeStr(t.NIK)}</td><td class="p-4">${safeStr(t['No HP'])}</td><td class="p-4">${safeStr(t.Alamat)}</td><td class="p-4 text-center">${actionButton('edit-guest', t.NIK, 'fa-edit', 'Edit tamu')}${actionButton('delete-guest', t.NIK, 'fa-trash', 'Hapus tamu')}</td></tr>`).join('') || emptyRow(5), true);
}
function updateDOMReservasi() {
    setElem('tbl-reservasi', [...globalReservasi].reverse().map(r => `<tr class="border-b"><td class="p-4 font-mono">${safeStr(r['Kode Booking'])}</td><td class="p-4 font-bold">${safeStr(r['Nama Pemesan'])}</td><td class="p-4">${safeStr(r['No Kamar'])}</td><td class="p-4">${safeStr(parseDateStandard(r['Tgl Check-in']))} s.d. ${safeStr(parseDateStandard(r['Tgl Check-out']))}</td><td class="p-4">${safeStr(r['Status Booking'])}</td><td class="p-4 text-center">${pendingBooking(r) ? actionButton('edit-booking', r['Kode Booking'], 'fa-edit', 'Edit reservasi') + actionButton('delete-booking', r['Kode Booking'], 'fa-trash', 'Hapus reservasi') : '—'}</td></tr>`).join('') || emptyRow(6), true);
}
function updateDOMTransaksi() {
    setElem('tbl-transaksi', [...globalTransaksi].reverse().map(t => `<tr class="border-b"><td class="p-4 font-mono text-blue-700">${safeStr(t['No Invoice'])}</td><td class="p-4 font-bold">${safeStr(t['Nama Tamu'])}</td><td class="p-4">${safeStr(t['No Kamar'])}</td><td class="p-4 text-right">${formatRp(t['Total Tagihan'])}</td><td class="p-4">${safeStr(t['Status Transaksi'])}</td><td class="p-4 text-center">${actionButton('print', t['No Invoice'], 'fa-print', 'Cetak invoice')}</td></tr>`).join('') || emptyRow(6), true);
    cariRiwayatTransaksi();
}
function cariRiwayatTransaksi() {
    const search = value('cari_riwayat').toLocaleLowerCase('id-ID');
    [...$('tbl-transaksi').rows].forEach(row => { row.hidden = !row.textContent.toLocaleLowerCase('id-ID').includes(search); });
}
function updateDOMUser() {
    setElem('tbl-users', globalUsers.map(u => `<tr><td class="p-3 font-bold">${safeStr(u.Username)}</td><td class="p-3">${safeStr(u.Role)}</td><td class="p-3">${safeStr(u.Status)}</td><td class="p-3 text-right">${actionButton('delete-user', u.Username, 'fa-trash', 'Hapus pengguna')}</td></tr>`).join('') || emptyRow(4), true);
}
function renderDashboardUI() {
    const today = getTodayYMD();
    setElem('d_tot', globalKamar.length); setElem('d_terisi', globalKamar.filter(k => transactionForRoom(k['No Kamar']) || text(k.Status) === 'Terisi').length);
    setElem('d_kosong', globalKamar.filter(k => text(k.Status) === 'Kosong' && !transactionForRoom(k['No Kamar'])).length);
    const arrivals = globalTransaksi.filter(t => (isActive(t) || isCompleted(t)) && isToday(t['Tgl Check-in']));
    setElem('d_ci', arrivals.length); setElem('d_co', globalTransaksi.filter(t => isCompleted(t) && isToday(t['Tgl Check-out'])).length);
    const revenue = { tunai: 0, tf: 0, qris: 0 };
    globalTransaksi.forEach(t => {
        const amount = cashForPeriod(t, date => date === today);
        const method = text(t['Metode Bayar']).toLowerCase();
        const bucket = method.includes('tunai') ? 'tunai' : /qris|wallet|kredit|debit/.test(method) ? 'qris' : 'tf';
        revenue[bucket] += amount;
    });
    const total = Object.values(revenue).reduce((a, b) => a + b, 0);
    ['d_rev', 'd_rev_big'].forEach(id => setElem(id, formatRp(total)));
    setElem('d_rev_count', arrivals.length); Object.entries(revenue).forEach(([key, amount]) => setElem(`d_rev_${key}`, formatRp(amount)));
    setElem('tbl-dash-ci', arrivals.slice(-4).reverse().map((t, i) => `<tr><td class="p-3">${i + 1}</td><td class="p-3">${safeStr(t['Nama Tamu'])}</td><td class="p-3">${safeStr(t['No Kamar'])}</td><td class="p-3">${safeStr(parseDateStandard(t['Tgl Check-in']))}</td><td class="p-3">${safeStr(parseDateStandard(t['Tgl Check-out']))}</td></tr>`).join('') || emptyRow(5, 'Belum ada check-in hari ini'), true);
    setElem('tbl-dash-resv', [...globalReservasi].reverse().slice(0, 3).map((r, i) => `<tr><td class="p-3">${i + 1}</td><td class="p-3">${safeStr(r['Nama Pemesan'])}</td><td class="p-3">${safeStr(r['No Kamar'])}</td><td class="p-3">${safeStr(parseDateStandard(r['Tgl Check-in']))}</td><td class="p-3">${safeStr(r['Status Booking'])}</td></tr>`).join('') || emptyRow(5, 'Belum ada reservasi'), true);
    setElem('room-grid', globalKamar.map(k => {
        const status = transactionForRoom(k['No Kamar']) ? 'Terisi' : text(k.Status);
        const color = { Kosong: 'text-green-700', Terisi: 'text-red-700', Booking: 'text-yellow-700' }[status] || 'text-orange-700';
        return `<button type="button" data-action="room-detail" data-id="${safeStr(k['No Kamar'])}" class="border rounded-xl p-4 bg-white shadow-sm hover:shadow-md"><span class="block font-black text-xl">${safeStr(k['No Kamar'])}</span><span class="block mt-2 font-bold ${color}">${safeStr(status || 'Tidak diketahui')}</span></button>`;
    }).join('') || '<p class="col-span-full p-4">Belum ada kamar. Tambahkan melalui menu Data Kamar.</p>', true);
}
function renderLaporanData() {
    const filter = parseDateStandard(value('filter_lap_tgl'));
    const period = filter || getTodayYMD().slice(0, 7);
    const matches = date => !!date && (filter ? date === filter : date.startsWith(period));
    const types = new Map(['Standard', 'Deluxe', 'VIP'].map(t => [t, { count: 0, revenue: 0 }]));
    const popularity = new Map(); let total = 0;
    globalTransaksi.forEach(t => {
        if (!isActive(t) && !isCompleted(t)) return;
        const income = cashForPeriod(t, matches); total += income;
        const type = text(roomById(t['No Kamar'])?.Tipe) || 'Kamar terhapus';
        if (!types.has(type)) types.set(type, { count: 0, revenue: 0 });
        types.get(type).revenue += income;
        if (matches(parseDateStandard(t['Tgl Check-in']))) {
            types.get(type).count++;
            const room = text(t['No Kamar']); popularity.set(room, (popularity.get(room) || 0) + 1);
        }
    });
    const favorite = [...popularity].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '—';
    const occupied = globalKamar.filter(k => transactionForRoom(k['No Kamar']) || text(k.Status) === 'Terisi').length;
    const periodLabel = filter ? `(${filter.split('-').reverse().join('/')})` : '(Bulan Ini)';
    setElem('lbl_lap_title_1', `Penerimaan pembayaran ${periodLabel}`); setElem('lbl_lap_title_2', `Kamar terlaris ${periodLabel}`); setElem('lbl_lap_title_3', `Kinerja tipe kamar ${periodLabel}`);
    setElem('lap_pendapatan', formatRp(total)); setElem('lap_okupansi', `${globalKamar.length ? Math.round(occupied / globalKamar.length * 100) : 0}%`); setElem('lap_terlaris', favorite);
    setElem('tbl-lap-tipe', [...types].map(([type, stats]) => `<tr><td class="p-3">${safeStr(type)}</td><td class="p-3 text-center">${stats.count} Kali</td><td class="p-3 text-right">${formatRp(stats.revenue)}</td></tr>`).join(''), true);
}

async function klikKamarDashboard(no) {
    const room = roomById(no); if (!room) return;
    const trx = transactionForRoom(no), status = text(room.Status);
    if (trx) {
        const result = await Swal.fire({ title: `Kamar ${text(no)}`, text: `${text(trx['Nama Tamu'])} • ${parseDateStandard(trx['Tgl Check-in'])} s.d. ${parseDateStandard(trx['Tgl Check-out'])}`, showCancelButton: true, confirmButtonText: 'Buka check-out', cancelButtonText: 'Tutup' });
        if (result.isConfirmed && switchPage('checkout')) { $('co_kamar').value = no; loadTagihanCheckout(); }
    } else if (status === 'Kosong') {
        const result = await Swal.fire({ title: `Kamar ${text(no)}`, text: `${text(room.Tipe)} • ${formatRp(room.Harga)} per malam`, showCancelButton: true, confirmButtonText: 'Buka check-in', cancelButtonText: 'Tutup' });
        if (result.isConfirmed && switchPage('checkin')) { $('ci_kamar').value = no; calcCheckin(); }
    } else if (['Cleaning', 'Maintenance'].includes(status)) {
        const result = await Swal.fire({ title: `Kamar ${text(no)} (${status})`, text: 'Pembersihan atau perbaikan sudah selesai?', showCancelButton: true, confirmButtonText: 'Tandai kosong', cancelButtonText: 'Batal' });
        if (result.isConfirmed) await runMutation('kamar', async () => { if (await postAPI('updateStatusKamar', { noKamar: no, statusBaru: 'Kosong' })) await loadAllData(); });
    } else await notify(status === 'Booking' ? 'Tarik kode reservasi melalui menu Check In untuk melanjutkan.' : 'Status kamar perlu diperiksa melalui Data Kamar.', `Kamar ${text(no)}`, 'info');
}
function renderFacilities(selected = ['Wifi', 'TV']) {
    const facilities = [...new Set(['Wifi', 'TV', 'AC', 'Air Panas', ...selected])];
    $('fas_container').innerHTML = facilities.map((f, i) => `<label class="flex items-center gap-2"><input type="checkbox" id="facility-${i}" value="${safeStr(f)}" ${selected.includes(f) ? 'checked' : ''}><span>${safeStr(f)}</span></label>`).join('');
}
function otomatisFasilitas() {
    const facilities = ['Wifi', 'TV']; if (['Deluxe', 'VIP'].includes(value('k_tipe'))) facilities.push('AC'); if (value('k_tipe') === 'VIP') facilities.push('Air Panas');
    renderFacilities(facilities);
}
function tambahFasilitasManualInline() {
    const facility = value('k_f_custom'); if (!facility) return;
    const selected = [...document.querySelectorAll('#fas_container input:checked')].map(el => el.value);
    renderFacilities([...selected, facility]); $('k_f_custom').value = '';
}
async function submitKamar(event) {
    event.preventDefault();
    return runMutation('kamar', async () => {
        const number = value('k_no'), editing = editMode.active && editMode.type === 'kamar';
        const current = roomById(number), status = value('k_status');
        if (!number || !value('k_tipe') || getRawNum('k_harga') <= 0) return notify('Nomor, tipe, dan harga kamar harus diisi. Harga harus lebih dari nol.');
        if (!editing && current) return notify('Nomor kamar sudah digunakan.');
        if (editing && current && text(current.Status) !== status && (transactionForRoom(number) || text(current.Status) === 'Booking')) return notify('Status kamar dengan transaksi atau booking tidak boleh diubah lewat formulir ini.');
        const facilities = [...document.querySelectorAll('#fas_container input:checked')].map(el => el.value);
        const row = [number, value('k_tipe'), getRawNum('k_harga'), value('k_lantai'), facilities.join(', '), value('k_ket'), status];
        if (await postAPI(editing ? 'updateData' : 'addKamar', editing ? { sheetName: 'Data Kamar', searchColIndex: 1, searchValue: editMode.idVal, rowData: row } : row)) { batalEdit('kamar'); await loadAllData(); }
    });
}
function editRowKamar(no) {
    if (!requireAccess('kamar')) return;
    const k = roomById(no); if (!k) return;
    if (editMode.active && editMode.type !== 'kamar') batalEdit(editMode.type);
    ['no', 'tipe', 'lantai', 'ket', 'status'].forEach((field, i) => setElem(`k_${field}`, k[['No Kamar', 'Tipe', 'Lantai', 'Keterangan', 'Status'][i]], false, true));
    setRawNum('k_harga', k.Harga); $('k_no').readOnly = true;
    renderFacilities(text(k.Fasilitas).split(',').map(text).filter(Boolean));
    editMode = { active: true, type: 'kamar', idVal: no }; setElem('btn_save_kamar', 'UPDATE DATA KAMAR'); $('btn_cancel_kamar').classList.remove('hidden'); $('main-content').scrollTop = 0;
}
async function submitTamu(event) {
    event.preventDefault();
    return runMutation('tamu', async () => {
        const nik = value('t_nik'), editing = editMode.active && editMode.type === 'tamu';
        if (!nik || !value('t_nama') || !value('t_hp')) return notify('Identitas, nama, dan nomor HP wajib diisi.');
        if (!editing && globalTamu.some(t => text(t.NIK) === nik)) return notify('Nomor identitas sudah terdaftar. Gunakan edit tamu.');
        const old = globalTamu.find(t => text(t.NIK) === nik) || {};
        const row = [nik, value('t_nama'), old['Jenis Kelamin'] ?? '-', old['Tanggal Lahir'] ?? '-', value('t_hp'), old.Email ?? '-', value('t_alamat'), old['Total Menginap'] ?? old['Total Kunjungan'] ?? 0, old['Total Pembayaran'] ?? old['Total Pengeluaran'] ?? 0];
        if (await postAPI(editing ? 'updateData' : 'addTamu', editing ? { sheetName: 'Data Tamu', searchColIndex: 1, searchValue: editMode.idVal, rowData: row } : row)) { batalEdit('tamu'); await loadAllData(); }
    });
}
function editRowTamu(nik) {
    if (!requireAccess('tamu')) return;
    const t = globalTamu.find(row => text(row.NIK) === text(nik)); if (!t) return;
    if (editMode.active && editMode.type !== 'tamu') batalEdit(editMode.type);
    ['nik', 'nama', 'hp', 'alamat'].forEach((field, i) => setElem(`t_${field}`, t[['NIK', 'Nama Lengkap', 'No HP', 'Alamat'][i]], false, true));
    $('t_nik').readOnly = true; editMode = { active: true, type: 'tamu', idVal: nik }; setElem('btn_save_tamu', 'UPDATE DATA TAMU'); $('btn_cancel_tamu').classList.remove('hidden'); $('main-content').scrollTop = 0;
}
function calcReservasi() {
    const days = stayDays(value('r_in'), value('r_out')), room = roomById(value('r_kamar'));
    $('r_out').min = value('r_in');
    setElem('r_info', days && room ? `${days} Malam × ${formatRp(room.Harga)} = ${formatRp(days * parseRpToNum(room.Harga))}` : 'Pilih kamar dan tanggal yang valid', false, true);
}
async function submitReservasi(event) {
    event.preventDefault();
    return runMutation('reservasi', async () => {
        const room = roomById(value('r_kamar')), days = stayDays(value('r_in'), value('r_out'));
        const editing = editMode.active && editMode.type === 'reservasi';
        const original = editing ? globalReservasi.find(r => text(r['Kode Booking']) === text(editMode.idVal)) : null;
        if (editing && !pendingBooking(original)) return notify('Hanya reservasi menunggu yang dapat diubah.');
        if (!room || !days || !value('r_nama') || !value('r_hp')) return notify('Nama, HP, kamar, dan tanggal harus valid.');
        if (['Maintenance', 'Cleaning'].includes(text(room.Status))) return notify('Kamar sedang dibersihkan atau diperbaiki.');
        if (value('r_in') < getTodayYMD() && (!original || value('r_in') !== parseDateStandard(original['Tgl Check-in']))) return notify('Tanggal reservasi baru tidak boleh di masa lalu.');
        const conflict = roomConflict(room['No Kamar'], value('r_in'), value('r_out'), editing ? editMode.idVal : '');
        if (conflict) return notify(conflict);
        const total = days * parseRpToNum(room.Harga), dp = getRawNum('r_dp');
        if (total <= 0 || dp < 0 || dp > total) return notify('DP harus di antara nol dan total biaya kamar.');
        const row = [editing ? editMode.idVal : uniqueId('BK'), value('r_nama'), value('r_hp'), room['No Kamar'], value('r_in'), value('r_out'), days, formatRp(total), formatRp(dp), value('r_metode'), value('r_catatan'), 'Menunggu'];
        if (await postAPI(editing ? 'updateData' : 'addReservasi', editing ? { sheetName: 'Reservasi', searchColIndex: 1, searchValue: editMode.idVal, rowData: row } : row)) { batalEdit('reservasi'); await loadAllData(); }
    });
}
function editRowReservasi(code) {
    if (!requireAccess('reservasi')) return;
    const r = globalReservasi.find(row => text(row['Kode Booking']) === text(code));
    if (!pendingBooking(r)) return notify('Reservasi ini tidak dapat diedit.');
    if (editMode.active && editMode.type !== 'reservasi') batalEdit(editMode.type);
    ['nama', 'hp', 'kamar', 'in', 'out', 'metode', 'catatan'].forEach((field, i) => {
        const cell = r[['Nama Pemesan', 'No HP', 'No Kamar', 'Tgl Check-in', 'Tgl Check-out', 'Metode Bayar', 'Catatan'][i]];
        setElem(`r_${field}`, ['in', 'out'].includes(field) ? parseDateStandard(cell) : cell, false, true);
    });
    setRawNum('r_dp', r.DP); editMode = { active: true, type: 'reservasi', idVal: code }; calcReservasi();
    setElem('btn_save_resv', 'UPDATE RESERVASI'); $('btn_cancel_resv').classList.remove('hidden'); $('main-content').scrollTop = 0;
}
function batalEdit(type) {
    $(`form-${type}`).reset();
    if (editMode.type === type) editMode = { active: false, type: null, idVal: null };
    const names = { kamar: ['k_no', 'k_harga', 'btn_save_kamar', 'btn_cancel_kamar', 'SIMPAN DATA KAMAR'], tamu: ['t_nik', null, 'btn_save_tamu', 'btn_cancel_tamu', 'SIMPAN DATA TAMU'], reservasi: [null, 'r_dp', 'btn_save_resv', 'btn_cancel_resv', 'SIMPAN RESERVASI'] };
    const [id, money, save, cancel, label] = names[type];
    if (id) $(id).readOnly = false; if (money) setRawNum(money, 0);
    if (type === 'kamar') renderFacilities(); if (type === 'reservasi') { $('r_info').value = ''; $('r_out').removeAttribute('min'); }
    setElem(save, label); $(cancel).classList.add('hidden');
}
async function hapusData(sheet, column, id) {
    const page = { 'Data Kamar': 'kamar', 'Data Tamu': 'tamu', Reservasi: 'reservasi', 'Data User': 'pengaturan' }[sheet];
    if (!page || !requireAccess(page) || busy) return;
    if (sheet === 'Data Kamar' && (globalTransaksi.some(t => text(t['No Kamar']) === text(id)) || globalReservasi.some(r => text(r['No Kamar']) === text(id)))) return notify('Kamar terkait transaksi atau reservasi. Gunakan status Maintenance untuk menonaktifkannya.');
    if (sheet === 'Data Tamu' && globalTransaksi.some(t => text(t['No KTP']) === text(id))) return notify('Tamu memiliki riwayat transaksi sehingga tidak dapat dihapus.');
    if (sheet === 'Reservasi') {
        const booking = globalReservasi.find(r => text(r['Kode Booking']) === text(id));
        if (!pendingBooking(booking) || parseRpToNum(booking.DP) > 0) return notify('Reservasi selesai atau memiliki DP tidak dapat dihapus. Selesaikan pencatatan pengembalian DP melalui admin.');
    }
    if (sheet === 'Data User') {
        if (text(activeUser.Username) === text(id)) return notify('Anda tidak dapat menghapus akun yang sedang digunakan.');
        const user = globalUsers.find(u => text(u.Username) === text(id));
        if (text(user?.['Hak Akses']) === 'Semua Akses' && globalUsers.filter(u => text(u['Hak Akses']) === 'Semua Akses' && text(u.Status) === 'Aktif').length <= 1) return notify('Admin aktif terakhir tidak dapat dihapus.');
    }
    const result = await Swal.fire({ title: 'Hapus data?', text: `Data ${text(id)} akan dihapus permanen.`, icon: 'warning', showCancelButton: true, confirmButtonText: 'Hapus', cancelButtonText: 'Batal' });
    if (result.isConfirmed) await runMutation(page, async () => { if (await postAPI('deleteData', { sheetName: sheet, searchColIndex: column, searchValue: id })) { if (editMode.type === page && text(editMode.idVal) === text(id)) batalEdit(page); await loadAllData(); } });
}

function cariTamuCI() {
    if (!requireAccess('checkin')) return;
    const key = value('ci_cari_tamu').toLowerCase(); if (!key) return notify('Masukkan identitas atau nama tamu.');
    const exact = globalTamu.filter(t => text(t.NIK).toLowerCase() === key || text(t['Nama Lengkap']).toLowerCase() === key);
    const matches = exact.length ? exact : globalTamu.filter(t => text(t['Nama Lengkap']).toLowerCase().includes(key));
    if (matches.length !== 1) return notify(matches.length ? 'Nama cocok dengan beberapa tamu. Gunakan nomor identitas.' : 'Tamu tidak ditemukan.');
    const t = matches[0]; ['ktp', 'nama', 'hp', 'alamat'].forEach((field, i) => setElem(`ci_${field}`, t[['NIK', 'Nama Lengkap', 'No HP', 'Alamat'][i]], false, true));
}
function cariReservasiCI() {
    if (!requireAccess('checkin')) return;
    const key = value('ci_cari_resv').toLowerCase(); if (!key) return notify('Masukkan kode atau nama pemesan.');
    const pending = globalReservasi.filter(pendingBooking);
    const exact = pending.filter(r => text(r['Kode Booking']).toLowerCase() === key);
    const matches = exact.length ? exact : pending.filter(r => text(r['Nama Pemesan']).toLowerCase().includes(key));
    if (matches.length !== 1) return notify(matches.length ? 'Beberapa reservasi ditemukan. Gunakan kode booking.' : 'Reservasi menunggu tidak ditemukan.');
    const r = matches[0];
    if (parseDateStandard(r['Tgl Check-out']) < getTodayYMD()) return notify('Jadwal reservasi sudah lewat. Ubah jadwal melalui menu Reservasi.');
    $('ci_kode_booking').value = r['Kode Booking']; updateDOMKamar();
    ['nama', 'hp', 'kamar', 'in', 'out', 'metode'].forEach((field, i) => {
        const cell = r[['Nama Pemesan', 'No HP', 'No Kamar', 'Tgl Check-in', 'Tgl Check-out', 'Metode Bayar'][i]];
        setElem(`ci_${field}`, ['in', 'out'].includes(field) ? parseDateStandard(cell) : cell, false, true);
    });
    setRawNum('ci_bayar', r.DP); setRawNum('ci_diskon', 0); calcCheckin();
    if (!value('ci_kamar')) notify('Data reservasi ditarik, tetapi kamar belum siap untuk check-in.');
}
function calcCheckin() {
    const days = stayDays(value('ci_in'), value('ci_out')), room = roomById(value('ci_kamar'));
    $('ci_out').min = value('ci_in'); setElem('ci_lbl_hari', days && room ? days : 0);
    setRawNum('ci_biaya', days && room ? days * parseRpToNum(room.Harga) - getRawNum('ci_diskon') : 0);
}
async function submitCheckin(event) {
    event.preventDefault();
    return runMutation('checkin', async () => {
        calcCheckin();
        const room = roomById(value('ci_kamar')), days = stayDays(value('ci_in'), value('ci_out'));
        const bookingCode = value('ci_kode_booking'), nik = value('ci_ktp');
        if (!room || !days || !nik || !value('ci_nama') || !value('ci_hp')) return notify('Identitas, nama, HP, kamar, dan tanggal harus valid.');
        if (value('ci_in') !== getTodayYMD()) return notify('Check-in harus memakai tanggal hari ini. Gunakan Reservasi untuk jadwal mendatang.');
        const booking = bookingCode ? globalReservasi.find(r => text(r['Kode Booking']) === bookingCode && pendingBooking(r)) : null;
        if (bookingCode && (!booking || text(booking['No Kamar']) !== text(room['No Kamar']))) return notify('Kamar tidak sesuai reservasi yang ditarik. Tarik ulang reservasi.');
        if (booking && (value('ci_in') !== parseDateStandard(booking['Tgl Check-in']) || value('ci_out') !== parseDateStandard(booking['Tgl Check-out']))) return notify('Jadwal berbeda dari reservasi. Ubah reservasi terlebih dahulu.');
        if (transactionForRoom(room['No Kamar']) || !(['Kosong', ...(booking ? ['Booking'] : [])].includes(text(room.Status)))) return notify('Kamar belum siap atau sudah terisi.');
        const conflict = roomConflict(room['No Kamar'], value('ci_in'), value('ci_out'), bookingCode); if (conflict) return notify(conflict);
        const price = parseRpToNum(room.Harga) * days, discount = getRawNum('ci_diskon'), total = price - discount, dp = getRawNum('ci_bayar');
        if (price <= 0 || discount < 0 || discount > price || dp < 0 || dp > total) return notify('Diskon atau pembayaran melebihi total tagihan.');
        if (booking && dp < parseRpToNum(booking.DP)) return notify('Pembayaran awal tidak boleh lebih kecil daripada DP reservasi.');
        const invoice = uniqueId('INV');
        const row = [invoice, value('ci_nama'), nik, value('ci_hp'), value('ci_alamat'), room['No Kamar'], value('ci_in'), value('ci_out'), days, formatRp(price), 0, 0, 0, 0, formatRp(discount), formatRp(dp), formatRp(total), formatRp(dp), formatRp(total - dp), value('ci_metode'), 'Aktif (Check-in)'];
        // Await guest creation: concurrent writes to the Apps Script used to race check-in.
        if (!globalTamu.some(t => text(t.NIK) === nik)) {
            if (!await postAPI('addTamu', [nik, row[1], '-', '-', row[3], '-', row[4], 0, 0])) return false;
            globalTamu.push({ NIK: nik, 'Nama Lengkap': row[1], 'No HP': row[3], Alamat: row[4] });
        }
        if (await postAPI('checkIn', { transaksiData: row, noKamar: room['No Kamar'], kodeBooking: bookingCode })) {
            const receipt = Object.fromEntries(TRANSACTION_COLUMNS.map((key, i) => [key, row[i]]));
            event.target.reset(); ['ci_diskon', 'ci_biaya', 'ci_bayar'].forEach(id => setRawNum(id, 0)); $('ci_kode_booking').value = ''; setElem('ci_lbl_hari', 0);
            await loadAllData(); switchPage(firstAllowedPage()); triggerPrint('record', receipt);
        }
    });
}
function clearCheckout() { actTrx = null; $('co_area').classList.add('hidden'); ['co_laundry', 'co_makan', 'co_minibar', 'co_denda', 'co_diskon'].forEach(id => setRawNum(id, 0)); }
function loadTagihanCheckout() {
    if (!requireAccess('checkout')) return;
    clearCheckout(); const trx = transactionForRoom(value('co_kamar'));
    if (!trx) return notify('Pilih kamar dengan transaksi aktif.');
    actTrx = { ...trx }; $('co_area').classList.remove('hidden');
    [['lbl_co_inv', trx['No Invoice']], ['lbl_co_nama', trx['Nama Tamu']], ['lbl_co_nokamar', trx['No Kamar']], ['lbl_co_hari', trx['Lama Menginap']], ['lbl_co_in', parseDateStandard(trx['Tgl Check-in'])], ['lbl_co_biaya', formatRp(trx['Biaya Kamar'])], ['lbl_co_diskon_awal', '- ' + formatRp(trx.Diskon)], ['lbl_co_dp_awal', formatRp(depositOf(trx))]].forEach(([id, val]) => setElem(id, val));
    setRawNum('co_laundry', trx.Laundry); setRawNum('co_makan', trx.Makanan); setRawNum('co_minibar', trx.Minibar); setRawNum('co_denda', trx.Denda); hitungTotalCO();
}
function hitungTotalCO() {
    if (!actTrx) return { tBaru: 0, sisa: 0, dk_total: 0, valid: false };
    const room = parseRpToNum(actTrx['Biaya Kamar']), originalDiscount = parseRpToNum(actTrx.Diskon), extraDiscount = getRawNum('co_diskon');
    const additional = ['co_laundry', 'co_makan', 'co_minibar', 'co_denda'].map(getRawNum);
    const charges = additional.reduce((a, b) => a + b, 0), discount = originalDiscount + extraDiscount;
    const total = room + charges - discount, paid = paidOf(actTrx), balance = total - paid;
    const valid = additional.every(n => n >= 0) && extraDiscount >= 0 && discount >= 0 && discount <= room + charges && total >= paid;
    // Applying the extra discount to the outstanding room balance is permitted.
    const roomBalance = Math.max(0, room - originalDiscount - paid - extraDiscount);
    setElem('lbl_co_sisa_kamar', formatRp(roomBalance)); setElem('lbl_co_sisa_tambahan', formatRp(Math.max(0, balance - roomBalance))); setElem('lbl_co_sisa', formatRp(Math.max(0, balance)));
    return { tBaru: total, sisa: balance, dk_total: discount, valid };
}
function checkoutRecord(settle) {
    const calc = hitungTotalCO(); if (!actTrx || !calc.valid) return null;
    return { ...actTrx, 'Tgl Check-out': settle ? getTodayYMD() : actTrx['Tgl Check-out'], Laundry: formatRp(getRawNum('co_laundry')), Makanan: formatRp(getRawNum('co_makan')), Minibar: formatRp(getRawNum('co_minibar')), Denda: formatRp(getRawNum('co_denda')), Diskon: formatRp(calc.dk_total), DP: formatRp(depositOf(actTrx)), 'Total Tagihan': formatRp(calc.tBaru), 'Sudah Dibayar': formatRp(settle ? calc.tBaru : paidOf(actTrx)), Sisa: formatRp(settle ? 0 : calc.sisa), 'Status Transaksi': settle ? 'Selesai (Check-out)' : actTrx['Status Transaksi'] };
}
async function submitCheckout() {
    return runMutation('checkout', async () => {
        if (!actTrx || value('co_kamar') !== text(actTrx['No Kamar']) || !globalTransaksi.some(t => t['No Invoice'] === actTrx['No Invoice'] && isActive(t))) return notify('Pilih dan muat ulang tagihan aktif.');
        const record = checkoutRecord(true); if (!record) return notify('Diskon tidak boleh melebihi tagihan atau mengurangi total di bawah pembayaran yang sudah diterima.');
        const payment = Math.max(0, parseRpToNum(record['Total Tagihan']) - paidOf(actTrx));
        const confirmation = await Swal.fire({ title: 'Konfirmasi pelunasan', text: `Pastikan ${formatRp(payment)} sudah diterima. Tamu akan dicatat check-out.`, icon: 'question', showCancelButton: true, confirmButtonText: 'Sudah diterima, check-out', cancelButtonText: 'Batal' });
        if (!confirmation.isConfirmed) return false;
        const row = TRANSACTION_COLUMNS.map(key => record[key]);
        if (await postAPI('checkOut', { noInvoice: record['No Invoice'], updateTransaksiData: row, noKamar: record['No Kamar'] })) {
            clearCheckout(); await loadAllData(); switchPage(firstAllowedPage()); triggerPrint('record', record);
        }
    });
}
function triggerPrint(mode, data = null) {
    if (!activeUser) return;
    if (mode === 'riwayat' && !requireAccess('pembayaran')) return;
    if (mode === 'checkout' && !requireAccess('checkout')) return;
    const record = mode === 'record' ? data : mode === 'riwayat' ? globalTransaksi.find(t => text(t['No Invoice']) === text(data)) : checkoutRecord(false);
    if (!record) return notify('Data invoice belum tersedia atau biaya tidak valid.');
    const total = parseRpToNum(record['Total Tagihan']), dp = depositOf(record), paid = paidOf(record);
    const fields = {
        pr_hotel_name: value('set_hotel') || 'SANSTECH PENGINAPAN', pr_hotel_address: value('set_alamat'), pr_hotel_tel: `Telp: ${value('set_telp')}`,
        pr_inv_no: record['No Invoice'], pr_guest_name: record['Nama Tamu'], pr_guest_phone: record['No HP'], pr_guest_address: record.Alamat || '—', pr_room_no: record['No Kamar'],
        pr_checkin: parseDateStandard(record['Tgl Check-in']), pr_checkout: parseDateStandard(record['Tgl Check-out']), pr_room_qty: record['Lama Menginap'], pr_room_price: formatRp(record['Biaya Kamar']),
        pr_laundry: formatRp(record.Laundry), pr_fnb: formatRp(record.Makanan), pr_minibar: formatRp(record.Minibar), pr_denda: formatRp(record.Denda), pr_discount: '- ' + formatRp(record.Diskon),
        pr_subtotal: formatRp(total), pr_dp: formatRp(dp), pr_paid: formatRp(Math.max(0, paid - dp)), pr_balance: formatRp(Math.max(0, total - paid)), pr_payment_method: record['Metode Bayar'],
        pr_inv_date: getTodayYMD().split('-').reverse().join('/'), pr_admin_name: activeUser.Username
    };
    Object.entries(fields).forEach(([id, val]) => setElem(id, val));
    // The print stylesheet alone reveals this area, avoiding an invoice flash in the app.
    requestAnimationFrame(() => window.print());
}

function requireXLSX() { if (typeof XLSX !== 'undefined') return true; notify('Komponen Excel belum tersedia. Muat ulang aplikasi.', 'Ekspor gagal', 'error'); return false; }
function exportTableToExcel(id, filename = 'Export') {
    const page = id.includes('kamar') ? 'kamar' : id.includes('tamu') ? 'tamu' : id.includes('reservasi') ? 'reservasi' : 'pembayaran';
    if (!requireAccess(page) || !requireXLSX()) return;
    const element = $(id), table = element?.tagName === 'TABLE' ? element : element?.closest('table');
    if (!table) return notify('Tabel ekspor tidak ditemukan.');
    const copy = table.cloneNode(true);
    const actions = [...copy.querySelectorAll('thead th')].map((cell, i) => /^(aksi|cetak)$/i.test(cell.textContent.trim()) ? i : -1).filter(i => i >= 0).reverse();
    [...copy.rows].forEach(row => { if (row.hidden || row.querySelector('[colspan]')) { row.remove(); return; } actions.forEach(index => row.cells[index]?.remove()); });
    const rows = [...copy.rows].map(row => [...row.cells].map(cell => cell.textContent.trim()));
    if (rows.length < 2) return notify('Tidak ada data untuk diekspor.');
    // Use strings explicitly to preserve NIK, telephone numbers, and leading zeros.
    const sheet = XLSX.utils.aoa_to_sheet(rows), book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, sheet, 'Data'); XLSX.writeFile(book, `${filename}.xlsx`);
}
function exportSemuaTransaksiExcel() {
    if (!requireAccess('laporan') || !requireXLSX()) return;
    if (!globalTransaksi.length) return notify('Belum ada transaksi untuk diekspor.');
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(globalTransaksi), 'Semua Transaksi'); XLSX.writeFile(book, 'Laporan_Semua_Transaksi.xlsx');
}
function backupDatabase() {
    if (!requireAccess('pengaturan')) return;
    window.open('https://docs.google.com/spreadsheets/d/1Z2iCSjdW2oi5dEucNR34mD-U2TEHi779OfbKgm11vwA/export?format=xlsx', '_blank', 'noopener,noreferrer');
}
async function simpanProfilPengaturan() {
    return runMutation('pengaturan', async () => {
        if (!value('set_hotel') || !value('set_alamat') || !value('set_telp')) return notify('Nama penginapan, alamat, dan telepon wajib diisi.');
        const rows = [['Profil Invoice', 'Nama Penginapan', value('set_hotel'), 'Menyesuaikan Struk Invoice'], ['Profil Invoice', 'Alamat Lengkap', value('set_alamat'), 'Menyesuaikan Struk Invoice'], ['Profil Invoice', 'Nomor Telepon', value('set_telp'), 'Menyesuaikan Struk Invoice']];
        if (await postAPI('savePengaturan', rows)) { await loadAllData(); await notify('Profil penginapan tersimpan.', 'Tersimpan', 'success'); }
    });
}
function changeUserRole() {
    const role = value('swal-r'); $('swal-custom').classList.toggle('hidden', role !== 'Custom'); $('akses-box').classList.toggle('hidden', role === 'Super Admin');
}
async function tambahUserBaru() {
    if (!requireAccess('pengaturan') || busy) return;
    const menus = allMenus.map(m => `<label class="flex gap-2 items-center"><input type="checkbox" class="menu-akses" value="${safeStr(m.text)}"><span>${safeStr(m.text)}</span></label>`).join('');
    const result = await Swal.fire({ title: 'Tambah PIN karyawan', html: `<div class="space-y-4"><input id="swal-u" class="swal2-input !w-full !mx-0" aria-label="Nama karyawan" placeholder="Nama karyawan"><input id="swal-p" type="password" inputmode="numeric" maxlength="6" class="swal2-input !w-full !mx-0" aria-label="PIN 6 angka" placeholder="PIN 6 angka"><select id="swal-r" class="swal2-select !w-full !mx-0"><option>Resepsionis</option><option>Super Admin</option><option>Custom</option></select><input id="swal-custom" class="swal2-input hidden !w-full !mx-0" aria-label="Jabatan khusus" placeholder="Jabatan khusus"><div id="akses-box" class="grid grid-cols-2 gap-3 text-sm text-left">${menus}</div></div>`, showCancelButton: true, confirmButtonText: 'Simpan', cancelButtonText: 'Batal', didOpen: () => $('swal-r').addEventListener('change', changeUserRole), preConfirm: () => {
        const name = value('swal-u'), pin = value('swal-p'), role = value('swal-r') === 'Custom' ? value('swal-custom') : value('swal-r');
        const access = role === 'Super Admin' ? 'Semua Akses' : [...document.querySelectorAll('.menu-akses:checked')].map(el => el.value).join(', ');
        if (!name || !role || !/^\d{6}$/.test(pin)) { Swal.showValidationMessage('Isi nama, jabatan, dan tepat 6 digit PIN.'); return false; }
        if (!access) { Swal.showValidationMessage('Pilih minimal satu hak akses.'); return false; }
        if (globalUsers.some(u => text(u.Username).toLowerCase() === name.toLowerCase())) { Swal.showValidationMessage('Nama karyawan sudah digunakan.'); return false; }
        return [name, pin, role, access, 'Aktif'];
    } });
    if (!result.value) return;
    await runMutation('pengaturan', async () => {
        const users = await fetchAPI('getUser');
        if (!Array.isArray(users.data)) throw new Error('Data pengguna tidak valid.');
        if (users.data.some(u => String(u.Password).padStart(6, '0') === result.value[1] || text(u.Username).toLowerCase() === result.value[0].toLowerCase())) return notify('Nama atau PIN sudah digunakan. Pilih yang lain.');
        if (await postAPI('addUser', result.value)) await loadAllData();
    });
}

document.addEventListener('click', event => {
    const button = event.target.closest('[data-action], [data-page]'); if (!button) return;
    event.preventDefault(); if (button.disabled) return;
    if (button.dataset.page) { switchPage(button.dataset.page); return; }
    const id = button.dataset.id;
    const handlers = { 'edit-room': () => editRowKamar(id), 'delete-room': () => hapusData('Data Kamar', 1, id), 'edit-guest': () => editRowTamu(id), 'delete-guest': () => hapusData('Data Tamu', 1, id), 'edit-booking': () => editRowReservasi(id), 'delete-booking': () => hapusData('Reservasi', 1, id), 'delete-user': () => hapusData('Data User', 1, id), print: () => triggerPrint('riwayat', id), 'room-detail': () => klikKamarDashboard(id) };
    handlers[button.dataset.action]?.();
});
window.addEventListener('DOMContentLoaded', () => {
    ['isLoggedIn', 'activeUser', 'activeRole', 'activeAkses'].forEach(key => localStorage.removeItem(key));
    const updateClock = () => setElem('current-date', new Date().toLocaleString('id-ID', { timeZone: HOTEL_TIMEZONE, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    updateClock(); setInterval(updateClock, 1000); renderFacilities();
    document.querySelectorAll('.pin-box').forEach((el, i) => {
        el.inputMode = 'numeric'; el.autocomplete = 'off'; el.setAttribute('aria-label', `Digit PIN ${i + 1}`);
        if (i > 0) el.addEventListener('paste', handlePaste);
        el.addEventListener('input', () => { el.value = el.value.replace(/\D/g, ''); if (el.value && i < 5) $(`pin${i + 2}`).focus(); else if (el.value && i === 5) submitPinLogin(); });
    });
    document.querySelectorAll('label').forEach(label => { const control = label.parentElement.querySelector('input[id],select[id],textarea[id]'); if (control && !label.querySelector('input')) label.htmlFor = control.id; });
    document.querySelectorAll('button[onclick="toggleSidebar()"]:not(#sidebar button)').forEach(button => { button.setAttribute('aria-label', 'Buka menu'); button.setAttribute('aria-controls', 'sidebar'); button.setAttribute('aria-expanded', 'false'); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') toggleSidebar(false); });
    window.addEventListener('offline', () => { dataFresh = false; if (activeUser) syncStatus('Koneksi terputus. Perubahan belum dapat disimpan.', true); });
    window.addEventListener('online', () => { if (activeUser && !busy) loadAllData(); });
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(() => { if (activeUser) syncStatus('Cache aplikasi belum tersedia. Aplikasi tetap dapat digunakan saat online.'); });
    $('pin1').focus();
});
