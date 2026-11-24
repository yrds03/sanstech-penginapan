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
- **Laporan:** penerimaan dihitung dari DP pada tanggal check-in dan pelunasan pada tanggal check-out. Nilai nol pada DP dipertahankan. Ini mengikuti informasi tanggal yang tersedia pada skema lama; tanggal penerimaan DP reservasi dan perubahan metode saat pelunasan belum dicatat terpisah.
- **Sinkronisasi:** kegagalan baca tidak mengganti data terakhir dengan tabel kosong. Penyimpanan diblokir sampai sinkronisasi pulih. Jika hasil POST tidak diketahui karena koneksi terputus, periksa hasil sinkronisasi sebelum mengirim ulang.
- **Offline:** shell aplikasi dapat dibuka setelah kunjungan online pertama. Data tamu, PIN, dan respons API tidak disimpan dalam cache service worker. Transaksi tetap memerlukan koneksi ke Google Apps Script.

## Kontrak API yang dipertahankan

Endpoint dan tautan cadangan spreadsheet yang sudah dipakai proyek dipertahankan di `app.js`. GET menggunakan `?action=...`. POST mengirim JSON `{ "action": "...", "data": ... }` dengan `Content-Type: text/plain;charset=UTF-8`, agar cocok dengan deployment Apps Script yang ada.

GET: `getKamar`, `getTamu`, `getReservasi`, `getTransaksi`, `getUser`, `getPengaturan`.

POST: `addKamar`, `addTamu`, `addReservasi`, `addUser`, `updateData`, `deleteData`, `updateStatusKamar`, `checkIn`, `checkOut`, `savePengaturan`.

Urutan kolom dikonfirmasi melalui pemeriksaan baca API pada 24 November 2026. `Data Tamu` memakai `Total Menginap` dan `Total Pembayaran`; `Reservasi` memakai `Jumlah Hari` dan `Harga Total`; kolom saldo transaksi bernama `Sisa`. Perubahan profil memakai pasangan `Item` / `Nilai`.

## Batas verifikasi backend

Kode Google Apps Script tidak terdapat dalam repositori ini. Pengujian browser memakai respons dan penulisan simulasi dengan kontrak kolom yang sama; tidak mengirim transaksi percobaan ke database operasional.

API lama menyediakan `getUser` untuk pemeriksaan PIN di browser. Menghapus PIN master, mencegah pemulihan sesi dari localStorage, dan membatasi menu memperbaiki perilaku klien, tetapi **tidak memberi otorisasi pada server**. Autentikasi server, hash PIN, pembatasan percobaan login, pemeriksaan izin setiap operasi, dan `LockService` untuk bentrok antarperangkat harus diterapkan pada proyek Google Apps Script sebelum aplikasi dianggap aman untuk data produksi. Pemeriksaan bentrok di browser tidak menjamin dua perangkat tidak memesan bersamaan. Endpoint lama yang tetap membuka pembacaan PIN juga harus diperbarui.

Pembuatan tamu dan check-in masih merupakan dua operasi API. Jika check-in gagal setelah tamu tersimpan, data tamu tetap tersimpan dan dapat dipakai saat mencoba kembali. Transaksi lintas sheet secara atomik dan idempotensi POST memerlukan dukungan backend.

## Pengembangan dan pengujian

```sh
npm ci
npm run check
npm run build:css
python tests/check_static.py
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
python tests/browser_check.py
```

Di Windows, pengujian memakai Chrome atau Edge yang sudah terpasang. Untuk browser lain, tentukan `BROWSER_EXECUTABLE`. Pengujian juga mengenali instalasi paket lokal dalam `.test-deps`.

Suite menguji login, izin menu, tanggal, rupiah, bentrok reservasi, check-in/checkout, kegagalan koneksi, invoice, Excel, data berbahaya, riwayat tamu, tampilan ponsel, serta cache offline. Workflow GitHub Actions menjalankan pemeriksaan yang sama pada push dan pull request.

Setelah mengubah kelas tampilan pada HTML/JS, jalankan `npm run build:css` dan sertakan `vendor/tailwind.css`. Saat mengubah bundle yang harus tersedia offline, naikkan versi `CACHE_NAME` dalam `sw.js`.
