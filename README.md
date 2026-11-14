# NeonLink

Мессенджер: общая лента + личные сообщения + админ-панель (`/admin`, только пользователь `CEBA`).
Стек: Node.js/Express + Socket.io, PostgreSQL (Neon), чистый HTML/CSS/JS в `html/`.

```
neonlink/
├── server.js            # API + WebSocket + раздача html/
├── schema.sql           # SQL-схема (выполняется сервером при старте)
├── package.json  render.yaml  .env.example  .gitignore
├── html/                # весь фронтенд (index.html, admin.html, css/, js/)
│   └── js/config.js     # NEONLINK_API — адрес сервера для .msi/.apk
└── clients/
    ├── desktop/         # Tauri v2 -> .msi
    └── android/         # Capacitor -> .apk
```

## Что требует локальной установки
| Задача | Нужно |
|---|---|
| Локальный запуск сервера | Node.js 18+ |
| .msi | Windows 10/11, Node.js, Rust (rustup), Visual Studio Build Tools (C++), WebView2 (есть в Win 11), WiX подтянется Tauri сам |
| .apk | Node.js, JDK 17, Android Studio (Android SDK) |

## 1. Neon (БД)
1. neon.tech → создайте проект → скопируйте Connection string.
2. Таблицы создавать вручную не нужно: сервер выполнит `schema.sql` при старте (можно и вручную в SQL Editor).

## 2. reCAPTCHA v3
https://www.google.com/recaptcha/admin → v3. Добавьте домены: ваш `*.onrender.com`, а также `localhost`
(нужны для APK и Tauri). Получите Site key и Secret key. Без ключей капча отключена — только для разработки.

## 3. Локальный запуск
```bash
cp .env.example .env     # заполните DATABASE_URL, JWT_SECRET, OWNER_PASSWORD
npm install
npm start                # http://localhost:3000
```
Аккаунт `CEBA` создаётся при старте, если задан `OWNER_PASSWORD`. Имя `CEBA` зарезервировано —
зарегистрироваться под ним через форму нельзя (никто не перехватит админку).

## 4. Деплой на Render
1. Загрузите проект в GitHub (`.env` в `.gitignore`).
2. Render → New → Blueprint → выберите репозиторий (подхватит `render.yaml`) — или New → Web Service:
   Build `npm install`, Start `npm start`.
3. В Environment задайте: `DATABASE_URL`, `JWT_SECRET` (generateValue), `RECAPTCHA_SECRET`,
   `RECAPTCHA_SITE_KEY`, `OWNER_PASSWORD`, `OWNER_USERNAME=CEBA`, `CORS_ORIGINS` (см. render.yaml).
4. После деплоя: `https://<имя>.onrender.com` — мессенджер, `/admin` — админка.
Free-план засыпает после простоя — первый запрос идёт ~30–60 с.

## 5. Windows .msi (Tauri v2)
1. В `html/js/config.js` укажите `window.NEONLINK_API = 'https://<имя>.onrender.com';`
2. Установите Rust (https://rustup.rs) и Visual Studio Build Tools (Desktop development with C++).
3. Подготовьте иконку (PNG ≥ 512×512, например `icon.png`):
```powershell
cd clients\desktop
npm install
npx tauri icon icon.png          # создаст src-tauri\icons\*
npm run build                    # = tauri build --bundles msi
```
4. Результат: `clients\desktop\src-tauri\target\release\bundle\msi\NeonLink_1.0.0_x64_ru-RU.msi`
Первая сборка Rust занимает 5–15 минут. Конфиг: `src-tauri/tauri.conf.json` (WiX-язык, окно, WebView2).

## 6. Android .apk (Capacitor)
1. В `html/js/config.js` укажите адрес Render (как выше).
2. Сборка:
```bash
cd clients/android
npm install
npx cap add android
npx cap sync
npx cap open android      # Android Studio: Build > Build APK(s)
# или из консоли:
cd android && ./gradlew assembleDebug
```
3. APK: `clients/android/android/app/build/outputs/apk/debug/app-debug.apk`.
Для публикации — подписанный release: Build > Generate Signed Bundle/APK.
`webDir` указывает на `../../html`; после правок фронтенда выполните `npx cap sync`.

## Безопасность
- `DATABASE_URL`, `JWT_SECRET`, ключи капчи — только в переменных окружения.
- Пароли — bcrypt (пакет `bcryptjs`, формат совместим с bcrypt, не требует компиляции на Render).
- Все `/api/admin/*` защищены middleware `adminOnly` (username === 'CEBA'); страница `/admin` лишь UI.
- Rate limit на вход/регистрацию/отправку, серверная проверка reCAPTCHA, экранирование через textContent.
- «Экстренный режим» блокирует регистрацию и отправку для всех, кроме админов.
- Аудит-лог записывает вход, регистрацию, отправку/правку/удаление, действия админа (просмотр чужих DM тоже логируется).
