# Sanstech Penginapan

Aplikasi penginapan statis yang terhubung ke Google Sheets melalui Google Apps Script. Halaman, JavaScript, CSS, pustaka Excel, dialog, dan font ikon disajikan dari repositori ini. Tidak diperlukan build untuk menjalankan versi yang sudah tersedia.

## Menjalankan

```sh
python -m http.server 8080
```

Buka `http://localhost:8080`. Masuk menggunakan PIN enam angka milik pengguna berstatus **Aktif** pada sheet `Data User`. Tidak ada PIN master atau login otomatis berdasarkan localStorage. Memuat ulang halaman meminta PIN kembali.

GitHub Pages dapat menyajikan isi repositori ini secara langsung. Pertahankan `index.html`, `app.js`, `manifest.json`, `sw.js`, direktori `icons`, dan direktori `vendor` pada lokasi relatif yang sama. Service worker membutuhkan HTTPS atau localhost. Ikon instalasi persegi disediakan dalam ukuran 192 dan 512 piksel; logo asli tetap tersedia tanpa perubahan.

## Alur operasional

- **Kamar:** hanya kamar kosong tanpa transaksi aktif dapat dipakai check-in. Cleaning dan Maintenance harus diselesaikan lebih dahulu. Kamar dengan riwayat tidak dapat dihapus agar referensi laporan terjaga.
- **Reservasi:** tanggal dan jadwal tumpang tindih diperiksa. Tanggal keluar sama dengan masuk dikenai minimum satu malam. Reservasi dengan DP tidak dapat dihapus tanpa proses pengembalian dana yang tercatat.
- **Check-in:** tanggal masuk harus hari ini menurut Asia/Jakarta. Tarik kode reservasi untuk menggunakan kamar berstatus Booking dan membawa DP serta metode bayarnya. Ubah jadwal melalui Reservasi sebelum check-in bila tanggal berbeda. Pembuatan tamu ditunggu sebelum transaksi disimpan.
- **Check-out:** tambahan layanan dan diskon dihitung bersama pembayaran yang sudah diterima. Konfirmasi pelunasan hanya setelah uang diterima. Pratinjau invoice tetap menampilkan sisa yang belum dibayar. Tarif kamar mengikuti durasi yang disepakati saat check-in; perpanjangan atau pengembalian dana memerlukan pencatatan tersendiri.
- **Laporan:** backend versi 2 memakai waktu penerimaan pada jurnal Pembayaran, termasuk DP reservasi sebelum check-in. Mode API lama tetap memakai tanggal check-in dan checkout karena hanya tanggal itu yang tersedia. Nilai nol pada DP dipertahankan.
- **Sinkronisasi:** kegagalan baca tidak mengganti data terakhir dengan tabel kosong. Penyimpanan diblokir sampai sinkronisasi pulih. Jika hasil POST tidak diketahui karena koneksi terputus, periksa hasil sinkronisasi sebelum mengirim ulang.
- **Offline:** shell aplikasi dapat dibuka setelah kunjungan online pertama. Data tamu, PIN, dan respons API tidak disimpan dalam cache service worker. Transaksi tetap memerlukan koneksi ke Google Apps Script.

## Kontrak API yang dipertahankan

Endpoint dan tautan cadangan spreadsheet yang sudah dipakai proyek dipertahankan di `app.js`. Dalam mode API lama, GET menggunakan `?action=...` dan POST mengirim JSON `{ "action": "...", "data": ... }` dengan `Content-Type: text/plain;charset=UTF-8`. Versi 2 hanya membuka `getCapabilities` melalui GET; pembacaan data dan penulisan memakai POST dengan token sesi. Frontend mendeteksi kemampuan backend sebelum memilih kontrak tersebut.

Pembacaan: `getKamar`, `getTamu`, `getReservasi`, `getTransaksi`, `getUser`, `getPengaturan`; versi 2 menggabungkan pembacaan operasional melalui `getSnapshot`.

POST: `addKamar`, `addTamu`, `addReservasi`, `addUser`, `updateData`, `deleteData`, `updateStatusKamar`, `checkIn`, `checkOut`, `savePengaturan`.

Urutan kolom dikonfirmasi melalui pemeriksaan baca API pada 24 November 2026. `Data Tamu` memakai `Total Menginap` dan `Total Pembayaran`; `Reservasi` memakai `Jumlah Hari` dan `Harga Total`; kolom saldo transaksi bernama `Sisa`. Perubahan profil memakai pasangan `Item` / `Nilai`.

## Backend dan sinkronisasi Google Sheets

Backend lengkap tersedia pada [backend/Code.gs](backend/Code.gs). Panduan pemasangan, daftar 10 sheet, migrasi data, trigger otomatis, autentikasi server, dan batas verifikasi tersedia di [backend/README.md](backend/README.md).

Frontend mendeteksi backend versi 2 dan memakai login server, token sesi di memori, snapshot konsisten, serta jurnal pembayaran. Selama deployment lama masih aktif, frontend tetap memakai kontrak lama; keamanan server dan otomatisasi baru baru berlaku setelah backend tersebut diterapkan.

## Pengembangan dan pengujian

```sh
npm ci
npm run check
npm run build:css
python tests/check_static.py
node --test tests/backend_check.cjs
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
python tests/browser_check.py
python tests/secure_browser_check.py
```

Di Windows, pengujian memakai Chrome atau Edge yang sudah terpasang. Untuk browser lain, tentukan `BROWSER_EXECUTABLE`. Pengujian juga mengenali instalasi paket lokal dalam `.test-deps`.

Suite menguji login, izin menu, tanggal, rupiah, bentrok reservasi, check-in/checkout, kegagalan koneksi, invoice, Excel, data berbahaya, riwayat tamu, tampilan ponsel, serta cache offline. Workflow GitHub Actions menjalankan pemeriksaan yang sama pada push dan pull request.

Setelah mengubah kelas tampilan pada HTML/JS, jalankan `npm run build:css` dan sertakan `vendor/tailwind.css`. Saat mengubah bundle yang harus tersedia offline, naikkan versi `CACHE_NAME` dalam `sw.js`.
