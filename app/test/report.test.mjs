import test from "node:test";
import assert from "node:assert/strict";
import {handleApi} from "../lib/api.mjs";
import {buildReport, reportBlock, reportCsv, REPORT_HEIGHT, REPORT_WIDTH, REPORT_CAP} from "../lib/report.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";
import {Store, TABS} from "../lib/store.mjs";
import {loadGas} from "./gas-fake.mjs";
import {msk, STAFF} from "./helpers.mjs";

const NOW = msk(1, 10);
const HEAD = ["Дата", "Начало", "Конец", "Событие", "Площадка", "Техника", "Зал", "ID"];
const ROWS = [HEAD,
  ["01.10.2026", "10:00", "12:00", "Репетиция", "Большая сцена", "Иванова М.В.", "", "aaaaaaa1"],
  ["02.10.2026", "18:00", "20:30", "Спектакль «Бука»", "Малая сцена", "Иванова М.В.", "Петрова Л.Н.", "aaaaaaa2"],
  ["03.10.2026", "11:00", "", "Без конца", "Большая сцена", "Сидорова Л.Р.", "", "aaaaaaa3"],
  ["10.10.2026", "19:00", "20:00", "Собрание труппы", "Большая сцена", "", "Петрова Л.Н.", "aaaaaaa4"]];
const events = () => {
  const book = new MemoryBook({[TABS.schedule]: ROWS, [TABS.staff]: STAFF});
  return new Store(book, {secret: "t", now: () => NOW}).book.get(TABS.schedule);
};
import {parseEvents} from "../lib/core.mjs";
const EV = parseEvents(events(), "2026-10-01");
const meeting = (e) => e.id === "aaaaaaa4";

test("по площадке: события, часы, собрания, итоги", () => {
  const r = buildReport(EV, {from: "2026-10-01", to: "2026-10-31", kind: "venue", value: "большая сцена", isMeeting: meeting});
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.summary, [["Событий", "2"], ["Собраний", "1"], ["Часов", "3"], ["Дней с событиями", "3"]]); // 2 + 1 ч; «без конца» часов не даёт
  assert.match(r.note, /не указано время/);
  assert.equal(r.rows[0][1], "10:00–12:00");
  assert.equal(r.rows[2][4], "Собрание");
});

test("период обрезает события; по всем площадкам включены все", () => {
  const r = buildReport(EV, {from: "2026-10-02", to: "2026-10-03", kind: "venue", value: "", isMeeting: meeting});
  assert.equal(r.rows.length, 2);
});

test("по сотруднику: смены, должность, часы, площадки", () => {
  const r = buildReport(EV, {from: "2026-10-01", to: "2026-10-31", kind: "person", value: "Иванова М.В.", isMeeting: meeting});
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0][4], "Техника");
  assert.deepEqual(r.summary, [["Смен", "2"], ["Часов", "4,5"], ["Площадок", "2"], ["Собраний", "0"]]);
});

test("по отделу: строка на человека, отсортировано по числу смен", () => {
  const r = buildReport(EV, {from: "2026-10-01", to: "2026-10-31", kind: "role", value: "Зал", isMeeting: meeting});
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.rows[0].slice(0, 4), ["Петрова Л.Н.", "2", "3,5", "1"]);
  const all = buildReport(EV, {from: "2026-10-01", to: "2026-10-31", kind: "role", value: "", isMeeting: meeting});
  assert.equal(all.rows.length, 3);
});

test("блок для листа: всегда одинакового размера, лишнее уходит в примечание", () => {
  const small = reportBlock(buildReport(EV, {from: "2026-10-01", to: "2026-10-31", kind: "venue"}), 2, {when: "x", by: "Иванова"});
  const many = Array.from({length: 45}, (_, i) => ({id: "i" + i, row: i + 2, date: "2026-10-05", dateEnd: "", time: "10:00", end: "11:00", title: "Событие " + i, hall: "Зал", roles: {}}));
  const big = reportBlock(buildReport(many, {from: "2026-10-01", to: "2026-10-31", kind: "venue"}), 3, {when: "x"});
  for (const b of [small, big]) { assert.equal(b.rows.length, REPORT_HEIGHT); assert.ok(b.rows.every((r) => r.length === REPORT_WIDTH)); }
  assert.equal(big.shown, REPORT_CAP);
  assert.match(big.rows[4 + REPORT_CAP + 1][0], /первые 30 из 45/);
  assert.match(big.rows[4 + REPORT_CAP][3], /45 записей/); // итоги по всем
  assert.match(reportCsv(buildReport(EV, {from: "2026-10-01", to: "2026-10-31", kind: "venue"})), /^﻿/);
});

function api() {
  const book = new MemoryBook({[TABS.schedule]: ROWS, [TABS.staff]: STAFF});
  const store = new Store(book, {secret: "t", now: () => NOW});
  const saved = [];
  const deps = {store, secret: "s", now: () => NOW, saveReport: (r, by) => { saved.push([r, by]); return {number: 7}; }};
  store.ensureLogins();
  const login = (phone) => handleApi({method: "POST", path: "/api/login", body: {login: store.users().find((u) => u.phone === phone).login}}, deps).body.token;
  return {saved, call: (token, body) => handleApi({method: "POST", path: "/api/report", token, body}, deps), login};
}

test("API: отчёт только у администраторов, проверяет параметры, сохраняет по запросу", () => {
  const t = api();
  const p = {from: "2026-10-01", to: "2026-10-31", kind: "venue", value: ""};
  assert.equal(t.call(t.login("9000000002"), p).status, 403); // читатель
  const admin = t.login("9000000001");
  assert.equal(t.call(admin, {...p, to: "2026-09-01"}).status, 400);
  assert.equal(t.call(admin, {...p, kind: "x"}).status, 400);
  const r = t.call(admin, p);
  assert.equal(r.status, 200);
  assert.equal(t.saved.length, 0);
  const s = t.call(admin, {...p, save: true, csv: true});
  assert.deepEqual([s.body.saved.number, t.saved[0][1]], [7, "Иванова М.В."]);
  assert.ok(s.body.csv.includes("Большая сцена"));
});

test("лист «Отчёты»: новый отчёт сверху, одинаковые блоки, метка только у последнего, старые удаляются", () => {
  const g = loadGas({tabs: {[TABS.schedule]: ROWS, [TABS.staff]: STAFF}, props: {SHEET_ID: "x"}, now: NOW});
  const rep = (kind, value) => buildReport(EV, {from: "2026-10-01", to: "2026-10-31", kind, value});
  g.ctx.__rep = rep("venue", "Большая сцена");
  const run = (n) => g.run(`saveReport_(${n === 1 ? "__rep" : "__rep2"}, "Иванова")`);
  g.ctx.__rep2 = rep("person", "Иванова М.В.");
  assert.equal(run(1).number, 1);
  assert.equal(run(2).number, 2);
  const sh = g.ss.getSheetByName(TABS.reports);
  assert.ok(!sh.hidden);
  assert.match(sh.cells[0][0], /^ОТЧЁТ № 2 · Сотрудник: Иванова/);
  assert.equal(sh.cells[0][6], "● ПОСЛЕДНИЙ");
  assert.match(sh.cells[REPORT_HEIGHT][0], /^ОТЧЁТ № 1 · Площадка/);
  assert.equal(sh.cells[REPORT_HEIGHT][6] || "", "");
  for (let i = 0; i < 20; i++) run(1);
  assert.ok(sh.getLastRow() <= 15 * REPORT_HEIGHT);
  assert.match(sh.cells[0][0], /№ 22/);
});

test("скорость: повторный запрос расписания не читает таблицу (события, комментарии, аватарки в кеше), правка кеш сбрасывает", () => {
  const tabs = {[TABS.schedule]: [["Дата", "Начало", "Конец", "Событие", "Площадка", "Касса", "ID"], ["04.10.2026", "11:00", "13:00", "Бука", "Малая сцена", "Иванова М.В.", "a1"]], [TABS.staff]: STAFF,
    [TABS.meta]: [["ID события", "Тип", "Описание", "—", "Автор", "Создано"], ["a1", "meeting", "x", "", "u", "1"]],
    [TABS.comments]: [["ID события", "ID", "Время", "Телефон", "Имя", "Текст", "Фото"], ["a1", "c1", "1", "9000000001", "И", "привет", "[]"]],
    [TABS.avatars]: [["Телефон", "Канал", "Фото", "Обновлено"], ["9000000001", "telegram", "http://x", "1"]]};
  const g = loadGas({tabs, props: {SHEET_ID: "x", STYLE_VER: "20", TOP_ROWS_DONE: "1", TEST_USERS: "1", OWNER_PHONE: "9000000001"}, now: NOW});
  const call = (req) => JSON.parse(g.run(`doPost(${JSON.stringify({postData: {contents: JSON.stringify(req)}})}).getContent()`));
  g.run("store_().ensureLogins()");
  const login = g.run('store_().users().find((u) => u.phone === "9000000001").login');
  const token = call({method: "POST", path: "/api/login", body: {login}}).token;
  const reads = () => g.ss.sheets.reduce((a, s) => a + (s.reads || 0), 0);
  call({method: "GET", path: "/api/schedule", token});
  const before = reads();
  const r = call({method: "GET", path: "/api/schedule", token});
  assert.equal(reads(), before, "второй запрос не должен читать таблицу");
  assert.equal(r.events[0].comments, 1);
  call({method: "POST", path: "/api/comments", token, body: {event: "a1", text: "ещё"}});
  assert.equal(call({method: "GET", path: "/api/schedule", token}).events[0].comments, 2, "после правки кеш обновился");
});
