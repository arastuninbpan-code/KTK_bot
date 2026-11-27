import test from "node:test";
import assert from "node:assert/strict";
import {handleMessage, runCycle} from "../lib/bot.mjs";
import {Gone} from "../lib/telegram.mjs";
import {TABS} from "../lib/store.mjs";
import {fakeChannel, lastTo, msk, setup} from "./helpers.mjs";

const APP = "https://app.test";
const say = (ctx, ch, chatId, text, phone = null) => handleMessage({store: ctx.store, channel: ch, ev: {chatId, text: phone && !text ? (ctx.store.ensureLogins(), ctx.store.users().find((u) => u.phone === String(phone).replace(/\D/g, "").slice(-10))?.pin || "") : text}, appUrl: APP, now: msk(1, 10)});

test.skip("устаревшая регистрация по номеру текстом", () => {
  const ctx = setup(); const ch = fakeChannel();
  say(ctx, ch, 5, "/start");
  assert.match(lastTo(ch, 5).text, /Добро пожаловать в КТК/); assert.equal(lastTo(ch, 5).options, "contact"); // первое знакомство: вступление
  say(ctx, ch, 5, "/shifts");
  assert.match(lastTo(ch, 5).text, /Здравствуйте/); assert.equal(lastTo(ch, 5).options, "contact"); // дальше — короткая просьба
  say(ctx, ch, 5, "", "+79000000003");
  assert.match(lastTo(ch, 5).text, /✈️ <b>Готово, Сидорова Л\.Р\.!<\/b>/);
  assert.match(lastTo(ch, 5).text, /Логин для входа в приложение: <code>[A-Z0-9]{6}<\/code>/);
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
  assert.match(lastTo(ch, 5).text, /PIN.*выдаёт директор/);
  say(ctx, ch, 5, "/stop");
  assert.equal(ctx.store.chats().length, 0);
  assert.equal(lastTo(ch, 5).options, "remove");
});

test.skip("постоянный код не используется для привязки нового чата", () => {
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

test("бот привязывает чат сразу после ввода выданного PIN", () => {
  const ctx = setup();
  const ch = fakeChannel();
  ctx.store.ensureLogins();
  const employee = ctx.store.users().find((u) => u.phone === "9000000002");
  say(ctx, ch, 77, employee.pin);
  assert.match(lastTo(ch, 77).text, /Готово, Петрова/);
  assert.equal(ctx.store.chats()[0].phone, employee.phone);
});

test("постоянный код подключает второй мессенджер, но код в уже подключённом чате не меняет сотрудника", () => {
  const ctx = setup(); const tg = fakeChannel("telegram"); const vk = fakeChannel("vk");
  say(ctx, tg, 10, "", "9000000001"); // безопасный контакт Telegram: Иванова
  say(ctx, vk, 20, ctx.store.users()[0].pin);
  assert.equal(ctx.store.chats().find((c) => c.channel === "vk" && c.chatId === "20").phone, "9000000001");
  say(ctx, tg, 10, "100002"); // случайно прислала код Петровой в уже подключённом чате
  assert.equal(ctx.store.chats().find((c) => c.channel === "telegram" && c.chatId === "10").phone, "9000000001");
  assert.match(lastTo(tg, 10).text, /Главное меню/);
});

test("пять неверных кодов блокируют подбор на 15 минут", () => {
  const ctx = setup(); const ch = fakeChannel();
  for (let i = 0; i < 4; i++) say(ctx, ch, 90, String(800000 + i));
  assert.match(lastTo(ch, 90).text, /Осталось попыток: 1/);
  say(ctx, ch, 90, "800004");
  assert.match(lastTo(ch, 90).text, /заблокирован на 15 минут/);
  say(ctx, ch, 90, "100001");
  assert.equal(ctx.store.chats().some((c) => c.chatId === "90"), false);
  assert.match(lastTo(ch, 90).text, /заблокирован на 15 минут/);
});

test("блокировку нельзя обойти правильным PIN — Telegram и VK", () => {
  for (const channelName of ["telegram", "vk"]) {
    const ctx = setup(); const ch = fakeChannel(channelName); const chat = channelName === "telegram" ? 191 : 192;
    ctx.store.ensureLogins();
    for (let i = 0; i < 5; i++) say(ctx, ch, chat, "999999");
    assert.match(lastTo(ch, chat).text, /заблокирован на 15 минут/);
    say(ctx, ch, chat, ctx.store.users()[0].pin);
    assert.match(lastTo(ch, chat).text, /заблокирован на 15 минут/);
    assert.equal(ctx.store.chats().some((c) => c.channel === channelName && c.chatId === String(chat)), false);
  }
});

test("директор разблокирует полностью закрытый вход командой /unlock PIN", () => {
  const ctx = setup(); const tg = fakeChannel("telegram");
  ctx.store.ensureLogins();
  const target = ctx.store.users().find((u) => u.phone === "9000000002");
  for (let level = 0; level < 4; level++) {
    for (let i = 0; i < 5; i++) ctx.store.authFailed("vk", "777", target.phone);
  }
  assert.equal(ctx.store.authState("vk", "777").blockedUntil, -1);
  say(ctx, tg, 1, "", "9000000001");
  say(ctx, tg, 1, `/unlock ${target.pin}`);
  assert.match(lastTo(tg, 1).text, /разблокирован/);
  assert.equal(ctx.store.authState("vk", "777").blockedUntil, 0);
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

test("несколько должностей на одном событии: в сообщениях и списке смен одно событие и все должности; изменения по нему приходят одним сообщением", () => {
  const ctx = setup(); const ch = fakeChannel();
  const staff = TABS.schedule;
  // Петрова на «Сказках» (10.10) стоит и в «Администраторе», и в «Гардеробе»
  const rows = ctx.store.book.get(staff);
  const i = rows.findIndex((r) => String(r[1]).startsWith("Сказки"));
  ctx.store.book.set(staff, i + 1, [rows[i][0], rows[i][1], "Петрова Л.Н.", "Петрова Л.Н.", "", "", ""]);
  say(ctx, ch, 7, "", "9000000002");
  say(ctx, ch, 7, "/shifts");
  const text = lastTo(ch, 7).text;
  assert.equal((text.match(/Сказки из старого чемодана/g) || []).length, 1, "событие в списке один раз");
  assert.match(text, /👤 Администратор \/ Капельдинер, Гардероб \/ Уборщица/);
  // первый проход запоминает состояние молча
  runCycle({store: ctx.store, senders: {telegram: ch}, now: msk(1, 10)});
  const before = ch.sent.length;
  // её же ставят ещё на две должности сразу -> одно сообщение со всеми новыми должностями
  const r2 = ctx.store.book.get(staff);
  const j = r2.findIndex((r) => String(r[1]).startsWith("Сказки"));
  ctx.store.book.set(staff, j + 1, [r2[j][0], r2[j][1], "Петрова Л.Н.", "Петрова Л.Н.", "Петрова Л.Н.", "Петрова Л.Н.", ""]);
  runCycle({store: ctx.store, senders: {telegram: ch}, now: msk(1, 10)});
  const added = ch.sent.slice(before).filter((s) => s.chatId === "7");
  assert.equal(added.length, 1, "одно сообщение, а не по одному на должность");
  assert.match(added[0].text, /Вам назначена смена/);
  assert.match(added[0].text, /Касса, Монтировка/);
});

test("ВК сохраняет привязку сотрудника без телефона между командами", () => {
  const ctx = setup(), ch = fakeChannel("vk");
  ctx.book.setCell(TABS.staff, 2, 2, "");
  ctx.store.ensureLogins();
  const employee = ctx.store.users()[0];
  say(ctx, ch, 5, employee.pin);
  assert.equal(ctx.store.chats()[0].phone, employee.phone);
  say(ctx, ch, 5, "📅 Мои смены");
  assert.doesNotMatch(lastTo(ch, 5).text, /Введите шестизначный PIN/);
  say(ctx, ch, 5, "🔕 Отключить");
  assert.match(lastTo(ch, 5).text, /Уведомления отключены/);
  assert.equal(ctx.store.chats().length, 0);
});
