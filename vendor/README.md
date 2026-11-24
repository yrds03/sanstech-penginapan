# Dependensi lokal

Pustaka berikut disertakan agar halaman tidak memerlukan CDN saat berjalan:

| Dependensi | Versi | Sumber | Lisensi |
| --- | --- | --- | --- |
| Tailwind CSS | 3.4.17 | Dibangun dari `styles.css`, `tailwind.config.cjs`, HTML, dan JS | `LICENSE-tailwind` |
| SweetAlert2 | 11.26.3 | jsDelivr / npm `sweetalert2` | `LICENSE-sweetalert2` |
| SheetJS CE | 0.20.3 | jsDelivr / npm `@e965/xlsx`, distribusi ulang SheetJS CE | `LICENSE-sheetjs` |
| Font Awesome Free | 6.4.0 | cdnjs; CSS dan font WOFF2 | `LICENSE-fontawesome` |

`fontawesome.min.css` hanya mengubah jalur relatif `../webfonts/` menjadi `./webfonts/`. SheetJS disalin dari distribusi ulang versi 0.20.3 karena CDN SheetJS mengembalikan HTTP 403 pada lingkungan pengembangan. Tinjau sumber dan versi saat memperbarui berkas vendor.
