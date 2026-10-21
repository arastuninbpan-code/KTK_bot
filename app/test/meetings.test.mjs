import test from "node:test";
import assert from "node:assert/strict";
import {handleApi} from "../lib/api.mjs";
import {Store, TABS} from "../lib/store.mjs";
import {msk, STAFF} from "./helpers.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";

const NOW = msk(1, 10);
const V2 = [["Дата", "Начало", "Конец", "Событие", "Площадка", "Касса", "ID"]];
function make({withId = true, files = true} = {}) {
  const sched = withId ? V2 : [V2[0].slice(0, 6)];
  const book = new MemoryBook({[TABS.schedule]: sched.map((r) => r.slice()), [TABS.staff]: STAFF});
  const store = new Store(book, {secret: "t", now: () => NOW});
  const announced = [];
  const saved = [];
  const deps = {store, secret: "s", now: () => NOW, announce: (a) => announced.push(a),
    ...(files ? {saveFile: (name, mime, data) => { saved.push({name, mime, size: data.length}); return {id: "f" + saved.length, name, mime, size: data.length, url: "https://drive.google.com/file/d/f" + saved.length + "/view", thumb: ""}; }} : {})};
  const call = (method, path, token, body = {}) => handleApi({method, path, token, body}, deps);
  store.ensureLogins();
  const login = (phone) => handleApi({method: "POST", path: "/api/login", body: {login: store.users().find((u) => u.phone === phone).login}}, deps).body.token;
  return {book, store, call, login, announced, saved};
}
const MEETING = {title: "Собрание труппы", date: "2026-10-12", dateEnd: "", time: "18:00", end: "", hall: "", roles: {}};
const FILE = {id: "d1", name: "Протокол.docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 1234, url: "https://drive.google.com/file/d/d1/view", thumb: ""};

test("собрание: создаётся с описанием и файлом, получает ID, рассылка вызывается один раз", () => {
  const t = make();
  const admin = t.login("9000000001");
  const r = t.call("POST", "/api/events", admin, {event: MEETING, meta: {kind: "meeting", note: "Повестка: сезон", files: [FILE, {...FILE, id: "evil", url: "https://evil.example/x"}], publish: true}});
  assert.equal(r.status, 200);
  assert.match(r.body.id, /^[0-9a-f]{8}$/);
  assert.equal(t.announced.length, 1);
  assert.equal(t.announced[0].kind, "meeting");
  assert.equal(t.announced[0].publish, true);
  assert.equal(t.announced[0].event.id, r.body.id);
  assert.deepEqual(t.announced[0].files.map((f) => f.id), ["d1"], "чужие адреса отбрасываются");
  const s = t.call("GET", "/api/schedule", admin).body;
  const ev = s.events.find((e) => e.title === "Собрание труппы");
  assert.equal(ev.id, r.body.id);
  assert.deepEqual([ev.meta.kind, ev.meta.note, ev.meta.files.length, ev.comments], ["meeting", "Повестка: сезон", 1, 0]);
  assert.equal(s.me.uid.length, 10);
  // обычное событие без meta ничего не рассылает, но ID получает
  const r2 = t.call("POST", "/api/events", admin, {event: {...MEETING, title: "Репетиция", date: "2026-10-13"}});
  assert.equal(t.announced.length, 1);
  assert.match(r2.body.id, /^[0-9a-f]{8}$/);
  // правка сохраняет ID и не рассылает снова
  const row = s.events.find((e) => e.title === "Собрание труппы");
  const put = t.call("PUT", "/api/events/" + row.row, admin, {rev: row.rev, event: {...MEETING, title: "Собрание труппы (перенос)"}, meta: {kind: "meeting", note: "Новая повестка"}});
  assert.equal(put.status, 200);
  assert.equal(put.body.id, r.body.id);
  assert.equal(t.announced.length, 1);
  assert.equal(t.call("GET", "/api/schedule", admin).body.events.find((e) => e.id === r.body.id).meta.note, "Новая повестка");
  // без служебной колонки ID метаданные не принимаются
  const t2 = make({withId: false});
  assert.equal(t2.call("POST", "/api/events", t2.login("9000000001"), {event: MEETING, meta: {kind: "meeting"}}).status, 409);
});

test("переписка по событию: читать и писать может любой сотрудник, удалять чужое — только редактор/админ; вложения только с Google Диска", () => {
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
  t.call("POST", "/api/comments", admin, {event: id, text: "", files: [FILE, {url: "https://evil.example/a"}]});
  const list = t.call("GET", "/api/comments", reader, {event: id}).body.items;
  assert.deepEqual(list.map((c) => [c.name, c.mine, c.files.length]), [["Петрова Л.Н.", true, 0], ["Иванова М.В.", false, 1]]);
  assert.deepEqual(list.map((c) => c.canDelete), [true, false]);
  assert.equal(t.call("GET", "/api/comments", reader, {event: id, since: list[0].ts}).body.items.length, 1, "только новое");
  assert.equal(t.call("DELETE", "/api/comments", reader, {id: list[1].id}).status, 403, "читатель чужое не удалит");
  assert.equal(t.call("DELETE", "/api/comments", admin, {id: list[0].id}).status, 200, "админ может любое");
  assert.equal(t.call("DELETE", "/api/comments", reader, {id: list[0].id}).status, 404);
  assert.equal(t.call("GET", "/api/schedule", reader).body.events.find((e) => e.id === id).comments, 1);
});

test("файлы: без подключённого Диска понятная ошибка; с Диском — загрузка; прикрепить к событию может только редактор", () => {
  const off = make({files: false});
  assert.equal(off.call("POST", "/api/files", off.login("9000000001"), {name: "a.pdf", mime: "application/pdf", data: "QQ=="}).status, 501);
  const t = make();
  const admin = t.login("9000000001");
  const reader = t.login("9000000002");
  const up = t.call("POST", "/api/files", reader, {name: "фото/1.jpg", mime: "image/jpeg", data: "QUJD"});
  assert.equal(up.status, 200);
  assert.equal(t.saved[0].name, "фото_1.jpg", "в имени файла нет косых черт");
  assert.equal(t.call("POST", "/api/files", reader, {name: "x", mime: "x", data: ""}).status, 400);
  const id = t.call("POST", "/api/events", admin, {event: MEETING, meta: {kind: "meeting", announce: false}}).body.id;
  assert.equal(t.call("POST", "/api/event-files", reader, {event: id, files: [up.body.file]}).status, 403);
  assert.equal(t.call("POST", "/api/event-files", admin, {event: id, files: [up.body.file], notify: true}).status, 200);
  assert.equal(t.announced.at(-1).kind, "files");
  assert.equal(t.call("GET", "/api/schedule", reader).body.events.find((e) => e.id === id).meta.files.length, 1);
  assert.equal(t.call("DELETE", "/api/event-files", admin, {event: id, fileId: up.body.file.id}).status, 200);
  assert.equal(t.call("GET", "/api/schedule", reader).body.events.find((e) => e.id === id).meta.files.length, 0);
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
