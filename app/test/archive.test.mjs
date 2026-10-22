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
  const g = loadGas({tabs: {[TABS.schedule]: ROWS, [TABS.staff]: STAFF, [TABS.venues]: [["Площадка", "Заметка", "Цвет"]]}, props: {SHEET_ID: "x", STYLE_VER: "17", TEST_USERS: "1"}, now: NOW});
  for (const n of ["_копия 05.09 Расписание", "_копия 20.09 Расписание", "_копия 01.01 Расписание", "_копия 01.05 Расписание"]) g.ss.insertSheet(n);
  g.run("runMaintenance()");
  const names = g.ss.sheets.map((s) => s.name);
  for (const n of ["_копия 01.10 Расписание", "_копия 01.10 Сотрудники", "_копия 01.10 Площадки"]) assert.ok(names.includes(n), n);
  assert.ok(g.ss.getSheetByName("_копия 01.10 Расписание").hidden);
  assert.ok(!names.includes("_копия 05.09 Расписание"), "ежедневная копия старше 14 дней убрана");
  assert.ok(names.includes("_копия 20.09 Расписание"), "свежая осталась");
  assert.ok(names.includes("_копия 01.01 Расписание"), "копия первого числа хранится дольше");
  assert.ok(names.includes("_копия 01.05 Расписание"), "копии первого числа — по одной на месяц (в следующем году заменяются новыми), больше 12 не копится");
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
  const g = loadGas({tabs: {[TABS.schedule]: ROWS, [TABS.staff]: STAFF}, props: {SHEET_ID: "x", STYLE_VER: "17", TEST_USERS: "1"}, now: NOW});
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
