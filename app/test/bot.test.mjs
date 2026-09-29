import test from "node:test";
import assert from "node:assert/strict";
import {handleMessage, runCycle} from "../lib/bot.mjs";
import {Gone} from "../lib/telegram.mjs";
import {TABS} from "../lib/store.mjs";
import {fakeChannel, lastTo, msk, setup} from "./helpers.mjs";

const say = (ctx, ch, chatId, text, phone = null) => handleMessage({store: ctx.store, channel: ch, ev: {chatId, text, phone}, siteUrl: "https://site.test", now: msk(1, 10)});

test("регистрация по контакту и по номеру текстом, чужой номер, команды без регистрации", async () => {
  const ctx = setup(); const ch = fakeChannel();
  await say(ctx, ch, 5, "/start");
  assert.match(lastTo(ch, 5).text, /Поделитесь номером|поделитесь номером/); assert.equal(lastTo(ch, 5).keyboard, "contact");
  await say(ctx, ch, 5, "/shifts");
  assert.equal(lastTo(ch, 5).keyboard, "contact");
  await say(ctx, ch, 5, "", "+79000000003");
  assert.match(lastTo(ch, 5).text, /✅ <b>Готово, Сидорова Л\.Р\.!<\/b>/);
  await say(ctx, ch, 7, "8 (900) 000-00-02");
  assert.equal((await ctx.store.chats()).length, 2);
  await say(ctx, ch, 8, "+7 999 999-99-99");
  assert.match(lastTo(ch, 8).text, /нет в списке/);
  assert.equal((await ctx.store.chats()).length, 2);
});

test("/shifts, /schedule, /login, /stop", async () => {
  const ctx = setup(); const ch = fakeChannel();
  await runCycle({store: ctx.store, senders: {}, now: msk(1, 10)}); // первый снимок
  await say(ctx, ch, 5, "", "9000000001");
  await say(ctx, ch, 5, "/shifts");
  assert.match(lastTo(ch, 5).text, /📋 <b>Ваши ближайшие смены<\/b>[\s\S]*Вс, 4 октября[\s\S]*Спектакль «Бука»/);
  await say(ctx, ch, 5, "/schedule@k_t_k_bot");
  assert.match(lastTo(ch, 5).text, /🎭 <b>Афиша<\/b>/);
  await say(ctx, ch, 5, "/login");
  const code = lastTo(ch, 5).text.match(/<code>(\d{6})<\/code>/)[1];
  assert.equal(await ctx.store.consumeCode(code), "9000000001");
  assert.equal(await ctx.store.consumeCode(code), null); // одноразовый
  await say(ctx, ch, 5, "/stop");
  assert.equal((await ctx.store.chats()).length, 0);
  assert.equal(lastTo(ch, 5).keyboard, "remove");
});

test("коды входа: просрочка и чужой код", async () => {
  let t = msk(1, 10);
  const ctx = setup(); ctx.store.now = () => t;
  const code = await ctx.store.issueCode("9000000001");
  assert.equal(await ctx.store.consumeCode("000000" === code ? "111111" : "000000"), null);
  t += 11 * 60 * 1000;
  assert.equal(await ctx.store.consumeCode(code), null);
});

test("runCycle: красивые уведомления только тому, кого касается; повторов нет", async () => {
  const ctx = setup(); const tg = fakeChannel();
  const senders = {telegram: tg};
  await runCycle({store: ctx.store, senders, now: msk(1, 10)});
  await say(ctx, tg, 5, "", "9000000001"); // Иванова
  await say(ctx, tg, 6, "", "9000000002"); // Петрова
  tg.sent.length = 0;

  const t = await ctx.book.get(TABS.schedule);
  t[2][0] = "04.10\n12.00 и 14.00"; // перенесли время «Буки» (там Иванова)
  await ctx.book.set(TABS.schedule, 3, t[2]);
  const r = await runCycle({store: ctx.store, senders, now: msk(1, 10)});
  assert.equal(r.sent, 1);
  assert.equal(tg.sent[0].chatId, "5");
  assert.match(tg.sent[0].text, /✏️ <b>Смена изменена<\/b>[\s\S]*⏰ <s>11:00 и 13:00<\/s> → <b>12:00 и 14:00<\/b>/);
  assert.equal((await runCycle({store: ctx.store, senders, now: msk(1, 10)})).sent, 0);

  const day = await runCycle({store: ctx.store, senders, now: msk(3, 12, 30)}); // за сутки до 12:00 04.10
  assert.equal(day.sent, 1);
  assert.match(tg.sent.at(-1).text, /^📅 <b>Завтра у вас смена<\/b>/);
});

test("runCycle: заблокировавший бота отвязывается", async () => {
  const ctx = setup();
  const dead = {name: "telegram", send: async () => { throw new Gone(); }};
  await runCycle({store: ctx.store, senders: {}, now: msk(1, 10)});
  await ctx.store.bind("telegram", "5", "9000000001", "Иванова М.В.");
  const t = await ctx.book.get(TABS.schedule);
  t[2][0] = "04.10\n12.00"; await ctx.book.set(TABS.schedule, 3, t[2]);
  await runCycle({store: ctx.store, senders: {telegram: dead}, now: msk(1, 10)});
  assert.equal((await ctx.store.chats()).length, 0);
});

test("блокировка не пускает второй проход", async () => {
  const ctx = setup();
  let inner = null;
  const first = await ctx.store.withLock(async () => { inner = await ctx.store.withLock(async () => "второй"); return "первый"; });
  assert.equal(first, "первый"); assert.deepEqual(inner, {skipped: true});
  assert.equal(await ctx.store.withLock(async () => "снова"), "снова"); // после завершения замок снят
});
