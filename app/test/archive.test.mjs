import test from "node:test";
import assert from "node:assert/strict";
import {handleApi} from "../lib/api.mjs";
import {archiveLine, buildReport, parseArchive, archiveCutoff} from "../lib/report.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";
import {Store, TABS} from "../lib/store.mjs";
import {loadGas} from "./gas-fake.mjs";
import {msk, STAFF} from "./helpers.mjs";

const NOW = msk(1, 10); // 1 октября 2026
const HEAD = ["Дата", "Начало", "Конец", "Событие", "Площадка", "Актёры", "ID"];
const ROWS = [HEAD,
  ["10.03.2025", "10:00", "12:00", "Старый спектакль", "Большая сцена", "Иванова М.В., Петрова Л.Н.", "aaaaaaa1"],
  ["05.11.2025", "18:00", "20:00", "Недавнее", "Малая сцена", "Иванова М.В.", "aaaaaaa2"],
  ["20.10.2026", "19:00", "21:00", "Будущее", "Малая сцена", "", "aaaaaaa3"]];

test("формат архива: событие -> строка -> событие без потерь", () => {
  const e = {id: "ab12cd34", date: "2025-03-10", dateEnd: "", time: "10:00", end: "12:00", title: "Спектакль", hall: "Большая сцена", roles: {"Актёры": ["Иванова М.В.", "Петрова Л.Н."], "Касса": ["Орлова А.В."]}};
  const [back] = parseArchive([archiveLine(e, true)], "2026-10-01");
  assert.deepEqual([back.id, back.date, back.time, back.end, back.title, back.hall, back.meeting], [e.id, e.date, e.time, e.end, e.title, e.hall, true]);
  assert.deepEqual(back.roles, e.roles);
  const multi = parseArchive([archiveLine({...e, date: "2025-03-10", dateEnd: "2025-03-12"})], "2026-10-01")[0];
  assert.equal(multi.dateEnd, "2025-03-12");
  assert.equal(archiveCutoff("2026-10-22", 12), "2025-10-01");
});

test("ежедневное обслуживание: копии листов (скрытые), старое уходит в «Архив», недавнее остаётся, старые копии убираются", () => {
  const g = loadGas({tabs: {[TABS.schedule]: ROWS, [TABS.staff]: STAFF, [TABS.venues]: [["Площадка", "Заметка", "Цвет"]]}, props: {SHEET_ID: "x", STYLE_VER: "23", TOP_ROWS_DONE: "1", TEST_USERS: "1"}, now: NOW});
  for (const n of ["_копия 05.09 Расписание", "_копия 20.09 Расписание", "_копия 25.09 Расписание", "_копия 28.09 Расписание", "_копия 29.09 Расписание", "_копия 30.09 Расписание", "_копия 30.09 Сотрудники", "_копия 01.01 Расписание"]) g.ss.insertSheet(n);
  g.run("runMaintenance()");
  const names = g.ss.sheets.map((s) => s.name);
  for (const n of ["_копия 01.10 Расписание", "_копия 01.10 Сотрудники", "_копия 01.10 Площадки"]) assert.ok(names.includes(n), n);
  assert.ok(g.ss.getSheetByName("_копия 01.10 Расписание").hidden);
  // остаются 5 последних дат: 01.10, 30.09, 29.09, 28.09, 25.09; остальные (20.09, 05.09 и 01.01 прошлых лет) удалены
  const stamps = [...new Set(names.filter((n) => n.startsWith("_копия ")).map((n) => n.slice(7, 12)))].sort();
  assert.deepEqual(stamps, ["01.10", "25.09", "28.09", "29.09", "30.09"]);
  assert.ok(names.includes("_копия 30.09 Сотрудники"), "копии одной даты удаляются и хранятся вместе");
  const arch = g.ss.getSheetByName(TABS.archive);
  assert.ok(arch && !arch.hidden, "лист «Архив» видимый");
  const lines = arch.getDataRange().getDisplayValues();
  assert.equal(lines.length, 2);
  assert.deepEqual([lines[1][0], lines[1][3], lines[1][4], lines[1][7]], ["10.03.2025", "Старый спектакль", "Большая сцена", "aaaaaaa1"]);
  const sched = g.ss.getSheetByName(TABS.schedule).getDataRange().getDisplayValues().map((r) => r[3]);
  assert.ok(!sched.includes("Старый спектакль"), "из расписания убрано");
  assert.ok(sched.includes("Недавнее") && sched.includes("Будущее"), "недавнее и будущее на месте");
  // второй запуск в тот же день ничего не делает; а повторный принудительный не задваивает архив
  g.run("runMaintenance()");
  assert.equal(g.ss.getSheetByName(TABS.archive).getDataRange().getDisplayValues().length, 2);
});

test("если копию сделать не удалось, в архив ничего не переносится", () => {
  const g = loadGas({tabs: {[TABS.schedule]: ROWS, [TABS.staff]: STAFF}, props: {SHEET_ID: "x", STYLE_VER: "23", TOP_ROWS_DONE: "1", TEST_USERS: "1"}, now: NOW});
  g.ss.getSheetByName(TABS.schedule).copyTo = () => { throw new Error("нет места"); };
  g.run("runMaintenance()");
  assert.equal(g.ss.getSheetByName(TABS.archive), null);
  assert.ok(g.ss.getSheetByName(TABS.schedule).getDataRange().getDisplayValues().some((r) => r[3] === "Старый спектакль"));
});

function api() {
  const book = new MemoryBook({[TABS.schedule]: ROWS, [TABS.staff]: STAFF});
  const store = new Store(book, {secret: "t", now: () => NOW});
  const deps = {store, secret: "s", now: () => NOW};
  store.ensureLogins();
  const token = handleApi({method: "POST", path: "/api/login", body: {login: store.users().find((u) => u.phone === "9000000001").login}}, deps).body.token;
  return {book, store, call: (method, path, body = {}) => handleApi({method, path, token, body}, deps)};
}

test("отчёт за прошлые годы читает и «Архив»", () => {
  const t = api();
  t.store.appendArchive([archiveLine({id: "z1", date: "2019-05-04", dateEnd: "", time: "10:00", end: "13:00", title: "Спектакль 2019", hall: "Большая сцена", roles: {"Актёры": ["Иванова М.В."]}}, false)]);
  const r = t.call("POST", "/api/report", {from: "2019-01-01", to: "2019-12-31", kind: "person", value: "Иванова М.В."});
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.report.rows.map((x) => x[3]), ["Спектакль 2019"]);
  assert.equal(r.body.report.summary[1][1], "3"); // часы
  const wide = t.call("POST", "/api/report", {from: "2016-01-01", to: "2026-12-31", kind: "venue", value: ""});
  assert.equal(wide.status, 200, "период в 10 лет разрешён");
});

test("удалённое событие остаётся в скрытом листе «_удалённое»", () => {
  const t = api();
  assert.equal(t.call("DELETE", "/api/events/id-aaaaaaa2").status, 200);
  const gone = t.book.get(TABS.deleted);
  assert.equal(gone.length, 2);
  assert.deepEqual([gone[1][1], gone[1][5], gone[1][6]], ["Иванова М.В.", "Недавнее", "Малая сцена"]);
  assert.match(gone[1][0], /^2026-10-01 10:00$/);
});

test("прогрев: запрос ?warm=1 отвечает мгновенно и ничего не меняет", () => {
  const g = loadGas({tabs: {[TABS.schedule]: ROWS, [TABS.staff]: STAFF}, props: {SHEET_ID: "x"}, now: NOW});
  assert.equal(g.run('doGet({parameter: {warm: "1"}}).getContent()'), "ok");
  assert.equal(g.run("doGet().getContent()"), "ok");
});

test("цвет площадки из приложения сразу попадает в таблицу занятости (не ждёт таймера)", () => {
  const tabs = {[TABS.schedule]: [HEAD, ["20.10.2026", "19:00", "21:00", "Бука", "Малая сцена", "", "aaaaaaa3"]], [TABS.staff]: STAFF,
    [TABS.venues]: [["Площадка", "Заметка", "Цвет"], ["Малая сцена", "", "Розовый"]]};
  const g = loadGas({tabs, props: {SHEET_ID: "x", STYLE_VER: "23", TOP_ROWS_DONE: "1", TEST_USERS: "1", OWNER_PHONE: "9000000001"}, now: NOW});
  const call = (req) => JSON.parse(g.run(`doPost(${JSON.stringify({postData: {contents: JSON.stringify(req)}})}).getContent()`));
  g.run("store_().ensureLogins()");
  const token = call({method: "POST", path: "/api/login", body: {login: g.run('store_().users().find((u) => u.phone === "9000000001").login')}}).token;
  const grey = g.run('colorHex("Серый")');
  const sh = g.ss.getSheetByName(TABS.venues);
  sh.styleLog.length = 0;
  assert.equal(call({method: "PUT", path: "/api/venues", token, body: {name: "Малая сцена", color: "Серый"}}).ok, true);
  assert.ok(sh.styleLog.some((x) => x[0] === "setBackground" && x[2] === grey && x[1] >= 2), "ячейка площадки в занятости перекрашена сразу");
  assert.equal(g.properties.occ_dirty, undefined);
});

test("свободные строки: заполнили одну — таблица сама добавляет ещё, всегда ровно пять под актуальным месяцем", () => {
  const g = loadGas({tabs: {[TABS.schedule]: [HEAD, ["20.10.2026", "19:00", "21:00", "Будущее", "Малая сцена", "", "aaaaaaa3"]], [TABS.staff]: STAFF}, props: {SHEET_ID: "x", TEST_USERS: "1", TOP_ROWS_DONE: "1"}, now: NOW});
  g.run("styleSheets()");
  const sch = g.ss.getSheetByName(TABS.schedule);
  const col = () => sch.getDataRange().getDisplayValues().map((r) => r[0]);
  const freeBelow = () => { const c = col(), d = c.indexOf("▼ ПРОШЕДШИЕ МЕСЯЦЫ"); let n = 0; for (let i = d - 1; i >= 0 && c[i] === ""; i--) n++; return n; };
  assert.equal(freeBelow(), 5);
  const first = col().indexOf("20.10.2026") + 2; // первая свободная строка под событием (нумерация с 1)
  sch.put(first, 1, "25.10.2026"); sch.put(first, 4, "Новое");
  g.run("onSheetChange()"); g.run("everyMinute()");
  assert.equal(freeBelow(), 5, "свободных строк снова пять");
  const c = col();
  assert.ok(c.indexOf("25.10.2026") > c.indexOf("20.10.2026") && c.indexOf("25.10.2026") < c.indexOf("▼ ПРОШЕДШИЕ МЕСЯЦЫ"));
  assert.ok(c.includes("СЕНТЯБРЬ 2026") && c.indexOf("СЕНТЯБРЬ 2026") > c.indexOf("▼ ПРОШЕДШИЕ МЕСЯЦЫ"), "сентябрь ниже разделителя");
  const divider = c.indexOf("▼ ПРОШЕДШИЕ МЕСЯЦЫ") + 1; // строка разделителя (с 1)
  const octGroup = sch.groups.find((x) => x.from === 3);
  assert.ok(octGroup && octGroup.to === divider - 1, "группа актуального месяца включает пять свободных строк: сворачивается вместе с ними");
  assert.ok(sch.getMaxRows() <= sch.getLastRow() + 1, "под последним прошедшим месяцем лишних пустых строк нет: лист компактный");
});

test("старые должности исходной таблицы: пустые убираются, с данными остаются", async () => {
  const OLD = ["Дата/Время", "Спектакль/Сцена", "Администратор/ Капельдинер", "Гардероб/ Уборщица", "Касса", "Монтировка", "Актеры, свет, звук"];
  const staff = STAFF.map((r) => r.slice());
  const g = loadGas({tabs: {[TABS.schedule]: [OLD, ["04.10", "Спектакль", "", "", "", "Орлова А.В.", ""]], [TABS.staff]: [["ФИО", "Телефон", "Роль", "Логин", "Доступ", "Комментарий", "Актёры", "Техника"], ...staff.slice(1).map((r) => [...r, "", "", "", "", "", ""])]}, props: {SHEET_ID: "x", TEST_USERS: "1", TOP_ROWS_DONE: "1"}, now: NOW});
  g.run("styleSheets()");
  const head = g.ss.getSheetByName(TABS.schedule).getDataRange().getDisplayValues()[0];
  assert.ok(head.includes("Монтировка"), "в колонке есть данные — осталась");
  for (const gone of ["Касса", "Гардероб/ Уборщица", "Администратор/ Капельдинер", "Актеры, свет, звук"]) assert.ok(!head.includes(gone), gone + " убрана");
  assert.ok(head.includes("Актёры") && head.includes("Техника"), "колонки-группы на месте");
});

// ---- место под «шапку»: строки над таблицей принадлежат пользователю ----
const BANNER = [["Мой театр: сезон 2026/27", "", "", "", "", "", ""], ["Расписание и смены", "", "", "", "", "", ""]];
function withBanner(extraProps = {}) {
  const tabs = {
    [TABS.schedule]: [...BANNER, HEAD, ["20.10.2026", "19:00", "21:00", "Будущее", "Малая сцена", "Иванова М.В.", "aaaaaaa3"]],
    [TABS.staff]: [["Список сотрудников"], [""], ...STAFF],
    [TABS.venues]: [["Мои площадки"], [""], ["Площадка", "Заметка", "Цвет"], ["Малая сцена", "", "Розовый"]],
  };
  const g = loadGas({tabs, props: {SHEET_ID: "x", STYLE_VER: "23", TOP_ROWS_DONE: "1", TEST_USERS: "1", TOP_ROWS_DONE: "1", OWNER_PHONE: "9000000001", ...extraProps}, now: NOW});
  const call = (req) => JSON.parse(g.run(`doPost(${JSON.stringify({postData: {contents: JSON.stringify(req)}})}).getContent()`));
  g.run("store_().ensureLogins()");
  const token = call({method: "POST", path: "/api/login", body: {login: g.run('store_().users().find((u) => u.phone === "9000000001").login')}}).token;
  return {g, call, token};
}

test("шапка пользователя сверху: система находит таблицу ниже, читает и пишет только в ней", () => {
  const {g, call, token} = withBanner();
  const sch = call({method: "GET", path: "/api/schedule", token});
  assert.deepEqual(sch.events.map((e) => e.title), ["Будущее"]);
  assert.ok(sch.staff.includes("Петрова Л.Н."), "сотрудники читаются из таблицы под шапкой");
  assert.equal(call({method: "POST", path: "/api/events", token, body: {event: {title: "Новое", date: "2026-10-25", dateEnd: "", time: "10:00", end: "11:00", hall: "Малая сцена", roles: {}}, id: "bbbbbbb1"}}).ok, true);
  assert.equal(call({method: "PUT", path: "/api/venues", token, body: {name: "Малая сцена", color: "Серый"}}).ok, true);
  g.run("everyMinute()");
  g.run("styleSheets()");
  const raw = g.ss.getSheetByName(TABS.schedule).getDataRange().getDisplayValues();
  assert.equal(raw[0][0], "Мой театр: сезон 2026/27");
  assert.equal(raw[1][0], "Расписание и смены");
  assert.equal(raw[2][0], "Дата", "шапка таблицы осталась на третьей строке");
  assert.ok(raw.some((r) => r[3] === "Новое"), "новое событие записано под шапкой");
  assert.ok(raw.slice(3).some((r) => /^ОКТЯБРЬ 2026$/.test(r[0])), "шапки месяцев — ниже шапки таблицы");
  const staffRaw = g.ss.getSheetByName(TABS.staff).getDataRange().getDisplayValues();
  assert.equal(staffRaw[0][0], "Список сотрудников");
  assert.equal(staffRaw[2][0], "ФИО");
  const venRaw = g.ss.getSheetByName(TABS.venues).getDataRange().getDisplayValues();
  assert.equal(venRaw[0][0], "Мои площадки");
  assert.equal(venRaw[2][2], "Цвет");
  assert.equal(venRaw[3][2], "Серый", "цвет площадки записан в строку площадки, а не в шапку пользователя");
  // повторные проходы шапку не трогают
  g.run("everyMinute()");
  assert.equal(g.ss.getSheetByName(TABS.schedule).getDataRange().getDisplayValues()[0][0], "Мой театр: сезон 2026/27");
});

test("при первом оформлении сверху главных листов вставляются две свободные строки (один раз)", () => {
  const g = loadGas({tabs: {[TABS.schedule]: [HEAD, ["20.10.2026", "19:00", "21:00", "Будущее", "Малая сцена", "", "aaaaaaa3"]], [TABS.staff]: STAFF, [TABS.venues]: [["Площадка", "Заметка", "Цвет"], ["Малая сцена", "", "Розовый"]]}, props: {SHEET_ID: "x", TEST_USERS: "1", OWNER_PHONE: "9000000001"}, now: NOW});
  g.run("styleSheets()");
  for (const [name, firstHeader] of [[TABS.schedule, "Дата"], [TABS.staff, "ФИО"], [TABS.venues, "Площадка"]]) {
    const v = g.ss.getSheetByName(name).getDataRange().getDisplayValues();
    assert.deepEqual([v[0].every((x) => x === ""), v[1].every((x) => x === ""), v[2][0].startsWith(firstHeader)], [true, true, true], name);
  }
  g.run("styleSheets()"); // второй раз ничего не добавляет
  assert.equal(g.ss.getSheetByName(TABS.schedule).getDataRange().getDisplayValues()[2][0], "Дата");
  assert.equal(g.ss.getSheetByName(TABS.schedule).getDataRange().getDisplayValues()[3][0].length > 0, true);
});

test("оформление как в образце: шапки и верхние строки #04A9F1, высота 44, закреплены строки и колонки", () => {
  const g = loadGas({tabs: {[TABS.schedule]: [HEAD, ["20.10.2026", "19:00", "21:00", "Будущее", "Малая сцена", "", "aaaaaaa3"]], [TABS.staff]: STAFF, [TABS.venues]: [["Площадка", "Заметка", "Цвет"], ["Малая сцена", "", "Розовый"]]}, props: {SHEET_ID: "x", TEST_USERS: "1", OWNER_PHONE: "9000000001"}, now: NOW});
  g.run("styleSheets()");
  for (const name of [TABS.schedule, TABS.staff, TABS.venues]) {
    const log = g.ss.getSheetByName(name).styleLog;
    assert.ok(log.some((x) => x[0] === "setBackground" && x[2] === "#04A9F1"), name + ": голубой цвет шапки");
    assert.ok(log.some((x) => x[0] === "rowHeight" && x[1] === 1 && x[2] === 44), name + ": верхние строки по 44");
    assert.ok(log.some((x) => x[0] === "frozen" && x[1] === 3), name + ": закреплены шапка и две верхние строки");
  }
  assert.ok(g.ss.getSheetByName(TABS.staff).styleLog.some((x) => x[0] === "frozenCols" && x[1] === 4));
  assert.ok(g.ss.getSheetByName(TABS.venues).styleLog.some((x) => x[0] === "frozenCols" && x[1] === 3));
});

test("стёрли название (имя, площадка, событие) — вся строка очищается; шапка месяца и правка других колонок не страдают; верх закрашен цветом шапки", () => {
  const g = loadGas({tabs: {[TABS.schedule]: [HEAD, ["20.10.2026", "19:00", "21:00", "Будущее", "Малая сцена", "", "aaaaaaa3"]], [TABS.staff]: STAFF, [TABS.venues]: [["Площадка", "Заметка", "Цвет"], ["Малая сцена", "", "Розовый"]]}, props: {SHEET_ID: "x", TEST_USERS: "1", OWNER_PHONE: "9000000001"}, now: NOW});
  g.run("styleSheets()");
  const sh = g.ss.getSheetByName(TABS.schedule);
  const rows = () => sh.getDataRange().getDisplayValues();
  const at = rows().findIndex((r) => r[3] === "Будущее") + 1;
  const edit = (row, col, value, oldValue) => { g.ctx.__e = {range: {getSheet: () => sh, getRow: () => row, getLastRow: () => row, getColumn: () => col, getLastColumn: () => col}, value, oldValue}; g.run("clearOrphanRows_(__e)"); };
  edit(at, 5, undefined, "Малая сцена"); // стёрли площадку, а не название
  assert.equal(rows()[at - 1][3], "Будущее");
  sh.put(at, 4, "");
  edit(at, 4, undefined, "Будущее");
  assert.deepEqual(rows()[at - 1].every((x) => x === ""), true, "название стёрто — строка пуста");
  const month = rows().findIndex((r) => /^ОКТЯБРЬ 2026$/.test(r[0])) + 1;
  edit(month, 4, undefined, "x");
  assert.match(rows()[month - 1][0], /ОКТЯБРЬ 2026/, "шапка месяца не стирается");
  assert.ok(sh.styleLog.some((x) => x[0] === "setBackground" && x[1] === 1 && x[2] === "#04A9F1"), "верхние строки закрашены цветом шапки");
});
