import test from "node:test";
import assert from "node:assert/strict";
import {handleApi, insertPosition} from "../lib/api.mjs";
import {readToken} from "../lib/auth.mjs";
import {TABS} from "../lib/store.mjs";
import {msk, setup} from "./helpers.mjs";

const NOW = msk(1, 10);
async function loginAs(ctx, phone) {
  const code = await ctx.store.issueCode(phone);
  const r = await handleApi({method: "POST", path: "/api/login", body: {code}}, ctx.deps);
  return r;
}
function make() {
  const ctx = setup(NOW);
  ctx.changes = 0;
  ctx.deps = {store: ctx.store, secret: "s3", now: () => NOW, afterChange: async () => { ctx.changes++; }};
  ctx.call = (method, path, token, body = {}, query = {}) => handleApi({method, path, token, body, query}, ctx.deps);
  return ctx;
}
const NEW = {date: "2026-10-06", time: "15:00", title: "Экскурсия", hall: "большая сцена", roles: {"Администратор/ Капельдинер": ["Петрова Л.Н."]}};

test("вход по коду: верный, повторный, неверный", async () => {
  const ctx = make();
  const ok = await loginAs(ctx, "9000000002");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.user, {name: "Петрова Л.Н.", role: "staff"});
  assert.equal(readToken(ok.body.token, "s3", NOW).sub, "9000000002");
  const code = await ctx.store.issueCode("9000000002");
  await handleApi({method: "POST", path: "/api/login", body: {code}}, ctx.deps);
  assert.equal((await handleApi({method: "POST", path: "/api/login", body: {code}}, ctx.deps)).status, 401);
  assert.equal((await ctx.call("GET", "/api/schedule", "мусор")).status, 401);
});

test("расписание: события, «мои» смены, список сотрудников только директору", async () => {
  const ctx = make();
  const staff = (await loginAs(ctx, "9000000002")).body.token;
  const dir = (await loginAs(ctx, "9000000001")).body.token;
  const s = (await ctx.call("GET", "/api/schedule", staff)).body;
  assert.deepEqual(s.events.map((e) => e.row), [2, 3, 5]);
  assert.deepEqual(s.events[0].mine, ["Администратор/ Капельдинер"]); // Петрова в 1-м событии
  assert.deepEqual(s.events[1].mine, []);
  assert.equal(s.staff, undefined);
  assert.equal(s.roles.length, 5);
  const d = (await ctx.call("GET", "/api/schedule", dir)).body;
  assert.equal(d.me.role, "director");
  assert.deepEqual(d.staff, ["Иванова М.В.", "Морозова Н.М.", "Петрова Л.Н.", "Сидорова Л.Р."]);
});

test("менять расписание может только директор", async () => {
  const ctx = make();
  const staff = (await loginAs(ctx, "9000000002")).body.token;
  for (const [m, p] of [["POST", "/api/events"], ["PUT", "/api/events/3"], ["DELETE", "/api/events/3"]]) {
    assert.equal((await ctx.call(m, p, staff, {event: NEW})).status, 403, m);
  }
  assert.equal(ctx.changes, 0);
  assert.equal((await ctx.book.get(TABS.schedule)).length, 5);
});

test("директор: создать (в порядке дат), изменить, перенести на другую дату, удалить", async () => {
  const ctx = make();
  const dir = (await loginAs(ctx, "9000000001")).body.token;
  assert.equal((await ctx.call("POST", "/api/events", dir, {event: NEW})).status, 200);
  let t = await ctx.book.get(TABS.schedule);
  assert.deepEqual(t[4].slice(0, 3), ["06.10\n15.00", "Экскурсия\n(большая сцена)", "Петрова Л.Н."]); // между 05.10 и 10.10
  assert.equal(ctx.changes, 1);

  const rev = (await ctx.call("GET", "/api/schedule", dir)).body.events.find((e) => e.title === "Экскурсия").rev;
  const upd = {...NEW, time: "16:00", roles: {"Администратор/ Капельдинер": ["Петрова Л.Н."], "Касса": ["Сидорова Л.Р."]}};
  assert.equal((await ctx.call("PUT", "/api/events/5", dir, {event: upd, rev})).status, 200);
  t = await ctx.book.get(TABS.schedule);
  assert.deepEqual([t[4][0], t[4][4]], ["06.10\n16.00", "Сидорова Л.Р."]);

  assert.equal((await ctx.call("PUT", "/api/events/5", dir, {event: upd, rev})).status, 409); // кто-то уже поменял

  const moved = {...upd, date: "2026-10-20"};
  assert.equal((await ctx.call("PUT", "/api/events/5", dir, {event: moved})).status, 200);
  t = await ctx.book.get(TABS.schedule);
  assert.equal(t.at(-1)[0], "20.10\n16.00"); // ушла в конец по порядку дат
  assert.equal(t.length, 6);

  assert.equal((await ctx.call("DELETE", "/api/events/6", dir, {})).status, 200);
  assert.equal((await ctx.book.get(TABS.schedule)).length, 5);
  assert.equal(ctx.changes, 4);
});

test("ошибки: неверные данные, неизвестные роль и сотрудник, несуществующая строка", async () => {
  const ctx = make();
  const dir = (await loginAs(ctx, "9000000001")).body.token;
  const bad = await ctx.call("POST", "/api/events", dir, {event: {date: "нет", title: ""}});
  assert.equal(bad.status, 400); assert.match(bad.body.error, /дату[\s\S]*название/);
  const r = await ctx.call("POST", "/api/events", dir, {event: {...NEW, roles: {"Пилот": ["Петрова Л.Н."], "Касса": ["Неизвестный"]}}});
  assert.match(r.body.error, /Нет такой роли: Пилот[\s\S]*Нет такого сотрудника: Неизвестный/);
  assert.equal((await ctx.call("PUT", "/api/events/99", dir, {event: NEW})).status, 404);
  assert.equal(ctx.changes, 0);
});

test("позиция вставки по дате", () => {
  const t = [["Дата"], ["01.10"], ["04.10"], ["10.10"]];
  assert.equal(insertPosition(t, "2026-10-06", "2026-10-01"), 4);
  assert.equal(insertPosition(t, "2026-09-01", "2026-10-01"), 2);
  assert.equal(insertPosition(t, "2026-12-01", "2026-10-01"), 5);
});
