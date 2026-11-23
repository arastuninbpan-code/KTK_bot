import test from "node:test";
import assert from "node:assert/strict";
import {handleApi, insertPosition} from "../lib/api.mjs";
import {readToken} from "../lib/auth.mjs";
import {TABS} from "../lib/store.mjs";
import {msk, setup} from "./helpers.mjs";

const NOW = msk(1, 10);
const CLIENT = "test_browser_000000000001";
function make() {
  const ctx = setup(NOW);
  ctx.now = NOW;
  ctx.store.now = () => ctx.now;
  ctx.changes = 0;
  ctx.deps = {store: ctx.store, secret: "s3", now: () => ctx.now, afterChange: () => { ctx.changes++; }};
  ctx.call = (method, path, token, body = {}) => {
    if (["/api/identify", "/api/login", "/api/activate"].includes(path) && !body.client) body = {...body, client: CLIENT};
    return handleApi({method, path, token, body}, ctx.deps);
  };
  ctx.login = (phone) => { ctx.store.ensureLogins(); return ctx.call("POST", "/api/login", "", {pin: ctx.store.users().find((u) => u.phone === phone).pin}); };
  return ctx;
}
const NEW = {date: "2026-10-06", time: "15:00", title: "Экскурсия", hall: "большая сцена", roles: {"Администратор/ Капельдинер": ["Петрова Л.Н."]}};

test("один PIN даёт вход, смена PIN завершает старую сессию", () => {
  const ctx = make();
  const ok = ctx.login("9000000002");
  assert.equal(ok.status, 200);
  assert.equal(readToken(ok.body.token, "s3", NOW).sub, "9000000002");
  const employee = ctx.store.users().find((u) => u.phone === "9000000002");
  const {pin} = ctx.store.staffCols_(ctx.book.get(TABS.staff));
  const newPin = Array.from({length: 10}, (_, i) => String(i).padStart(6, "0")).find((p) => !ctx.store.findByPin(p));
  ctx.book.setCell(TABS.staff, employee.row, pin + 1, newPin);
  assert.equal(ctx.call("POST", "/api/login", "", {pin: employee.pin}).status, 401);
  assert.equal(ctx.call("GET", "/api/schedule", ok.body.token).status, 401);
  assert.equal(ctx.call("POST", "/api/login", "", {pin: newPin}).status, 200);
  assert.equal(ctx.login("9000000005").status, 403);
});

test("приложение: пять ошибок блокируют устройство, верный PIN не обходит 15 минут", () => {
  const ctx = make(); ctx.store.ensureLogins();
  const user = ctx.store.users().find((u) => u.phone === "9000000001");
  const client = "blocked_browser_000000001";
  for (let i = 1; i <= 4; i++) {
    const r = ctx.call("POST", "/api/login", "", {login: user.login, pin: "999999", client});
    assert.equal(r.status, 401); assert.match(r.body.error, new RegExp(`Осталось попыток: ${5 - i}`));
  }
  assert.equal(ctx.call("POST", "/api/login", "", {login: user.login, pin: "999999", client}).status, 429);
  assert.equal(ctx.call("POST", "/api/login", "", {login: user.login, pin: user.pin, client}).status, 429, "правильный PIN во время блокировки тоже запрещён");
  ctx.now += 15 * 60 * 1000 + 1;
  assert.equal(ctx.call("POST", "/api/login", "", {login: user.login, pin: user.pin, client}).status, 200);
  assert.equal(ctx.store.authState("app", client).attempts, 0);
});

test("ступени входа: 15 минут, 30 минут, час, затем полная блокировка до решения директора", () => {
  const ctx = make(); ctx.store.ensureLogins();
  const user = ctx.store.users().find((u) => u.phone === "9000000002");
  const client = "iphone_style_lock_000001";
  const failFive = () => Array.from({length: 5}, () => ctx.call("POST", "/api/login", "", {login: user.login, pin: "999999", client})).at(-1);
  let r = failFive(); assert.equal(r.status, 429); assert.match(r.body.error, /15 минут/);
  ctx.now += 15 * 60 * 1000 + 1;
  r = failFive(); assert.equal(r.status, 429); assert.match(r.body.error, /30 минут/);
  ctx.now += 30 * 60 * 1000 + 1;
  r = failFive(); assert.equal(r.status, 429); assert.match(r.body.error, /60 минут/);
  ctx.now += 60 * 60 * 1000 + 1;
  r = failFive(); assert.equal(r.status, 423); assert.match(r.body.error, /полностью заблокирован/);
  ctx.now += 24 * 60 * 60 * 1000;
  assert.equal(ctx.call("POST", "/api/login", "", {login: user.login, pin: user.pin, client}).status, 423, "время не снимает полную блокировку");
  assert.equal(ctx.store.users().find((u) => u.phone === user.phone).temporary, false);
  ctx.store.authSucceeded("app", client);
  assert.equal(ctx.call("POST", "/api/login", "", {login: user.login, pin: user.pin, client}).status, 200);
});

test("общий предел попыток действует при смене идентификатора браузера", () => {
  const ctx = make();
  ctx.store.ensureLogins();
  const user = ctx.store.users()[0];
  const wrong = Array.from({length: 10}, (_, i) => String(i).padStart(6, "0")).find((p) => !ctx.store.findByPin(p));
  for (let i = 0; i < 30; i++) {
    assert.equal(ctx.call("POST", "/api/login", "", {pin: wrong, client: "new_browser_00000000_" + i}).status, 401);
  }
  assert.equal(ctx.call("POST", "/api/login", "", {pin: user.pin}).status, 429);
  ctx.now += 3600001;
  assert.equal(ctx.call("POST", "/api/login", "", {pin: user.pin}).status, 200);
});

test("пустые PIN заполняются, дубликаты не дают войти", () => {
  const ctx = make();
  ctx.store.ensureLogins();
  const users = ctx.store.users();
  assert.ok(users.every((u) => /^\d{6}$/.test(u.pin)));
  assert.equal(new Set(users.map((u) => u.pin)).size, users.length);
  const {pin} = ctx.store.staffCols_(ctx.book.get(TABS.staff));
  ctx.book.setCell(TABS.staff, users[1].row, pin + 1, users[0].pin);
  assert.equal(ctx.call("POST", "/api/login", "", {pin: users[0].pin}).status, 401);
  assert.equal(ctx.call("POST", "/api/activate", "", {login: users[0].login, pin: "999999"}).status, 401);
});

test("расписание: события, «мои» смены, список сотрудников только тем, кто может править", () => {
  const ctx = make();
  const reader = ctx.login("9000000002").body.token;
  const admin = ctx.login("9000000001").body.token;
  const s = ctx.call("GET", "/api/schedule", reader).body;
  assert.deepEqual(s.events.map((e) => e.row), [2, 3, 5]);
  assert.deepEqual(s.events[0].mine, ["Администратор/ Капельдинер"]); // Петрова в 1-м событии
  assert.deepEqual(s.events[1].mine, []);
  assert.equal(s.staff, undefined);
  assert.equal(s.roles.length, 5);
  const d = ctx.call("GET", "/api/schedule", admin).body;
  assert.equal(d.me.roleLabel, "Админ");
  assert.deepEqual(d.staff, ["Иванова М.В.", "Морозова Н.М.", "Петрова Л.Н.", "Сидорова Л.Р."]); // заблокированная Орлова не в списке
});

test("менять расписание: читатель не может, редактор и админ могут", () => {
  const ctx = make();
  const reader = ctx.login("9000000002").body.token;
  for (const [m, p] of [["POST", "/api/events"], ["PUT", "/api/events/3"], ["DELETE", "/api/events/3"]]) {
    assert.equal(ctx.call(m, p, reader, {event: NEW}).status, 403, m);
  }
  assert.equal(ctx.changes, 0);
  assert.equal(ctx.book.get(TABS.schedule).length, 5);
  const editor = ctx.login("9000000004").body.token;
  assert.equal(ctx.call("POST", "/api/events", editor, {event: NEW}).status, 200);
});

test("создать (в порядке дат), изменить, перенести на другую дату, удалить", () => {
  const ctx = make();
  const admin = ctx.login("9000000001").body.token;
  assert.equal(ctx.call("POST", "/api/events", admin, {event: NEW}).status, 200);
  let t = ctx.book.get(TABS.schedule);
  assert.deepEqual(t[4].slice(0, 3), ["06.10\n15.00", "Экскурсия\n(большая сцена)", "Петрова Л.Н."]); // между 05.10 и 10.10
  assert.equal(ctx.changes, 1);

  const rev = ctx.call("GET", "/api/schedule", admin).body.events.find((e) => e.title === "Экскурсия").rev;
  const upd = {...NEW, time: "16:00", roles: {"Администратор/ Капельдинер": ["Петрова Л.Н."], "Касса": ["Сидорова Л.Р."]}};
  assert.equal(ctx.call("PUT", "/api/events/5", admin, {event: upd, rev}).status, 200);
  t = ctx.book.get(TABS.schedule);
  assert.deepEqual([t[4][0], t[4][4]], ["06.10\n16.00", "Сидорова Л.Р."]);
  assert.equal(ctx.call("PUT", "/api/events/5", admin, {event: upd, rev}).status, 409); // кто-то уже поменял

  assert.equal(ctx.call("PUT", "/api/events/5", admin, {event: {...upd, date: "2026-10-20"}}).status, 200);
  t = ctx.book.get(TABS.schedule);
  assert.equal(t.at(-1)[0], "20.10\n16.00"); // ушла в конец по порядку дат
  assert.equal(t.length, 6);

  assert.equal(ctx.call("DELETE", "/api/events/6", admin, {}).status, 200);
  assert.equal(ctx.book.get(TABS.schedule).length, 5);
  assert.equal(ctx.changes, 4);
});

test("ошибки: неверные данные, неизвестные роль и сотрудник, несуществующая строка", () => {
  const ctx = make();
  const admin = ctx.login("9000000001").body.token;
  const bad = ctx.call("POST", "/api/events", admin, {event: {date: "нет", title: ""}});
  assert.equal(bad.status, 400); assert.match(bad.body.error, /дату[\s\S]*название/);
  const r = ctx.call("POST", "/api/events", admin, {event: {...NEW, roles: {"Пилот": ["Петрова Л.Н."], "Касса": ["Неизвестный"]}}});
  assert.match(r.body.error, /Нет такой роли: Пилот[\s\S]*Нет такого сотрудника: Неизвестный/);
  assert.equal(ctx.call("PUT", "/api/events/99", admin, {event: NEW}).status, 404);
  assert.equal(ctx.changes, 0);
});

test("позиция вставки по дате", () => {
  const t = [["Дата"], ["01.10"], ["04.10"], ["10.10"]];
  assert.equal(insertPosition(t, "2026-10-06", "2026-10-01"), 4);
  assert.equal(insertPosition(t, "2026-09-01", "2026-10-01"), 2);
  assert.equal(insertPosition(t, "2026-12-01", "2026-10-01"), 5);
});
