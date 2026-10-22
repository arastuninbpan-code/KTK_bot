import test from "node:test";
import assert from "node:assert/strict";
import {handleAck, handleMessage, runCycle} from "../lib/bot.mjs";
import {handleApi} from "../lib/api.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";
import {Store, TABS} from "../lib/store.mjs";
import {parseAck, ackLabel} from "../lib/format.mjs";
import {telegramCallback} from "../lib/telegram.mjs";
import {vkButtonEvent, vkKeyboard} from "../lib/vk.mjs";
import {loadGas} from "./gas-fake.mjs";
import {fakeChannel, msk, STAFF} from "./helpers.mjs";

const NOW = msk(1, 10);
const APP = "https://app.test";
const HEAD = ["Дата", "Начало", "Конец", "Событие", "Площадка", "Касса", "ID"];
const day0 = [HEAD, ["12.10.2026", "19:00", "21:00", "Спектакль «Бука»", "Малая сцена", "", "abcd1234"]];

function make() {
  const book = new MemoryBook({[TABS.schedule]: day0.map((r) => r.slice()), [TABS.staff]: STAFF});
  const store = new Store(book, {secret: "t", now: () => NOW});
  const tg = fakeChannel("telegram");
  const senders = {telegram: tg};
  runCycle({store, senders, now: NOW, appUrl: APP}); // первый снимок
  const say = (chatId, phone) => handleMessage({store, channel: tg, ev: {chatId, text: "", phone}, appUrl: APP, now: NOW});
  say(5, "9000000001"); // Иванова — админ
  say(6, "9000000002"); // Петрова — читатель
  tg.sent.length = 0;
  return {book, store, tg, senders};
}

test("уведомление о назначении приходит с кнопками «Увидел(а)» и «Не могу» (если у события есть ID)", () => {
  const t = make();
  t.book.setCell(TABS.schedule, 2, 6, "Петрова Л.Н."); // поставили на смену
  runCycle({store: t.store, senders: t.senders, now: NOW, appUrl: APP});
  const to6 = t.tg.sent.filter((m) => m.chatId === "6");
  assert.equal(to6.length, 1);
  assert.deepEqual(to6[0].options.ack, {eventId: "abcd1234"});
  assert.equal(to6[0].options.button.url, APP);
  assert.deepEqual(parseAck("ack:ok:abcd1234"), {status: "ok", eventId: "abcd1234"});
  assert.equal(parseAck("ack:ok:zzzz"), null);
  assert.equal(ackLabel("ok", "ok"), "✅ Увидел(а) ✓");
  assert.equal(ackLabel("no", "ok"), "🚫 Не могу");
});

test("«Увидел(а)»: отметка записывается (повтор не плодит строк), «Не могу» сразу уведомляет администратора один раз", () => {
  const t = make();
  t.book.setCell(TABS.schedule, 2, 6, "Петрова Л.Н.");
  runCycle({store: t.store, senders: t.senders, now: NOW, appUrl: APP});
  t.tg.sent.length = 0;
  const press = (status) => handleAck({store: t.store, channel: t.tg, chatId: 6, status, eventId: "abcd1234", appUrl: APP, senders: t.senders, now: NOW});
  let r = press("ok");
  assert.deepEqual([r.ok, r.changed, r.status], [true, true, "ok"]);
  assert.equal(press("ok").changed, false, "повторное нажатие ничего не меняет");
  assert.equal(t.store.acks().length, 1);
  assert.equal(t.tg.sent.length, 0, "«Увидел» администратора не беспокоит");
  r = press("no"); // передумала
  assert.equal(r.changed, true);
  assert.equal(t.store.acks().length, 1, "одна отметка на человека и событие");
  assert.equal(t.store.acks()[0].status, "no");
  const toAdmin = t.tg.sent.filter((m) => m.chatId === "5");
  assert.equal(toAdmin.length, 1);
  assert.match(toAdmin[0].text, /Петрова Л\.Н\.[\s\S]*не может[\s\S]*Бука[\s\S]*12\.10/);
  press("no");
  assert.equal(t.tg.sent.filter((m) => m.chatId === "5").length, 1, "администратору не пишем дважды");
  // чужой чат и человек не из состава
  assert.equal(handleAck({store: t.store, channel: t.tg, chatId: 999, status: "ok", eventId: "abcd1234", now: NOW}).ok, false);
  t.book.setCell(TABS.schedule, 2, 6, "");
  assert.match(press("ok").toast, /нет в составе/);
});

test("приложение видит отметки: у человека — своя, у администратора — по всем; отметка из приложения работает так же", () => {
  const t = make();
  t.book.setCell(TABS.schedule, 2, 6, "Петрова Л.Н.");
  const deps = {store: t.store, secret: "s", now: () => NOW, senders: t.senders, appUrl: APP};
  t.store.ensureLogins();
  const tok = (phone) => handleApi({method: "POST", path: "/api/login", body: {login: t.store.users().find((u) => u.phone === phone).login}}, deps).body.token;
  const admin = tok("9000000001"), petr = tok("9000000002");
  const call = (token, method, path, body = {}) => handleApi({method, path, token, body}, deps);
  assert.equal(call(petr, "POST", "/api/ack", {event: "abcd1234", status: "ok"}).status, 200);
  assert.equal(call(petr, "POST", "/api/ack", {event: "abcd1234", status: "meh"}).status, 400);
  assert.equal(call(admin, "POST", "/api/ack", {event: "abcd1234", status: "ok"}).status, 409, "администратор в составе не стоит");
  const mine = call(petr, "GET", "/api/schedule").body.events[0];
  assert.deepEqual([mine.myAck, mine.acks], ["ok", undefined], "человеку чужие отметки не показываем");
  const adm = call(admin, "GET", "/api/schedule").body.events[0];
  assert.deepEqual(adm.acks, {"Петрова Л.Н.": "ok"});
  call(petr, "POST", "/api/ack", {event: "abcd1234", status: "no"});
  assert.equal(t.tg.sent.filter((m) => m.chatId === "5" && /не может/.test(m.text)).length, 1, "«Не могу» из приложения тоже сообщается администратору");
});

test("VK: кнопки-обратный вызов и разбор нажатия; Telegram: разбор нажатия", () => {
  const kb = JSON.parse(vkKeyboard({ack: {eventId: "abcd1234"}, button: {text: "Открыть в приложении", url: APP}}));
  assert.equal(kb.inline, true);
  assert.deepEqual(kb.buttons[0].map((b) => [b.action.type, b.action.label, b.color]), [["callback", "✅ Увидел(а)", "positive"], ["callback", "🚫 Не могу", "negative"]]);
  assert.equal(kb.buttons[1][0].action.type, "open_link");
  assert.deepEqual(JSON.parse(kb.buttons[0][1].action.payload), {a: "ack", s: "no", e: "abcd1234"});
  const ev = vkButtonEvent({type: "message_event", object: {peer_id: 77, user_id: 77, event_id: "ev1", conversation_message_id: 5, payload: {a: "ack", s: "no", e: "abcd1234"}}});
  assert.deepEqual([ev.chatId, ev.status, ev.eventId, ev.eventKey], ["77", "no", "abcd1234", "ev1"]);
  assert.equal(vkButtonEvent({type: "message_event", object: {peer_id: 1, payload: {a: "other"}}}), null);
  const cb = telegramCallback({callback_query: {id: "q1", data: "ack:ok:abcd1234", message: {message_id: 9, chat: {id: 5, type: "private"}}}});
  assert.deepEqual([cb.id, cb.chatId, cb.messageId, cb.data], ["q1", 5, 9, "ack:ok:abcd1234"]);
  assert.equal(telegramCallback({callback_query: {id: "q", data: "x", message: {message_id: 1, chat: {id: -5, type: "group"}}}}), null);
});

test("скрипт Google: нажатие в Telegram записывает отметку, отвечает человеку и помечает кнопку; в VK — всплывающее подтверждение", () => {
  const tabs = {[TABS.schedule]: [HEAD, ["12.10.2026", "19:00", "21:00", "Спектакль «Бука»", "Малая сцена", "Петрова Л.Н.", "abcd1234"]], [TABS.staff]: STAFF,
    "Подписчики": [["Канал", "ID чата", "Телефон", "ФИО"], ["telegram", "6", "9000000002", "Петрова Л.Н."], ["telegram", "5", "9000000001", "Иванова М.В."], ["vk", "77", "9000000002", "Петрова Л.Н."]]};
  const g = loadGas({tabs, props: {SHEET_ID: "x", STYLE_VER: "20", TOP_ROWS_DONE: "1", TELEGRAM_BOT_TOKEN: "TOKEN", WEBHOOK_SECRET: "hook", APP_URL: APP, VK_TOKEN: "vk", VK_GROUP_ID: "1", VK_SECRET: "s"}, now: NOW});
  g.run("store_().ensureLogins()");
  const tgPost = (update) => g.run(`doPost(${JSON.stringify({parameter: {secret: "hook"}, postData: {contents: JSON.stringify(update)}})}).getContent()`);
  assert.equal(tgPost({update_id: 11, callback_query: {id: "q1", data: "ack:no:abcd1234", message: {message_id: 9, chat: {id: 6, type: "private"}}}}), "ok");
  const calls = g.fetches.map((f) => f.url.split("/").pop());
  assert.ok(calls.includes("answerCallbackQuery") && calls.includes("editMessageReplyMarkup"), calls.join(","));
  assert.equal(g.fetches.find((f) => f.url.endsWith("answerCallbackQuery")).body.text.includes("не можете"), true);
  const edit = g.fetches.find((f) => f.url.endsWith("editMessageReplyMarkup")).body;
  assert.equal(edit.reply_markup.inline_keyboard[0][1].text, "🚫 Не могу ✓", "выбранная кнопка помечена");
  assert.ok(g.fetches.some((f) => f.url.endsWith("sendMessage") && String(f.body.chat_id) === "5" && /не может/.test(f.body.text)), "администратору ушло сообщение");
  assert.equal(g.run('store_().acks()[0].status'), "no");
  assert.equal(tgPost({update_id: 11, callback_query: {id: "q1", data: "ack:no:abcd1234", message: {message_id: 9, chat: {id: 6, type: "private"}}}}), "ok"); // повтор доставки не плодит ответов
  // VK
  const before = g.fetches.length;
  const vkPost = (update) => g.run(`doPost(${JSON.stringify({parameter: {secret: "hook", vk: "1"}, postData: {contents: JSON.stringify(update)}})}).getContent()`);
  vkPost({type: "message_event", secret: "s", group_id: 1, object: {peer_id: 77, user_id: 77, event_id: "evX", conversation_message_id: 3, payload: {a: "ack", s: "ok", e: "abcd1234"}}});
  const ans = g.fetches.slice(before).find((f) => f.url.includes("messages.sendMessageEventAnswer"));
  assert.ok(ans, "ВК получил ответ на нажатие");
  assert.equal(JSON.parse(ans.body.event_data).type, "show_snackbar");
  assert.equal(g.run('store_().acks()[0].status'), "ok", "в ВК нажали «Увидел» — статус обновился");
});

test("после обновления вебхук Telegram настраивается сам один раз (с нажатиями кнопок)", () => {
  const g = loadGas({tabs: {[TABS.schedule]: [HEAD], [TABS.staff]: STAFF}, props: {SHEET_ID: "x", STYLE_VER: "20", TOP_ROWS_DONE: "1", TELEGRAM_BOT_TOKEN: "TOKEN", RELAY_URL: "https://relay.test/abc", WEBHOOK_SECRET: "h"}, now: NOW});
  g.run("everyMinute()");
  const hooks = g.fetches.filter((f) => f.url.endsWith("/setWebhook"));
  assert.equal(hooks.length, 1);
  assert.deepEqual(hooks[0].body.allowed_updates, ["message", "callback_query"]);
  g.run("everyMinute()");
  assert.equal(g.fetches.filter((f) => f.url.endsWith("/setWebhook")).length, 1, "второй раз не настраиваем");
});
