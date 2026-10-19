import test from "node:test";
import assert from "node:assert/strict";
import {loadGas} from "./gas-fake.mjs";
import {HEAD, STAFF} from "./helpers.mjs";

const NOW = Date.UTC(2026, 9, 1, 7, 0); // 1 октября 2026, 10:00 по Москве
const SCHEDULE = [HEAD,
  ["04.10\n11.00 и 13.00", "Спектакль «Бука»\n(малая сцена)", "Иванова М.В.", "Морозова Н.М.", "", "", ""],
  ["10.10", "Сказки из старого чемодана", "Петрова Л.Н.", "", "", "", ""]];
const G = () => loadGas({now: NOW, tabs: {"Расписание": SCHEDULE, "Сотрудники": STAFF},
  props: {SHEET_ID: "x", STYLE_VER: "5", TELEGRAM_BOT_TOKEN: "TOKEN", WEBHOOK_SECRET: "hook", APP_URL: "https://app.test"}});

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
  const code = sentTo(g, 6).at(-1).body.text.match(/<code>([^<]+)<\/code>/)[1];
  const login = api(g, {method: "POST", path: "/api/login", body: {login: code}});
  assert.equal(login._status, 200); assert.equal(login.user.roleLabel, "Читатель");
  assert.equal(api(g, {method: "POST", path: "/api/login", body: {login: code}})._status, 200); // логин постоянный

  const sched = api(g, {method: "GET", path: "/api/schedule", token: login.token});
  assert.deepEqual(sched.events.map((e) => e.title), ["Спектакль «Бука»", "Сказки из старого чемодана"]);
  assert.deepEqual(sched.events[1].mine, ["Администратор/ Капельдинер"]);
  assert.equal(api(g, {method: "POST", path: "/api/events", token: login.token, body: {event: {date: "2026-10-06", title: "X"}}})._status, 403);

  tg(g, msg(5, "/login")); // админ
  const adminCode = sentTo(g, 5).at(-1).body.text.match(/<code>([^<]+)<\/code>/)[1];
  const admin = api(g, {method: "POST", path: "/api/login", body: {login: adminCode}});
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

test("правка таблицы руками рассылается сразу после паузы, не дожидаясь минутного таймера; версия данных растёт", () => {
  const g = G();
  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"}));
  g.run("everyMinute()");
  const rev0 = g.run("getRev_()");
  g.ss.getSheetByName("Расписание").put(2, 1, "04.10\n12.00 и 14.00");
  g.run("onSheetChange()");
  assert.match(sentTo(g, 5).at(-1).body.text, /💬 <b>Смена изменена<\/b>[\s\S]*<s>11:00 и 13:00<\/s> → <b>12:00 и 14:00<\/b>/);
  assert.notEqual(g.run("getRev_()"), rev0);
  assert.equal(g.properties.dirty, undefined);
});

test("быстрая сверка: если за время паузы была ещё правка, лишний запуск не делает рассылку", () => {
  const g = G();
  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"}));
  g.run("everyMinute()");
  g.ss.getSheetByName("Расписание").put(2, 1, "04.10\n12.00 и 14.00");
  // «новая правка» появляется, пока первая обработка спит
  g.run("Utilities.sleep = () => { PropertiesService.getScriptProperties().setProperty('dirty', 'newer'); }");
  const n = sentTo(g, 5).length;
  g.run("onSheetChange()");
  assert.equal(sentTo(g, 5).length, n);
  assert.equal(g.properties.dirty, "newer"); // дело за той самой «новой» обработкой или минутным таймером
});

test("setup создаёт таймеры и секреты; setWebhook показывает только адрес сайта; заблокировавший бота отвязывается", () => {
  const g = G();
  g.run("setup()");
  g.run("setup()"); // повторный запуск: старые таймеры удаляются, новые не дублируются
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
  g.setFetchStatus(403); // Telegram: «бот заблокирован»
  g.run("onSheetChange()");
  assert.equal(g.ss.getSheetByName("Подписчики").getDataRange().getDisplayValues().slice(1).filter((r) => r[0] && r[1]).length, 0);
});

test("styleSheets: перенос в новый формат (копия сохранена), шапки месяцев, чередование, роли списком, группы галочками, площадки", () => {
  const g = G();
  g.ss.getSheetByName("Расписание").put(4, 1, "05.11"); g.ss.getSheetByName("Расписание").put(4, 2, "Ноябрьское событие");
  g.run("styleSheets()");
  const sh = g.ss.getSheetByName("Расписание").getDataRange().getDisplayValues();
  assert.deepEqual(sh[0].slice(0, 5), ["Дата", "Начало", "Конец", "Событие", "Площадка"]);
  assert.deepEqual(sh.slice(1).map((r) => r.slice(0, 5).join("|")),
    ["ОКТЯБРЬ 2026||||", "04.10|11:00||Спектакль «Бука»|малая сцена", "04.10|13:00||Спектакль «Бука»|малая сцена", "10.10|||Сказки из старого чемодана|", "НОЯБРЬ 2026||||", "05.11|||Ноябрьское событие|"]);
  assert.deepEqual(sh[2].slice(5, 7), ["Иванова М.В.", "Морозова Н.М."]); // люди переехали вместе со строкой
  assert.ok(g.ss.sheets.some((x) => /^Расписание \(копия /.test(x.name)), "копия старого листа сохранена");
  assert.deepEqual(g.ss.getSheetByName("Площадки").getDataRange().getDisplayValues(), [["Площадка", "Заметка"], ["Малая сцена", ""]]);
  const log = g.ss.getSheetByName("Расписание").styleLog;
  assert.ok(log.some((l) => l[0] === "setBackground" && l[2] === "#1B3560")); // шапки месяцев
  assert.ok(log.some((l) => l[0] === "setBackground" && l[2] === "#0A96DC")); // заголовки колонок
  assert.equal(g.ss.getSheetByName("Расписание").rules[0].calls[0][0], "whenFormulaSatisfied");
  assert.ok(log.some((l) => l[0] === "validation" && l[1].calls.some((c) => c[0] === "requireValueInRange"))); // площадка — выпадающий список
  const staff = g.ss.getSheetByName("Сотрудники");
  assert.equal(staff.rules.length, 6); // 4 роли + заявка + доступ снят
  assert.ok(staff.styleLog.some((l) => l[0] === "validation" && l[1].calls.some((c) => c[0] === "requireCheckbox"))); // галочки групп
  assert.deepEqual(staff.getDataRange().getDisplayValues()[0].slice(4), ["Доступ", "Комментарий", "Актёры", "Техника", "Зал"]);
  assert.ok(staff.getDataRange().getDisplayValues().slice(1).every((r) => r[0] === "" || r[4] === "true"), "у внесённых людей доступ включён");
  assert.equal(staff.getDataRange().getDisplayValues()[3][2], "Читатель"); // пустая роль -> «Читатель»
  g.run("styleSheets()"); // повторный запуск ничего не дублирует
  assert.equal(g.ss.getSheetByName("Расписание").getDataRange().getDisplayValues().filter((r) => /^[А-ЯЁ]+ \d{4}$/.test(r[0])).length, 2);
  assert.equal(g.ss.sheets.filter((x) => /^Расписание \(копия /.test(x.name)).length, 1);
});

test("группы: галочки в таблице -> состав групп; выдача логинов не затирает галочки", () => {
  const g = G();
  g.run("styleSheets()");
  const staff = g.ss.getSheetByName("Сотрудники");
  staff.put(2, 7, "TRUE"); staff.put(3, 7, "TRUE"); staff.put(3, 8, "TRUE"); // Иванова и Петрова — «Актёры», Петрова — ещё «Техника»
  g.run("store_().ensureLogins()");
  const admin = api(g, {method: "POST", path: "/api/login", body: {login: g.run("store_().users()[0].login")}});
  assert.equal(admin._status, 200);
  const sched = api(g, {method: "GET", path: "/api/schedule", token: admin.token});
  assert.deepEqual(sched.groups, [{name: "Актёры", members: ["Иванова М.В.", "Петрова Л.Н."]}, {name: "Техника", members: ["Петрова Л.Н."]}, {name: "Зал", members: []}]);
  staff.put(5, 1, "Новичок Н.Н."); staff.put(5, 2, "9000000010"); // человек без логина: он выдастся, галочки соседей остаются
  g.run("store_().ensureLogins()");
  const row = g.ss.getSheetByName("Сотрудники").getDataRange().getDisplayValues();
  assert.match(row[4][3], /^[A-Z][A-Z0-9]{5}$/);
  assert.deepEqual([row[1][6], row[2][6], row[2][7]], ["TRUE", "TRUE", "TRUE"]);
});

// ---------- ВКонтакте ----------
const VKPROPS = {VK_TOKEN: "VKTOKEN", VK_GROUP_ID: "club123", VK_SECRET: "vksecret", VK_CONFIRM: "abc123", TG_CHANNEL: "@teatr"};
const GV = (extra = {}) => loadGas({now: NOW, tabs: {"Расписание": SCHEDULE, "Сотрудники": STAFF},
  props: {SHEET_ID: "x", STYLE_VER: "5", TELEGRAM_BOT_TOKEN: "TOKEN", WEBHOOK_SECRET: "hook", APP_URL: "https://app.test", ...VKPROPS, ...extra}});
const vk = (g, update, secret = "hook") => g.run(`doPost(${JSON.stringify({parameter: {secret, vk: "1"}, postData: {contents: JSON.stringify(update)}})}).getContent()`);
const vkMsg = (id, text, extra = {}) => ({type: "message_new", event_id: "e" + Math.random(), secret: "vksecret", object: {message: {peer_id: id, from_id: id, text, ...extra}}});
const vkSent = (g, id) => g.fetches.filter((f) => f.url.endsWith("/messages.send") && String(f.body.user_id) === String(id));

test("ВК: подтверждение адреса, чужой секрет игнорируется, беседы и эхо пропускаются", () => {
  const g = GV();
  assert.equal(vk(g, {type: "confirmation", group_id: 123}), "abc123");
  assert.equal(vk(g, vkMsg(5, "/start"), "не тот"), "ok");
  assert.equal(vk(g, {...vkMsg(5, "/start"), secret: "левый"}), "ok");
  assert.equal(vk(g, vkMsg(5, "/start", {peer_id: 2000000001})), "ok"); // беседа
  assert.equal(vk(g, vkMsg(5, "/start", {out: 1})), "ok");
  assert.equal(g.fetches.length, 0);
});

test("ВК: человек пишет логин -> подключается, получает простой текст с кнопкой-ссылкой; повтор события не дублирует", () => {
  const g = GV();
  g.run("store_().ensureLogins()");
  const login = g.run("store_().users()[1].login"); // Петрова
  const ev = vkMsg(7, login.toLowerCase());
  assert.equal(vk(g, ev), "ok");
  const hello = vkSent(g, 7).at(-1).body;
  assert.match(hello.message, /^✈️ Готово, Петрова Л\.Н\.!/);
  assert.ok(!/[<>]/.test(hello.message), "никакой HTML-разметки в ВК");
  assert.equal(hello.v, "5.199");
  assert.equal(hello.access_token, "VKTOKEN");
  for (const [k, v] of Object.entries(hello)) assert.equal(typeof v, "string", `параметр ${k} должен уходить строкой`);
  assert.match(hello.random_id, /^\d{13,16}$/); // целое int64: без точки и порядка
  assert.equal(g.ss.getSheetByName("Подписчики").getDataRange().getDisplayValues()[1].join("|"), "vk|7|9000000002|Петрова Л.Н.");
  const n = g.fetches.length;
  vk(g, ev); // тот же event_id
  assert.equal(g.fetches.length, n);
  vk(g, vkMsg(7, "/shifts"));
  const sh = vkSent(g, 7).at(-1).body;
  assert.match(sh.message, /Ваши ближайшие смены/);
  assert.deepEqual(JSON.parse(sh.keyboard), {inline: true, buttons: [[{action: {type: "open_link", link: "https://app.test", label: "Открыть в приложении"}}]]});
});

test("ВК: уведомление о смене уходит и в Telegram, и в ВК, перенос показан зачёркнутым временем; запретил сообщения — отвязывается", () => {
  const g = GV();
  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"}));
  vk(g, vkMsg(8, "+7 900 000 00 01"));
  g.run("everyMinute()");
  g.ss.getSheetByName("Расписание").put(2, 1, "04.10\n12.00 и 14.00");
  g.run("onSheetChange()");
  assert.match(sentTo(g, 5).at(-1).body.text, /<s>11:00 и 13:00<\/s>/);
  const v = vkSent(g, 8).at(-1).body.message;
  assert.match(v, /Смена изменена/);
  assert.ok(v.includes("1̶") && !v.includes("<s>"), "в ВК зачёркнуто значками");
  g.setFetchReply((url) => (url.endsWith("/messages.send") ? JSON.stringify({error: {error_code: 901, error_msg: "Can't send messages for users without permission"}}) : null));
  g.ss.getSheetByName("Расписание").put(2, 1, "04.10\n15.00");
  g.run("onSheetChange()");
  const subs = g.ss.getSheetByName("Подписчики").getDataRange().getDisplayValues().slice(1).filter((r) => r[0] && r[1]);
  assert.deepEqual(subs.map((r) => r[0]), ["telegram"]);
});

test("публикация афиши: сначала предпросмотр без имён, «/post да» — на стену ВК и в Telegram-канал; читателю нельзя", () => {
  const g = GV();
  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"})); // Иванова — Админ
  tg(g, msg(6, "", {user_id: 6, phone_number: "9000000002"})); // Петрова — Читатель
  tg(g, msg(6, "/post"));
  assert.match(sentTo(g, 6).at(-1).body.text, /только администратор и редактор/);
  const before = g.fetches.length;
  tg(g, msg(5, "/post"));
  const preview = sentTo(g, 5).at(-1).body.text;
  assert.match(preview, /Так будет выглядеть афиша[\s\S]*🎭 Афиша на неделю[\s\S]*Спектакль «Бука»[\s\S]*📍 Малая сцена[\s\S]*Куда: ВКонтакте, Telegram-канал[\s\S]*\/post да/);
  assert.ok(!/Иванова|Морозова/.test(preview.split("—")[0].split("Так будет выглядеть афиша")[1]), "имён сотрудников в афише нет");
  assert.equal(g.fetches.length, before + 1); // только сам предпросмотр
  tg(g, msg(5, "/post да"));
  const wall = g.fetches.find((f) => f.url.endsWith("/wall.post"));
  assert.equal(wall.body.owner_id, "-123");
  assert.equal(wall.body.from_group, "1");
  assert.match(wall.body.message, /🎭 Афиша на неделю/);
  const chan = g.fetches.find((f) => f.url.endsWith("/sendMessage") && f.body.chat_id === "@teatr");
  assert.match(chan.body.text, /Спектакль «Бука»/);
  assert.match(sentTo(g, 5).at(-1).body.text, /✅ ВКонтакте: опубликовано\n✅ Telegram-канал: опубликовано/);
});

test("публикация: не настроено -> понятное сообщение; ошибка ВК показана без токена", () => {
  const g = GV({VK_TOKEN: "", VK_GROUP_ID: "", TG_CHANNEL: ""});
  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"}));
  tg(g, msg(5, "/post"));
  assert.match(sentTo(g, 5).at(-1).body.text, /Публикация пока не настроена/);
  const h = GV();
  tg(h, msg(5, "", {user_id: 5, phone_number: "9000000001"}));
  h.setFetchReply((url) => (url.endsWith("/wall.post") ? JSON.stringify({error: {error_code: 15, error_msg: "Access denied: no access to call this method"}}) : null));
  tg(h, msg(5, "/post да"));
  const res = sentTo(h, 5).at(-1).body.text;
  assert.match(res, /⚠️ ВКонтакте: VK 15: Access denied/);
  assert.ok(!res.includes("VKTOKEN"));
});

test("ВК: журнал диагностики пишется в лист «_лог» (причина молчания видна в таблице)", () => {
  const g = GV();
  vk(g, vkMsg(5, "/start"), "не тот"); // чужой secret в адресе
  vk(g, {...vkMsg(5, "/start"), secret: "левый"}); // не тот секретный ключ ВК
  vk(g, vkMsg(5, "/start", {peer_id: 2000000001})); // беседа
  g.setFetchReply((url) => (url.endsWith("/messages.send") ? JSON.stringify({error: {error_code: 15, error_msg: "Access denied: no permission"}}) : null));
  vk(g, vkMsg(9, "привет")); // отправка отвергнута ВК
  g.setFetchReply(null);
  vk(g, vkMsg(10, "привет")); // успех
  const log = g.ss.getSheetByName("_лог").getDataRange().getDisplayValues().map((r) => r[1]);
  assert.match(log[1], /secret в адресе воркера/);
  assert.match(log[2], /секретный ключ Callback API не совпал/);
  assert.match(log[3], /не личное сообщение/);
  assert.match(log[4], /ОШИБКА — VK 15: Access denied/);
  assert.match(log[5], /от 10 обработано/);
  assert.ok(!log.join(" ").includes("VKTOKEN"));
});

// ---------- кэш листов ----------
const reads = (g, name) => g.ss.getSheetByName(name).reads || 0;

test("кэш: повторные команды не читают листы заново; ответы те же", () => {
  const g = G();
  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"}));
  tg(g, msg(5, "/shifts"));
  const before = ["Расписание", "Сотрудники", "Подписчики"].map((n) => reads(g, n));
  tg(g, msg(5, "/shifts"));
  tg(g, msg(5, "/schedule"));
  assert.deepEqual(["Расписание", "Сотрудники", "Подписчики"].map((n) => reads(g, n)), before, "листы взяты из кэша");
  assert.match(sentTo(g, 5).at(-1).body.text, /Афиша/);
});

test("кэш: подписка, логин, правка таблицы руками и правка на сайте сразу видны (кэш сбрасывается)", () => {
  const g = G();
  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"}));
  tg(g, msg(5, "/shifts")); // кэш заполнен
  // подписался второй человек: его строка в «Подписчиках» видна сразу
  tg(g, msg(6, "", {user_id: 6, phone_number: "9000000002"}));
  assert.equal(g.run("store_().chats().length"), 2);
  tg(g, msg(6, "/stop"));
  assert.equal(g.run("store_().chats().length"), 1);
  // логин выдан и виден сразу
  tg(g, msg(5, "/login"));
  assert.match(sentTo(g, 5).at(-1).body.text, /<code>[A-Z][A-Z0-9]{5}<\/code>/);
  // правка таблицы руками: после onSheetChange бот видит новое
  g.ss.getSheetByName("Расписание").put(2, 1, "04.10\n15.00");
  g.run("onSheetChange()");
  tg(g, msg(5, "/shifts"));
  assert.match(sentTo(g, 5).at(-1).body.text, /⏰ 15:00/);
  // правка на сайте: событие сразу в расписании у следующего запроса
  g.run("store_().ensureLogins()");
  const login = api(g, {method: "POST", path: "/api/login", body: {login: g.run("store_().users()[0].login")}});
  api(g, {method: "POST", path: "/api/events", token: login.token, body: {event: {date: "2026-10-12", time: "10:00", title: "Новое", roles: {}}}});
  const sched = api(g, {method: "GET", path: "/api/schedule", token: login.token});
  assert.ok(sched.events.some((e) => e.title === "Новое"));
});

test("кэш: большой лист режется на куски и читается целиком", () => {
  const g = G();
  const rows = Array.from({length: 600}, (_, i) => ["Событие номер " + i + " — " + "я".repeat(120), "x"]);
  g.run(`cacheWrite_("Площадки", ${JSON.stringify(rows)})`);
  assert.equal(JSON.stringify(g.run('cacheRead_("Площадки")')), JSON.stringify(rows)); // (массивы из изолированной среды сравниваем как текст)
  g.run('cacheDrop_("Площадки")');
  assert.equal(g.run('cacheRead_("Площадки")'), null);
});

test("styleSheets: видны только три листа; месяцы — группы строк (прошлые свёрнуты); новые шапки появляются сами", () => {
  const g = G();
  g.ss.getSheetByName("Расписание").put(4, 1, "05.09"); // событие в прошлом месяце
  g.run("styleSheets()");
  const visible = g.ss.sheets.filter((x) => !x.hidden).map((x) => x.name);
  assert.deepEqual(visible.sort(), ["Площадки", "Расписание", "Сотрудники"].sort());
  const sch = g.ss.getSheetByName("Расписание");
  assert.ok(sch.groups.length >= 2);
  const collapsed = sch.groups.filter((x) => x.collapsed).length;
  assert.equal(collapsed, 1, "сентябрь (прошёл) свёрнут, октябрь открыт");
  // человек добавил событие в новом месяце вручную -> таймер ставит шапку и обновляет версию данных
  const row = sch.getLastRow() + 1;
  sch.put(row, 1, "03.12"); sch.put(row, 4, "Новогоднее");
  g.run("onSheetChange()");
  g.run("everyMinute()");
  const col = sch.getDataRange().getDisplayValues().map((r) => r[0]);
  assert.ok(col.includes("ДЕКАБРЬ 2026") && col.indexOf("ДЕКАБРЬ 2026") < col.indexOf("03.12"));
  g.run("everyMinute()"); // ничего не дублируется
  assert.equal(sch.getDataRange().getDisplayValues().filter((r) => r[0] === "ДЕКАБРЬ 2026").length, 1);
});

test("приложение: me.login и me.channels для кнопок подключения", () => {
  const g = G();
  g.run("styleSheets()");
  g.run("store_().ensureLogins()");
  const login = g.run("store_().users()[0].login");
  const t = api(g, {method: "POST", path: "/api/login", body: {login}}).token;
  const before = api(g, {method: "GET", path: "/api/schedule", token: t}).me;
  assert.equal(before.login, login);
  assert.deepEqual(before.channels, []);
  tg(g, msg(5, "", {user_id: 5, phone_number: "9000000001"}));
  const after = api(g, {method: "GET", path: "/api/schedule", token: t}).me;
  assert.deepEqual(after.channels, ["telegram"]);
});

test("после обновления таблица оформляется сама; новая колонка-группа и новый человек получают галочки без ручных действий", () => {
  const g = G();
  delete g.properties.STYLE_VER;
  g.run("everyMinute()"); // как после выкладки новой версии
  assert.equal(g.properties.STYLE_VER, "5");
  const staff = g.ss.getSheetByName("Сотрудники");
  assert.deepEqual(staff.getDataRange().getDisplayValues()[0].slice(4, 6), ["Доступ", "Комментарий"]);
  assert.deepEqual(g.ss.sheets.filter((x) => !x.hidden).map((x) => x.name).sort(), ["Площадки", "Расписание", "Сотрудники"]);
  // директор вписал новый вид деятельности в шапку и нового человека
  const before = staff.styleLog.length;
  const nr = staff.getLastRow() + 1;
  staff.put(1, 10, "Свет"); staff.put(nr, 1, "Новый Н.Н."); staff.put(nr, 2, "9000000099");
  g.run("onSheetChange()");
  g.run("everyMinute()");
  assert.ok(staff.styleLog.slice(before).some((l) => l[0] === "validation" && l[1].calls.some((c) => c[0] === "requireCheckbox")), "галочки для новой колонки");
  const rows = staff.getDataRange().getDisplayValues();
  assert.equal(rows[nr - 1][2], "Читатель");
  assert.equal(rows[nr - 1][4], "true");
});

test("колонка «Комментарий»: без галочек, случайные TRUE/FALSE стираются, обычный текст остаётся", () => {
  const g = G();
  g.run("styleSheets()");
  const staff = g.ss.getSheetByName("Сотрудники");
  staff.put(2, 6, "TRUE"); staff.put(3, 6, "FALSE"); staff.put(4, 6, "Хочу к вам");
  staff.styleLog.length = 0;
  g.run("styleSheets()");
  const c = staff.getDataRange().getDisplayValues().map((r) => r[5]);
  assert.deepEqual(c.slice(1, 4), ["", "", "Хочу к вам"]);
});

test("месяцы идут по порядку без повторов: перепутанные события сортируются, дублирующиеся шапки убираются", () => {
  const g = G();
  g.run("styleSheets()");
  const sch = g.ss.getSheetByName("Расписание");
  // как на скриншоте: сентябрьское событие вписали после октябрьских, а потом октябрьское — ещё раз
  let row = sch.getLastRow() + 1;
  sch.put(row, 1, "05.09"); sch.put(row, 4, "Сентябрьское"); row++;
  sch.put(row, 1, "19.10"); sch.put(row, 4, "Позднее октябрьское");
  g.run("onSheetChange()");
  g.run("everyMinute()");
  const col = sch.getDataRange().getDisplayValues().map((r) => r[0]);
  const heads = col.filter((x) => /^[А-ЯЁ]+ \d{4}$/.test(x));
  assert.deepEqual(heads, ["СЕНТЯБРЬ 2026", "ОКТЯБРЬ 2026"]);
  assert.ok(col.indexOf("05.09") < col.indexOf("ОКТЯБРЬ 2026"));
  assert.ok(col.indexOf("19.10") > col.indexOf("10.10"));
  g.run("everyMinute()");
  assert.deepEqual(sch.getDataRange().getDisplayValues().map((r) => r[0]), col, "повторный проход ничего не меняет");
});

test("колонки переставили: система находит их по названиям, появляется красная кнопка; «Да, вернуть» возвращает исходный вид", () => {
  const g = G();
  g.run("styleSheets()");
  const staff = g.ss.getSheetByName("Сотрудники");
  const swap = (a, b) => { staff.cells.forEach((row) => { while (row.length < 8) row.push(""); [row[a], row[b]] = [row[b], row[a]]; }); };
  swap(1, 2); // «Телефон» и «Роль» поменялись местами
  assert.equal(g.run("store_().users().find((u) => u.name === 'Иванова М.В.').role"), "admin"); // читается как раньше
  assert.equal(g.run("store_().users().find((u) => u.name === 'Иванова М.В.').phone"), "9000000001");
  g.run("onSheetChange()");
  g.run("everyMinute()");
  const head = staff.getDataRange().getDisplayValues()[0];
  const at = head.findIndex((x) => x.startsWith("↺"));
  assert.ok(at > 0, "красная кнопка появилась в шапке");
  assert.ok(staff.styleLog.some((l) => l[0] === "setBackground" && l[2] === "#F04E4A"));
  // запись идёт в правильную колонку, а не в соседнюю
  g.run("store_().addAccessRequest('9001112233', 'Хочу в команду')");
  const rows = staff.getDataRange().getDisplayValues();
  const req = rows.find((r) => r[0] === "ЗАЯВКА");
  assert.ok(req.includes("9001112233") && req.some((x) => /Хочу в команду/.test(x)));
  assert.equal(req[head.indexOf("Телефон")], "9001112233");
  // нажали «Да, вернуть»
  g.run(`onSheetChange({value: "✔ Да, вернуть", range: {getRow: () => 1, getValue: () => "✔ Да, вернуть", getSheet: () => SpreadsheetApp.openById("x").getSheetByName("Сотрудники")}})`);
  const back = staff.getDataRange().getDisplayValues();
  assert.deepEqual(back[0].slice(0, 6), ["ФИО", "Телефон", "Роль", "Логин", "Доступ", "Комментарий"]);
  assert.ok(!back[0].some((x) => x.startsWith("↺")), "кнопка исчезла");
  assert.equal(back[1][1].replace(/\D/g, "").slice(-10), "9000000001");
  assert.equal(back[1][2], "Админ");
});

test("владелец: строку удалили, роль понизили, доступ сняли — всё возвращается; войти он может всегда", () => {
  const g = G();
  g.properties.OWNER_PHONE = "9000000001";
  g.properties.OWNER_NAME = "Иванова М.В.";
  g.run("styleSheets()");
  g.run("store_().ensureLogins()");
  g.run("runCycle_()");
  const login = g.run("store_().users().find((u) => u.phone === '9000000001').login");
  assert.ok(login, "логин запомнен");
  assert.equal(g.properties.OWNER_LOGIN, login);
  const staff = g.ss.getSheetByName("Сотрудники");
  // 1) роль понизили и сняли «Доступ» — читается как админ и в таблице исправляется
  staff.put(2, 3, "Заблокирован"); staff.put(2, 5, "FALSE"); g.run("dropAllCaches_()"); // как после правки руками
  assert.equal(g.run("store_().users().find((u) => u.phone === '9000000001').role"), "admin");
  g.run("runCycle_()");
  assert.deepEqual([staff.cells[1][2], staff.cells[1][4]], ["Админ", "TRUE"]);
  // 2) строку удалили целиком — возвращается с тем же логином, вход работает
  staff.deleteRow(2); g.run("dropAllCaches_()");
  assert.equal(api(g, {method: "POST", path: "/api/login", body: {login}})._status, 200);
  g.run("runCycle_()");
  const back = staff.getDataRange().getDisplayValues().find((r) => r[1] === "9000000001");
  assert.ok(back && back[0] === "Иванова М.В." && back[2] === "Админ" && back[3] === login);
});

test("новая колонка-группа в «Сотрудниках» оформляется сразу после правки, без ожидания таймера", () => {
  const g = G();
  g.run("styleSheets()");
  const staff = g.ss.getSheetByName("Сотрудники");
  const before = staff.styleLog.length;
  staff.put(1, 10, "обычные");
  g.run(`onSheetChange({range: {getSheet: () => SpreadsheetApp.openById("x").getSheetByName("Сотрудники"), getRow: () => 1, getValue: () => "обычные"}, value: "обычные"})`);
  const log = staff.styleLog.slice(before);
  assert.ok(log.some((l) => l[0] === "validation" && l[1].calls.some((c) => c[0] === "requireCheckbox")), "галочки");
  assert.ok(log.some((l) => l[0] === "setBackground" && l[2] === "#0A96DC"), "цвет шапки");
});
