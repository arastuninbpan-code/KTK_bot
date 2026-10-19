// Оформление сообщений для мессенджеров (HTML-разметка Telegram: <b>, <s>, <code>).
// Короткие сообщения с эмодзи в тон логотипа: ✈️ назначение, 💬 информация, ❗ срочное (за час).

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD_LONG = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const parts = (iso) => {
  const d = new Date(Date.parse(iso + "T00:00:00Z"));
  return {day: d.getUTCDate(), month: MONTHS[d.getUTCMonth()], wd: d.getUTCDay()};
};
/** «воскресенье, 4 октября» */
export const dateLong = (iso) => { const p = parts(iso); return `${WD_LONG[p.wd]}, ${p.day} ${p.month}`; };
/** «Вс, 4 октября» */
export const dateShort = (iso) => { const p = parts(iso); return `${WD_SHORT[p.wd]}, ${p.day} ${p.month}`; };

export const roleText = (role) => String(role || "").replace(/\s*\/\s*/g, " / ");
export const timeText = (t) => String(t || "").split(/,\s*/).filter(Boolean).join(" и ");
/** «11:00–12:30» (начало–окончание); без окончания — только начало. */
export const timeRange = (r) => { const s = timeText(r && r.time); return s && r.end ? `${s}–${r.end}` : s; };

/**
 * Блок одной смены: жирное название, дата · время, зал, роль.
 * opts.old — прежняя версия (показываем «было → стало»); opts.strike — смена отменена; opts.withDate=false — без даты.
 */
export function shiftBlock(r, opts = {}) {
  const {old, strike, withDate = true} = opts;
  const lines = [strike ? `<b><s>${esc(r.event)}</s></b>` : `<b>${esc(r.event)}</b>`];
  const when = [];
  if (withDate) when.push(`🗓 ${dateShort(r.date)}`);
  if (old && timeRange(old) !== timeRange(r)) when.push(`⏰ ${timeRange(old) ? `<s>${timeRange(old)}</s> → ` : ""}<b>${timeRange(r) || "время уточняется"}</b>`);
  else if (r.time) when.push(`⏰ ${timeRange(r)}`);
  if (when.length) lines.push(when.join(" · "));
  if (old && old.hall !== r.hall) lines.push(`📍 ${old.hall ? `<s>${esc(cap(old.hall))}</s> → ` : ""}<b>${esc(cap(r.hall)) || "уточняется"}</b>`);
  else if (r.hall) lines.push(`📍 ${esc(cap(r.hall))}`);
  if (r.role) lines.push(`👤 ${esc(roleText(r.role))}`);
  return lines.join("\n");
}

export const msgAdded = (r) => `✈️ <b>Вам назначена смена</b>\n\n${shiftBlock(r)}`;
export const msgChanged = (r, old) => `💬 <b>Смена изменена</b>\n\n${shiftBlock(r, {old})}`;
export const msgRemoved = (r) => `💬 <b>Смена отменена</b>\n\n${shiftBlock(r, {strike: true})}`;

export function msgChange(kind, row, old) {
  return kind === "added" ? msgAdded(row) : kind === "removed" ? msgRemoved(row) : msgChanged(row, old);
}

/** Напоминание: kind = "day" (за сутки / накануне) или "hour" (❗ срочное); rows — смены одного человека. */
export function msgReminder(kind, rows) {
  const many = rows.length > 1;
  const head = kind === "hour"
    ? `❗ <b>${many ? "Через час у вас смены" : "Через час у вас смена"}</b>`
    : `💬 <b>${many ? "Завтра у вас смены" : "Завтра у вас смена"}</b>`;
  return `${head}\n\n${rows.map((r) => shiftBlock(r, {withDate: kind !== "hour"})).join("\n\n")}`;
}

const byDate = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);

/** Список смен человека, сгруппированный по дням. */
export function shiftsText(rows) {
  if (!rows.length) return "💬 <b>Ближайших смен пока нет</b>";
  const out = ["💬 <b>Ваши ближайшие смены</b>"];
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
  if (!events.size) return "💬 <b>Событий пока нет</b>";
  const out = ["💬 <b>Афиша</b>"];
  let day = "";
  for (const {r, roles} of [...events.values()].slice(0, limit)) {
    if (r.date !== day) { day = r.date; out.push(`\n🗓 <b>${dateShort(r.date)}</b>`); }
    const meta = [r.time && `⏰ ${timeRange(r)}`, r.hall && `📍 ${esc(cap(r.hall))}`].filter(Boolean).join(" · ");
    out.push(`<b>${esc(r.event)}</b>${meta ? `\n${meta}` : ""}`);
    for (const [role, people] of roles) out.push(`👤 ${esc(roleText(role))}: ${people.map(esc).join(", ")}`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export const HELP = [
  "<b>Что я умею</b>",
  "/shifts — ваши ближайшие смены",
  "/schedule — афиша с составом",
  "/login — ваш логин для входа в приложение",
  "/stop — отключить уведомления",
].join("\n");

export const msgWelcome = (name) => `✈️ <b>Готово, ${esc(name)}!</b>\nТеперь я буду присылать уведомления о ваших сменах.\n\n${HELP}`;
export const msgAskPhone = "💬 <b>Здравствуйте!</b>\nЧтобы получать уведомления о сменах, поделитесь номером телефона (кнопка ниже, если она есть) или просто напишите сообщением свой номер либо логин, который выдал администратор.";
export const msgUnknownPhone = "💬 <b>Этого номера нет в списке сотрудников.</b>\nОбратитесь к администратору, чтобы вас добавили. Если у вас есть логин, просто пришлите его сюда.";
export const msgStopped = "💬 <b>Уведомления отключены.</b>\nЧтобы включить снова, напишите /start.";
export const msgConnected = (name, canPost = false) => `💬 <b>${esc(name)}</b>, вы подключены.\n\n${HELP}${canPost ? "\n/post — опубликовать афишу недели" : ""}`;
export const msgBlocked = "💬 <b>Доступ закрыт.</b>\nОбратитесь к администратору.";
export const msgLogin = (login) => `🔑 <b>Ваш логин</b>

<code>${esc(login)}</code>

Введите его в приложении. Логин постоянный: его выдаёт и может изменить администратор.`;

// ---------- публикация афиши (в группу ВКонтакте и/или Telegram-канал) ----------
/**
 * Афиша на неделю для открытой публикации: события по дням, время, площадка. Без имён сотрудников.
 * events — результат parseEvents; простой текст (подходит и стене ВК, и каналу Telegram).
 */
export function publicAfishaText(events, today, days = 7) {
  const last = new Date(Date.parse(today + "T00:00:00Z") + (days - 1) * 86400000).toISOString().slice(0, 10);
  const list = events.filter((e) => e.date <= last && (e.dateEnd || e.date) >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  if (!list.length) return "";
  const head = `🎭 Афиша на неделю: ${dateShort(today).split(", ")[1]} — ${dateShort(last).split(", ")[1]}`;
  const out = [head];
  let day = "";
  for (const e of list) {
    const key = e.date < today ? today : e.date;
    if (key !== day) { day = key; out.push(`\n🗓 ${dateLong(key)}`); }
    const when = e.time ? `${timeRange(e)} · ` : "";
    const range = e.dateEnd ? ` (${dateShort(e.date).split(", ")[1]} — ${dateShort(e.dateEnd).split(", ")[1]})` : "";
    out.push(`${when}${e.title}${range}${e.hall ? `\n📍 ${cap(e.hall)}` : ""}`);
  }
  return out.join("\n").trim();
}

export const msgPostNoRights = "💬 <b>Публиковать могут только администратор и редактор.</b>";
export const msgPostEmpty = "💬 <b>На ближайшую неделю событий нет:</b> публиковать нечего.";
export const msgPostNotConfigured = "💬 <b>Публикация пока не настроена.</b>\nНужны: для ВКонтакте — VK_TOKEN и VK_GROUP_ID, для Telegram-канала — TG_CHANNEL (в свойствах скрипта).";
export const msgPostPreview = (text, targets) => `💬 <b>Так будет выглядеть афиша</b>\n\n${esc(text)}\n\n—\nКуда: ${esc(targets.join(", "))}. Чтобы опубликовать, отправьте /post да`;
export const msgPostResult = (lines) => `💬 <b>Публикация</b>\n\n${lines.map(esc).join("\n")}`;

/** Кнопка под сообщением: «Открыть в приложении». Если адрес приложения не задан — без кнопки. */
export const appButton = (url) => (url ? {button: {text: "Открыть в приложении", url}} : undefined);

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
