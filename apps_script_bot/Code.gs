/**
 * Бот и приложение расписания театра на Google Apps Script (бесплатно, без сервера).
 * ФАЙЛ СОБИРАЕТСЯ АВТОМАТИЧЕСКИ из app/lib и app/gas/shell.gs — руками не править (node app/build-gas.mjs).
 *
 * Свойства скрипта: SHEET_ID, TELEGRAM_BOT_TOKEN, RELAY_URL (или WEBAPP_URL), APP_URL (адрес приложения для кнопки в боте).
 * Установка: setup() → «Начать развертывание → Веб-приложение» → setWebhook() → styleSheets().
 */

// ===== lib/platform.mjs =====
// Платформенные мелочи (криптография, пауза), которые в Node и в Google Apps Script устроены по-разному.
// Node подставляет реализацию из platform-node.mjs (тесты, стенд), Apps Script — из своей оболочки.
const platform = {
  sha256hex: null,        // (строка) -> hex
  hmacB64url: null,       // (данные, секрет) -> base64url без «=»
  b64urlEncode: null,     // (строка UTF-8) -> base64url
  b64urlDecode: null,     // (base64url) -> строка UTF-8
  randomInt: null,        // (max) -> целое от 0 до max-1
  sleep: () => {},        // (мс)
};

// ===== lib/core.mjs =====
// Чистая логика без сети: разбор таблицы театра, сверка людей, сравнение версий, напоминания.
// Таблица: Дата/Время | Спектакль/Сцена | Администратор | Гардероб | Касса | Монтировка | Актёры, свет, звук
// Роль берётся из заголовка колонки, люди — из ячеек. Одна строка таблицы = одно событие.

const TZ_OFFSET_H = 3; // Москва: UTC+3 круглый год
const DAY_MS = 86400000;
const REMINDERS = [
  // за сколько до начала, насколько можно опоздать с отправкой (чтобы новую смену не «догоняли» сразу двумя напоминаниями)
  {kind: "day", before: 24 * 3600e3, grace: 3 * 3600e3},
  {kind: "hour", before: 3600e3, grace: 30 * 60e3},
];
const EVE_HOUR = 18; // смены без времени: напоминание накануне вечером

// ===== имена и телефоны =====
function norm(s) {
  s = String(s).toLowerCase().replace(/ё/g, "е").replace(/\.\s+/g, ".");
  return s.split(/\s+/).filter(Boolean).join(" ");
}

/** Любой вид номера -> цифры без кода страны: «8 (930) 702-91-09», «+7 930 702 91 09», «79307029109» -> «9307029109». */
function normPhone(s) {
  const d = String(s).replace(/\D/g, "");
  return d.length === 11 && (d[0] === "7" || d[0] === "8") ? d.slice(1) : d;
}

/** В ячейке может быть несколько номеров: через запятую, «;», «/» или с новой строки. */
function phonesIn(s) {
  return String(s).split(/[;,/\n]/).map(normPhone).filter((p) => p.length >= 7);
}

/** Сообщение — номер, а не слова или команда: 10–12 цифр и ни одной буквы. */
function looksLikePhone(t) {
  const d = String(t).replace(/\D/g, "");
  return d.length >= 10 && d.length <= 12 && !/\p{L}/u.test(String(t));
}

/** [фамилия, инициалы] без учёта регистра, точек и пробелов: «Дьячков Н. А» и «дьячков н.а.» -> ["дьячков","на"]. */
function personKey(name) {
  const w = String(name).toLowerCase().replace(/ё/g, "е").match(/\p{L}+(?:-\p{L}+)*/gu) || [];
  if (!w.length) return ["", ""];
  return [w[0], w.slice(1).map((x) => x[0]).join("")];
}

/**
 * Телефоны сотрудников, которых в расписании обозначает запись `person`.
 * Фамилия должна совпасть; инициалы, если есть с обеих сторон, тоже (можно неполные).
 * Если в расписании только фамилия, а такой фамилии несколько разных сотрудников — никого не выбираем.
 */
function matchPhones(person, users) {
  const [surname, initials] = personKey(person);
  if (!surname) return [];
  const found = [];
  for (const u of users) {
    const [s, i] = personKey(u.name);
    if (s === surname && (!initials || !i || i.startsWith(initials) || initials.startsWith(i))) {
      found.push({phone: u.phone, key: s + "/" + i});
    }
  }
  if (!initials && new Set(found.map((f) => f.key)).size > 1) return [];
  return found.map((f) => f.phone);
}

// ===== даты =====
function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}

function parseDate(s, todayIso) {
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return isoDate(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (m) return isoDate(2000 + +m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})\.(\d{1,2})$/); // «04.10» — год берём текущий
  if (m) return isoDate(+todayIso.slice(0, 4), +m[2], +m[1]);
  return null;
}

const todayIso = (nowMs) => new Date(nowMs + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);

// ===== разбор таблицы =====
const NAME_RE = /[А-ЯЁ][а-яё-]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\./g;
const HALL_RE = /\(([^)]*сцен[^)]*)\)/i;

function splitPeople(text) {
  const names = String(text).match(NAME_RE); // ловит и «Иванова А.А. Петрова Б.Б.» без разделителя
  if (names) return names.map((n) => n.split(/\s+/).join(" "));
  return String(text).split(/[/;,\n]/).map((p) => p.trim()).filter(Boolean);
}

const headerRoles = (table) => (table[0] || []).slice(2).map((c) => String(c).split(/\s+/).filter(Boolean).join(" "));

/**
 * Таблица -> события (по одному на строку): {row, date, dateEnd, time, title, hall, roles: {роль: [имена]}}.
 * row — номер строки в листе (1 = заголовок). Пустые дни пропускаются.
 */
function parseEvents(table, today) {
  if (!table || !table.length) return [];
  const roles = headerRoles(table);
  const out = [];
  table.slice(1).forEach((raw, idx) => {
    const cells = raw.map((c) => String(c).trim());
    while (cells.length < roles.length + 2) cells.push("");
    const dm = cells[0].match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/);
    const date = dm ? parseDate(dm[1], today) : null;
    if (!date) return;
    let rest = cells[0].slice(dm[0].length);
    let dateEnd = "";
    const rm = rest.match(/до\s+(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/); // «25.10 до 31.10» — диапазон
    if (rm) {
      const end = parseDate(rm[1], today);
      const days = end ? Math.round((Date.parse(end) - Date.parse(date)) / DAY_MS) : 0;
      if (days > 0 && days <= 31) dateEnd = end;
      rest = rest.slice(0, rm.index) + rest.slice(rm.index + rm[0].length);
    }
    const time = [...rest.matchAll(/\b(\d{1,2})[.:](\d{2})\b/g)].map((m) => String(+m[1]).padStart(2, "0") + ":" + m[2]).join(", ");
    let title = cells[1].split("\n").map((x) => x.trim()).filter(Boolean).join(" / ");
    let hall = "";
    const hm = title.match(HALL_RE);
    if (hm) {
      hall = hm[1].trim();
      title = (title.slice(0, hm.index) + title.slice(hm.index + hm[0].length)).split(/\s+/).join(" ").replace(/^[ /]+|[ /]+$/g, "");
    }
    const byRole = {};
    let staffed = 0;
    roles.forEach((role, i) => {
      const people = splitPeople(cells[i + 2]);
      if (people.length) { byRole[role] = people; staffed += people.length; }
    });
    if (!title && !staffed) return;
    out.push({row: idx + 2, date, dateEnd, time, title: title || "Смена", hall, roles: byRole, staffed: staffed > 0});
  });
  return out;
}

/** События -> строки «один человек в одной роли на одном дне» (для сравнения версий и напоминаний). */
function eventsToRows(events) {
  const out = [];
  for (const e of events) {
    const days = [e.date];
    if (e.dateEnd) for (let d = addDays(e.date, 1); d <= e.dateEnd; d = addDays(d, 1)) days.push(d);
    for (const day of days) {
      const base = {date: day, time: e.time, event: e.title, hall: e.hall};
      const entries = Object.entries(e.roles);
      if (!entries.length) out.push({...base, role: "", person: ""});
      for (const [role, people] of entries) for (const person of people) out.push({...base, role, person});
    }
  }
  return out;
}

const parseGrid = (table, today) => eventsToRows(parseEvents(table, today));

// ===== строки расписания =====
const rowKey = (r) => [r.date, norm(r.event), norm(r.role), norm(r.person)].join("|");

/** Начало смены (самое раннее из указанных времён) в мс UTC или null, если времени нет. */
function startMs(r) {
  const m = /\b(\d{1,2})[.:](\d{2})\b/.exec(r.time || "");
  if (!m) return null;
  const [y, mo, d] = r.date.split("-").map(Number);
  const ms = Date.UTC(y, mo - 1, d, +m[1], +m[2]) - TZ_OFFSET_H * 3600e3;
  return isNaN(ms) ? null : ms;
}

/** Что изменилось между версиями расписания -> [{kind, person, row, old}]. Прошлое и строки без ФИО игнорируются. */
function diffRows(oldRows, newRows, today) {
  const o = new Map(oldRows.filter((r) => r.person).map((r) => [rowKey(r), r]));
  const n = new Map(newRows.filter((r) => r.person).map((r) => [rowKey(r), r]));
  const out = [];
  for (const [k, r] of n) {
    if (r.date < today) continue;
    if (!o.has(k)) out.push({kind: "added", person: r.person, row: r});
    else if (o.get(k).time !== r.time || o.get(k).hall !== r.hall) out.push({kind: "changed", person: r.person, row: r, old: o.get(k)});
  }
  for (const [k, r] of o) if (!n.has(k) && r.date >= today) out.push({kind: "removed", person: r.person, row: r});
  return out;
}

/** За сутки и за час до смены (если время указано), иначе накануне вечером. Каждое напоминание — один раз. */
function findReminders(rows, users, sent, nowMs) {
  const items = []; // {phone, kind, row}
  const newKeys = [];
  for (const r of rows) {
    if (!r.person) continue;
    const phones = matchPhones(r.person, users);
    if (!phones.length) continue;
    const start = startMs(r);
    let rules;
    if (start !== null) {
      rules = REMINDERS.map((x) => ({kind: x.kind, trigger: start - x.before, grace: x.grace}));
    } else {
      const [y, m, d] = r.date.split("-").map(Number);
      rules = [{kind: "eve", trigger: Date.UTC(y, m - 1, d - 1, EVE_HOUR, 0) - TZ_OFFSET_H * 3600e3, grace: 6 * 3600e3}];
    }
    for (const x of rules) {
      if (!(x.trigger <= nowMs && nowMs < x.trigger + x.grace)) continue;
      if (start !== null && nowMs >= start) continue;
      const key = `${x.kind}|${rowKey(r)}|${r.time}`;
      for (const phone of phones) {
        if (sent.has(phone + "\t" + key)) continue;
        sent.add(phone + "\t" + key);
        newKeys.push([phone, key]);
        items.push({phone, kind: x.kind === "hour" ? "hour" : "day", row: r});
      }
    }
  }
  return {items, newKeys};
}

const dateOfKey = (key) => (key.includes("|") ? key.split("|")[1] : key);

/** Один проход: сравнить с прошлой версией, найти напоминания. Ничего не отправляет. */
function planCycle(table, users, snap, nowMs) {
  const today = todayIso(nowMs);
  const rows = parseGrid(table, today);
  const meta = snap.meta || {};
  const changes = []; // {phone, kind, row, old}
  if (meta.initialized) { // первый запуск — молча запоминаем, чтобы не завалить всех уведомлениями
    for (const c of diffRows(meta.schedule || [], rows, today)) {
      for (const phone of matchPhones(c.person, users)) changes.push({phone, kind: c.kind, row: c.row, old: c.old});
    }
  }
  const digests = snap.digests || [];
  const sent = new Set(digests.map(([p, k]) => p + "\t" + k));
  const rem = findReminders(rows, users, sent, nowMs);
  const cutoff = addDays(today, -2);
  const keptDigests = digests.concat(rem.newKeys).filter(([, k]) => dateOfKey(k) >= cutoff);
  return {changes, reminders: rem.items, snap: {chats: [], digests: keptDigests, meta: {...meta, schedule: rows, initialized: true}}};
}

// ===== запись события обратно в таблицу (в том же виде, как её ведёт театр) =====
const dd = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;

/** Событие -> ячейки строки: «04.10\n11.00 и 13.00» | «Название\n(малая сцена)» | «Иванова М.В./ Петрова Л.Н.» | ... */
function buildRow(event, roles, today) {
  const year = today.slice(0, 4);
  const dateText = (iso) => (iso.slice(0, 4) === year ? dd(iso) : `${dd(iso)}.${iso.slice(0, 4)}`);
  const times = String(event.time || "").split(/[,;]|\s+и\s+/).map((t) => t.trim()).filter(Boolean).map((t) => t.replace(":", "."));
  const dateCell = [dateText(event.date) + (event.dateEnd ? ` до ${dateText(event.dateEnd)}` : ""), times.join(" и ")].filter(Boolean).join("\n");
  const title = String(event.title || "").trim();
  const hall = String(event.hall || "").trim();
  const titleCell = [title, hall ? `(${hall})` : ""].filter(Boolean).join("\n");
  return [dateCell, titleCell, ...roles.map((r) => (event.roles?.[r] || []).join("/ "))];
}

function validateEvent(e) {
  const errors = [];
  if (!e || typeof e !== "object") return ["Пустое событие"];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "") || !isoDate(+e.date.slice(0, 4), +e.date.slice(5, 7), +e.date.slice(8, 10))) errors.push("Укажите дату");
  if (e.dateEnd && !(/^\d{4}-\d{2}-\d{2}$/.test(e.dateEnd) && e.dateEnd >= e.date)) errors.push("Дата окончания не может быть раньше даты начала");
  if (e.time && !/^\s*\d{1,2}[.:]\d{2}(\s*(,|;|и)\s*\d{1,2}[.:]\d{2})*\s*$/.test(e.time)) errors.push("Время укажите как 11:00 или 11:00, 13:00");
  if (!String(e.title || "").trim()) errors.push("Укажите название");
  return errors;
}

// ===== lib/format.mjs =====
// Оформление сообщений для мессенджеров (HTML-разметка Telegram: <b>, <s>, <code>).
// Короткие сообщения с эмодзи в тон логотипа: ✈️ назначение, 💬 информация, ❗ срочное (за час).

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD_LONG = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const WD_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const parts = (iso) => {
  const d = new Date(Date.parse(iso + "T00:00:00Z"));
  return {day: d.getUTCDate(), month: MONTHS[d.getUTCMonth()], wd: d.getUTCDay()};
};
/** «воскресенье, 4 октября» */
const dateLong = (iso) => { const p = parts(iso); return `${WD_LONG[p.wd]}, ${p.day} ${p.month}`; };
/** «Вс, 4 октября» */
const dateShort = (iso) => { const p = parts(iso); return `${WD_SHORT[p.wd]}, ${p.day} ${p.month}`; };

const roleText = (role) => String(role || "").replace(/\s*\/\s*/g, " / ");
const timeText = (t) => String(t || "").split(/,\s*/).filter(Boolean).join(" и ");

/**
 * Блок одной смены: жирное название, дата · время, зал, роль.
 * opts.old — прежняя версия (показываем «было → стало»); opts.strike — смена отменена; opts.withDate=false — без даты.
 */
function shiftBlock(r, opts = {}) {
  const {old, strike, withDate = true} = opts;
  const lines = [strike ? `<b><s>${esc(r.event)}</s></b>` : `<b>${esc(r.event)}</b>`];
  const when = [];
  if (withDate) when.push(`🗓 ${dateShort(r.date)}`);
  if (old && old.time !== r.time) when.push(`⏰ ${old.time ? `<s>${timeText(old.time)}</s> → ` : ""}<b>${timeText(r.time) || "время уточняется"}</b>`);
  else if (r.time) when.push(`⏰ ${timeText(r.time)}`);
  if (when.length) lines.push(when.join(" · "));
  if (old && old.hall !== r.hall) lines.push(`📍 ${old.hall ? `<s>${esc(cap(old.hall))}</s> → ` : ""}<b>${esc(cap(r.hall)) || "уточняется"}</b>`);
  else if (r.hall) lines.push(`📍 ${esc(cap(r.hall))}`);
  if (r.role) lines.push(`👤 ${esc(roleText(r.role))}`);
  return lines.join("\n");
}

const msgAdded = (r) => `✈️ <b>Вам назначена смена</b>\n\n${shiftBlock(r)}`;
const msgChanged = (r, old) => `💬 <b>Смена изменена</b>\n\n${shiftBlock(r, {old})}`;
const msgRemoved = (r) => `💬 <b>Смена отменена</b>\n\n${shiftBlock(r, {strike: true})}`;

function msgChange(kind, row, old) {
  return kind === "added" ? msgAdded(row) : kind === "removed" ? msgRemoved(row) : msgChanged(row, old);
}

/** Напоминание: kind = "day" (за сутки / накануне) или "hour" (❗ срочное); rows — смены одного человека. */
function msgReminder(kind, rows) {
  const many = rows.length > 1;
  const head = kind === "hour"
    ? `❗ <b>${many ? "Через час у вас смены" : "Через час у вас смена"}</b>`
    : `💬 <b>${many ? "Завтра у вас смены" : "Завтра у вас смена"}</b>`;
  return `${head}\n\n${rows.map((r) => shiftBlock(r, {withDate: kind !== "hour"})).join("\n\n")}`;
}

const byDate = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);

/** Список смен человека, сгруппированный по дням. */
function shiftsText(rows) {
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
function afishaText(rows, limit = 12) {
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
    const meta = [r.time && `⏰ ${timeText(r.time)}`, r.hall && `📍 ${esc(cap(r.hall))}`].filter(Boolean).join(" · ");
    out.push(`<b>${esc(r.event)}</b>${meta ? `\n${meta}` : ""}`);
    for (const [role, people] of roles) out.push(`👤 ${esc(roleText(role))}: ${people.map(esc).join(", ")}`);
    out.push("");
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const HELP = [
  "<b>Что я умею</b>",
  "/shifts — ваши ближайшие смены",
  "/schedule — афиша с составом",
  "/login — ваш логин для входа в приложение",
  "/stop — отключить уведомления",
].join("\n");

const msgWelcome = (name) => `✈️ <b>Готово, ${esc(name)}!</b>\nТеперь я буду присылать уведомления о ваших сменах.\n\n${HELP}`;
const msgAskPhone = "💬 <b>Здравствуйте!</b>\nЧтобы получать уведомления о сменах, поделитесь номером телефона (кнопка ниже) или пришлите свой логин, который выдал администратор.";
const msgUnknownPhone = "💬 <b>Этого номера нет в списке сотрудников.</b>\nОбратитесь к администратору, чтобы вас добавили. Если у вас есть логин, просто пришлите его сюда.";
const msgStopped = "💬 <b>Уведомления отключены.</b>\nЧтобы включить снова, напишите /start.";
const msgConnected = (name) => `💬 <b>${esc(name)}</b>, вы подключены.\n\n${HELP}`;
const msgBlocked = "💬 <b>Доступ закрыт.</b>\nОбратитесь к администратору.";
const msgLogin = (login) => `🔑 <b>Ваш логин</b>

<code>${esc(login)}</code>

Введите его в приложении. Логин постоянный: его выдаёт и может изменить администратор.`;

/** Кнопка под сообщением: «Открыть в приложении». Если адрес приложения не задан — без кнопки. */
const appButton = (url) => (url ? {button: {text: "Открыть в приложении", url}} : undefined);

/** Режет длинный текст на сообщения ≤ 3900 знаков по пустым строкам. */
function chunkText(text, max = 3900) {
  if (text.length <= max) return [text];
  const out = [];
  let cur = "";
  for (const block of text.split("\n\n")) {
    if (cur && (cur + "\n\n" + block).length > max) { out.push(cur); cur = block; } else cur = cur ? cur + "\n\n" + block : block;
  }
  if (cur) out.push(cur);
  return out;
}

// ===== lib/telegram.mjs =====
// Разбор сообщений Telegram (отправка делается в оболочке платформы).

/** Чат больше недоступен (человек заблокировал бота). */
class Gone extends Error {}

/** Сообщение Telegram -> {chatId, text, phone}. Только личные чаты и только собственный контакт. */
function telegramEvent(update) {
  const m = update.message;
  if (!m || !m.chat || m.chat.type !== "private") return null;
  const own = m.contact && m.from && m.contact.user_id === m.from.id;
  return {chatId: m.chat.id, text: m.text || "", phone: own ? m.contact.phone_number : null};
}

// ===== lib/store.mjs =====
// Хранилище поверх таблицы: сотрудники и роли, чаты, снимок расписания, коды входа, блокировка.

const TABS = {schedule: "Расписание", staff: "Сотрудники", chats: "Подписчики", state: "_служебное", lock: "_замок"};
const SUBS_HEADER = ["Канал", "ID чата", "Телефон", "ФИО"];
const ROLE_LABELS = {admin: "Админ", editor: "Редактор", reader: "Читатель", blocked: "Заблокирован"};
const CHUNK = 40000; // лимит ячейки Google — 50 000 знаков

/** Текст из колонки «Роль» -> код роли. Пусто — читатель; «директор» (старое название) — админ. */
function parseRole(text) {
  const t = String(text || "").toLowerCase();
  if (/заблок/.test(t)) return "blocked";
  if (/админ|директор/.test(t)) return "admin";
  if (/редактор/.test(t)) return "editor";
  return "reader";
}
/** Логин для сравнения: без регистра, пробелов и дефисов. */
const normLogin = (t) => String(t || "").toLowerCase().replace(/[\s\-_.]/g, "");
const LOGIN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const canEdit = (role) => role === "admin" || role === "editor";

class Store {
  constructor(book, {secret = "dev", now = () => Date.now()} = {}) {
    this.book = book;
    this.secret = secret;
    this.now = now;
  }

  // --- сотрудники: ФИО | Телефон | Роль (Админ / Редактор / Читатель / Заблокирован) | Логин ---
  users() {
    const out = [];
    for (const [name = "", phones = "", role = "", login = ""] of this.book.get(TABS.staff).slice(1)) {
      const n = String(name).trim();
      if (!n) continue;
      for (const phone of phonesIn(phones)) out.push({name: n, phone, role: parseRole(role), login: String(login).trim()});
    }
    return out;
  }

  /** Активные сотрудники (без заблокированных): им можно писать и входить на сайт. */
  activeUsers() { return this.users().filter((u) => u.role !== "blocked"); }

  staffNames() {
    return [...new Set(this.activeUsers().map((u) => u.name))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  // --- чаты (Telegram / MAX) ---
  chats() {
    this.book.ensure(TABS.chats, SUBS_HEADER);
    return this.book.get(TABS.chats).slice(1)
      .map((r, i) => ({row: i + 2, channel: String(r[0] || ""), chatId: String(r[1] || ""), phone: normPhone(r[2] || "")}))
      .filter((c) => c.channel && c.chatId);
  }

  bind(channel, chatId, phone, name) {
    const existing = this.chats().find((c) => c.channel === channel && c.chatId === String(chatId));
    const values = [channel, String(chatId), phone, name];
    if (existing) this.book.set(TABS.chats, existing.row, values);
    else this.book.append(TABS.chats, values);
  }

  unbind(channel, chatId) {
    for (const c of this.chats().filter((c) => c.channel === channel && c.chatId === String(chatId)).reverse()) {
      this.book.clearRow(TABS.chats, c.row);
    }
  }

  // --- снимок расписания и отметки о напоминаниях (лист «_служебное», JSON кусками по ячейкам) ---
  snapshot() {
    this.book.ensure(TABS.state);
    const text = this.book.get(TABS.state).map((r) => r[0] || "").join("");
    try { return text.trim() ? JSON.parse(text) : {}; } catch { return {}; }
  }

  saveSnapshot(snap) {
    const text = JSON.stringify(snap);
    const chunks = [];
    for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
    this.book.replaceColumnA(TABS.state, chunks.length ? chunks : [""]);
  }

  // --- логины: колонка D «Логин» в листе «Сотрудники». Выдаёт и меняет администратор прямо в таблице ---
  hash(text) { return platform.sha256hex(`${this.secret}:${text}`).slice(0, 32); }

  /** Отметка логина внутри сессии: после смены логина в таблице старые входы перестают работать. */
  loginMark(login) { return this.hash("login:" + normLogin(login)); }

  /** Сотрудник по логину (с учётом заблокированных — решает вызывающий). */
  findByLogin(text) {
    const key = normLogin(text);
    return key ? this.users().find((u) => normLogin(u.login) === key) || null : null;
  }

  /** Всем сотрудникам без логина выдаёт случайный (6 знаков, без похожих букв и цифр). Возвращает число выданных. */
  ensureLogins() {
    const rows = this.book.get(TABS.staff);
    if (rows.length < 2) return 0;
    const used = new Set(rows.slice(1).map((r) => normLogin(r[3])).filter(Boolean));
    let n = 0;
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (!String(r[0] || "").trim() || normLogin(r[3])) continue;
      let login;
      do {
        login = LOGIN_ALPHABET[platform.randomInt(23)]; // первый знак — буква, чтобы логин не путали с номером
        for (let k = 0; k < 5; k++) login += LOGIN_ALPHABET[platform.randomInt(LOGIN_ALPHABET.length)];
      } while (used.has(normLogin(login)));
      used.add(normLogin(login));
      this.book.set(TABS.staff, i + 1, [r[0] || "", r[1] || "", r[2] || "", login]);
      n++;
    }
    if (n && !String(rows[0][3] || "").trim()) this.book.set(TABS.staff, 1, [rows[0][0] || "ФИО", rows[0][1] || "Телефон", rows[0][2] || "Роль", "Логин"]);
    return n;
  }

  // --- блокировка, чтобы два прохода не разослали одно и то же дважды ---
  withLock(fn, ttlMs = 50000) {
    this.book.ensure(TABS.lock);
    const t = this.now();
    const held = Number((this.book.get(TABS.lock)[0] || [])[0] || 0);
    if (held && t - held < ttlMs) return {skipped: true};
    this.book.set(TABS.lock, 1, [t]);
    try {
      return fn();
    } finally {
      this.book.clearRow(TABS.lock, 1);
    }
  }
}

// ===== lib/auth.mjs =====
// Сессии: подписанный токен (HMAC-SHA256), без хранения на сервере.

const sameString = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

function makeToken(payload, secret, ttlMs = 30 * 24 * 3600e3, now = Date.now()) {
  const body = platform.b64urlEncode(JSON.stringify({...payload, exp: now + ttlMs}));
  return `${body}.${platform.hmacB64url(body, secret)}`;
}

function readToken(token, secret, now = Date.now()) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !sameString(sig, platform.hmacB64url(body, secret))) return null;
  try {
    const p = JSON.parse(platform.b64urlDecode(body));
    return p.exp > now ? p : null;
  } catch {
    return null;
  }
}

// ===== lib/api.mjs =====
// API приложения. Чистая функция: запрос -> {status, body}. Синхронный код, никакой привязки к платформе.

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Версия строки: по ней ловим одновременные правки (если строку уже изменили, вернём 409). */
const rev = (cells) => platform.sha256hex((cells || []).map(String).join("\u0001")).slice(0, 12);

/** Номер строки, куда вставить событие с датой `date`, чтобы лист оставался по порядку дат. */
function insertPosition(table, date, today) {
  for (let i = table.length; i >= 2; i--) {
    const m = String(table[i - 1]?.[0] || "").match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/);
    const d = m ? parseDate(m[1], today) : null;
    if (d && d <= date) return i + 1;
  }
  return 2;
}

function writeAt(store, table, date, cells, today) {
  const at = insertPosition(table, date, today);
  if (at > table.length) store.book.append(TABS.schedule, cells);
  else { store.book.insert(TABS.schedule, at); store.book.set(TABS.schedule, at, cells); }
}

const publicUser = (u) => ({name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role], canEdit: canEdit(u.role)});

function handleApi(req, deps) {
  const {store, secret, now = () => Date.now(), afterChange = () => {}} = deps;
  const {method, path, body = {}, token} = req;
  try {
    // --- без входа ---
    if (method === "POST" && path === "/api/login") {
      store.ensureLogins();
      const user = store.findByLogin(body.login);
      if (!user) { platform.sleep(400); throw new HttpError(401, "Такого логина нет. Отправьте боту /login: он пришлёт ваш логин."); }
      if (user.role === "blocked") throw new HttpError(403, "Доступ закрыт. Обратитесь к администратору.");
      return {status: 200, body: {token: makeToken({sub: user.phone, l: store.loginMark(user.login)}, secret, undefined, now()), user: publicUser(user)}};
    }

    // --- нужен вход ---
    const session = readToken(token, secret, now());
    if (!session) throw new HttpError(401, "Нужно войти");
    const users = store.users();
    const me = users.find((u) => u.phone === session.sub);
    if (!me || me.role === "blocked" || !me.login || session.l !== store.loginMark(me.login)) throw new HttpError(401, "Нужно войти");
    const today = todayIso(now());

    if (method === "GET" && path === "/api/schedule") {
      const table = store.book.get(TABS.schedule);
      const events = parseEvents(table, today)
        .filter((e) => (e.dateEnd || e.date) >= today)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map((e) => ({...e, rev: rev(table[e.row - 1]),
          mine: Object.entries(e.roles).filter(([, names]) => names.some((n) => matchPhones(n, users).includes(me.phone))).map(([role]) => role)}));
      return {status: 200, body: {today, me: publicUser(me), roles: headerRoles(table), events, staff: canEdit(me.role) ? store.staffNames() : undefined}};
    }

    if (["POST", "PUT", "DELETE"].includes(method) && path.startsWith("/api/events")) {
      if (!canEdit(me.role)) throw new HttpError(403, "Менять расписание могут только администратор и редактор.");
      const table = store.book.get(TABS.schedule);
      const roles = headerRoles(table);
      const rowNo = Number(path.split("/")[3] || 0);

      if (method !== "POST") {
        if (!(rowNo >= 2) || !table[rowNo - 1]) throw new HttpError(404, "Событие не найдено (возможно, его уже удалили).");
        if (body.rev !== undefined && body.rev !== rev(table[rowNo - 1])) throw new HttpError(409, "Событие уже изменили. Обновите страницу и повторите.");
      }
      if (method === "DELETE") {
        store.book.remove(TABS.schedule, rowNo);
        afterChange();
        return {status: 200, body: {ok: true}};
      }

      const event = body.event;
      const errors = validateEvent(event);
      const staff = new Set(store.staffNames());
      for (const [role, names] of Object.entries(event?.roles || {})) {
        if (!roles.includes(role)) errors.push(`Нет такой роли: ${role}`);
        for (const n of names) if (!staff.has(n)) errors.push(`Нет такого сотрудника: ${n}`);
      }
      if (errors.length) throw new HttpError(400, errors.join(". "));
      const cells = buildRow(event, roles, today);

      if (method === "POST") {
        writeAt(store, table, event.date, cells, today);
      } else {
        const old = parseEvents(table, today).find((e) => e.row === rowNo);
        if (old && old.date !== event.date) { // дата изменилась: переносим строку, чтобы лист остался по порядку
          store.book.remove(TABS.schedule, rowNo);
          writeAt(store, store.book.get(TABS.schedule), event.date, cells, today);
        } else {
          store.book.set(TABS.schedule, rowNo, cells);
        }
      }
      afterChange();
      return {status: 200, body: {ok: true}};
    }
    throw new HttpError(404, "Не найдено");
  } catch (e) {
    if (e instanceof HttpError) return {status: e.status, body: {error: e.message}};
    console.error(String(e?.message || e));
    return {status: 500, body: {error: "Что-то пошло не так. Попробуйте ещё раз."}};
  }
}

// ===== lib/bot.mjs =====
// Диалог с сотрудником (одинаков для любого мессенджера) и рассылка уведомлений. Синхронный код.

/**
 * channel: {name, send(chatId, text, options)}; options: "contact" | "remove" | {button: {text, url}}
 * ev: {chatId, text, phone}
 */
function handleMessage({store, channel, ev, appUrl = "", now = Date.now()}) {
  const chat = ev.chatId;
  const text = String(ev.text || "").trim();
  let phone = ev.phone ? normPhone(ev.phone) : null;
  if (!phone && looksLikePhone(text)) phone = normPhone(text); // номер, введённый вручную
  const users = store.users();
  const btn = appButton(appUrl);

  // логин, выданный администратором: сразу узнаём человека
  const byLogin = !phone && text && !text.startsWith("/") ? users.find((x) => x.login && normLogin(x.login) === normLogin(text)) : null;
  if (byLogin) phone = byLogin.phone;

  if (phone) {
    const u = users.find((x) => x.phone === phone);
    if (!u) return channel.send(chat, msgUnknownPhone);
    if (u.role === "blocked") return channel.send(chat, msgBlocked);
    store.bind(channel.name, chat, phone, u.name);
    return channel.send(chat, msgWelcome(u.name), "remove");
  }

  const mine = store.chats().find((c) => c.channel === channel.name && c.chatId === String(chat));
  const user = mine ? users.find((x) => x.phone === mine.phone) : null;
  if (!user) return channel.send(chat, msgAskPhone, "contact");
  if (user.role === "blocked") return channel.send(chat, msgBlocked);

  const cmd = (text.split(/\s+/)[0] || "").toLowerCase().split("@")[0];
  const today = todayIso(now);
  if (cmd === "/shifts") {
    const rows = parseGrid(store.book.get(TABS.schedule), today).filter((r) => r.date >= today && r.person && matchPhones(r.person, users).includes(user.phone));
    return channel.send(chat, shiftsText(rows), btn);
  }
  if (cmd === "/schedule") {
    return channel.send(chat, afishaText(parseGrid(store.book.get(TABS.schedule), today).filter((r) => r.date >= today)), btn);
  }
  if (cmd === "/login") {
    store.ensureLogins();
    const fresh = store.users().find((x) => x.phone === user.phone);
    return channel.send(chat, msgLogin(fresh.login), {...btn, copy: {text: "📋 Скопировать логин", value: fresh.login}});
  }
  if (cmd === "/stop") {
    store.unbind(channel.name, chat);
    return channel.send(chat, msgStopped, "remove");
  }
  return channel.send(chat, msgConnected(user.name), btn);
}

/** Сверяет расписание с прошлой версией, рассылает уведомления и напоминания. senders: {telegram: {send}, ...} */
function runCycle({store, senders, now = Date.now(), appUrl = "", log = console}) {
  store.ensureLogins();
  const users = store.activeUsers();
  const table = store.book.get(TABS.schedule);
  const snap = store.snapshot();
  const plan = planCycle(table, users, snap, now);
  if (JSON.stringify(plan.snap) !== JSON.stringify({chats: [], ...snap})) store.saveSnapshot(plan.snap);

  const messages = plan.changes.map((c) => ({phone: c.phone, text: msgChange(c.kind, c.row, c.old)}));
  const groups = new Map();
  for (const r of plan.reminders) {
    const k = r.phone + "\t" + r.kind;
    groups.set(k, {phone: r.phone, kind: r.kind, rows: [...(groups.get(k)?.rows || []), r.row]});
  }
  for (const g of groups.values()) messages.push({phone: g.phone, text: msgReminder(g.kind, g.rows)});

  if (!messages.length) return {sent: 0};
  const chats = store.chats();
  const btn = appButton(appUrl);
  let sent = 0;
  for (const m of messages) {
    for (const c of chats.filter((x) => x.phone === m.phone)) {
      try {
        senders[c.channel]?.send(c.chatId, m.text, btn);
        sent++;
      } catch (err) {
        if (err instanceof Gone) store.unbind(c.channel, c.chatId);
        else log.error(String(err.message || err));
      }
    }
  }
  return {sent};
}


// =====================================================================================
// Оболочка Google Apps Script: доступ к таблице, Telegram, точки входа, таймеры, оформление таблицы.
// Всё, что выше, — общий код из app/lib (собирается автоматически, руками не править).
// =====================================================================================

// ---------- платформа ----------
const toB64url_ = (bytes) => Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
Object.assign(platform, {
  sha256hex: (s) => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map((b) => ((b + 256) % 256).toString(16).padStart(2, "0")).join(""),
  hmacB64url: (data, secret) => toB64url_(Utilities.computeHmacSha256Signature(data, secret)),
  b64urlEncode: (s) => toB64url_(Utilities.newBlob(s).getBytes()),
  b64urlDecode: (s) => Utilities.newBlob(Utilities.base64DecodeWebSafe(s + "===".slice((s.length + 3) % 4))).getDataAsString(),
  randomInt: (max) => parseInt(Utilities.getUuid().replace(/-/g, "").slice(0, 8), 16) % max,
  sleep: (ms) => Utilities.sleep(ms),
});

// ---------- свойства ----------
function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k);
}

function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty("SESSION_SECRET");
  if (!s) { s = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, ""); p.setProperty("SESSION_SECRET", s); }
  return s;
}

// ---------- книга: тот же интерфейс, что у MemoryBook в тестах ----------
class GasBook {
  constructor() { this.ss = SpreadsheetApp.openById(prop_("SHEET_ID")); this.memo = {}; } // memo: лист читаем один раз за запрос (это самое медленное место)
  sheet(tab) {
    const s = this.ss.getSheetByName(tab);
    if (!s) throw new Error("Нет листа «" + tab + "»");
    return s;
  }
  ensure(tab, header) {
    this.memo = {};
    if (this.ss.getSheetByName(tab)) return;
    const s = this.ss.insertSheet(tab);
    if (header) s.getRange(1, 1, 1, header.length).setNumberFormat("@").setValues([header.map(String)]);
  }
  get(tab) {
    if (this.memo[tab]) return this.memo[tab];
    const s = this.sheet(tab);
    const rows = s.getLastRow() === 0 ? [] : s.getRange(1, 1, s.getLastRow(), Math.max(1, s.getLastColumn())).getDisplayValues();
    return (this.memo[tab] = rows);
  }
  set(tab, row, values) {
    this.memo = {};
    const s = this.sheet(tab);
    const width = Math.max(values.length, s.getLastColumn());
    const padded = values.map(String);
    while (padded.length < width) padded.push("");
    s.getRange(row, 1, 1, width).setNumberFormat("@").setValues([padded]); // текстом: «04.10» не превращается в дату
  }
  append(tab, values) { this.set(tab, this.sheet(tab).getLastRow() + 1, values); }
  insert(tab, beforeRow) {
    this.memo = {};
    const s = this.sheet(tab);
    if (beforeRow > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), 1);
    else s.insertRowBefore(beforeRow);
  }
  remove(tab, row) { this.memo = {}; this.sheet(tab).deleteRow(row); }
  clearRow(tab, row) { this.memo = {}; const s = this.sheet(tab); s.getRange(row, 1, 1, s.getMaxColumns()).clearContent(); }
  replaceColumnA(tab, values) {
    this.memo = {};
    const s = this.sheet(tab);
    s.clear();
    if (values.length) s.getRange(1, 1, values.length, 1).setNumberFormat("@").setValues(values.map((v) => [String(v)]));
  }
}

const store_ = () => new Store(new GasBook(), {secret: secret_()});

// ---------- Telegram ----------
function tgSend_(chatId, text, options) {
  const pieces = chunkText(text);
  pieces.forEach((piece, i) => {
    const body = {chat_id: chatId, text: piece, parse_mode: "HTML", link_preview_options: {is_disabled: true}};
    if (i === pieces.length - 1) {
      if (options === "contact") body.reply_markup = {keyboard: [[{text: "📱 Поделиться номером", request_contact: true}]], resize_keyboard: true, one_time_keyboard: true};
      else if (options === "remove") body.reply_markup = {remove_keyboard: true};
      else if (options && (options.button || options.copy)) {
        const rows = [];
        if (options.copy) rows.push([{text: options.copy.text, copy_text: {text: options.copy.value}}]); // кнопка «скопировать» одним нажатием
        if (options.button) rows.push([{text: options.button.text, url: options.button.url}]);
        body.reply_markup = {inline_keyboard: rows};
      }
    }
    const r = UrlFetchApp.fetch("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/sendMessage",
      {method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true});
    const code = r.getResponseCode();
    if (code === 403) throw new Gone(); // бот заблокирован пользователем
    if (code >= 400) throw new Error("Telegram HTTP " + code + ": " + r.getContentText().slice(0, 200)); // без адреса: в нём токен
  });
}

const SENDERS = {telegram: {name: "telegram", send: tgSend_}};

// ---------- цикл: сверка с таблицей, уведомления, напоминания ----------
const runCycle_ = () => runCycle({store: store_(), senders: SENDERS, now: Date.now(), appUrl: prop_("APP_URL") || "", log: console});

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Таймер раз в минуту: подхватывает правки таблицы (через ~15 с тишины) и раз в ~5 минут проверяет напоминания. */
function everyMinute() {
  const p = PropertiesService.getScriptProperties();
  const now = Date.now();
  const dirty = Number(p.getProperty("dirty") || 0);
  const last = Number(p.getProperty("last_cycle") || 0);
  const dueDirty = dirty && now - dirty >= 15000;
  if (!dueDirty && now - last < 4 * 60e3 + 30e3) return;
  withLock_(() => {
    if (dueDirty) p.deleteProperty("dirty");
    p.setProperty("last_cycle", String(now));
    runCycle_();
  });
}

/** Срабатывает при любой правке таблицы руками; только отмечает время, работа — в everyMinute. */
function onSheetChange() {
  PropertiesService.getScriptProperties().setProperty("dirty", String(Date.now()));
}

// ---------- точки входа ----------
const json_ = (obj) => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
const ok_ = () => ContentService.createTextOutput("ok");

function doGet() {
  return ok_();
}

/** Сюда приходят: (1) сообщения Telegram (через посредника, с ?secret=), (2) запросы приложения (JSON с полем path). */
function doPost(e) {
  try {
    if (e && e.parameter && e.parameter.secret) return telegramUpdate_(e);
    const req = JSON.parse(e.postData.contents);
    if (!req || typeof req.path !== "string" || req.path.indexOf("/api/") !== 0) return json_({error: "Не найдено"});
    return json_(apiCall_(req));
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    return json_({error: "Что-то пошло не так. Попробуйте ещё раз."});
  }
}

function apiCall_(req) {
  const call = () => handleApi({method: req.method || "GET", path: req.path, token: req.token, body: req.body || {}}, {
    store: store_(),
    secret: secret_(),
    // после правки сразу рассылаем уведомления (не ждём таймера); ошибки рассылки не ломают сохранение
    afterChange: () => { try { runCycle_(); } catch (err) { console.error(String(err && err.message ? err.message : err)); } },
  });
  const r = req.method && req.method !== "GET" ? withLock_(call) : call();
  return Object.assign({}, r.body, {_status: r.status});
}

function telegramUpdate_(e) {
  if (e.parameter.secret !== prop_("WEBHOOK_SECRET")) return ok_();
  const update = JSON.parse(e.postData.contents);
  const cache = CacheService.getScriptCache();
  if (cache.get("u" + update.update_id)) return ok_(); // Telegram может прислать то же сообщение повторно
  cache.put("u" + update.update_id, "1", 21600);
  const ev = telegramEvent(update);
  if (ev) withLock_(() => handleMessage({store: store_(), channel: SENDERS.telegram, ev, appUrl: prop_("APP_URL") || "", now: Date.now()}));
  return ok_();
}

// ---------- установка ----------
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty("WEBHOOK_SECRET")) p.setProperty("WEBHOOK_SECRET", Utilities.getUuid().replace(/-/g, ""));
  secret_();
  ScriptApp.getProjectTriggers().forEach(ScriptApp.deleteTrigger);
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("everyMinute").timeBased().everyMinutes(1).create();
  new GasBook().ensure(TABS.chats, SUBS_HEADER);
  console.log("Готово: таймеры созданы. Теперь запустите setWebhook() и styleSheets().");
}

/** Только адрес сайта из ссылки (в Apps Script нет встроенного URL); секретную часть не показываем. */
const hostOf_ = (u) => String(u || "").replace(/^https?:\/\/([^\/?#]+).*$/, "$1");

/**
 * Говорит Telegram, куда присылать сообщения. Если задано RELAY_URL (посредник Cloudflare), сообщения идут через него:
 * Apps Script отвечает на POST перенаправлением (302), Telegram считает это ошибкой и тормозит.
 */
function setWebhook() {
  let target = prop_("RELAY_URL");
  if (!target) {
    const url = prop_("WEBAPP_URL"); // из редактора getUrl() отдаёт тестовый адрес /dev (даёт Telegram ошибку 401)
    if (!url || !/\/exec$/.test(url)) throw new Error("Нужен адрес веб-приложения, оканчивающийся на /exec (свойство WEBAPP_URL) или RELAY_URL.");
    target = url + "?secret=" + encodeURIComponent(prop_("WEBHOOK_SECRET"));
  }
  console.log("Вебхук будет на: " + hostOf_(target));
  const r = UrlFetchApp.fetch("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/setWebhook", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    payload: JSON.stringify({url: target, allowed_updates: ["message"]}),
  });
  console.log(r.getContentText());
}

/** Показывает состояние вебхука (ошибки доставки, очередь). */
function webhookInfo() {
  const r = UrlFetchApp.fetch("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/getWebhookInfo", {muteHttpExceptions: true});
  const info = JSON.parse(r.getContentText()).result || {};
  console.log(JSON.stringify({host: hostOf_(info.url), pending: info.pending_update_count, last_error: info.last_error_message}));
}

function deleteWebhook() {
  UrlFetchApp.fetch("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/deleteWebhook", {muteHttpExceptions: true});
}

// ---------- оформление таблицы (запустить один раз: styleSheets) ----------
const C = {navy: "#1B3560", blue: "#0A96DC", light: "#D4F1FC", cream: "#FBF6DC", coral: "#F04E4A", orange: "#F2961E", white: "#FFFFFF"};
const MONTHS_UP = ["ЯНВАРЬ", "ФЕВРАЛЬ", "МАРТ", "АПРЕЛЬ", "МАЙ", "ИЮНЬ", "ИЮЛЬ", "АВГУСТ", "СЕНТЯБРЬ", "ОКТЯБРЬ", "НОЯБРЬ", "ДЕКАБРЬ"];
const MONTH_ROW_RE = /^[А-ЯЁ]+ \d{4}$/;
const ROLE_LIST = ["Админ", "Редактор", "Читатель", "Заблокирован"];

function styleSheets() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  styleSchedule_(ss.getSheetByName(TABS.schedule));
  styleStaff_(ss.getSheetByName(TABS.staff));
  const chats = ss.getSheetByName(TABS.chats);
  if (chats) styleHeader_(chats, 4);
  console.log("Таблица оформлена.");
}

function styleHeader_(sheet, cols) {
  sheet.getRange(1, 1, 1, cols).setBackground(C.blue).setFontColor(C.white).setFontWeight("bold").setHorizontalAlignment("center")
    .setVerticalAlignment("middle").setWrap(true);
  sheet.setRowHeight(1, 44);
  sheet.setFrozenRows(1);
}

/** Шапки месяцев («СЕНТЯБРЬ 2026»), заголовки колонок, чередование строк. */
function styleSchedule_(sheet) {
  const today = todayIso(Date.now());
  // 1) шапки месяцев перед первым событием каждого месяца (снизу вверх, чтобы номера строк не съезжали)
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 1).getDisplayValues();
  const heads = [];
  let prevMonth = "";
  for (let r = 2; r <= values.length; r++) {
    const cell = String(values[r - 1][0]).trim();
    if (MONTH_ROW_RE.test(cell)) { prevMonth = cell; continue; }
    const m = cell.match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/);
    const d = m ? parseDate(m[1], today) : null;
    if (!d) continue;
    const title = MONTHS_UP[+d.slice(5, 7) - 1] + " " + d.slice(0, 4);
    if (title !== prevMonth) { heads.push({row: r, title}); prevMonth = title; }
  }
  heads.reverse().forEach((h) => { sheet.insertRowBefore(h.row); sheet.getRange(h.row, 1).setNumberFormat("@").setValue(h.title); });

  // 2) оформление
  const lastRow = Math.max(2, sheet.getLastRow());
  const cols = Math.max(2, sheet.getLastColumn());
  const all = sheet.getRange(2, 1, lastRow - 1, cols);
  all.setBackground(C.white).setFontColor(C.navy).setWrap(true).setVerticalAlignment("top").setNumberFormat("@")
    .setBorder(true, true, true, true, true, true, "#9CB6D3", SpreadsheetApp.BorderStyle.SOLID);
  styleHeader_(sheet, cols);
  const all2 = sheet.getRange(1, 1, sheet.getLastRow(), 1).getDisplayValues();
  for (let r = 2; r <= all2.length; r++) {
    if (!MONTH_ROW_RE.test(String(all2[r - 1][0]).trim())) continue;
    const row = sheet.getRange(r, 1, 1, cols);
    row.merge().setBackground(C.navy).setFontColor(C.white).setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle").setFontSize(13);
    sheet.setRowHeight(r, 38);
  }
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 260);
  for (let c = 3; c <= cols; c++) sheet.setColumnWidth(c, 160);
  // чередование строк белый / светло-голубой (кроме шапок месяцев) — правилом, чтобы новые строки красились сами
  const range = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), cols);
  const banding = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(ISEVEN(ROW()),$A2<>"",NOT(REGEXMATCH($A2,"^[А-ЯЁ]+ [0-9]{4}$")))')
    .setBackground(C.light).setRanges([range]).build();
  sheet.setConditionalFormatRules([banding]);
}

/** Роли выпадающим списком с цветом: Админ / Редактор / Читатель / Заблокирован. */
function styleStaff_(sheet) {
  const cols = Math.max(4, sheet.getLastColumn());
  if (String(sheet.getRange(1, 3).getValue()).trim() === "") sheet.getRange(1, 3).setValue("Роль");
  if (String(sheet.getRange(1, 4).getValue()).trim() === "") sheet.getRange(1, 4).setValue("Логин");
  styleHeader_(sheet, cols);
  const last = Math.max(sheet.getMaxRows(), 2);
  const rng = sheet.getRange(2, 3, last - 1, 1);
  // старые значения приводим к новым названиям
  const cur = sheet.getRange(2, 3, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  const next = cur.map(([v]) => [{"": "Читатель"}[String(v).trim()] || (/директор/i.test(v) ? "Админ" : v)]);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 3, next.length, 1).setNumberFormat("@").setValues(next);
  rng.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLE_LIST, true).setAllowInvalid(false).build());
  const rule = (text, bg, fg) => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text).setBackground(bg).setFontColor(fg).setBold(true).setRanges([rng]).build();
  sheet.setConditionalFormatRules([rule("Админ", C.navy, C.white), rule("Редактор", C.blue, C.white), rule("Читатель", C.light, C.navy), rule("Заблокирован", C.coral, C.white)]);
  sheet.setColumnWidth(1, 240);
  sheet.setColumnWidth(2, 170);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 150);
  sheet.getRange(2, 4, Math.max(sheet.getMaxRows() - 1, 1), 1).setFontFamily("Roboto Mono").setHorizontalAlignment("center");
}
