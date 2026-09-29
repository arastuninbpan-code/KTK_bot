import test from "node:test";
import assert from "node:assert/strict";
import "../lib/platform-node.mjs";
import {afishaText, appButton, chunkText, dateLong, esc, msgAdded, msgChanged, msgLogin, msgReminder, msgRemoved, shiftsText} from "../lib/format.mjs";

const row = {date: "2026-10-04", time: "11:00, 13:00", event: "Спектакль «Бука»", hall: "малая сцена", role: "Администратор/ Капельдинер", person: "Иванова М.В."};

test("дата словами", () => {
  assert.equal(dateLong("2026-10-04"), "воскресенье, 4 октября");
});

test("✈️ назначение: короткий блок, жирное название, дата · время, зал, роль", () => {
  assert.equal(msgAdded(row), [
    "✈️ <b>Вам назначена смена</b>", "",
    "<b>Спектакль «Бука»</b>", "🗓 Вс, 4 октября · ⏰ 11:00 и 13:00", "📍 Малая сцена", "👤 Администратор / Капельдинер"].join("\n"));
});

test("💬 изменение: старое зачёркнуто, новое выделено; отмена: название зачёркнуто", () => {
  const t = msgChanged({...row, time: "12:30"}, row);
  assert.match(t, /^💬 <b>Смена изменена<\/b>/);
  assert.match(t, /🗓 Вс, 4 октября · ⏰ <s>11:00 и 13:00<\/s> → <b>12:30<\/b>/);
  assert.match(t, /📍 Малая сцена/);
  assert.match(msgRemoved(row), /^💬 <b>Смена отменена<\/b>\n\n<b><s>Спектакль «Бука»<\/s><\/b>/);
});

test("напоминания: 💬 завтра (с датой), ❗ через час (без даты); несколько смен", () => {
  assert.match(msgReminder("day", [row]), /^💬 <b>Завтра у вас смена<\/b>[\s\S]*🗓 Вс, 4 октября/);
  const hour = msgReminder("hour", [row, {...row, event: "Вторая"}]);
  assert.match(hour, /^❗ <b>Через час у вас смены<\/b>/);
  assert.ok(!hour.includes("🗓"));
});

test("список смен и афиша группируются по дням", () => {
  const t = shiftsText([row, {...row, date: "2026-10-10", event: "Сказки", time: "", hall: ""}]);
  assert.match(t, /💬 <b>Ваши ближайшие смены<\/b>\n\n🗓 <b>Вс, 4 октября<\/b>\n<b>Спектакль «Бука»<\/b>/);
  assert.match(t, /🗓 <b>Сб, 10 октября<\/b>/);
  assert.equal(shiftsText([]), "💬 <b>Ближайших смен пока нет</b>");
  const a = afishaText([row, {...row, person: "Морозова Н.М.", role: "Гардероб"}]);
  assert.match(a, /💬 <b>Афиша<\/b>[\s\S]*<b>Спектакль «Бука»<\/b>\n⏰ 11:00 и 13:00 · 📍 Малая сцена\n👤 Администратор \/ Капельдинер: Иванова М.В.\n👤 Гардероб: Морозова Н.М./);
});

test("экранирование, код входа, кнопка, разбиение длинного текста", () => {
  assert.equal(esc("<b>&"), "&lt;b&gt;&amp;");
  assert.match(msgLogin("123456"), /<code>123456<\/code>[\s\S]*10 минут/);
  assert.deepEqual(appButton("https://x.y"), {button: {text: "Открыть в приложении", url: "https://x.y"}});
  assert.equal(appButton(""), undefined);
  const long = Array.from({length: 200}, (_, i) => `блок ${i} ${"я".repeat(50)}`).join("\n\n");
  const parts = chunkText(long);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 3900));
  assert.equal(parts.join("\n\n"), long);
});
