# Backend Google Apps Script dan struktur sheet

`Code.gs` adalah pengganti lengkap kode yang dilampirkan, untuk spreadsheet `1Z2iCSjdW2oi5dEucNR34mD-U2TEHi779OfbKgm11vwA`. Kode ini belum diterapkan ke akun Google hanya dengan menyimpannya di GitHub.

## Pemasangan satu kali

1. Buka spreadsheet, pilih **Ekstensi → Apps Script**. Gunakan proyek yang memiliki deployment `AKfycbyjAptPUXrwxBve2yA6Px0KmCnhm5muxOoevwIlV6VkuqPpRCqDLR671TDoI2ePny_t`.
2. Salin cadangan spreadsheet dan kode lama sebelum migrasi. Pada proyek tersebut, ganti seluruh isi `Code.gs` dengan berkas ini; jangan menambahkan kode baru di bawah kode lama.
3. Pada **Project Settings**, tampilkan manifest `appsscript.json`. Sesuaikan manifest dengan berkas yang disertakan: zona waktu Asia/Jakarta, runtime V8, izin spreadsheet dan pemasangan trigger.
4. Pilih fungsi **`setupSistemPenginapan`**, lalu **Run** dan berikan izin Google. Fungsi ini membuat sheet/header, memperbaiki urutan kolom yang dikenali, memigrasikan PIN lama, mengisi jurnal pembayaran historis, dan memasang dua trigger. Sheet dengan perubahan urutan header disalin ke tab `Cadangan ...` sebelum dipetakan ulang.
5. Pilih **Deploy → Manage deployments → Edit → New version → Deploy** pada deployment yang sama. Pertahankan **Execute as: Me** dan akses web app yang mendukung frontend publik; akses data pada API baru tetap mensyaratkan token login. Penggunaan deployment yang sama mempertahankan URL aplikasi.
6. Buka ulang frontend versi terbaru. Login memakai PIN karyawan yang sudah ada. Periksa `?action=getCapabilities`: respons `serverAuth: true` menunjukkan kode baru sudah aktif. Lakukan pengecekan awal data dan saldo sebelum transaksi operasional berikutnya.

PIN tidak berubah selama migrasi; isi kolom `Password` diganti dengan hash HMAC bersalt. Aplikasi versi lama tidak dapat lagi membandingkan PIN di browser setelah migrasi, sehingga setup dan pergantian deployment perlu dilakukan berurutan saat tidak ada transaksi berjalan. Jangan mengaktifkan lagi deployment kode lama: API lama tidak memiliki pemeriksaan izin server. Arsipkan/nonaktifkan deployment lama yang tidak dipakai.

Ganti PIN yang sebelumnya tersedia melalui API lama, termasuk PIN admin bawaan jika masih digunakan. Pemilik spreadsheet dapat memasukkan enam angka baru pada kolom Password; trigger edit akan menggantinya dengan hash. Jangan mengisi PIN yang sama untuk dua pengguna.

Jika `Data User` benar-benar kosong, tentukan Script Property **`PIN_ADMIN_AWAL`** dengan enam angka pilihan Anda sebelum menjalankan setup. Admin pertama bernama `admin`; properti PIN sementara dihapus setelah setup berhasil. Tidak ada PIN master. Jangan menghapus **`AUTH_PEPPER`**, karena diperlukan untuk memverifikasi hash PIN yang sudah tersimpan.

## Sheet dan header otomatis

| Sheet | Isi |
| --- | --- |
| Dashboard | Indikator, Nilai, Keterangan; dihitung ulang dari data operasional |
| Data Kamar | Nomor, tipe, harga, lantai, fasilitas, keterangan, status |
| Data Tamu | Identitas, kontak, alamat, total menginap dan pembayaran |
| Reservasi | Kode, pemesan, jadwal, harga, DP, metode dan status |
| Transaksi (In-Out) | Invoice, identitas tamu, kamar, jadwal, biaya, pembayaran, status, dan Kode Booking |
| Pengaturan | Kategori, Item, Nilai, Keterangan; penyimpanan profil tidak menghapus pengaturan lain |
| Data User | Username, Password dalam bentuk hash, Role, Hak Akses, Status |
| Pembayaran | ID Pembayaran, No Invoice, Kode Booking, Tanggal, Jenis, Nominal, Metode Bayar, Petugas, Keterangan |
| Log Aktivitas | ID Log, Waktu, Petugas, Aksi, Referensi, Keterangan |
| Permintaan API | ID Permintaan, Username, Aksi, Payload Hash, Status, Hasil, Waktu |

Daftar header lengkap dan urutannya didefinisikan sekali pada `SHEET_SCHEMA` dalam `Code.gs`. Dua puluh satu kolom transaksi lama dipertahankan; kolom `Kode Booking` ditambahkan di ujung. Kolom tambahan milik pengguna dipertahankan. Kolom identitas dan nomor telepon diformat sebagai teks agar nol awal tidak hilang. Header dibekukan dan diberi warna; nominal memakai format bilangan rupiah tanpa mengubahnya menjadi teks `Rp`.

Setup tidak menambahkan kamar atau tamu fiktif. Sheet tanpa header yang dapat dikenali, header identitas yang hilang, identitas duplikat, atau transaksi aktif ganda dihentikan untuk diperiksa; sistem tidak menebak dan menghapus data tersebut.

## Otomatisasi

- `saatSheetDiubah`: trigger edit spreadsheet terpasang; memperbarui status kamar, statistik tamu, dan dashboard setelah perubahan manual. Perubahan dari API tidak memicu `onEdit`, sehingga API juga melakukan rekonsiliasi langsung sebelum mengembalikan sukses.
- `sinkronkanSistemPenginapan`: trigger setiap lima menit untuk memperbarui status Booking berdasarkan hari Jakarta dan memeriksa kembali sheet/header. Setup berulang tidak menambah trigger duplikat.
- Frontend versi baru mengambil snapshot konsisten saat login dan setelah penyimpanan. Penyegaran berkala setiap 30 detik dilakukan ketika tidak ada formulir aktif atau penyimpanan berlangsung.
- Reservasi mencatat DP pada waktu penerimaan yang sebenarnya. Check-in hanya menambahkan selisih pembayaran di atas DP reservasi. Checkout mencatat pelunasan, mengubah kamar ke Cleaning, dan memperbarui total tamu.
- Pembayaran historis diisi satu kali saat migrasi dan diberi keterangan bahwa tanggal penerimaan aslinya tidak tersedia. Nilai DP historis memakai tanggal check-in, pelunasan memakai tanggal checkout, dan DP reservasi menunggu memakai waktu migrasi. Periksa jurnal migrasi terhadap pembukuan asli; sistem tidak dapat menemukan tanggal yang tidak pernah dicatat.

Gunakan formulir aplikasi untuk transaksi, reservasi dengan DP, dan pembayaran. Trigger rekonsiliasi tidak mengubah suntingan manual transaksi keuangan menjadi bukti penerimaan baru. Sheet Dashboard, Pembayaran, Log Aktivitas, dan Permintaan API merupakan hasil sistem; suntingan langsung dapat merusak jejak audit. Membatasi akses edit spreadsheet kepada pengelola tetap diperlukan; izin API tidak membatasi orang yang sudah diberi akses spreadsheet oleh Google.

## API versi 2

Publik: GET `getCapabilities` dan POST `login` dengan `{ "action": "login", "data": { "pin": "..." } }`.

Operasi setelah login: POST JSON dengan `action`, `data`, dan `token`. Setiap penulisan wajib menyertakan `requestId` unik. `getSnapshot` menyediakan data yang diizinkan untuk pengguna tersebut dalam satu respons; `getUser` hanya mengembalikan profil tanpa PIN/hash. Token hanya disimpan di memori browser; sesi berakhir setelah empat jam atau ketika cache server dibersihkan. Akun nonaktif atau PIN berubah langsung membatalkan sesi.

Semua perubahan memakai `LockService.getScriptLock()` dan memeriksa ulang izin, tarif, DP, invoice, serta jadwal di server. `Permintaan API` mencegah pengulangan request ID yang sama menjadi transaksi kedua. Lock berlaku pada satu proyek Apps Script; jalankan penulisan operasional melalui satu proyek ini. Proyek lain yang menulis langsung ke spreadsheet tidak ikut terkunci.

Google Sheets tidak menyediakan transaksi lintas sheet yang setara database SQL. Implementasi menyimpan snapshot rentang yang akan berubah, berusaha memulihkannya jika penulisan gagal, dan menandai request yang hasilnya belum pasti. Penghentian proses secara paksa atau kegagalan saat mencatat hasil masih memerlukan pemeriksaan admin. Status `DIPROSES` atau `GAGAL` tidak diputar ulang otomatis.

Jika properti `RECOVERY_REQUIRED` muncul, penyimpanan dan rekonsiliasi otomatis diblokir. Periksa tab, cadangan, dan Permintaan API; pulihkan data yang perlu, jalankan setup untuk memvalidasi, lalu hapus properti itu melalui Project Settings setelah hasilnya benar. Jangan menghapusnya hanya untuk melewati pemeriksaan.

Pembatasan login berlaku global karena web app Apps Script tidak memberikan alamat IP klien pada parameter request: 15 kegagalan dalam lima menit. Login yang benar tidak menghapus hitungan kegagalan.

## Verifikasi

```sh
node --test tests/backend_check.cjs
python tests/secure_browser_check.py
```

Pengujian menjalankan **kode `Code.gs` yang sama**, dengan layanan Spreadsheet/Cache/Lock/Properties/Trigger simulasi. Pengujian browser menghubungkan frontend ke backend itu untuk memeriksa alur penuh. Pemeriksaan tersebut tidak menulis transaksi contoh ke spreadsheet operasional dan tidak menggantikan verifikasi setelah deployment Google.

Referensi Google: [LockService](https://developers.google.com/apps-script/reference/lock/lock-service), [Range.setValues](https://developers.google.com/apps-script/reference/spreadsheet/range#setvaluesvalues), dan [memperbarui deployment](https://developers.google.com/apps-script/api/reference/rest/v1/projects.deployments/update).
