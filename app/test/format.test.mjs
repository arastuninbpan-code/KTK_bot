import test from "node:test";
import assert from "node:assert/strict";
import {afishaText, chunkText, dateLong, esc, msgAdded, msgChanged, msgLogin, msgReminder, msgRemoved, shiftsText} from "../lib/format.mjs";

const row = {date: "2026-10-04", time: "11:00, 13:00", event: "Спектакль «Бука»", hall: "малая сцена", role: "Администратор/ Капельдинер", person: "Иванова М.В."};

test("дата словами", () => {
  assert.equal(dateLong("2026-10-04"), "воскресенье, 4 октября");
});

test("смена назначена: аккуратный блок", () => {
  assert.equal(msgAdded(row), [
    "🆕 <b>Вам назначена смена</b>", "",
    "🎭 <b>Спектакль «Бука»</b>", "🗓 воскресенье, 4 октября", "⏰ 11:00 и 13:00", "📍 малая сцена", "👤 Администратор / Капельдинер"].join("\n"));
});

test("смена изменена: старое зачёркнуто, новое выделено; отмена: название зачёркнуто", () => {
  const t = msgChanged({...row, time: "12:30"}, row);
  assert.match(t, /✏️ <b>Смена изменена<\/b>/);
  assert.match(t, /⏰ <s>11:00 и 13:00<\/s> → <b>12:30<\/b>/);
  assert.match(t, /📍 малая сцена/); // зал не менялся: просто строка
  assert.match(msgRemoved(row), /❌ <b>Смена отменена<\/b>[\s\S]*🎭 <s>Спектакль «Бука»<\/s>/);
});

test("напоминания: за сутки с датой, за час без даты; несколько смен", () => {
  assert.match(msgReminder("day", [row]), /^📅 <b>Завтра у вас смена<\/b>[\s\S]*🗓 воскресенье/);
  const hour = msgReminder("hour", [row, {...row, event: "Вторая"}]);
  assert.match(hour, /^⏰ <b>Через час у вас смены<\/b>/);
  assert.ok(!hour.includes("🗓"));
});

test("список смен и афиша группируются по дням", () => {
  const t = shiftsText([row, {...row, date: "2026-10-10", event: "Сказки", time: "", hall: ""}]);
  assert.match(t, /📋 <b>Ваши ближайшие смены<\/b>\n\n🗓 <b>Вс, 4 октября<\/b>\n🎭 <b>Спектакль «Бука»<\/b>/);
  assert.match(t, /🗓 <b>Сб, 10 октября<\/b>/);
  assert.equal(shiftsText([]), "📭 <b>Ближайших смен пока нет</b>");
  const a = afishaText([row, {...row, person: "Морозова Н.М.", role: "Гардероб"}]);
  assert.match(a, /🎭 <b>Афиша<\/b>[\s\S]*⏰ 11:00 и 13:00 · 📍 малая сцена\n👤 Администратор \/ Капельдинер: Иванова М.В.\n👤 Гардероб: Морозова Н.М./);
});

test("экранирование, код входа, разбиение длинного текста", () => {
  assert.equal(esc("<b>&"), "&lt;b&gt;&amp;");
  assert.match(msgLogin("123456", "https://x.y"), /<code>123456<\/code>[\s\S]*https:\/\/x\.y[\s\S]*10 минут/);
  const long = Array.from({length: 200}, (_, i) => `блок ${i} ${"я".repeat(50)}`).join("\n\n");
  const parts = chunkText(long);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 3900));
  assert.equal(parts.join("\n\n"), long);
});
