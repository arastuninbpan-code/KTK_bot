import test from "node:test";
import assert from "node:assert/strict";
import {handleApi} from "../lib/api.mjs";
import {Store, TABS} from "../lib/store.mjs";
import {msk, STAFF} from "./helpers.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";
import {loadGas} from "./gas-fake.mjs";

const NOW = msk(1, 10);
const V2 = [["Дата", "Начало", "Конец", "Событие", "Площадка", "Касса", "ID"]];
function make({withId = true} = {}) {
  const sched = withId ? V2 : [V2[0].slice(0, 6)];
  const book = new MemoryBook({[TABS.schedule]: sched.map((r) => r.slice()), [TABS.staff]: STAFF});
  const store = new Store(book, {secret: "t", now: () => NOW});
  const announced = [];
  const deps = {store, secret: "s", now: () => NOW, announce: (a) => announced.push(a)};
  const call = (method, path, token, body = {}) => handleApi({method, path, token, body}, deps);
  store.ensureLogins();
  const login = (phone) => handleApi({method: "POST", path: "/api/login", body: {login: store.users().find((u) => u.phone === phone).login}}, deps).body.token;
  return {book, store, call, login, announced};
}
const MEETING = {title: "Собрание труппы", date: "2026-10-12", dateEnd: "", time: "18:00", end: "", hall: "", roles: {}};
const JPEG = "/9j/4AAQSkZJRgABAQEASABIAAD/" + "A".repeat(200); // правдоподобная base64-строка

test("собрание: создаётся с текстом документа, получает ID, рассылка вызывается один раз и несёт этот текст", () => {
  const t = make();
  const admin = t.login("9000000001");
  const doc = "Повестка собрания\n1. Афиша на ноябрь\n2. Репетиции";
  const r = t.call("POST", "/api/events", admin, {event: MEETING, meta: {kind: "meeting", note: doc, publish: true}});
  assert.equal(r.status, 200);
  assert.match(r.body.id, /^[0-9a-f]{8}$/);
  assert.equal(t.announced.length, 1);
  assert.deepEqual([t.announced[0].kind, t.announced[0].publish, t.announced[0].note, t.announced[0].event.id], ["meeting", true, doc, r.body.id]);
  const s = t.call("GET", "/api/schedule", admin).body;
  const ev = s.events.find((e) => e.title === "Собрание труппы");
  assert.deepEqual([ev.id, ev.meta.kind, ev.meta.note, ev.comments], [r.body.id, "meeting", doc, 0]);
  assert.equal(s.me.uid.length, 10);
  // обычное событие без meta ничего не рассылает, но ID получает
  const r2 = t.call("POST", "/api/events", admin, {event: {...MEETING, title: "Репетиция", date: "2026-10-13"}});
  assert.equal(t.announced.length, 1);
  assert.match(r2.body.id, /^[0-9a-f]{8}$/);
  // правка сохраняет ID и не рассылает снова
  const put = t.call("PUT", "/api/events/" + ev.row, admin, {rev: ev.rev, event: {...MEETING, title: "Собрание труппы (перенос)"}, meta: {kind: "meeting", note: "Новая повестка"}});
  assert.equal(put.status, 200);
  assert.equal(put.body.id, r.body.id);
  assert.equal(t.announced.length, 1);
  assert.equal(t.call("GET", "/api/schedule", admin).body.events.find((e) => e.id === r.body.id).meta.note, "Новая повестка");
  // рассылку можно отключить для группы, но не для сотрудников: флаг publish только про группу
  const r3 = t.call("POST", "/api/events", admin, {event: {...MEETING, title: "Совещание", date: "2026-10-14"}, meta: {kind: "meeting", note: "x", publish: false}});
  assert.equal(t.announced.at(-1).publish, false);
  assert.equal(r3.status, 200);
  // без служебной колонки ID метаданные не принимаются
  const t2 = make({withId: false});
  assert.equal(t2.call("POST", "/api/events", t2.login("9000000001"), {event: MEETING, meta: {kind: "meeting"}}).status, 409);
});

test("переписка по событию: читать и писать может любой сотрудник, удалять чужое — только редактор/админ; к сообщению можно приложить до 4 фото", () => {
  const t = make();
  const admin = t.login("9000000001");
  const reader = t.login("9000000002");
  const id = t.call("POST", "/api/events", admin, {event: MEETING}).body.id;
  let tick = 0;
  t.store.now = () => NOW + 1000 * ++tick; // у сообщений разное время
  assert.equal(t.call("POST", "/api/comments", reader, {event: id, text: ""}).status, 400, "пустое сообщение");
  assert.equal(t.call("POST", "/api/comments", reader, {event: "нет", text: "привет"}).status, 404);
  const a = t.call("POST", "/api/comments", reader, {event: id, text: "Буду на собрании"}).body.item;
  assert.equal(a.mine, true);
  assert.equal(a.name, "Петрова Л.Н.");
  assert.ok(!("phone" in a), "телефон наружу не отдаём");
  const pid = t.call("POST", "/api/photos", admin, {data: JPEG}).body.id;
  t.call("POST", "/api/comments", admin, {event: id, text: "", photos: [pid, "не-номер", pid, "0123456789ab"]});
  const list = t.call("GET", "/api/comments", reader, {event: id}).body.items;
  assert.deepEqual(list.map((c) => [c.name, c.mine, c.photos.length]), [["Петрова Л.Н.", true, 0], ["Иванова М.В.", false, 2]]);
  assert.deepEqual(list[1].photos, [pid, "0123456789ab"], "мусор и повторы отброшены");
  assert.deepEqual(list.map((c) => c.canDelete), [true, false]);
  assert.equal(t.call("GET", "/api/comments", reader, {event: id, since: list[0].ts}).body.items.length, 1, "только новое");
  assert.equal(t.call("DELETE", "/api/comments", reader, {id: list[1].id}).status, 403, "читатель чужое не удалит");
  assert.equal(t.call("DELETE", "/api/comments", admin, {id: list[0].id}).status, 200, "админ может любое");
  assert.equal(t.call("DELETE", "/api/comments", reader, {id: list[0].id}).status, 404);
  assert.equal(t.call("GET", "/api/schedule", reader).body.events.find((e) => e.id === id).comments, 1);
});

test("фото: принимаются только сжатые JPEG (base64), хранятся кусками в скрытом листе и отдаются обратно целиком", () => {
  const t = make();
  const reader = t.login("9000000002");
  assert.equal(t.call("POST", "/api/photos", reader, {data: ""}).status, 400);
  assert.equal(t.call("POST", "/api/photos", reader, {data: "<script>alert(1)</script>" + "A".repeat(200)}).status, 400, "не base64");
  assert.equal(t.call("POST", "/api/photos", reader, {data: "A".repeat(170000)}).status, 413, "слишком большое");
  const big = "QUJD".repeat(25000); // 100 000 знаков -> три куска по ячейкам
  const r = t.call("POST", "/api/photos", reader, {data: "data:image/jpeg;base64," + big});
  assert.equal(r.status, 200);
  assert.equal(t.book.get(TABS.photos).length - 1, 3, "три куска в скрытом листе");
  assert.equal(t.call("GET", "/api/photos", reader, {id: r.body.id}).body.data, "data:image/jpeg;base64," + big);
  assert.equal(t.call("GET", "/api/photos", reader, {id: "000000000000"}).status, 404);
  assert.equal(t.call("GET", "/api/photos", reader, {id: "../x"}).status, 404);
  assert.equal(t.call("GET", "/api/photos", "мусор", {id: r.body.id}).status, 401, "без входа фото не отдаются");
});

test("аватарки: ключ — короткий код человека, у кого два канала — берётся свежее; ключ меняется при обновлении", () => {
  const t = make();
  const reader = t.login("9000000002");
  const key0 = t.call("GET", "/api/schedule", reader).body.avatarKey;
  t.store.setAvatar("9000000002", "vk", "https://sun1.userapi.com/a.jpg");
  const items = t.call("GET", "/api/avatars", reader).body.items;
  const uid = t.call("GET", "/api/schedule", reader).body.me.uid;
  assert.equal(items[uid], "https://sun1.userapi.com/a.jpg");
  assert.notEqual(t.call("GET", "/api/schedule", reader).body.avatarKey, key0);
  assert.ok(!JSON.stringify(items).includes("9000000002"), "телефон в ответе не светится");
  assert.ok(t.store.avatarAge("9000000002", "vk") > 0);
});

test("«не могу работать» нельзя отметить на дату, когда человек уже назначен на смену", () => {
  const t = make();
  const admin = t.login("9000000001");
  const reader = t.login("9000000002");
  t.call("POST", "/api/events", admin, {event: {...MEETING, title: "Спектакль", date: "2026-10-12", roles: {"Касса": ["Петрова Л.Н."]}}});
  const r = t.call("POST", "/api/off", reader, {add: ["2026-10-12", "2026-10-14"]});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /12\.10 вам уже назначена смена/);
  assert.deepEqual(r.body.busy, ["2026-10-12"]);
  assert.deepEqual(t.store.offDates("9000000002"), [], "ничего не записалось (ни занятая, ни свободная дата)");
  assert.equal(t.call("POST", "/api/off", reader, {add: ["2026-10-14"]}).status, 200);
  // чужая смена не мешает
  assert.equal(t.call("POST", "/api/off", admin, {add: ["2026-10-12"]}).status, 200);
});

test("итоги собрания: приложили при редактировании — рассылка и пост один раз; тот же текст повторно не рассылается", () => {
  const t = make();
  const admin = t.login("9000000001");
  const created = t.call("POST", "/api/events", admin, {event: MEETING, meta: {kind: "meeting", note: "Повестка: афиша на ноябрь", publish: true}});
  assert.equal(created.status, 200);
  const id = created.body.id;
  assert.equal(t.announced.length, 1);
  const put = (meta) => t.call("PUT", `/api/events/id-${id}`, admin, {event: MEETING, meta: {kind: "meeting", note: "Повестка: афиша на ноябрь", ...meta}});
  // правка без итогов — ничего нового не рассылается
  assert.equal(put({}).status, 200);
  assert.equal(t.announced.length, 1);
  // приложили итоги после собрания
  assert.equal(put({summary: "Решили: афиша в ноябре, репетиции по вторникам."}).status, 200);
  assert.equal(t.announced.length, 2);
  assert.deepEqual([t.announced[1].kind, t.announced[1].note, t.announced[1].publish, t.announced[1].dm, t.announced[1].event.id], ["meetingSummary", "Решили: афиша в ноябре, репетиции по вторникам.", true, true, id]);
  const ev = t.call("GET", "/api/schedule", admin).body.events.find((e) => e.id === id);
  assert.deepEqual([ev.meta.note, ev.meta.summary], ["Повестка: афиша на ноябрь", "Решили: афиша в ноябре, репетиции по вторникам."], "повестка и итоги хранятся отдельно");
  // повторное сохранение того же текста (в том числе повтор из очереди) ничего не рассылает
  put({summary: "Решили: афиша в ноябре, репетиции по вторникам."});
  assert.equal(t.announced.length, 2);
  // исправили итоги и сняли галочки: рассылка получает «не писать в ВК и не слать личные»
  put({summary: "Решили: афиша в ноябре, репетиции по средам.", publishSummary: false, sendSummary: false});
  assert.equal(t.announced.length, 3);
  assert.deepEqual([t.announced[2].publish, t.announced[2].dm], [false, false]);
  // обычное событие итогов не рассылает
  const plain = t.call("POST", "/api/events", admin, {event: {...MEETING, title: "Репетиция", date: "2026-10-13"}, meta: {kind: "event", note: "", summary: "что-то"}});
  assert.equal(plain.status, 200);
  assert.equal(t.announced.length, 3);
  // читатель редактировать не может
  const reader = t.login("9000000002");
  assert.equal(t.call("PUT", `/api/events/id-${id}`, reader, {event: MEETING, meta: {kind: "meeting", summary: "x"}}).status, 403);
});

test("скрипт Google: итоги собрания уходят личными сообщениями и постом в ВК с заголовком «Итоги собрания»", () => {
  const tabs = {"Расписание": [["Дата", "Начало", "Конец", "Событие", "Площадка", "ID"], ["12.10.2026", "18:00", "", "Собрание труппы", "", "abcd1234"]], "Сотрудники": STAFF,
    "Подписчики": [["Канал", "ID чата", "Телефон", "ФИО"], ["telegram", "6", "9000000002", "Петрова Л.Н."]]};
  const g = loadGas({tabs, props: {SHEET_ID: "x", STYLE_VER: "20", TOP_ROWS_DONE: "1", TELEGRAM_BOT_TOKEN: "TOKEN", WEBHOOK_SECRET: "h", APP_URL: "https://app.test", VK_TOKEN: "vk", VK_GROUP_ID: "5", OWNER_PHONE: "9000000001"}, now: NOW});
  g.run("store_().ensureLogins()");
  const call = (req) => JSON.parse(g.run(`doPost(${JSON.stringify({postData: {contents: JSON.stringify(req)}})}).getContent()`));
  const token = call({method: "POST", path: "/api/login", body: {login: g.run('store_().users().find((u) => u.phone === "9000000001").login')}}).token;
  const r = call({method: "PUT", path: "/api/events/id-abcd1234", token, body: {event: {title: "Собрание труппы", date: "2026-10-12", dateEnd: "", time: "18:00", end: "", hall: "", roles: {}}, meta: {kind: "meeting", note: "", summary: "Итог: утвердили афишу."}}});
  assert.equal(r.ok, true);
  const dm = g.fetches.filter((f) => f.url.endsWith("/sendMessage") && String(f.body.chat_id) === "6");
  assert.equal(dm.length, 1);
  assert.match(dm[0].body.text, /Итоги собрания: Собрание труппы[\s\S]*Итог: утвердили афишу/);
  const wall = g.fetches.find((f) => f.url.includes("wall.post"));
  assert.ok(wall && /Итоги собрания: Собрание труппы/.test(wall.body.message), "пост на стене группы");
});
