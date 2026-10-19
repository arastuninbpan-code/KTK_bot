// Новый формат листа (Дата | Начало | Конец | Событие | Площадка | роли), занятость площадок, группы, лёгкая проверка версии.
import test from "node:test";
import assert from "node:assert/strict";
import {handleApi} from "../lib/api.mjs";
import {buildRow, diffRows, findConflicts, layoutOf, migrateTable, parseEvents, parseGrid, validateEvent} from "../lib/core.mjs";
import {msgChanged, msgReminder, shiftsText} from "../lib/format.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";
import {Store, TABS} from "../lib/store.mjs";
import {HEAD, msk, SCHEDULE, STAFF} from "./helpers.mjs";
import "../lib/platform-node.mjs";

const TODAY = "2026-10-01";
const ROLES = HEAD.slice(2);
export const HEAD2 = ["Дата", "Начало", "Конец", "Событие", "Площадка", ...ROLES];
const row2 = (date, start, end, title, hall, ...people) => { const r = [date, start, end, title, hall, ...people]; while (r.length < HEAD2.length) r.push(""); return r; };
const V2 = [HEAD2,
  row2("04.10", "11:00", "12:30", "Спектакль «Бука»", "Малая сцена", "Иванова М.В.", "Морозова Н.М."),
  row2("04.10", "13:00", "", "Спектакль «Бука»", "Малая сцена", "Иванова М.В."),
  row2("10.10", "", "", "Сказки из старого чемодана", "", "Петрова Л.Н.")];

test("читаем новый лист: начало, конец, площадка; формат узнаётся по заголовку", () => {
  assert.equal(layoutOf(V2).v, 2);
  assert.equal(layoutOf(SCHEDULE).v, 1);
  const ev = parseEvents(V2, TODAY);
  assert.deepEqual(ev.map((e) => [e.row, e.time, e.end, e.hall, e.title]), [
    [2, "11:00", "12:30", "Малая сцена", "Спектакль «Бука»"], [3, "13:00", "", "Малая сцена", "Спектакль «Бука»"], [4, "", "", "", "Сказки из старого чемодана"]]);
  assert.deepEqual(ev[0].roles["Администратор/ Капельдинер"], ["Иванова М.В."]);
  assert.deepEqual(ev[0].roles["Гардероб/ Уборщица"], ["Морозова Н.М."]);
});

test("запись события в новый лист читается тем же разбором (в т. ч. диапазон дат и время через точку)", () => {
  const roles = HEAD2.slice(5).map((c) => c.replace(/\s+/g, " ").trim());
  const e = {date: "2026-10-12", dateEnd: "2026-10-14", time: "9.05", end: "11:00", title: "Фестиваль", hall: "Фойе", roles: {[roles[0]]: ["Иванова М.В."]}};
  const cells = buildRow(e, roles, TODAY, {v: 2});
  assert.deepEqual(cells.slice(0, 5), ["12.10 до 14.10", "09:05", "11:00", "Фестиваль", "Фойе"]);
  const [back] = parseEvents([HEAD2, cells], TODAY);
  assert.deepEqual([back.date, back.dateEnd, back.time, back.end, back.title, back.hall], ["2026-10-12", "2026-10-14", "09:05", "11:00", "Фестиваль", "Фойе"]);
});

test("перенос старого листа: время в отдельные колонки, зал — в «Площадку», два времени — две строки, люди и месяцы остаются", () => {
  const old = [...SCHEDULE.slice(0, 3), ["ОКТЯБРЬ 2026", "", "", "", "", "", ""]];
  const out = migrateTable(old, TODAY);
  assert.deepEqual(out.map((r) => r.slice(0, 5).join("|")), [
    "Дата|Начало|Конец|Событие|Площадка", "01.10|||Спектакль «Игра» репетиция|большая сцена",
    "04.10|11:00||Спектакль «Бука»|малая сцена", "04.10|13:00||Спектакль «Бука»|малая сцена", "ОКТЯБРЬ 2026||||"]);
  assert.equal(new Set(out.map((r) => r.length)).size, 1);
  assert.equal(out[1][5], "Иванова М.В./ Петрова Л.Н."); // ячейки с людьми перенесены как были
  assert.equal(migrateTable(out, TODAY), out); // повторный перенос ничего не делает
  const names = parseEvents(out, TODAY).map((e) => e.title + "@" + e.hall + "@" + e.time);
  assert.deepEqual(names, ["Спектакль «Игра» репетиция@большая сцена@", "Спектакль «Бука»@малая сцена@11:00", "Спектакль «Бука»@малая сцена@13:00"]);
});

const ev = (date, time, end, hall, extra = {}) => ({row: 9, date, dateEnd: "", time, end, hall, title: "X", ...extra});

test("занятость площадки: пересечение по времени, стык не конфликт, нет конца = 2 часа, без времени = весь день, другие площадки не мешают", () => {
  const busy = [ev("2026-10-04", "11:00", "12:30", "Малая сцена", {row: 2, title: "Бука"})];
  assert.equal(findConflicts(busy, ev("2026-10-04", "12:00", "13:00", "малая  сцена", {row: -1})).length, 1); // регистр и пробелы не важны
  assert.equal(findConflicts(busy, ev("2026-10-04", "12:30", "14:00", "Малая сцена", {row: -1})).length, 0); // встык
  assert.equal(findConflicts(busy, ev("2026-10-04", "10:00", "11:00", "Малая сцена", {row: -1})).length, 0);
  assert.equal(findConflicts(busy, ev("2026-10-04", "10:00", "", "Малая сцена", {row: -1})).length, 1); // 10:00 + 2 часа заходит на 11:00
  assert.equal(findConflicts(busy, ev("2026-10-04", "", "", "Малая сцена", {row: -1})).length, 1); // без времени — весь день
  assert.equal(findConflicts(busy, ev("2026-10-05", "11:00", "12:00", "Малая сцена", {row: -1})).length, 0); // другой день
  assert.equal(findConflicts(busy, ev("2026-10-04", "11:00", "12:00", "Большая сцена", {row: -1})).length, 0);
  assert.equal(findConflicts(busy, ev("2026-10-04", "11:00", "12:00", "", {row: -1})).length, 0); // площадка не выбрана
  assert.equal(findConflicts(busy, ev("2026-10-04", "11:00", "12:30", "Малая сцена", {row: 2})).length, 0); // само с собой при правке
  const fest = [ev("2026-10-08", "", "", "Фойе", {row: 3, dateEnd: "2026-10-12", title: "Фестиваль"})];
  assert.equal(findConflicts(fest, ev("2026-10-10", "15:00", "16:00", "Фойе", {row: -1})).length, 1); // многодневное занимает все дни
});

test("diff: изменилось окончание — это «изменено»; одно событие дважды в день не склеивается", () => {
  const a = parseGrid([HEAD2, row2("04.10", "11:00", "", "Бука", "", "Иванова М.В."), row2("04.10", "13:00", "", "Бука", "", "Иванова М.В.")], TODAY);
  assert.equal(a.length, 2);
  assert.notEqual(a[0].seq, a[1].seq);
  const b = parseGrid([HEAD2, row2("04.10", "11:00", "12:30", "Бука", "", "Иванова М.В."), row2("04.10", "13:00", "", "Бука", "", "Иванова М.В.")], TODAY);
  const d = diffRows(a, b, TODAY);
  assert.deepEqual(d.map((c) => c.kind), ["changed"]);
  assert.equal(d[0].row.end, "12:30");
  assert.deepEqual(diffRows(a, a, TODAY), []);
});

test("проверка события: окончание только вместе с началом", () => {
  assert.deepEqual(validateEvent({date: "2026-10-12", title: "X", time: "11:00", end: "12:30"}), []);
  assert.equal(validateEvent({date: "2026-10-12", title: "X", end: "12:30"}).length, 1);
  assert.equal(validateEvent({date: "2026-10-12", title: "X", time: "11:00", end: "позже"}).length, 1);
});

test("сообщения бота показывают «начало–конец» и перенос окончания", () => {
  const r = {date: "2026-10-04", time: "11:00", end: "12:30", event: "Бука", hall: "Малая сцена", role: "Касса", person: "Иванова М.В."};
  assert.match(shiftsText([r]), /⏰ 11:00–12:30/);
  assert.match(msgReminder("hour", [r]), /❗ <b>Через час у вас смена<\/b>[\s\S]*⏰ 11:00–12:30/);
  assert.match(msgChanged({...r, end: "13:00"}, r), /⏰ <s>11:00–12:30<\/s> → <b>11:00–13:00<\/b>/);
});

// ---- API ----
const NOW = msk(1, 10);
function make() {
  const book = new MemoryBook({[TABS.schedule]: V2, [TABS.staff]: [[...STAFF[0], "Логин", "Актёры", "Техника"],
    ["Иванова М.В.", "+7 900 000-00-01", "Админ", "ADM111", "TRUE", ""], ["Петрова Л.Н.", "8 900 000 00 02", "Читатель", "RDR222", "TRUE", "TRUE"], ["Сидорова Л.Р.", "9000000003", "", "SID333", "", "TRUE"],
    ["Орлова А.В.", "9000000005", "Заблокирован", "BLK444", "TRUE", ""]], [TABS.venues]: [["Площадка", "Заметка"], ["Малая сцена", ""], ["Большая сцена", ""]]});
  const store = new Store(book, {secret: "t", now: () => NOW});
  let rev = "1";
  const ctx = {book, store, changes: 0};
  const deps = {store, secret: "s", now: () => NOW, afterChange: () => { ctx.changes++; }, getRev: () => rev, bumpRev: () => { rev = String(Number(rev) + 1); }};
  ctx.call = (method, path, token, body = {}) => handleApi({method, path, token, body}, deps);
  ctx.login = (login) => ctx.call("POST", "/api/login", "", {login}).body.token;
  return ctx;
}
const NEW = {date: "2026-10-04", time: "12:00", end: "13:00", title: "Репетиция", hall: "Малая сцена", roles: {}};

test("API: расписание отдаёт начало/конец, формат, площадки и (редакторам) группы; читателю группы не отдаём", () => {
  const ctx = make();
  const admin = ctx.call("GET", "/api/schedule", ctx.login("adm111")).body;
  assert.equal(admin.layout, 2);
  assert.deepEqual([admin.events[0].time, admin.events[0].end, admin.events[0].hall], ["11:00", "12:30", "Малая сцена"]);
  assert.deepEqual(admin.venues, ["Малая сцена", "Большая сцена"]);
  assert.deepEqual(admin.groups, [{name: "Актёры", members: ["Иванова М.В.", "Петрова Л.Н."]}, {name: "Техника", members: ["Петрова Л.Н.", "Сидорова Л.Р."]}]); // заблокированная Орлова не входит
  const reader = ctx.call("GET", "/api/schedule", ctx.login("rdr222")).body;
  assert.equal(reader.groups, undefined);
  assert.equal(reader.staff, undefined);
});

test("API: площадка занята — предупреждение со списком пересечений; «всё равно сохранить» (force) записывает в нужные колонки", () => {
  const ctx = make();
  const t = ctx.login("ADM111");
  const r = ctx.call("POST", "/api/events", t, {event: NEW});
  assert.equal(r.status, 409);
  assert.equal(r.body.conflicts[0].title, "Спектакль «Бука»");
  assert.match(r.body.error, /Площадка «Малая сцена» занята: Спектакль «Бука» \(11:00–12:30\)/);
  assert.equal(ctx.changes, 0);
  const ok = ctx.call("POST", "/api/events", t, {event: NEW, force: true});
  assert.equal(ok.status, 200);
  assert.deepEqual(ctx.book.get(TABS.schedule).map((r) => r.slice(0, 5).join("|")).slice(1), [
    "04.10|11:00|12:30|Спектакль «Бука»|Малая сцена", "04.10|13:00||Спектакль «Бука»|Малая сцена", "04.10|12:00|13:00|Репетиция|Малая сцена", "10.10|||Сказки из старого чемодана|"]);
});

test("API: свободное время и правка собственного события не считаются конфликтом; конец без начала — ошибка", () => {
  const ctx = make();
  const t = ctx.login("ADM111");
  assert.equal(ctx.call("POST", "/api/events", t, {event: {...NEW, time: "15:00", end: "16:00"}}).status, 200);
  const first = ctx.call("GET", "/api/schedule", t).body.events[0];
  const same = {title: first.title, date: first.date, time: first.time, end: "12:00", hall: first.hall, roles: {}};
  assert.equal(ctx.call("PUT", `/api/events/${first.row}`, t, {event: same, rev: first.rev}).status, 200);
  assert.equal(ctx.call("POST", "/api/events", t, {event: {...NEW, time: "", end: "10:00", hall: ""}}).status, 400);
});

test("API: площадки добавляют и убирают только админ и редактор; с будущими событиями убрать нельзя", () => {
  const ctx = make();
  assert.equal(ctx.call("POST", "/api/venues", ctx.login("RDR222"), {name: "Фойе"}).status, 403);
  const t = ctx.login("ADM111");
  const add = ctx.call("POST", "/api/venues", t, {name: "  Репетиционный   зал "});
  assert.deepEqual(add.body.venues, ["Малая сцена", "Большая сцена", "Репетиционный зал"]);
  assert.deepEqual(ctx.call("POST", "/api/venues", t, {name: "репетиционный зал"}).body.venues.length, 3); // повтор не дублируется
  assert.equal(ctx.call("DELETE", "/api/venues", t, {name: "Малая сцена"}).status, 409); // там «Бука»
  assert.deepEqual(ctx.call("DELETE", "/api/venues", t, {name: "Репетиционный зал"}).body.venues, ["Малая сцена", "Большая сцена"]);
  assert.equal(ctx.call("POST", "/api/venues", t, {name: ""}).status, 400);
});

test("API: ping отвечает без чтения таблицы, а версия растёт после любой правки", () => {
  const ctx = make();
  const t = ctx.login("RDR222");
  const same = ctx.call("GET", "/api/ping", t, {rev: "1"});
  assert.deepEqual(same.body, {rev: "1", changed: false});
  ctx.book.get = () => { throw new Error("таблицу читать не должны"); };
  assert.equal(ctx.call("GET", "/api/ping", t, {rev: "0"}).body.changed, true);
  assert.equal(ctx.call("GET", "/api/ping", "мусор", {rev: "1"}).status, 401);
});
