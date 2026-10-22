import test from "node:test";
import assert from "node:assert/strict";
import {handleMessage, runCycle} from "../lib/bot.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";
import {Store, TABS} from "../lib/store.mjs";
import {loadGas} from "./gas-fake.mjs";
import {fakeChannel, msk, STAFF} from "./helpers.mjs";

const NOW = msk(1, 10);
const APP = "https://app.test";
const HEAD = ["Дата", "Начало", "Конец", "Событие", "Площадка", "Касса", "ID"];

test("несколько изменений у человека за раз — ОДНО сообщение со всем", () => {
  const book = new MemoryBook({[TABS.schedule]: [HEAD, ["12.10.2026", "19:00", "21:00", "Спектакль «Бука»", "Малая сцена", "", "abcd1234"], ["13.10.2026", "11:00", "13:00", "Репетиция", "Большая сцена", "", "bbbb2222"], ["14.10.2026", "10:00", "12:00", "Сказки", "Малая сцена", "Петрова Л.Н.", "cccc3333"]], [TABS.staff]: STAFF});
  const store = new Store(book, {secret: "t", now: () => NOW});
  const tg = fakeChannel("telegram");
  const senders = {telegram: tg};
  runCycle({store, senders, now: NOW, appUrl: APP});
  handleMessage({store, channel: tg, ev: {chatId: 6, text: "", phone: "9000000002"}, appUrl: APP, now: NOW}); // Петрова
  tg.sent.length = 0;
  book.setCell(TABS.schedule, 2, 6, "Петрова Л.Н."); // назначили на «Буку»
  book.setCell(TABS.schedule, 3, 6, "Петрова Л.Н."); // назначили на репетицию
  book.setCell(TABS.schedule, 4, 6, "");              // сняли со «Сказок»
  runCycle({store, senders, now: NOW, appUrl: APP});
  const mine = tg.sent.filter((m) => m.chatId === "6");
  assert.equal(mine.length, 1, "одно сообщение, а не три");
  assert.match(mine[0].text, /Изменения в ваших сменах[\s\S]*Назначена смена[\s\S]*Бука[\s\S]*Назначена смена[\s\S]*Репетиция[\s\S]*Смена отменена[\s\S]*Сказки/);
  assert.equal(mine[0].options.button.url, APP);
});

test("скрипт Google: правки из приложения подряд дают ОДНО сообщение; если приложение закрыли — разошлёт минутный таймер", () => {
  const tabs = {[TABS.schedule]: [HEAD], [TABS.staff]: STAFF, "Подписчики": [["Канал", "ID чата", "Телефон", "ФИО"], ["telegram", "6", "9000000002", "Петрова Л.Н."]]};
  const g = loadGas({tabs, props: {SHEET_ID: "x", STYLE_VER: "21", TOP_ROWS_DONE: "1", TELEGRAM_BOT_TOKEN: "TOKEN", WEBHOOK_SECRET: "hook", APP_URL: APP, OWNER_PHONE: "9000000001"}, now: NOW});
  const call = (req) => JSON.parse(g.run(`doPost(${JSON.stringify({postData: {contents: JSON.stringify(req)}})}).getContent()`));
  g.run("store_().ensureLogins()");
  const token = call({method: "POST", path: "/api/login", body: {login: g.run('store_().users().find((u) => u.phone === "9000000001").login')}}).token;
  call({method: "GET", path: "/api/schedule", token});
  g.run("runCycle_()"); // первый снимок
  const to6 = () => g.fetches.filter((f) => f.url.endsWith("/sendMessage") && String(f.body.chat_id) === "6");
  const ev = (title, date, id) => ({event: {title, date, dateEnd: "", time: "10:00", end: "11:00", hall: "", roles: {"Касса": ["Петрова Л.Н."]}}, id});
  call({method: "POST", path: "/api/events", token, body: ev("Первое", "2026-10-12", "aaaa0001")});
  g.advance(3000);
  call({method: "POST", path: "/api/events", token, body: ev("Второе", "2026-10-13", "aaaa0002")});
  assert.equal(to6().length, 0, "пока правки идут, ничего не рассылаем");
  g.advance(9000);
  call({method: "POST", path: "/api/flush", token});
  assert.equal(to6().length, 1, "одно сообщение обо всех правках");
  assert.match(to6()[0].body.text, /Изменения в ваших сменах[\s\S]*Первое[\s\S]*Второе/);
  // приложение закрыли: минутный таймер
  call({method: "POST", path: "/api/events", token, body: ev("Третье", "2026-10-14", "aaaa0003")});
  g.advance(16000);
  g.run("everyMinute()");
  assert.equal(to6().length, 2);
  assert.match(to6()[1].body.text, /Третье/);
});
