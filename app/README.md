# Сайт, вход по коду и бот (GitHub Pages + Apps Script)

Бесплатно и без своего сервера. Данные лежат в Google Таблице.

- **Сайт** — папка `docs/`, публикуется на GitHub Pages.
- **Бот и API** — `apps_script_bot/Code.gs` (генерируется: `node app/build-gas.mjs`), работает в Google Apps Script.
- **Relay** — `relay/worker.js` на Cloudflare Workers (Telegram требует ответ 200, Apps Script отвечает 302).

## Запуск
1. Apps Script: вставьте новый `Code.gs` (raw-ссылка на GitHub), Свойства скрипта: `SHEET_ID`, `TELEGRAM_BOT_TOKEN`, `RELAY_URL`, `APP_URL` (адрес сайта).
2. Запустите `setup`, затем **Развернуть → Управление → Новая версия**, потом `setWebhook`, `styleSheets`.
3. GitHub → Settings → Pages → ветка `main`, папка `/docs`. Сайт: `https://<аккаунт>.github.io/KTK_bot/`.
4. В листе «Сотрудники» в колонке «Роль»: Админ / Редактор / Читатель / Заблокирован.
5. Бот: `/login` → код → вход на сайте. Демо без сервера: `?demo` (коды 000000 админ, 111111 читатель).

## Разработка
```
cd app && npm test
node dev/server.mjs   # стенд: http://localhost:8788
node build-gas.mjs    # пересобрать Code.gs
```
