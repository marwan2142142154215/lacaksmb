# SMB Lacak — Fleet Tracking

Aplikasi pelacak armada (SMB): dashboard web, broker WebSocket, dan APK Android
tracker/master yang dipasang di HP armada.

## Teknologi
- Node.js 24 (LTS)
- Express-kin https custom broker (`server/index.mjs`)
- React 19
- Tailwind CSS 4
- Vite 8
- SQLite (better via `node:sqlite`)
- Capacitor Android 8
- Cloudflare Tunnel & Worker static hosting

## Library utama
- react / react-dom   : UI tracker & dashboard
- tailwindcss         : styling
- zustand / dsb       : state (mengikuti pembakuan perlahan)
- ws                  : WebSocket broker
- qrcode              : QR admin enrolment
- capacitor           : APK Android

## Cara menjalankan di local
1. `npm install`
2. salin `.env.example` menjadi `.env.local`, lalu isi pengaturannya
3. `npm run dev` (nilai default vite dev pada port 51355)
4. `npm run server:pilot` (menjalankan broker lokal) bila diperlukan
5. Untuk APK: `npm run android:build:tracker`

## Penanggung jawab
- Tim            : Pengembang SMB Lacak
- Developer      : Marwan
- Divisi pengguna: Operasional / IT

## Tautan terkait
- Dokumen analisa : binis-flow/catalog (pending)
- Alamat staging  : broker.lacaksmbbot.com (penugasan fasilitator)
- Alamat production: broker.lacaksmbbot.com

## Standar mutu proyek
Standar Pengembangan Sistem perusahaan diberlakukan pada repo ini:
- `.editorconfig`  : indentasi 4 spasi
- `.prettierrc.json` & `.vscode` : format otomatis
- Hanya `main` yang boleh di-deploy; perubahan masuk lewat branch `feature/...` atau `fix/...`
