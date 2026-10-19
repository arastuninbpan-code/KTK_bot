// Локальный стенд: приложение (docs/) + API на тестовых данных в памяти, без Google и Telegram. Запуск: node dev/server.mjs
import "../lib/platform-node.mjs";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {extname, join, normalize} from "node:path";
import {fileURLToPath} from "node:url";
import {handleApi} from "../lib/api.mjs";
import {makeToken} from "../lib/auth.mjs";
import {addDays, todayIso} from "../lib/core.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";
import {Store, TABS} from "../lib/store.mjs";

const SITE = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "docs");
const SECRET = "dev-secret";
const HEAD = ["Дата", "Начало", "Конец", "Событие", "Площадка", "Администратор/\nКапельдинер", "Гардероб/\nУборщица", "Касса", "Монтировка", "Актеры, свет,\nзвук"];
const d = (n) => { const iso = addDays(todayIso(Date.now()), n); return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`; };

export function makeStand() {
  const book = new MemoryBook({
    [TABS.staff]: [["ФИО", "Телефон", "Роль", "Логин", "Актёры", "Техника", "Зал"],
      ["Иванова Мария Викторовна", "9000000001", "Админ", "ADMIN1", "TRUE", "", ""], ["Петрова Л.Н.", "9000000002", "Читатель", "READER", "TRUE", "", "TRUE"], ["Сидорова Л.Р.", "9000000003", "Читатель", "SIDOR1", "", "", "TRUE"],
      ["Морозова Н.М.", "9000000004", "Редактор", "EDITOR", "", "", "TRUE"], ["Орлова А.В.", "9000000005", "Читатель", "ORLOV1", "", "TRUE", ""], ["Кузнецова Е.Н.", "9000000006", "Читатель", "KUZN01", "", "TRUE", ""]],
    [TABS.venues]: [["Площадка", "Заметка"], ["Большая сцена", ""], ["Малая сцена", ""], ["Фойе", ""]],
    [TABS.schedule]: [HEAD,
      [d(0), "", "", "Репетиция «Игра в солдатики»", "Большая сцена", "Иванова М.В./ Петрова Л.Н.", "Сидорова Л.Р.", "", "", ""],
      [d(1), "11:00", "12:30", "Спектакль «Бука»", "Малая сцена", "Петрова Л.Н.", "Морозова Н.М.", "Орлова А.В.", "", ""],
      [d(1), "13:00", "14:30", "Спектакль «Бука»", "Малая сцена", "Петрова Л.Н.", "", "", "", ""],
      [d(3), "15:00", "16:00", "Экскурсия по театру", "Фойе", "Кузнецова Е.Н.", "", "", "", ""],
      [d(6), "11:00", "13:00", "Спектакль «Мери Поппинс»", "Большая сцена", "Иванова М.В./ Сидорова Л.Р.", "Морозова Н.М.", "Орлова А.В.", "Кузнецова Е.Н.", ""],
      [`${d(8)} до ${d(12)}`, "", "", "Фестиваль в Барнауле", "", "", "", "", "", ""]],
  });
  const store = new Store(book, {secret: SECRET});
  const changes = [];
  let rev = 1;
  const call = (req) => handleApi(req, {store, secret: SECRET, getRev: () => String(rev), bumpRev: () => { rev++; }, afterChange: () => { changes.push(Date.now()); }});
  return {book, store, call, changes, token: (phone) => makeToken({sub: phone, l: store.loginMark(store.users().find((u) => u.phone === phone).login)}, SECRET)};
}

const TYPES = {".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".webmanifest": "application/manifest+json"};

export function serve(port = 8788) {
  const stand = makeStand();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/dev/token") { res.end(stand.token(url.searchParams.get("phone"))); return; }
    if (url.pathname === "/config.js") { res.setHeader("Content-Type", "text/javascript"); res.end('window.KTK = {API_URL: "", BOT_URL: "https://t.me/k_t_k_bot"};'); return; }
    if (url.pathname.startsWith("/api/")) {
      let body = {};
      if (req.method !== "GET") { const chunks = []; for await (const c of req) chunks.push(c); try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch {} }
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      const r = stand.call({method: req.method, path: url.pathname, body: {...Object.fromEntries(url.searchParams), ...body}, token});
      res.writeHead(r.status, {"Content-Type": "application/json"}); res.end(JSON.stringify(r.body)); return;
    }
    const file = normalize(url.pathname === "/" ? "/index.html" : url.pathname).replace(/^(\.\.[/\\])+/, "");
    try {
      const data = await readFile(join(SITE, file));
      res.writeHead(200, {"Content-Type": TYPES[extname(file)] || "application/octet-stream"}); res.end(data);
    } catch { res.writeHead(404); res.end("нет"); }
  });
  return new Promise((ok) => server.listen(port, () => ok({server, stand, port})));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) serve(Number(process.env.PORT) || 8788).then(({port}) => console.log(`Стенд: http://localhost:${port}`));
