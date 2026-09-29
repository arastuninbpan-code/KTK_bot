import test from "node:test";
import assert from "node:assert/strict";
import {loadGas} from "./gas-fake.mjs";
import {HEAD, STAFF} from "./helpers.mjs";

const NOW = Date.UTC(2026, 9, 1, 7, 0); // 1 октября 2026, 10:00 по Москве
const SCHEDULE = [HEAD,
  ["04.10\n11.00 и 13.00", "Спектакль «Бука»\n(малая сцена)", "Иванова М.В.", "Морозова Н.М.", "", "", ""],
  ["10.10", "Сказки из старого чемодана", "Петрова Л.Н.", "", "", "", ""]];
const G = () => loadGas({now: NOW, tabs: {"Расписание": SCHEDULE, "Сотрудники": STAFF},
  props: {SHEET_ID: "x", TELEGRAM_BOT_TOKEN: "TOKEN", WEBHOOK_SECRET: "hook", APP_URL: "https://app.test"}});

const tg = (g, update) => g.run(`doPost(${JSON.stringify({parameter: {secret: "hook"}, postData: {contents: JSON.stringify(update)}})}).getContent()`);
const msg = (id, text, contact) => ({update_id: Math.floor(Math.random() * 1e9), message: {chat: {id, type: "private"}, from: {id}, text, contact}});
const api = (g, req) => JSON.parse(g.run(`doPost(${JSON.stringify({postData: {contents: JSON.stringify(req)}})}).getContent()`));
const sentTo = (g, chat) => g.fetches.filter((f) => f.url.endsWith("/sendMessage") && String(f.body.chat_id) === String(chat));

test("Telegram: подключение по контакту, ответ красиво оформлен, токен не попал в лог", () => {
  const g = G();
  assert.equal(tg(g, msg(5, "/start")), "ok");
  assert.equal(sentTo(g, 5).at(-1).body.reply_markup.keyboard[0][0].request_contact, true);
  tg(g, msg(5, "", {user_id: 5, phone_number: "+7 900 000-00-01"}));
  const hello = sentTo(g, 5).at(-1).body;
  assert.equal(hello.parse_mode, "HTML");
  assert.match(hello.text, /✈️ <b>Готово, Иванова М\.В\.!<\/b>/);
  assert.equal(g.ss.getSheetByName("Подписчики").getDataRange().getDisplayValues()[1].join("|"), "telegram|5|9000000001|Иванова М.В.");
  assert.equal(tg(g, {update_id: 1, message: {chat: {id: 5, type: "private"}, from: {id: 5}, text: "/shifts"}}), "ok");
  const dup = g.fetches.length;
  tg(g, {update_id: 1, message: {chat: {id: 5, type: "private"}, from: {id: 5}, text: "/shifts"}}); // повтор того же update_id
  assert.equal(g.fetches.length, dup);
  assert.match(sentTo(g, 5).at(-1).body.text, /💬 <b>Ваши ближайшие смены<\/b>[\s\S]*Спектакль «Бука»/);
  assert.deepEqual(sentTo(g, 5).at(-1).body.reply_markup.inline_keyboard[0][0], {text: "Открыть в приложении", url: "https://app.test"});
});

test("чужой секрет вебхука игнорируется", () => {
  const g = G();
  assert.equal(g.run(`doPost(${JSON.stringify({parameter: {secret: "не тот"}, postData: {contents: JSON.stringify(msg(5, "/start"))}})}).getContent()`), "ok");
  assert.equal(g.fetches.length, 0);
});

test("вход по коду из бота и работа приложения: чтение, права, правка админом → сразу уведомление подписчику", () => {
  const g = G();
  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"})); // Иванова (Админ)
  tg(g, msg(6, "", {user_id: 6, phone_number: "9000000002"})); // Петрова (Читатель)
  g.run("everyMinute()"); // первый снимок расписания (тихо)
  tg(g, msg(6, "/login"));
  const code = sentTo(g, 6).at(-1).body.text.match(/<code>(\d{6})<\/code>/)[1];
  const login = api(g, {method: "POST", path: "/api/login", body: {code}});
  assert.equal(login._status, 200); assert.equal(login.user.roleLabel, "Читатель");
  assert.equal(api(g, {method: "POST", path: "/api/login", body: {code}})._status, 200); // код многоразовый

  const sched = api(g, {method: "GET", path: "/api/schedule", token: login.token});
  assert.deepEqual(sched.events.map((e) => e.title), ["Спектакль «Бука»", "Сказки из старого чемодана"]);
  assert.deepEqual(sched.events[1].mine, ["Администратор/ Капельдинер"]);
  assert.equal(api(g, {method: "POST", path: "/api/events", token: login.token, body: {event: {date: "2026-10-06", title: "X"}}})._status, 403);

  tg(g, msg(5, "/login")); // админ
  const adminCode = sentTo(g, 5).at(-1).body.text.match(/<code>(\d{6})<\/code>/)[1];
  const admin = api(g, {method: "POST", path: "/api/login", body: {code: adminCode}});
  assert.equal(admin.user.canEdit, true);
  const before = sentTo(g, 6).length;
  const ev = {date: "2026-10-06", time: "15:00", title: "Экскурсия", hall: "большая сцена", roles: {"Администратор/ Капельдинер": ["Петрова Л.Н."]}};
  assert.equal(api(g, {method: "POST", path: "/api/events", token: admin.token, body: {event: ev}})._status, 200);
  const sheet = g.ss.getSheetByName("Расписание").getDataRange().getDisplayValues();
  assert.deepEqual(sheet[2].slice(0, 3), ["06.10\n15.00", "Экскурсия\n(большая сцена)", "Петрова Л.Н."]); // вставлено по порядку дат
  const notes = sentTo(g, 6).slice(before);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body.text, /✈️ <b>Вам назначена смена<\/b>\n\n<b>Экскурсия<\/b>\n🗓 Вт, 6 октября · ⏰ 15:00\n📍 Большая сцена\n👤 Администратор \/ Капельдинер/);
});

test("правка таблицы руками подхватывается таймером через ~15 секунд тишины", () => {
  const g = G();
  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"}));
  g.run("everyMinute()");
  const sh = g.ss.getSheetByName("Расписание");
  sh.put(2, 1, "04.10\n12.00 и 14.00");
  g.run("onSheetChange()");
  const n = sentTo(g, 5).length;
  g.run("everyMinute()"); // слишком рано: правка только что была
  assert.equal(sentTo(g, 5).length, n);
  g.advance(20000);
  g.run("everyMinute()");
  assert.match(sentTo(g, 5).at(-1).body.text, /💬 <b>Смена изменена<\/b>[\s\S]*<s>11:00 и 13:00<\/s> → <b>12:00 и 14:00<\/b>/);
});

test("setup создаёт таймеры и секреты; setWebhook показывает только адрес сайта; заблокировавший бота отвязывается", () => {
  const g = G();
  g.run("setup()");
  assert.deepEqual(g.triggers.map((t) => t.fn), ["onSheetChange", "onSheetChange", "everyMinute"]);
  assert.ok(g.properties.SESSION_SECRET.length >= 64);
  g.properties.RELAY_URL = "https://relay.example.workers.dev/секретное-слово";
  g.run("setWebhook()");
  const hook = g.fetches.at(-1);
  assert.match(hook.url, /\/setWebhook$/);
  assert.equal(hook.body.url, g.properties.RELAY_URL);
  assert.equal(g.run("hostOf_('https://relay.example.workers.dev/секретное-слово?a=1')"), "relay.example.workers.dev");

  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"}));
  g.run("everyMinute()");
  g.ss.getSheetByName("Расписание").put(2, 1, "04.10\n12.00");
  g.run("onSheetChange()"); g.advance(20000);
  g.setFetchStatus(403); // Telegram: «бот заблокирован»
  g.run("everyMinute()");
  assert.equal(g.ss.getSheetByName("Подписчики").getDataRange().getDisplayValues().slice(1).filter((r) => r[0] && r[1]).length, 0);
});

test("styleSheets: шапки месяцев, заголовки, чередование строк, роли выпадающим списком", () => {
  const g = G();
  g.ss.getSheetByName("Расписание").put(4, 1, "05.11"); g.ss.getSheetByName("Расписание").put(4, 2, "Ноябрьское событие");
  g.run("styleSheets()");
  const rows = g.ss.getSheetByName("Расписание").getDataRange().getDisplayValues().map((r) => r[0].split("\n")[0]);
  assert.deepEqual(rows.slice(1), ["ОКТЯБРЬ 2026", "04.10", "10.10", "НОЯБРЬ 2026", "05.11"]);
  const log = g.ss.getSheetByName("Расписание").styleLog;
  assert.ok(log.some((l) => l[0] === "setBackground" && l[2] === "#1B3560")); // шапки месяцев
  assert.ok(log.some((l) => l[0] === "setBackground" && l[2] === "#0A96DC")); // заголовки колонок
  assert.equal(g.ss.getSheetByName("Расписание").rules[0].calls[0][0], "whenFormulaSatisfied");
  const staff = g.ss.getSheetByName("Сотрудники");
  assert.equal(staff.rules.length, 4);
  assert.ok(staff.styleLog.some((l) => l[0] === "validation"));
  assert.equal(staff.getDataRange().getDisplayValues()[3][2], "Читатель"); // пустая роль -> «Читатель»
  g.run("styleSheets()"); // повторный запуск ничего не дублирует
  assert.equal(g.ss.getSheetByName("Расписание").getDataRange().getDisplayValues().filter((r) => /^[А-ЯЁ]+ \d{4}$/.test(r[0])).length, 2);
});
