// Оформление сообщений для мессенджеров (HTML-разметка Telegram: <b>, <s>, <code>).

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD_LONG = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const WD_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const parts = (iso) => {
  const d = new Date(Date.parse(iso + "T00:00:00Z"));
  return {day: d.getUTCDate(), month: MONTHS[d.getUTCMonth()], wd: d.getUTCDay()};
};
/** «воскресенье, 4 октября» */
export const dateLong = (iso) => { const p = parts(iso); return `${WD_LONG[p.wd]}, ${p.day} ${p.month}`; };
/** «Вс, 4 октября» */
export const dateShort = (iso) => { const p = parts(iso); return `${WD_SHORT[p.wd][0].toUpperCase()}${WD_SHORT[p.wd].slice(1)}, ${p.day} ${p.month}`; };

export const roleText = (role) => String(role || "").replace(/\s*\/\s*/g, " / ");
export const timeText = (t) => String(t || "").split(/,\s*/).filter(Boolean).join(" и ");

/** Блок одной смены. opts.old — прежняя версия (показываем «было → стало»); opts.strike — смена отменена. */
export function shiftBlock(r, opts = {}) {
  const {old, strike, withDate = true} = opts;
  const lines = [`🎭 ${strike ? `<s>${esc(r.event)}</s>` : `<b>${esc(r.event)}</b>`}`];
  if (withDate) lines.push(`🗓 ${dateLong(r.date)}`);
  if (old && old.time !== r.time) lines.push(`⏰ ${old.time ? `<s>${timeText(old.time)}</s> → ` : ""}<b>${timeText(r.time) || "время уточняется"}</b>`);
  else if (r.time) lines.push(`⏰ ${timeText(r.time)}`);
  if (old && old.hall !== r.hall) lines.push(`📍 ${old.hall ? `<s>${esc(old.hall)}</s> → ` : ""}<b>${esc(r.hall) || "уточняется"}</b>`);
  else if (r.hall) lines.push(`📍 ${esc(r.hall)}`);
  if (r.role) lines.push(`👤 ${esc(roleText(r.role))}`);
  return lines.join("\n");
}

export const msgAdded = (r) => `🆕 <b>Вам назначена смена</b>\n\n${shiftBlock(r)}`;
export const msgChanged = (r, old) => `✏️ <b>Смена изменена</b>\n\n${shiftBlock(r, {old})}`;
export const msgRemoved = (r) => `❌ <b>Смена отменена</b>\n\n${shiftBlock(r, {strike: true})}`;

export function msgChange(kind, row, old) {
  return kind === "added" ? msgAdded(row) : kind === "removed" ? msgRemoved(row) : msgChanged(row, old);
}

/** Напоминание: kind = "day" (за сутки / накануне) или "hour"; rows — смены одного человека. */
export function msgReminder(kind, rows) {
  const many = rows.length > 1;
  const head = kind === "hour"
    ? `⏰ <b>${many ? "Через час у вас смены" : "Через час у вас смена"}</b>`
    : `📅 <b>${many ? "Завтра у вас смены" : "Завтра у вас смена"}</b>`;
  return `${head}\n\n${rows.map((r) => shiftBlock(r, {withDate: kind !== "hour"})).join("\n\n")}`;
}

const byDate = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);

/** Список смен человека, сгруппированный по дням. */
export function shiftsText(rows) {
  if (!rows.length) return "📭 <b>Ближайших смен пока нет</b>";
  const out = ["📋 <b>Ваши ближайшие смены</b>"];
  let day = "";
  for (const r of [...rows].sort(byDate)) {
    if (r.date !== day) { day = r.date; out.push(`\n🗓 <b>${dateShort(r.date)}</b>`); }
    out.push(shiftBlock(r, {withDate: false}) + "\n");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Афиша: события по дням, у каждого — состав. rows — строки «человек в роли». */
export function afishaText(rows, limit = 12) {
  const events = new Map();
  for (const r of [...rows].sort((a, b) => (a.date + a.time + a.event).localeCompare(b.date + b.time + b.event))) {
    const k = [r.date, r.time, r.event].join("|");
    if (!events.has(k)) events.set(k, {r, roles: new Map()});
    if (r.person) {
      const m = events.get(k).roles;
      m.set(r.role, [...(m.get(r.role) || []), r.person]);
    }
  }
  if (!events.size) return "📭 <b>Событий пока нет</b>";
  const out = ["🎭 <b>Афиша</b>"];
  let day = "";
  for (const {r, roles} of [...events.values()].slice(0, limit)) {
    if (r.date !== day) { day = r.date; out.push(`\n🗓 <b>${dateShort(r.date)}</b>`); }
    const meta = [r.time && `⏰ ${timeText(r.time)}`, r.hall && `📍 ${esc(r.hall)}`].filter(Boolean).join(" · ");
    out.push(`🎭 <b>${esc(r.event)}</b>${meta ? `\n${meta}` : ""}`);
    for (const [role, people] of roles) out.push(`👤 ${esc(roleText(role))}: ${people.map(esc).join(", ")}`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const HELP = [
  "<b>Что я умею</b>",
  "📋 /shifts — ваши ближайшие смены",
  "🎭 /schedule — афиша с составом",
  "🔑 /login — код для входа на сайт",
  "🔕 /stop — отключить уведомления",
].join("\n");

export const msgWelcome = (name) => `✅ <b>Готово, ${esc(name)}!</b>\nТеперь я буду присылать уведомления о ваших сменах.\n\n${HELP}`;
export const msgAskPhone = "👋 <b>Здравствуйте!</b>\nЧтобы получать уведомления о сменах, поделитесь номером телефона: нажмите кнопку ниже или напишите номер сообщением.";
export const msgUnknownPhone = "🤔 <b>Этого номера нет в списке сотрудников.</b>\nОбратитесь к администратору, чтобы вас добавили.";
export const msgStopped = "🔕 <b>Уведомления отключены.</b>\nЧтобы включить снова, напишите /start.";
export const msgConnected = (name) => `👋 <b>${esc(name)}</b>, вы подключены.\n\n${HELP}`;
export const msgLogin = (code, url) => `🔑 <b>Ваш код для входа</b>\n\n<code>${code}</code>\n\nВведите его на сайте${url ? `:\n${url}` : ""}\nКод действует 10 минут и подходит один раз.`;

/** Режет длинный текст на сообщения ≤ 3900 знаков по пустым строкам. */
export function chunkText(text, max = 3900) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = "";
  for (const block of text.split("\n\n")) {
    if (cur && (cur + "\n\n" + block).length > max) { out.push(cur); cur = block; } else cur = cur ? cur + "\n\n" + block : block;
  }
  if (cur) out.push(cur);
  return out;
}
