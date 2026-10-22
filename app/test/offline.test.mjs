import test from "node:test";
import assert from "node:assert/strict";
import {handleApi} from "../lib/api.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";
import {Store, TABS} from "../lib/store.mjs";
import {msk, STAFF} from "./helpers.mjs";

const NOW = msk(1, 10);
function make() {
  const book = new MemoryBook({[TABS.schedule]: [["Дата", "Начало", "Конец", "Событие", "Площадка", "Касса", "ID"]], [TABS.staff]: STAFF});
  const store = new Store(book, {secret: "t", now: () => NOW});
  const venueTouched = [];
  const deps = {store, secret: "s", now: () => NOW, afterVenues: () => venueTouched.push(1)};
  store.ensureLogins();
  const login = (phone) => handleApi({method: "POST", path: "/api/login", body: {login: store.users().find((u) => u.phone === phone).login}}, deps).body.token;
  const token = login("9000000001");
  return {book, venueTouched, call: (method, path, body = {}) => handleApi({method, path, token, body}, deps)};
}
const EV = {title: "Сказка", date: "2026-10-12", dateEnd: "", time: "10:00", end: "11:00", hall: "", roles: {}};

test("событие с ID от приложения: повторная отправка (связь оборвалась на ответе) ничего не задваивает", () => {
  const t = make();
  const a = t.call("POST", "/api/events", {event: EV, id: "abcd1234"});
  assert.deepEqual([a.status, a.body.id], [200, "abcd1234"]);
  const b = t.call("POST", "/api/events", {event: EV, id: "abcd1234"});
  assert.deepEqual([b.status, b.body.duplicate], [200, true]);
  const s = t.call("GET", "/api/schedule").body;
  assert.equal(s.events.filter((e) => e.title === "Сказка").length, 1);
  assert.equal(s.events[0].id, "abcd1234");
});

test("правка и удаление по ID работают, даже если строки сдвинулись; удаление уже удалённого — не ошибка", () => {
  const t = make();
  t.call("POST", "/api/events", {event: {...EV, title: "Первое", date: "2026-10-20"}, id: "00000001"});
  t.call("POST", "/api/events", {event: {...EV, title: "Второе", date: "2026-10-10"}, id: "00000002"}); // встаёт выше первого
  const put = t.call("PUT", "/api/events/id-00000001", {event: {...EV, title: "Первое (изм.)", date: "2026-10-20"}});
  assert.equal(put.status, 200);
  assert.ok(t.call("GET", "/api/schedule").body.events.some((e) => e.id === "00000001" && e.title === "Первое (изм.)"));
  assert.equal(t.call("DELETE", "/api/events/id-00000002").status, 200);
  const again = t.call("DELETE", "/api/events/id-00000002");
  assert.deepEqual([again.status, again.body.gone], [200, true]);
  assert.equal(t.call("PUT", "/api/events/id-deadbeef", {event: EV}).status, 404);
  assert.deepEqual(t.call("GET", "/api/schedule").body.events.map((e) => e.id), ["00000001"]);
});

test("цвет площадки и дни «не могу» можно присылать повторно", () => {
  const t = make();
  assert.equal(t.call("POST", "/api/venues", {name: "Фойе", color: "Красный"}).status, 200);
  assert.equal(t.call("POST", "/api/venues", {name: "Фойе", color: "Красный"}).status, 200);
  assert.equal(t.call("PUT", "/api/venues", {name: "Фойе", color: "Красный"}).status, 200);
  assert.equal(t.call("DELETE", "/api/venues", {name: "Фойе"}).status, 200);
  assert.equal(t.call("DELETE", "/api/venues", {name: "Фойе"}).status, 200);
  assert.equal(t.call("POST", "/api/off", {add: ["2026-10-15"], remove: []}).status, 200);
  assert.equal(t.call("POST", "/api/off", {add: ["2026-10-15"], remove: []}).status, 200);
  assert.deepEqual(t.call("GET", "/api/schedule").body.me.off, ["2026-10-15"]);
});

test("сбой на сервере отвечает со статусом 500: приложение не считает правку сохранённой и повторит", async () => {
  const {loadGas} = await import("./gas-fake.mjs");
  const g = loadGas({tabs: {[TABS.schedule]: [["Дата"]], [TABS.staff]: STAFF}, props: {SHEET_ID: "x"}, now: NOW});
  const r = JSON.parse(g.run(`doPost({postData: {contents: "{не json"}}).getContent()`));
  assert.equal(r._status, 500);
  const nf = JSON.parse(g.run(`doPost({postData: {contents: JSON.stringify({path: "/x"})}}).getContent()`));
  assert.equal(nf._status, 404);
});

test("правка площадки (цвет, добавление, удаление) просит перерисовать таблицу занятости", () => {
  const t = make();
  t.call("POST", "/api/venues", {name: "Фойе", color: "Красный"});
  t.call("PUT", "/api/venues", {name: "Фойе", color: "Красный"});
  t.call("DELETE", "/api/venues", {name: "Фойе"});
  assert.equal(t.venueTouched.length, 3);
});
