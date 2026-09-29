// Запуск: node --test apps_script_bot/test.js  (Code.gs выполняется как есть, без Google-сервисов)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const vm = require("vm");

const ctx = vm.createContext({console});
vm.runInContext(fs.readFileSync(__dirname + "/Code.gs", "utf8") + `
this.api = {normPhone_, phonesIn_, looksLikePhone_, personKey_, matchPhones_, parseGrid_, diff_, reminders_,
            handleEvent_, planCycle_, todayIso_, telegramEvent_, describe_, hostOf_};`, ctx);
// Результаты из изолированного контекста приводим к обычным объектам, иначе строгое сравнение массивов не сработает.
const plain = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
const A = Object.fromEntries(Object.entries(ctx.api).map(([k, f]) => [k, (...a) => plain(f(...a))]));

const msk = (day, hour = 10, min = 0) => Date.UTC(2026, 9, day, hour - 3, min); // октябрь 2026, время по Москве
const TODAY = "2026-10-01";
const HEAD = ["4Дата/\nВремя", "Спектакль/\nСцена", "Администратор/\nКапельдинер", "Гардероб/\nУборщица", "Касса", "Монтировка", "Актеры, свет,\nзвук"];
const grid = (...rows) => A.parseGrid_([HEAD, ...rows], TODAY);

test("телефоны в любом формате дают один номер", () => {
  for (const raw of ["89307029109", "+79307029109", "79307029109", "8 930 702 91 09", "8 (930) 702-91-09", "+7 (930) 702-91-09",
    "8-930-702-91-09", "930.702.91.09", "9307029109", " 8 930 702 91 09 ", "+7 930 702 91 09", "тел. 8 930 702 91 09", "‎+7 930 702 91 09"]) {
    assert.strictEqual(A.normPhone_(raw), "9307029109", raw);
  }
  assert.ok(A.looksLikePhone_("8 (930) 702-91-09") && A.looksLikePhone_("+7 930 702 91 09"));
  assert.ok(!A.looksLikePhone_("/start") && !A.looksLikePhone_("привет") && !A.looksLikePhone_("тел. 8 930 702 91 09") && !A.looksLikePhone_("12345"));
  assert.deepStrictEqual((A.phonesIn_("8 930 702-91-09, +7 900 000-00-01;\n89001112233")), ["9307029109", "9000000001", "9001112233"]);
  assert.deepStrictEqual((A.phonesIn_("нет")), []);
});

const EMP = [{name: "Дьячков Н. А", phone: "9307029109"}, {name: "Иванова М.В.", phone: "9000000001"}];

test("людей в расписании узнаём при любой записи фамилии и инициалов", () => {
  for (const w of ["Дьячков", "дьячков н.а.", "Дьячков Н. А", "Дьячков Н.А", "ДЬЯЧКОВ Н.", "Дьячков Никита Александрович"]) {
    assert.deepStrictEqual((A.matchPhones_(w, EMP)), ["9307029109"], w);
  }
  for (const w of ["Дьячков М.В.", "Петров", ""]) assert.deepStrictEqual((A.matchPhones_(w, EMP)), [], w);
  const twins = EMP.concat([{name: "Дьячков М.В.", phone: "9000000009"}]);
  assert.deepStrictEqual((A.matchPhones_("Дьячков", twins)), []); // однофамильцы: не гадаем
  assert.deepStrictEqual((A.matchPhones_("Дьячков Н.А.", twins)), ["9307029109"]);
  const two = EMP.concat([{name: "Дьячков Н. А", phone: "9001112233"}]); // один человек, два номера
  assert.deepStrictEqual((A.matchPhones_("Дьячков", two)).sort(), ["9001112233", "9307029109"]);
  assert.deepStrictEqual((A.personKey_("Иванова-Петрова А.Б.")), ["иванова-петрова", "аб"]);
});

test("сетка театра: роли из заголовков, зал из скобок, время, диапазоны, пустые дни", () => {
  const r = grid(["01.10", "Спектакль «Игра» репетиция (большая сцена)", "Иванова М.В./ Петрова Л.Н.", "Сидорова Л.Р.", "", "", ""]);
  assert.deepStrictEqual(r.map((x) => [x.person, x.role]), [["Иванова М.В.", "Администратор/ Капельдинер"], ["Петрова Л.Н.", "Администратор/ Капельдинер"], ["Сидорова Л.Р.", "Гардероб/ Уборщица"]]);
  assert.strictEqual(r[0].hall, "большая сцена");
  assert.strictEqual(r[0].event, "Спектакль «Игра» репетиция");
  assert.strictEqual(r[0].date, "2026-10-01");

  const b = grid(["04.10\n11.00 и 13.00", "Спектакль «Бука»\n(малая сцена)", "Иванова М.В.", "Морозова Н.М.", "Орлова А.В.", "", ""], ["05.10", "", "", "", "", "", ""]);
  assert.deepStrictEqual([...new Set(b.map((x) => x.time))], ["11:00, 13:00"]);
  assert.strictEqual(b.length, 3);

  const c = grid(["15.10", "Выезд в Сеченово\nСпектакль «Игра»", "Кузнецова Е.Н. Иванова М.В.", "", "", "", ""], ["25.10 до 31.10", "Фестиваль в Барнауле", "", "", "", "", ""]);
  assert.deepStrictEqual(c.filter((x) => x.date === "2026-10-15").map((x) => x.person), ["Кузнецова Е.Н.", "Иванова М.В."]);
  const fest = c.filter((x) => x.event === "Фестиваль в Барнауле");
  assert.strictEqual(fest.length, 7);
  assert.strictEqual(fest[6].date, "2026-10-31");
  assert.strictEqual(fest[0].person, "");

  const d = grid(["30.09.2026\n12.00", "", "Дьячков", "", "", "", ""]); // как в реальной таблице: только фамилия, без названия
  assert.deepStrictEqual([d[0].event, d[0].time, d[0].person], ["Смена", "12:00", "Дьячков"]);
  assert.deepStrictEqual(grid(["мусор", "x"]), []);
});

test("diff: назначили / сняли / перенесли; прошлое и строки без ФИО молчат", () => {
  const old = grid(["04.10\n11.00", "Бука (малая сцена)", "Иванова М.В.", "", "", "", ""], ["06.10", "Репетиция", "", "", "", "Петрова Б.Б.", ""]);
  const neu = grid(["04.10\n12.00", "Бука (малая сцена)", "Иванова М.В.", "", "", "", ""], ["07.10", "Репетиция", "", "", "", "Сидорова В.В.", ""]);
  const kinds = A.diff_(old, neu, TODAY).map((c) => c.kind + ":" + c.person).sort();
  assert.deepStrictEqual(kinds, ["added:Сидорова В.В.", "changed:Иванова М.В.", "removed:Петрова Б.Б."]);
  assert.deepStrictEqual(A.diff_(grid(["01.09", "Старое", "Иванова М.В.", "", "", "", ""]), [], TODAY), []);
  assert.deepStrictEqual(A.diff_([], grid(["05.10", "Экскурсия", "", "", "", "", ""]), TODAY), []);
});

const rowsShift = grid(["04.10\n11.00", "Спектакль «Бука» (малая сцена)", "Иванова М.В.", "", "", "", ""]);
const IV = [{name: "Иванова М.В.", phone: "9000000001"}];
const remind = (rows, sent, now) => A.reminders_(rows, IV, sent, now);

test("напоминания за сутки и за час: по одному разу, не после начала", () => {
  const sent = new Set();
  assert.strictEqual(remind(rowsShift, sent, msk(3, 10)).notes.length, 0); // рано
  const day = remind(rowsShift, sent, msk(3, 12));
  assert.strictEqual(day.notes.length, 1);
  assert.ok(day.notes[0].text.startsWith("📅 Завтра"));
  assert.strictEqual(remind(rowsShift, sent, msk(3, 12, 30)).notes.length, 0); // повтор не шлём
  assert.strictEqual(remind(rowsShift, sent, msk(4, 9)).notes.length, 0); // за час ещё рано
  const hour = remind(rowsShift, sent, msk(4, 10));
  assert.ok(hour.notes[0].text.startsWith("⏰ Через час"));
  assert.strictEqual(remind(rowsShift, sent, msk(4, 10, 5)).notes.length, 0);
  assert.strictEqual(remind(rowsShift, new Set(), msk(4, 11, 1)).notes.length, 0); // смена уже началась
});

test("смену, добавленную поздно, не догоняют напоминанием «за сутки»", () => {
  const sent = new Set();
  assert.strictEqual(remind(rowsShift, sent, msk(4, 6)).notes.length, 0);
  assert.strictEqual(remind(rowsShift, sent, msk(4, 10)).notes.length, 1);
});

test("смена без времени: одно напоминание накануне вечером", () => {
  const rows = grid(["07.10", "Репетиция", "Иванова М.В.", "", "", "", ""]);
  const sent = new Set();
  assert.strictEqual(remind(rows, sent, msk(6, 17)).notes.length, 0);
  assert.strictEqual(remind(rows, sent, msk(6, 18)).notes.length, 1);
  assert.strictEqual(remind(rows, sent, msk(6, 19)).notes.length, 0);
});

// --- диалог ---
function makeEnv(users, schedule) {
  const chats = new Map();
  const env = {users, schedule, sent: [], chats,
    phoneOf: (c) => chats.get(String(c)), bind: (c, p) => chats.set(String(c), p), unbind: (c) => chats.delete(String(c)),
    send: (c, text, kb) => env.sent.push({chat: String(c), text, kb})};
  return env;
}
const last = (env, chat) => env.sent.filter((s) => s.chat === String(chat)).pop();
const NOW = msk(1, 10);

test("регистрация: контакт, номер текстом, чужой номер, команды без регистрации", () => {
  const env = makeEnv(EMP, []);
  A.handleEvent_(env, {chatId: 5, text: "/start"}, NOW);
  assert.ok(last(env, 5).text.includes("поделитесь номером") && last(env, 5).kb === "contact");
  A.handleEvent_(env, {chatId: 5, text: "/shifts"}, NOW);
  assert.ok(last(env, 5).text.includes("поделитесь номером"));
  A.handleEvent_(env, {chatId: 5, text: "", phone: "+79307029109"}, NOW);
  assert.ok(last(env, 5).text.includes("Готово, Дьячков Н. А") && env.chats.get("5") === "9307029109");
  A.handleEvent_(env, {chatId: 7, text: "8 (900) 000-00-01"}, NOW);
  assert.strictEqual(env.chats.get("7"), "9000000001");
  A.handleEvent_(env, {chatId: 8, text: "+7 999 999-99-99"}, NOW);
  assert.ok(last(env, 8).text.includes("нет в списке") && !env.chats.has("8"));
});

test("/shifts, /schedule, /stop", () => {
  const sched = grid(["04.10\n11.00", "Бука (малая сцена)", "Иванова М.В.", "", "", "", ""], ["03.10", "Экскурсия", "Дьячков", "", "", "", ""]);
  const env = makeEnv(EMP, sched);
  A.handleEvent_(env, {chatId: 5, text: "", phone: "9307029109"}, NOW);
  A.handleEvent_(env, {chatId: 5, text: "/shifts"}, NOW);
  assert.strictEqual(last(env, 5).text, "03.10 (сб) — Экскурсия, Администратор/ Капельдинер"); // «Дьячков» без инициалов найден
  A.handleEvent_(env, {chatId: 5, text: "/schedule@k_t_k_bot"}, NOW);
  assert.ok(last(env, 5).text.includes("04.10 (вс) 11:00 — Бука (малая сцена)") && last(env, 5).text.includes("Администратор/ Капельдинер: Иванова М.В."));
  A.handleEvent_(env, {chatId: 5, text: "/stop"}, NOW);
  assert.ok(!env.chats.has("5"));
  A.handleEvent_(env, {chatId: 5, text: "/shifts"}, NOW);
  assert.ok(last(env, 5).text.includes("поделитесь номером"));
});

test("полный цикл: тихий первый снимок, потом уведомления только тому, кого касается; состояние переживает JSON", () => {
  const tbl = (...rows) => [HEAD, ...rows];
  const t1 = tbl(["04.10\n11.00", "Бука (малая сцена)", "Иванова М.В.", "", "", "", ""]);
  let plan = A.planCycle_(t1, EMP, {}, msk(1, 10));
  assert.strictEqual(plan.notes.length, 0); // первый запуск молчит
  let snap = JSON.parse(JSON.stringify(plan.snap));

  const t2 = tbl(["04.10\n11.00", "Бука (малая сцена)", "Иванова М.В.", "", "", "", ""], ["05.10\n10.00", "Репетиция", "Дьячков", "", "", "", ""]);
  plan = A.planCycle_(t2, EMP, snap, msk(1, 10));
  assert.deepStrictEqual(plan.notes.map((n) => n.phone), ["9307029109"]);
  assert.ok(plan.notes[0].text.startsWith("🆕 Вам назначено"));
  snap = JSON.parse(JSON.stringify(plan.snap));
  assert.strictEqual(A.planCycle_(t2, EMP, snap, msk(1, 10)).notes.length, 0); // повторов нет

  const t3 = tbl(["04.10\n12.00", "Бука (малая сцена)", "Иванова М.В.", "", "", "", ""], ["05.10\n10.00", "Репетиция", "Дьячков", "", "", "", ""]);
  plan = A.planCycle_(t3, EMP, snap, msk(1, 10));
  assert.deepStrictEqual(plan.notes.map((n) => [n.phone, n.text.slice(0, 2)]), [["9000000001", "✏️"]]);
  snap = JSON.parse(JSON.stringify(plan.snap));

  plan = A.planCycle_(t3, EMP, snap, msk(3, 12)); // за сутки до Буки (перенесена на 12:00 → 03.10 12:00)
  assert.ok(plan.notes.some((n) => n.phone === "9000000001" && n.text.startsWith("📅 Завтра")));
  snap = JSON.parse(JSON.stringify(plan.snap));
  assert.strictEqual(A.planCycle_(t3, EMP, snap, msk(3, 12, 30)).notes.filter((n) => n.phone === "9000000001").length, 0);
  const old = A.planCycle_(t3, EMP, snap, msk(20, 12)); // ключи давно прошедших дат забываются
  assert.strictEqual(old.snap.digests.length, 0);
});

test("Telegram: чужой контакт и группы игнорируются", () => {
  const own = A.telegramEvent_({message: {chat: {id: 5, type: "private"}, from: {id: 5}, contact: {user_id: 5, phone_number: "+7 930"}}});
  assert.strictEqual(own.phone, "+7 930");
  const foreign = A.telegramEvent_({message: {chat: {id: 5, type: "private"}, from: {id: 5}, contact: {user_id: 9, phone_number: "+7 930"}}});
  assert.strictEqual(foreign.phone, null);
  assert.strictEqual(A.telegramEvent_({message: {chat: {id: -1, type: "group"}, from: {id: 5}, text: "hi"}}), null);
});

test("hostOf_ показывает только адрес сайта, без секретной части", () => {
  assert.strictEqual(A.hostOf_("https://ktk-relay.x.workers.dev/секрет123?a=b"), "ktk-relay.x.workers.dev");
  assert.strictEqual(A.hostOf_(""), "");
  assert.strictEqual(A.hostOf_(undefined), "");
});
