import test from "node:test";
import assert from "node:assert/strict";
import {handleMessage, runCycle} from "../lib/bot.mjs";
import {Gone} from "../lib/telegram.mjs";
import {TABS} from "../lib/store.mjs";
import {fakeChannel, lastTo, msk, setup} from "./helpers.mjs";

const APP = "https://app.test";
const say = (ctx, ch, chatId, text, phone = null) => handleMessage({store: ctx.store, channel: ch, ev: {chatId, text, phone}, appUrl: APP, now: msk(1, 10)});

test("регистрация по контакту и по номеру текстом, чужой и заблокированный номера, команды без регистрации", () => {
  const ctx = setup(); const ch = fakeChannel();
  say(ctx, ch, 5, "/start");
  assert.match(lastTo(ch, 5).text, /Здравствуйте/); assert.equal(lastTo(ch, 5).options, "contact");
  say(ctx, ch, 5, "/shifts");
  assert.equal(lastTo(ch, 5).options, "contact");
  say(ctx, ch, 5, "", "+79000000003");
  assert.match(lastTo(ch, 5).text, /✈️ <b>Готово, Сидорова Л\.Р\.!<\/b>/);
  say(ctx, ch, 7, "8 (900) 000-00-02");
  assert.equal(ctx.store.chats().length, 2);
  say(ctx, ch, 8, "+7 999 999-99-99");
  assert.match(lastTo(ch, 8).text, /нет в списке/);
  say(ctx, ch, 9, "9000000005"); // Орлова заблокирована
  assert.match(lastTo(ch, 9).text, /Доступ закрыт/);
  assert.equal(ctx.store.chats().length, 2);
});

test("/shifts, /schedule, /login с кнопкой «Открыть в приложении», /stop", () => {
  const ctx = setup(); const ch = fakeChannel();
  runCycle({store: ctx.store, senders: {}, now: msk(1, 10)}); // первый снимок
  say(ctx, ch, 5, "", "9000000001");
  say(ctx, ch, 5, "/shifts");
  assert.match(lastTo(ch, 5).text, /💬 <b>Ваши ближайшие смены<\/b>[\s\S]*Вс, 4 октября[\s\S]*Спектакль «Бука»/);
  assert.deepEqual(lastTo(ch, 5).options, {button: {text: "Открыть в приложении", url: APP}});
  say(ctx, ch, 5, "/schedule@k_t_k_bot");
  assert.match(lastTo(ch, 5).text, /💬 <b>Афиша<\/b>/);
  say(ctx, ch, 5, "/login");
  const login = lastTo(ch, 5).text.match(/<code>([^<]+)<\/code>/)[1];
  assert.equal(ctx.store.findByLogin(login).phone, "9000000001");
  say(ctx, ch, 5, "/login"); // логин постоянный
  assert.match(lastTo(ch, 5).text, new RegExp(login));
  say(ctx, ch, 5, "/stop");
  assert.equal(ctx.store.chats().length, 0);
  assert.equal(lastTo(ch, 5).options, "remove");
});

test("бот узнаёт человека по логину из таблицы; заблокированному и чужому логину не верит", () => {
  const ctx = setup(); const ch = fakeChannel();
  ctx.store.ensureLogins();
  const login = (ph) => ctx.store.users().find((u) => u.phone === ph).login;
  say(ctx, ch, 7, login("9000000002").toLowerCase()); // Петрова
  assert.match(lastTo(ch, 7).text, /Петрова Л\.Н\./);
  assert.equal(ctx.store.chats().find((c) => c.chatId === "7").phone, "9000000002");
  say(ctx, ch, 8, login("9000000005")); // Орлова заблокирована
  assert.match(lastTo(ch, 8).text, /Доступ закрыт/);
  say(ctx, ch, 9, "ЛЕВЫЙ99");
  assert.equal(lastTo(ch, 9).options, "contact");
});

test("runCycle: короткие уведомления с кнопкой только тому, кого касается; повторов нет; заблокированным не пишем", () => {
  const ctx = setup(); const tg = fakeChannel();
  const senders = {telegram: tg};
  runCycle({store: ctx.store, senders, now: msk(1, 10), appUrl: APP});
  say(ctx, tg, 5, "", "9000000001"); // Иванова
  say(ctx, tg, 6, "", "9000000002"); // Петрова
  tg.sent.length = 0;

  const t = ctx.book.get(TABS.schedule);
  t[2][0] = "04.10\n12.00 и 14.00"; // перенесли время «Буки» (там Иванова)
  ctx.book.set(TABS.schedule, 3, t[2]);
  const r = runCycle({store: ctx.store, senders, now: msk(1, 10), appUrl: APP});
  assert.equal(r.sent, 1);
  assert.equal(tg.sent[0].chatId, "5");
  assert.match(tg.sent[0].text, /💬 <b>Смена изменена<\/b>[\s\S]*⏰ <s>11:00 и 13:00<\/s> → <b>12:00 и 14:00<\/b>/);
  assert.deepEqual(tg.sent[0].options, {button: {text: "Открыть в приложении", url: APP}});
  assert.equal(runCycle({store: ctx.store, senders, now: msk(1, 10), appUrl: APP}).sent, 0);

  assert.equal(runCycle({store: ctx.store, senders, now: msk(3, 12, 30), appUrl: APP}).sent, 1); // за сутки до 12:00 04.10
  assert.match(tg.sent.at(-1).text, /^💬 <b>Завтра у вас смена<\/b>/);
  const hour = runCycle({store: ctx.store, senders, now: msk(4, 11, 10), appUrl: APP});
  assert.equal(hour.sent, 1);
  assert.match(tg.sent.at(-1).text, /^❗ <b>Через час у вас смена<\/b>/);
});

test("runCycle: заблокировавший бота отвязывается", () => {
  const ctx = setup();
  const dead = {name: "telegram", send: () => { throw new Gone(); }};
  runCycle({store: ctx.store, senders: {}, now: msk(1, 10)});
  ctx.store.bind("telegram", "5", "9000000001", "Иванова М.В.");
  const t = ctx.book.get(TABS.schedule);
  t[2][0] = "04.10\n12.00"; ctx.book.set(TABS.schedule, 3, t[2]);
  runCycle({store: ctx.store, senders: {telegram: dead}, now: msk(1, 10)});
  assert.equal(ctx.store.chats().length, 0);
});

test("блокировка не пускает второй проход", () => {
  const ctx = setup();
  let inner = null;
  const first = ctx.store.withLock(() => { inner = ctx.store.withLock(() => "второй"); return "первый"; });
  assert.equal(first, "первый"); assert.deepEqual(inner, {skipped: true});
  assert.equal(ctx.store.withLock(() => "снова"), "снова"); // после завершения замок снят
});
