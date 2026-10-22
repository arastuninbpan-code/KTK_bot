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

test("собрание: две галочки — личные сообщения и пост в ВК; при создании по умолчанию оба, при редактировании только если отмечено", () => {
  const t = make();
  const admin = t.login("9000000001");
  const created = t.call("POST", "/api/events", admin, {event: MEETING, meta: {kind: "meeting", note: "Повестка", sendDm: true, publish: true}});
  const id = created.body.id;
  assert.equal(t.announced.length, 1);
  assert.deepEqual([t.announced[0].dm, t.announced[0].publish], [true, true]);
  const put = (meta) => t.call("PUT", `/api/events/id-${id}`, admin, {event: MEETING, meta: {kind: "meeting", ...meta}});
  // правили текст, галочек нет — ничего не рассылается
  assert.equal(put({note: "Повестка + итоги", sendDm: false, publish: false}).status, 200);
  assert.equal(t.announced.length, 1);
  // приложили итоги и отметили обе галочки
  assert.equal(put({note: "Итоги: афиша в ноябре.", sendDm: true, publish: true, resend: true}).status, 200);
  assert.equal(t.announced.length, 2);
  assert.deepEqual([t.announced[1].note, t.announced[1].dm, t.announced[1].publish], ["Итоги: афиша в ноябре.", true, true]);
  // только пост в ВК, без личных сообщений
  put({note: "Итоги: афиша в ноябре (уточнено).", sendDm: false, publish: true, resend: true});
  assert.deepEqual([t.announced[2].dm, t.announced[2].publish], [false, true]);
  // только личные сообщения, без поста
  put({note: "Итоги: ещё раз.", sendDm: true, publish: false, resend: true});
  assert.deepEqual([t.announced[3].dm, t.announced[3].publish], [true, false]);
  const ev = t.call("GET", "/api/schedule", admin).body.events.find((e) => e.id === id);
  assert.equal(ev.meta.note, "Итоги: ещё раз.", "текст сохранился в собрании");
  // читатель разослать не может
  const reader = t.login("9000000002");
  assert.equal(t.call("PUT", `/api/events/id-${id}`, reader, {event: MEETING, meta: {kind: "meeting", note: "x", resend: true}}).status, 403);
  assert.equal(t.announced.length, 4);
  // у обычного события рассылки нет
  const plain = t.call("POST", "/api/events", admin, {event: {...MEETING, title: "Репетиция", date: "2026-10-13"}, meta: {kind: "event", note: "", announce: false}});
  t.call("PUT", `/api/events/id-${plain.body.id}`, admin, {event: {...MEETING, title: "Репетиция", date: "2026-10-13"}, meta: {kind: "event", note: "", resend: true}});
  assert.equal(t.announced.length, 4);
});

test("собрание можно создать совсем без рассылки: обе галочки сняты (announce: false)", () => {
  const t = make();
  const admin = t.login("9000000001");
  const r = t.call("POST", "/api/events", admin, {event: MEETING, meta: {kind: "meeting", note: "Повестка", sendDm: false, publish: false, announce: false}});
  assert.equal(r.status, 200);
  assert.equal(t.announced.length, 0);
});

test("скрипт Google: без галочки «Разослать сотрудникам» личные сообщения не уходят, а пост в ВК выходит", () => {
  const tabs = {"Расписание": [["Дата", "Начало", "Конец", "Событие", "Площадка", "ID"], ["12.10.2026", "18:00", "", "Собрание труппы", "", "abcd1234"]], "Сотрудники": STAFF,
    "Подписчики": [["Канал", "ID чата", "Телефон", "ФИО"], ["telegram", "6", "9000000002", "Петрова Л.Н."]]};
  const g = loadGas({tabs, props: {SHEET_ID: "x", STYLE_VER: "22", TOP_ROWS_DONE: "1", TELEGRAM_BOT_TOKEN: "TOKEN", WEBHOOK_SECRET: "h", APP_URL: "https://app.test", VK_TOKEN: "vk", VK_GROUP_ID: "5", OWNER_PHONE: "9000000001"}, now: NOW});
  g.run("store_().ensureLogins()");
  const call = (req) => JSON.parse(g.run(`doPost(${JSON.stringify({postData: {contents: JSON.stringify(req)}})}).getContent()`));
  const token = call({method: "POST", path: "/api/login", body: {login: g.run('store_().users().find((u) => u.phone === "9000000001").login')}}).token;
  const put = (meta) => call({method: "PUT", path: "/api/events/id-abcd1234", token, body: {event: {title: "Собрание труппы", date: "2026-10-12", dateEnd: "", time: "18:00", end: "", hall: "", roles: {}}, meta: {kind: "meeting", note: "Итоги: утвердили афишу.", ...meta}}});
  const dm = () => g.fetches.filter((f) => f.url.endsWith("/sendMessage") && String(f.body.chat_id) === "6").length;
  put({sendDm: false, publish: true, resend: true});
  assert.equal(dm(), 0, "личные сообщения не отправлялись");
  assert.ok(g.fetches.some((f) => f.url.includes("wall.post") && /Итоги: утвердили афишу/.test(f.body.message)), "пост на стене группы");
  put({sendDm: true, publish: false, resend: true});
  assert.equal(dm(), 1, "личное сообщение ушло");
  assert.equal(g.fetches.filter((f) => f.url.includes("wall.post")).length, 1, "второй пост не выкладывался");
});
