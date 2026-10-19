/**
 * Бот и приложение расписания театра на Google Apps Script (бесплатно, без сервера).
 * ФАЙЛ СОБИРАЕТСЯ АВТОМАТИЧЕСКИ из app/lib и app/gas/shell.gs — руками не править (node app/build-gas.mjs).
 *
 * Свойства скрипта: SHEET_ID, TELEGRAM_BOT_TOKEN, RELAY_URL (или WEBAPP_URL), APP_URL (адрес приложения для кнопки в боте).
 * ВКонтакте (необязательно): VK_TOKEN, VK_GROUP_ID, VK_SECRET, VK_CONFIRM. Публикация афиши: VK_TOKEN + VK_GROUP_ID и/или TG_CHANNEL.
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

/**
 * Формат листа «Расписание». v1 — как вело театр: Дата/Время | Спектакль/Сцена | роли…
 * v2 — Дата | Начало | Конец | Событие | Площадка | роли… (определяем по заголовку, оба читаются).
 */
function layoutOf(table) {
  const head = (table && table[0]) || [];
  if (/начал/i.test(String(head[1] || "")) && /конец|оконч/i.test(String(head[2] || ""))) return {v: 2, roleStart: 5};
  return {v: 1, roleStart: 2};
}

const headerRoles = (table) => (table[0] || []).slice(layoutOf(table).roleStart).map((c) => String(c).split(/\s+/).filter(Boolean).join(" "));

/** Время из текста -> «09:05» или «». */
function clock(s) {
  const m = String(s || "").match(/\b(\d{1,2})[.:](\d{2})\b/);
  return m && +m[1] < 24 && +m[2] < 60 ? String(+m[1]).padStart(2, "0") + ":" + m[2] : "";
}

/** Ячейка даты: «04.10», «04.10.2026», «25.10 до 31.10» (+ в старом формате время на второй строке). */
function parseDateCell(text, today) {
  const dm = text.match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/);
  const date = dm ? parseDate(dm[1], today) : null;
  if (!date) return null;
  let rest = text.slice(dm[0].length);
  let dateEnd = "";
  const rm = rest.match(/до\s+(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/);
  if (rm) {
    const end = parseDate(rm[1], today);
    const days = end ? Math.round((Date.parse(end) - Date.parse(date)) / DAY_MS) : 0;
    if (days > 0 && days <= 31) dateEnd = end;
    rest = rest.slice(0, rm.index) + rest.slice(rm.index + rm[0].length);
  }
  return {date, dateEnd, rest};
}

/** «Название\n(большая сцена)» -> {title, hall} (старый формат: зал в скобках со словом «сцена»). */
function splitTitleHall(cell) {
  let title = cell.split("\n").map((x) => x.trim()).filter(Boolean).join(" / ");
  let hall = "";
  const hm = title.match(HALL_RE);
  if (hm) {
    hall = hm[1].trim();
    title = (title.slice(0, hm.index) + title.slice(hm.index + hm[0].length)).split(/\s+/).join(" ").replace(/^[ /]+|[ /]+$/g, "");
  }
  return {title, hall};
}

/**
 * Таблица -> события (по одному на строку): {row, date, dateEnd, time, end, title, hall, roles: {роль: [имена]}}.
 * time — начало («11:00», в старом формате может быть список «11:00, 13:00»), end — окончание или «».
 * hall — площадка. row — номер строки в листе (1 = заголовок). Пустые дни пропускаются.
 */
function parseEvents(table, today) {
  if (!table || !table.length) return [];
  const lay = layoutOf(table);
  const roles = headerRoles(table);
  const out = [];
  table.slice(1).forEach((raw, idx) => {
    const cells = raw.map((c) => String(c).trim());
    while (cells.length < roles.length + lay.roleStart) cells.push("");
    const d = parseDateCell(cells[0], today);
    if (!d) return;
    let time, end = "", title, hall;
    if (lay.v === 2) {
      time = clock(cells[1]);
      end = clock(cells[2]);
      title = cells[3].split("\n").map((x) => x.trim()).filter(Boolean).join(" / ");
      hall = cells[4].split(/\s+/).filter(Boolean).join(" ");
    } else {
      time = [...d.rest.matchAll(/\b(\d{1,2})[.:](\d{2})\b/g)].map((m) => String(+m[1]).padStart(2, "0") + ":" + m[2]).join(", ");
      ({title, hall} = splitTitleHall(cells[1]));
    }
    const byRole = {};
    let staffed = 0;
    roles.forEach((role, i) => {
      const people = splitPeople(cells[i + lay.roleStart]);
      if (people.length) { byRole[role] = people; staffed += people.length; }
    });
    if (!title && !staffed) return;
    out.push({row: idx + 2, date: d.date, dateEnd: d.dateEnd, time, end, title: title || "Смена", hall, roles: byRole, staffed: staffed > 0});
  });
  return out;
}

// ===== занятость площадок =====
const DEFAULT_MINUTES = 120; // если конец не указан, считаем, что событие идёт 2 часа
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const daysOf = (e) => { const out = []; for (let d = e.date; d <= (e.dateEnd || e.date); d = addDays(d, 1)) out.push(d); return out; };

/** Интервалы занятости события внутри дня (минуты от полуночи). Без времени или многодневное — занято весь день. */
function slotsOf(e) {
  const starts = String(e.time || "").split(/,\s*/).map(toMin).filter((x) => x !== null);
  if (e.dateEnd || !starts.length) return [[0, 1440]];
  const end = starts.length === 1 ? toMin(e.end) : null;
  return starts.map((s) => [s, end !== null && end > s ? end : Math.min(s + DEFAULT_MINUTES, 24 * 60 + 60)]);
}

/** События на той же площадке, которые пересекаются по времени с `cand` (сам `cand`, row = cand.row, не считается). */
function findConflicts(events, cand) {
  const hall = norm(cand.hall || "");
  if (!hall) return [];
  const mine = slotsOf(cand);
  const days = new Set(daysOf(cand));
  const out = [];
  for (const e of events) {
    if (e.row === cand.row || norm(e.hall || "") !== hall) continue;
    if (!daysOf(e).some((d) => days.has(d))) continue;
    if (slotsOf(e).some(([a, b]) => mine.some(([c, d]) => a < d && c < b))) out.push({row: e.row, title: e.title, date: e.date, dateEnd: e.dateEnd, time: e.time, end: e.end});
  }
  return out;
}

/** События -> строки «один человек в одной роли на одном дне» (для сравнения версий и напоминаний). */
function eventsToRows(events) {
  const out = [];
  const seen = new Map(); // одно и то же событие дважды в день (11:00 и 13:00) — разные строки, различаем по номеру
  for (const e of events) {
    const days = [e.date];
    if (e.dateEnd) for (let d = addDays(e.date, 1); d <= e.dateEnd; d = addDays(d, 1)) days.push(d);
    for (const day of days) {
      const base = {date: day, time: e.time, end: e.end || "", event: e.title, hall: e.hall};
      const push = (role, person) => {
        const k = [day, norm(e.title), norm(role), norm(person)].join("|");
        const n = seen.get(k) || 0;
        seen.set(k, n + 1);
        out.push({...base, role, person, seq: n});
      };
      const entries = Object.entries(e.roles);
      if (!entries.length) push("", "");
      for (const [role, people] of entries) for (const person of people) push(role, person);
    }
  }
  return out;
}

const parseGrid = (table, today) => eventsToRows(parseEvents(table, today));

// ===== строки расписания =====
const rowKey = (r) => [r.date, norm(r.event), norm(r.role), norm(r.person)].join("|") + (r.seq ? "#" + r.seq : "");

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
    else if (o.get(k).time !== r.time || (o.get(k).end || "") !== (r.end || "") || o.get(k).hall !== r.hall) out.push({kind: "changed", person: r.person, row: r, old: o.get(k)});
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

const dateTextOf = (iso, today) => (iso.slice(0, 4) === today.slice(0, 4) ? dd(iso) : `${dd(iso)}.${iso.slice(0, 4)}`);
const dateRangeText = (e, today) => dateTextOf(e.date, today) + (e.dateEnd ? ` до ${dateTextOf(e.dateEnd, today)}` : "");

/**
 * Событие -> ячейки строки.
 * v2: «04.10» | «11:00» | «12:30» | «Название» | «Большая сцена» | «Иванова М.В./ Петрова Л.Н.» | …
 * v1: «04.10\n11.00 и 13.00» | «Название\n(малая сцена)» | … (конец и площадка вне скобок в старом формате не хранятся)
 */
function buildRow(event, roles, today, layout = {v: 1}) {
  const title = String(event.title || "").trim();
  const hall = String(event.hall || "").trim();
  const people = roles.map((r) => (event.roles?.[r] || []).join("/ "));
  if (layout.v === 2) {
    return [dateRangeText(event, today), clock(String(event.time || "").split(/[,;]|\s+и\s+/)[0]), clock(event.end), title, hall, ...people];
  }
  const times = String(event.time || "").split(/[,;]|\s+и\s+/).map((t) => t.trim()).filter(Boolean).map((t) => t.replace(":", "."));
  const dateCell = [dateRangeText(event, today), times.join(" и ")].filter(Boolean).join("\n");
  const titleCell = [title, hall ? `(${hall})` : ""].filter(Boolean).join("\n");
  return [dateCell, titleCell, ...people];
}

/** Старый лист -> новый (Дата | Начало | Конец | Событие | Площадка | роли…). События с двумя временами делятся на две строки. */
function migrateTable(table, today) {
  if (layoutOf(table).v === 2) return table;
  const oldRoles = (table[0] || []).slice(2).map(String);
  const byRow = new Map(parseEvents(table, today).map((e) => [e.row, e]));
  const width = 5 + oldRoles.length;
  const pad = (cells) => { while (cells.length < width) cells.push(""); return cells; };
  const out = [pad(["Дата", "Начало", "Конец", "Событие", "Площадка", ...oldRoles])];
  table.slice(1).forEach((raw, idx) => {
    const cells = raw.map((c) => String(c).trim());
    const e = byRow.get(idx + 2);
    const roleCells = oldRoles.map((_, i) => cells[i + 2] || "");
    if (!e) { out.push(pad([cells[0] || "", "", "", cells[1] || "", "", ...roleCells])); return; } // шапки месяцев и прочее переносим как есть
    const {title} = splitTitleHall(cells[1] || "");
    const starts = e.time ? e.time.split(/,\s*/) : [""];
    for (const start of starts) out.push(pad([dateRangeText(e, today), start, "", title, e.hall, ...roleCells]));
  });
  return out;
}

function validateEvent(e) {
  const errors = [];
  if (!e || typeof e !== "object") return ["Пустое событие"];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date || "") || !isoDate(+e.date.slice(0, 4), +e.date.slice(5, 7), +e.date.slice(8, 10))) errors.push("Укажите дату");
  if (e.dateEnd && !(/^\d{4}-\d{2}-\d{2}$/.test(e.dateEnd) && e.dateEnd >= e.date)) errors.push("Дата окончания не может быть раньше даты начала");
  if (e.time && !/^\s*\d{1,2}[.:]\d{2}(\s*(,|;|и)\s*\d{1,2}[.:]\d{2})*\s*$/.test(e.time)) errors.push("Время укажите как 11:00 или 11:00, 13:00");
  if (e.end && !/^\s*\d{1,2}[.:]\d{2}\s*$/.test(e.end)) errors.push("Время окончания укажите как 12:30");
  if (e.end && !e.time) errors.push("Укажите время начала");
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
/** «11:00–12:30» (начало–окончание); без окончания — только начало. */
const timeRange = (r) => { const s = timeText(r && r.time); return s && r.end ? `${s}–${r.end}` : s; };

/**
 * Блок одной смены: жирное название, дата · время, зал, роль.
 * opts.old — прежняя версия (показываем «было → стало»); opts.strike — смена отменена; opts.withDate=false — без даты.
 */
function shiftBlock(r, opts = {}) {
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
    const meta = [r.time && `⏰ ${timeRange(r)}`, r.hall && `📍 ${esc(cap(r.hall))}`].filter(Boolean).join(" · ");
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
const msgAskPhone = "💬 <b>Здравствуйте!</b>\nЧтобы получать уведомления о сменах, поделитесь номером телефона (кнопка ниже, если она есть) или просто напишите сообщением свой номер либо логин, который выдал администратор.";
const msgUnknownPhone = "💬 <b>Этого номера нет в списке сотрудников.</b>\nОбратитесь к администратору, чтобы вас добавили. Если у вас есть логин, просто пришлите его сюда.";
const msgStopped = "💬 <b>Уведомления отключены.</b>\nЧтобы включить снова, напишите /start.";
const msgConnected = (name, canPost = false) => `💬 <b>${esc(name)}</b>, вы подключены.\n\n${HELP}${canPost ? "\n/post — опубликовать афишу недели" : ""}`;
const msgBlocked = "💬 <b>Доступ закрыт.</b>\nОбратитесь к администратору.";
const msgRequestSent = "💬 <b>Вашего номера нет в списке сотрудников.</b>\nЗаявка передана администратору, он увидит её в таблице. Если хотите, напишите одним сообщением, кто вы (ФИО и должность): оно попадёт администратору.\n\nКак только доступ откроют, я напишу вам сам.";
const msgCommentSaved = "💬 <b>Передал администратору.</b>\nКак только откроют доступ, я напишу вам сам.";
const msgAccessGranted = (name) => `✈️ <b>Доступ открыт, ${esc(name)}!</b>\nТеперь я буду присылать уведомления о ваших сменах.\n\n${HELP}`;
const msgLogin = (login) => `🔑 <b>Ваш логин</b>

<code>${esc(login)}</code>

Введите его в приложении. Логин постоянный: его выдаёт и может изменить администратор.`;

// ---------- публикация афиши (в группу ВКонтакте и/или Telegram-канал) ----------
/**
 * Афиша на неделю для открытой публикации: события по дням, время, площадка. Без имён сотрудников.
 * events — результат parseEvents; простой текст (подходит и стене ВК, и каналу Telegram).
 */
function publicAfishaText(events, today, days = 7) {
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

const msgPostNoRights = "💬 <b>Публиковать могут только администратор и редактор.</b>";
const msgPostEmpty = "💬 <b>На ближайшую неделю событий нет:</b> публиковать нечего.";
const msgPostNotConfigured = "💬 <b>Публикация пока не настроена.</b>\nНужны: для ВКонтакте — VK_TOKEN и VK_GROUP_ID, для Telegram-канала — TG_CHANNEL (в свойствах скрипта).";
const msgPostPreview = (text, targets) => `💬 <b>Так будет выглядеть афиша</b>\n\n${esc(text)}\n\n—\nКуда: ${esc(targets.join(", "))}. Чтобы опубликовать, отправьте /post да`;
const msgPostResult = (lines) => `💬 <b>Публикация</b>\n\n${lines.map(esc).join("\n")}`;

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
  const f = m.from || {};
  const label = "Telegram " + ([f.first_name, f.last_name].filter(Boolean).join(" ") || "без имени") + (f.username ? " @" + f.username : " (tg://user?id=" + (f.id || m.chat.id) + ")");
  return {chatId: m.chat.id, text: m.text || "", phone: own ? m.contact.phone_number : null, date: m.date || 0, label, name: [f.first_name, f.last_name].filter(Boolean).join(" ")};
}

// ===== lib/vk.mjs =====
// ВКонтакте: разбор входящих событий (Callback API) и подготовка сообщений. Сеть — в gas/shell.gs.
// Сообщения у нас написаны в HTML-разметке Telegram (<b>, <s>, <code>); у VK такой разметки нет, поэтому переводим в простой текст.

const UNESCAPE = {"&lt;": "<", "&gt;": ">", "&amp;": "&"};

/** HTML Telegram -> простой текст для ВК: <s>…</s> зачёркиваем значками, остальные теги убираем, &lt; &gt; &amp; возвращаем. */
function htmlToPlain(html) {
  return String(html)
    .replace(/<s>([\s\S]*?)<\/s>/g, (_, t) => Array.from(t.replace(/<[^>]*>/g, "")).map((c) => (c === " " ? c : c + "̶")).join(""))
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:lt|gt|amp);/g, (m) => UNESCAPE[m]);
}

/** Клавиатура под сообщением: кнопка-ссылка «Открыть в приложении». Подпись в ВК — до 40 знаков. */
function vkKeyboard(options) {
  if (!options || !options.button) return undefined;
  return JSON.stringify({inline: true, buttons: [[{action: {type: "open_link", link: options.button.url, label: String(options.button.text).slice(0, 40)}}]]});
}

/**
 * Callback API: {type, object: {message: {peer_id, from_id, text, out}}, event_id, secret, group_id}
 * -> {chatId, text, phone: null, eventId} для личных сообщений людей; всё остальное (беседы, эхо, другие события) -> null.
 */
function vkEvent(update) {
  if (!update || update.type !== "message_new") return null;
  const m = (update.object || {}).message;
  if (!m || m.out || !(m.from_id > 0) || m.peer_id !== m.from_id) return null;
  // ref — значение из ссылки vk.me/club…?ref=…: так «Подключить ВК» в приложении передаёт логин
  return {chatId: String(m.peer_id), text: m.text || "", phone: null, eventId: update.event_id || "", date: m.date || 0, start: String(m.ref || ""), label: "ВК https://vk.com/id" + m.peer_id};
}

/** Коды ошибок messages.send, при которых человеку писать нельзя (запретил сообщения или не начинал диалог). */
const VK_CANT_WRITE = [901, 902, 900];

// ===== lib/layout.mjs =====
// Колонки таблицы можно двигать и переименовывать: система находит нужные по названиям в шапке.
// columnPlan говорит, в каком порядке читать физические колонки, чтобы остальной код видел привычный («канонический») порядок.
const RESTORE_MARK = "↺";
const RESTORE_LABEL = "↺ Вернуть исходный вид";
const RESTORE_CONFIRM = "✔ Да, вернуть";

// Основные колонки по порядку: [подпись в исходном виде, как узнать в шапке]
const STAFF_MAIN = [["ФИО", /^(фио|сотрудник|имя)/i], ["Телефон", /телефон|номер/i], ["Роль", /^роль/i], ["Логин", /^логин/i]];
const STAFF_EXTRA = [["Доступ", /^доступ$/i], ["Комментарий", /^комментарий$/i]];
const SCHEDULE_MAIN = [["Дата", /^дата/i], ["Начало", /начал/i], ["Конец", /конец|оконч/i], ["Событие", /событие|спектакль|мероприят/i], ["Площадка", /площадк/i]];

/**
 * tab: "staff" | "schedule". head — шапка как в таблице.
 * -> null (план не нужен: старый формат расписания или шапку не узнали) или
 *    {perm, labels, modified, identity}: perm[i] — номер физической колонки для i-й колонки канонического порядка ,
 *    labels — шапка канонического вида, modified — порядок отличается от исходного (нужна красная кнопка),
 *    identity — читать таблицу как есть.
 */
function columnPlan(tab, head) {
  const h = head.map((x) => String(x || "").trim());
  const isButton = (x) => x.startsWith(RESTORE_MARK);
  if (tab === "schedule" && !(h.some((x) => /начал/i.test(x)) && h.some((x) => /конец|оконч/i.test(x)))) return null; // старый формат
  const main = tab === "staff" ? STAFF_MAIN : SCHEDULE_MAIN;
  const used = new Set();
  const find = (re) => { const i = h.findIndex((x, k) => !used.has(k) && x && !isButton(x) && re.test(x)); if (i >= 0) used.add(i); return i; };
  const perm = main.map(([, re]) => find(re));
  if (perm.some((p) => p < 0)) return null; // шапку не узнали (переименована или колонку удалили): читаем как раньше, по положению
  const labels = main.map(([l]) => l);
  if (tab === "staff") for (const [l, re] of STAFF_EXTRA) { const i = find(re); if (i >= 0) { perm.push(i); labels.push(l); } }
  const fixed = perm.length;
  h.forEach((x, k) => { if (!used.has(k) && !isButton(x)) { perm.push(k); labels.push(x); } });
  while (perm.length > fixed && perm[perm.length - 1] >= 0 && !h[perm[perm.length - 1]]) { perm.pop(); labels.pop(); } // пустые колонки в конце шапки не считаем
  const modified = perm.some((p, i) => p !== i);
  const identity = !modified && !h.some(isButton);
  return {perm, labels, modified, identity};
}

/** Физические строки -> канонический порядок колонок . */
function virtualize(rows, plan) {
  if (!plan || plan.identity) return rows;
  return rows.map((r, i) => plan.perm.map((p, j) => (i === 0 ? (p >= 0 ? r[p] : plan.labels[j]) : (p >= 0 ? (r[p] ?? "") : ""))));
}

/** Номер физической колонки (с нуля) для колонки канонического порядка; за пределами плана — как есть. */
const physicalCol = (plan, col) => (!plan || plan.identity ? col : col < plan.perm.length ? plan.perm[col] : col);

// ===== lib/store.mjs =====
// Хранилище поверх таблицы: сотрудники и роли, чаты, снимок расписания, коды входа, блокировка.

const TABS = {schedule: "Расписание", staff: "Сотрудники", venues: "Площадки", chats: "Подписчики", requests: "_заявки", state: "_служебное", lock: "_замок"};
const REQUESTS_HEADER = ["Канал", "ID чата", "Телефон"];
const VENUES_HEADER = ["Площадка", "Заметка"];
const CHECKED_RE = /^(true|да|yes|1|✓|✔|x|х)$/i; // галочка в таблице: TRUE / ✓ / «да»
const SUBS_HEADER = ["Канал", "ID чата", "Телефон", "ФИО"];
const ROLE_LABELS = {admin: "Админ", editor: "Редактор", reader: "Читатель", blocked: "Заблокирован"};
const CHUNK = 40000; // лимит ячейки Google — 50 000 знаков

/** Текст из колонки «Роль» -> код роли. Пусто — читатель; «директор» (старое название) — админ. */
/** Строка — заявка на доступ: в колонке «Роль» стоит «Заявка» (или, как раньше, вместо ФИО написано «ЗАЯВКА»). */
const isPendingRow = (name, role) => /^заявка/i.test(String(role || "").trim()) || /^заявка/i.test(String(name || "").trim());

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
  constructor(book, {secret = "dev", now = () => Date.now(), owner = null} = {}) {
    this.owner = owner && owner.phone ? owner : null; // владелец системы: {phone, name, login}; его нельзя удалить, заблокировать или понизить
    this.book = book;
    this.secret = secret;
    this.now = now;
  }

  // --- сотрудники: ФИО | Телефон | Роль | Логин | Доступ (галочка) | Комментарий | группы (колонки с галочками) ---
  /**
   * Служебные колонки ищем по заголовку (правее «Логина»): «Доступ» и «Комментарий»; все остальные колонки с названием — группы.
   * Если колонки «Доступ» нет (старая таблица), доступ есть у всех, кроме роли «Заблокирован».
   */
  staffCols_(rows) {
    const head = (rows[0] || []).map((h) => String(h || "").trim());
    const find = (re) => head.findIndex((h, i) => i >= 4 && re.test(h));
    const access = find(/^доступ$/i);
    const comment = find(/^комментарий$/i);
    const groups = head.map((name, col) => ({name, col})).filter((g) => g.col >= 4 && g.name && g.col !== access && g.col !== comment);
    return {access, comment, groups};
  }

  users() {
    const rows = this.book.get(TABS.staff);
    const {access, groups: defs} = this.staffCols_(rows);
    const out = [];
    for (const row of rows.slice(1)) {
      const [name = "", phones = "", role = "", login = ""] = row;
      const n = String(name).trim();
      if (!n) continue;
      const ticked = access >= 0 && CHECKED_RE.test(String(row[access] || "").trim());
      const pending = isPendingRow(n, role) && !ticked; // заявка одобрена, когда поставили галочку «Доступ» или сменили роль
      const hasAccess = !pending && (access < 0 || ticked); // галочка «Доступ» снята — как «Заблокирован»
      const groups = defs.filter((g) => CHECKED_RE.test(String(row[g.col] || "").trim())).map((g) => g.name);
      for (const phone of phonesIn(phones)) {
        out.push({name: n, phone, role: hasAccess ? parseRole(role) : "blocked", login: String(login).trim(), groups, pending});
      }
    }
    const o = this.owner;
    if (o) {
      const mine = out.filter((u) => u.phone === o.phone);
      if (!mine.length) out.push({name: o.name || "Владелец", phone: o.phone, role: "admin", login: o.login || "", groups: [], pending: false});
      for (const u of mine) { u.role = "admin"; u.pending = false; } // даже если строку испортили в таблице
    }
    return out;
  }

  /** Строка владельца в «Сотрудниках»: если её удалили, роль сменили или сняли «Доступ» — возвращаем (имя, номер и логин хранятся отдельно). */
  ensureOwner() {
    const o = this.owner;
    if (!o) return;
    const rows = this.book.get(TABS.staff);
    const {access} = this.staffCols_(rows);
    const at = rows.findIndex((r, i) => i > 0 && phonesIn(r[1] || "").includes(o.phone));
    if (at < 0) {
      const row = [o.name || "Владелец", o.phone, "Админ", o.login || ""];
      if (access >= 0) { while (row.length < access) row.push(""); row[access] = "TRUE"; }
      this.book.append(TABS.staff, row);
      return;
    }
    const r = rows[at];
    if (parseRole(r[2]) !== "admin") this.book.setCell(TABS.staff, at + 1, 3, "Админ");
    if (access >= 0 && !CHECKED_RE.test(String(r[access] || "").trim())) this.book.setCell(TABS.staff, at + 1, access + 1, "TRUE");
    if (!String(r[0] || "").trim() || /^заявка/i.test(String(r[0]))) this.book.setCell(TABS.staff, at + 1, 1, o.name || "Владелец");
  }

  /** Группы: [{name, members: [ФИО]}] в порядке колонок. Состав — по галочкам в таблице; заблокированные не входят. */
  groups() {
    const {groups: defs} = this.staffCols_(this.book.get(TABS.staff));
    const active = this.activeUsers();
    return defs.map((g) => ({name: g.name, members: [...new Set(active.filter((u) => u.groups.includes(g.name)).map((u) => u.name))]}));
  }

  // --- заявки на доступ: незнакомый номер -> строка «ЗАЯВКА» в «Сотрудниках» (без галочки «Доступ») + запись в служебном листе ---
  stamp() { const d = new Date(this.now() + 3 * 3600e3).toISOString(); return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)}`; }

  /**
   * Добавляет или дополняет заявку на доступ; администратор видит строку и комментарий прямо в таблице.
   * name — имя человека из мессенджера: оно сразу попадает в «ФИО» (в «Роли» стоит «Заявка» до одобрения).
   */
  addAccessRequest(phone, note, name = "") {
    const rows = this.book.get(TABS.staff);
    const cols = this.staffCols_(rows);
    let commentCol = cols.comment;
    if (commentCol < 0) { // в старой таблице колонки «Комментарий» ещё нет: заводим справа
      commentCol = Math.max(4, (rows[0] || []).length);
      this.book.setCell(TABS.staff, 1, commentCol + 1, "Комментарий");
    }
    const line = `[${this.stamp()}] ${note}`;
    let at = rows.findIndex((r, i) => i > 0 && phonesIn(r[1] || "").includes(phone));
    if (at >= 0) { // этот номер уже есть (старая заявка): дописываем
      const old = String(rows[at][commentCol] || "").trim();
      this.book.setCell(TABS.staff, at + 1, commentCol + 1, old ? old + "\n" + line : line);
      if (name && !String(rows[at][0] || "").trim()) this.book.setCell(TABS.staff, at + 1, 1, name);
      return at + 1;
    }
    at = rows.findIndex((r, i) => i > 0 && !String(r[0] || "").trim() && !String(r[1] || "").trim()); // сначала свободная строка внутри списка
    if (at < 0) at = rows.length;
    this.book.setCell(TABS.staff, at + 1, 1, String(name || "").trim() || "Без имени");
    this.book.setCell(TABS.staff, at + 1, 2, phone);
    this.book.setCell(TABS.staff, at + 1, 3, "Заявка");
    this.book.setCell(TABS.staff, at + 1, commentCol + 1, line);
    return at + 1;
  }

  requests() {
    if (!this.book.has(TABS.requests)) return [];
    return this.book.get(TABS.requests).slice(1)
      .map((r, i) => ({row: i + 2, channel: String(r[0] || ""), chatId: String(r[1] || ""), phone: normPhone(r[2] || "")}))
      .filter((r) => r.channel && r.chatId);
  }

  addRequest(channel, chatId, phone) {
    this.book.ensure(TABS.requests, REQUESTS_HEADER);
    if (this.requests().some((r) => r.channel === channel && r.chatId === String(chatId))) return;
    this.book.append(TABS.requests, [channel, String(chatId), phone]);
  }

  removeRequest(channel, chatId) {
    for (const r of this.requests().filter((x) => x.channel === channel && x.chatId === String(chatId)).reverse()) this.book.clearRow(TABS.requests, r.row);
  }

  // --- площадки: лист «Площадки» (название | заметка) ---
  venues() {
    if (!this.book.has(TABS.venues)) return [];
    const seen = new Set();
    const out = [];
    for (const [name = ""] of this.book.get(TABS.venues).slice(1)) {
      const n = String(name).split(/\s+/).filter(Boolean).join(" ");
      if (n && !seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
    }
    return out;
  }

  addVenue(name) {
    const n = String(name || "").split(/\s+/).filter(Boolean).join(" ");
    if (!n) return false;
    this.book.ensure(TABS.venues, VENUES_HEADER);
    if (this.venues().some((v) => v.toLowerCase() === n.toLowerCase())) return false;
    this.book.append(TABS.venues, [n, ""]);
    return true;
  }

  removeVenue(name) {
    if (!this.book.has(TABS.venues)) return false;
    const want = String(name || "").trim().toLowerCase();
    const i = this.book.get(TABS.venues).findIndex((r, k) => k > 0 && String(r[0] || "").trim().toLowerCase() === want);
    if (i < 0) return false;
    this.book.remove(TABS.venues, i + 1);
    return true;
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
      this.book.setCell(TABS.staff, i + 1, 4, login); // только колонка «Логин»: галочки групп правее не трогаем
      n++;
    }
    if (n && !String(rows[0][3] || "").trim()) this.book.setCell(TABS.staff, 1, 4, "Логин");
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
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
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
/** Для кнопок «Подключить Telegram / ВК»: к каким каналам уже привязан человек и какой у него логин (он идёт в ссылку-подключение). */
const connections = (store, me) => ({login: me.login, channels: [...new Set(store.chats().filter((c) => c.phone === me.phone).map((c) => c.channel))]});

function handleApi(req, deps) {
  const {store, secret, now = () => Date.now(), afterChange = () => {}, getRev = () => "", bumpRev = () => {}} = deps;
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
    // лёгкая проверка «есть ли новое»: без чтения таблицы (только подпись входа и счётчик версий)
    if (path === "/api/ping") { const rv = getRev(); return {status: 200, body: {rev: rv, changed: body.rev !== rv}}; }
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
      // площадки: список из листа «Площадки» + все, что уже вписано в события
      const venues = [...store.venues()];
      for (const e of events) if (e.hall && !venues.some((v) => norm(v) === norm(e.hall))) venues.push(e.hall);
      const editor = canEdit(me.role);
      return {status: 200, body: {today, me: {...publicUser(me), ...connections(store, me)}, roles: headerRoles(table), layout: layoutOf(table).v, rev: getRev(), events, venues,
        staff: editor ? store.staffNames() : undefined, groups: editor ? store.groups() : undefined}};
    }

    if (path === "/api/venues" && ["POST", "DELETE"].includes(method)) {
      if (!canEdit(me.role)) throw new HttpError(403, "Площадки могут менять только администратор и редактор.");
      const name = String(body.name || "").split(/\s+/).filter(Boolean).join(" ");
      if (!name) throw new HttpError(400, "Укажите название площадки");
      if (name.length > 60) throw new HttpError(400, "Название слишком длинное");
      if (method === "POST") store.addVenue(name);
      else {
        const busy = parseEvents(store.book.get(TABS.schedule), today).some((e) => norm(e.hall) === norm(name) && (e.dateEnd || e.date) >= today);
        if (busy) throw new HttpError(409, "На этой площадке есть будущие события. Сначала перенесите их.");
        store.removeVenue(name);
      }
      bumpRev();
      return {status: 200, body: {ok: true, venues: store.venues()}};
    }

    if (["POST", "PUT", "DELETE"].includes(method) && path.startsWith("/api/events")) {
      if (!canEdit(me.role)) throw new HttpError(403, "Менять расписание могут только администратор и редактор.");
      const table = store.book.get(TABS.schedule);
      const roles = headerRoles(table);
      const layout = layoutOf(table);
      const rowNo = Number(path.split("/")[3] || 0);

      if (method !== "POST") {
        if (!(rowNo >= 2) || !table[rowNo - 1]) throw new HttpError(404, "Событие не найдено (возможно, его уже удалили).");
        if (body.rev !== undefined && body.rev !== rev(table[rowNo - 1])) throw new HttpError(409, "Событие уже изменили. Обновите страницу и повторите.");
      }
      if (method === "DELETE") {
        store.book.remove(TABS.schedule, rowNo);
        bumpRev();
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
      // площадка занята в это время? Предупреждаем; если человек подтвердил (force) — сохраняем
      if (!body.force && event.hall) {
        const clash = findConflicts(parseEvents(table, today), {...event, row: method === "PUT" ? rowNo : -1});
        if (clash.length) {
          const c = clash[0];
          throw new HttpError(409, `Площадка «${event.hall}» занята: ${c.title}${c.time ? ` (${c.time}${c.end ? "–" + c.end : ""})` : ""}`, {conflicts: clash});
        }
      }
      const cells = buildRow(event, roles, today, layout);

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
      bumpRev();
      afterChange();
      return {status: 200, body: {ok: true}};
    }
    throw new HttpError(404, "Не найдено");
  } catch (e) {
    if (e instanceof HttpError) return {status: e.status, body: {error: e.message, ...e.extra}};
    console.error(String(e?.message || e));
    return {status: 500, body: {error: "Что-то пошло не так. Попробуйте ещё раз."}};
  }
}

// ===== lib/bot.mjs =====
// Диалог с сотрудником (одинаков для любого мессенджера) и рассылка уведомлений. Синхронный код.

/**
 * channel: {name, send(chatId, text, options)}; options: "contact" | "remove" | {button: {text, url}}
 * ev: {chatId, text, phone}
 * publishers: {targets(): [названия мест], post(text): [строки-итоги]} — публикация афиши в группу ВК / канал Telegram (необязательно)
 */
function handleMessage({store, channel, ev, appUrl = "", now = Date.now(), publishers = null, log = () => {}, lookupName = () => ""}) {
  const chat = ev.chatId;
  const text = String(ev.text || "").trim();
  let phone = ev.phone ? normPhone(ev.phone) : null;
  if (!phone && looksLikePhone(text)) phone = normPhone(text); // номер, введённый вручную
  const users = store.users();
  const btn = appButton(appUrl);

  // логин, выданный администратором (или пришедший из ссылки «Подключить» в приложении: /start ЛОГИН): сразу узнаём человека
  const startPayload = ev.start || (/^\/start(?:@\w+)?\s+(\S+)/i.exec(text) || [])[1] || "";
  const loginText = startPayload || (text && !text.startsWith("/") ? text : "");
  const byLogin = !phone && loginText ? users.find((x) => x.login && normLogin(x.login) === normLogin(loginText)) : null;
  if (byLogin) phone = byLogin.phone;

  const label = ev.label || channel.name;
  const myRequest = () => store.requests().find((r) => r.channel === channel.name && r.chatId === String(chat));
  // человека нет в таблице: доступа нет, но заявка и его слова видны администратору прямо в листе «Сотрудники»
  const askAccess = (typed) => {
    const mine = myRequest();
    if (mine) log("Заявка: комментарий дописан в строку " + store.addAccessRequest(mine.phone, `${label}: пишет другой номер ${typed}`));
    else {
      let name = ev.name || "";
      if (!name) { try { name = lookupName(); } catch (e) { name = ""; } } // имя из профиля ВК: отдельный запрос, делаем только для заявки
      log("Заявка: записана в строку " + store.addAccessRequest(typed, `${label}: запросил доступ`, name));
      store.addRequest(channel.name, chat, typed);
    }
    return channel.send(chat, msgRequestSent);
  };

  if (phone) {
    const u = users.find((x) => x.phone === phone);
    if (!u) return askAccess(phone);
    if (u.role === "blocked") {
      if (!u.pending) return channel.send(chat, msgBlocked);
      store.addRequest(channel.name, chat, phone); // заявка уже есть в таблице, связываем с этим чатом
      return channel.send(chat, msgRequestSent);
    }
    store.bind(channel.name, chat, phone, u.name);
    return channel.send(chat, msgWelcome(u.name), "remove");
  }

  const mine = store.chats().find((c) => c.channel === channel.name && c.chatId === String(chat));
  const user = mine ? users.find((x) => x.phone === mine.phone) : null;
  if (!user) {
    const req = myRequest();
    if (req && text && !text.startsWith("/")) { // сообщение от человека с открытой заявкой: пишем в комментарий администратору
      log("Заявка: комментарий записан в строку " + store.addAccessRequest(req.phone, `${label}: ${text}`));
      return channel.send(chat, msgCommentSaved);
    }
    return req ? channel.send(chat, msgRequestSent) : channel.send(chat, msgAskPhone, "contact");
  }
  if (user.role === "blocked") return channel.send(chat, msgBlocked);

  const [first = "", ...rest] = text.split(/\s+/);
  const cmd = first.toLowerCase().split("@")[0];
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
  if (cmd === "/post") {
    if (!canEdit(user.role)) return channel.send(chat, msgPostNoRights);
    const targets = publishers ? publishers.targets() : [];
    if (!targets.length) return channel.send(chat, msgPostNotConfigured);
    const text = publicAfishaText(parseEvents(store.book.get(TABS.schedule), today), today);
    if (!text) return channel.send(chat, msgPostEmpty);
    if (!/^(да|yes|ok)$/i.test(text0(rest))) return channel.send(chat, msgPostPreview(text, targets)); // сначала показываем, что уйдёт
    return channel.send(chat, msgPostResult(publishers.post(text)));
  }
  if (cmd === "/stop") {
    store.unbind(channel.name, chat);
    return channel.send(chat, msgStopped, "remove");
  }
  return channel.send(chat, msgConnected(user.name, canEdit(user.role) && Boolean(publishers && publishers.targets().length)), btn);
}

const text0 = (words) => String(words[0] || "").trim();

/** Сверяет расписание с прошлой версией, рассылает уведомления и напоминания. senders: {telegram: {send}, ...} */
function runCycle({store, senders, now = Date.now(), appUrl = "", log = console}) {
  store.ensureOwner();
  store.ensureLogins();
  // администратор открыл доступ тем, кто оставил заявку: подключаем их чат и пишем «доступ открыт»
  for (const rq of store.requests()) {
    const u = store.activeUsers().find((x) => x.phone === rq.phone);
    if (!u) continue;
    store.bind(rq.channel, rq.chatId, u.phone, u.name);
    store.removeRequest(rq.channel, rq.chatId);
    try { senders[rq.channel]?.send(rq.chatId, msgAccessGranted(u.name), "remove"); } catch (err) { if (!(err instanceof Gone)) log.error(String(err.message || err)); }
  }
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
// Настройки читаем одним обращением за запуск (каждое отдельное чтение — около 50 мс). Меняющиеся значения (метки правок,
// версия данных) читаем напрямую, мимо этой копии.
let propsMemo_ = null;
function prop_(k) {
  if (!propsMemo_) propsMemo_ = PropertiesService.getScriptProperties().getProperties();
  const v = propsMemo_[k];
  return v === undefined ? null : v;
}

function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty("SESSION_SECRET");
  if (!s) { s = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, ""); p.setProperty("SESSION_SECRET", s); }
  return s;
}

// ---------- кэш листов ----------
// Чтение листа из таблицы — самое медленное место (около 0,4 с на лист). Часто нужные листы держим в кэше Google и
// сбрасываем при любой правке: скриптом (GasBook), на сайте (тоже через GasBook) и руками (onSheetChange).
const PLAN_KIND_ = {[TABS.staff]: "staff", [TABS.schedule]: "schedule"};
const CACHED_TABS_ = [TABS.schedule, TABS.staff, TABS.venues, TABS.chats, TABS.requests];
const CACHE_TTL_ = 600; // запас: даже если сброс почему-то не сработал, через 10 минут данные обновятся
const CACHE_PART_ = 30000; // значение в кэше Google ограничено 100 КБ, режем на куски

function cacheRead_(tab) {
  const c = CacheService.getScriptCache();
  const token = c.get("T:" + tab);
  if (!token) return null;
  const n = Number(token.split(":")[0]);
  const keys = [];
  for (let i = 0; i < n; i++) keys.push("T:" + tab + ":" + token + ":" + i);
  const got = c.getAll(keys);
  let json = "";
  for (const k of keys) { if (got[k] == null) return null; json += got[k]; }
  try { return JSON.parse(json); } catch (e) { return null; }
}

function cacheWrite_(tab, rows) {
  const json = JSON.stringify(rows);
  const n = Math.max(1, Math.ceil(json.length / CACHE_PART_));
  const token = n + ":" + Utilities.getUuid().slice(0, 8);
  const parts = {};
  for (let i = 0; i < n; i++) parts["T:" + tab + ":" + token + ":" + i] = json.slice(i * CACHE_PART_, (i + 1) * CACHE_PART_);
  const c = CacheService.getScriptCache();
  c.putAll(parts, CACHE_TTL_);
  c.put("T:" + tab, token, CACHE_TTL_);
}

const cacheDrop_ = (tab) => CacheService.getScriptCache().remove("T:" + tab);
const dropAllCaches_ = () => CacheService.getScriptCache().removeAll(CACHED_TABS_.map((t) => "T:" + t));

// ---------- книга: тот же интерфейс, что у MemoryBook в тестах ----------
class GasBook {
  constructor() { this.memo = {}; this.opened = null; this.plans = {}; } // memo: лист читаем один раз за запрос
  get ss() { return this.opened || (this.opened = SpreadsheetApp.openById(prop_("SHEET_ID"))); } // таблицу открываем только когда без неё не обойтись
  sheet(tab) {
    const s = this.ss.getSheetByName(tab);
    if (!s) throw new Error("Нет листа «" + tab + "»");
    return s;
  }
  touch(tab) { this.memo = {}; this.plans = {}; cacheDrop_(tab); } // после любой записи в лист
  has(tab) {
    if (CACHED_TABS_.indexOf(tab) >= 0 && CacheService.getScriptCache().get("T:" + tab)) return true;
    return this.ss.getSheetByName(tab) !== null;
  }
  ensure(tab, header) {
    if (this.has(tab)) return;
    const s = this.ss.insertSheet(tab);
    if ([TABS.staff, TABS.schedule, TABS.venues].indexOf(tab) < 0) { try { s.hideSheet(); } catch (e) { /* служебный лист просто останется видимым */ } }
    if (header) s.getRange(1, 1, 1, header.length).setNumberFormat("@").setValues([header.map(String)]);
    this.touch(tab);
  }
  /** Одна ячейка текстом (остальные в строке, например галочки групп, не трогаем). */
  setCell(tab, row, col, value) {
    const at = physicalCol(this.plan(tab), col - 1);
    if (at < 0) return; // такой колонки в таблице нет
    this.grow_(this.sheet(tab), row);
    this.sheet(tab).getRange(row, at + 1).setNumberFormat("@").setValue(String(value));
    this.touch(tab);
  }
  /** Как читать колонки листа: людей и расписание находим по названиям в шапке, поэтому колонки можно двигать. */
  plan(tab) {
    if (!(tab in this.plans)) { this.get(tab); }
    return this.plans[tab] || null;
  }
  get(tab) {
    if (this.memo[tab]) return this.memo[tab];
    const cached = CACHED_TABS_.indexOf(tab) >= 0;
    let rows = cached ? cacheRead_(tab) : null;
    if (!rows) {
      const s = this.sheet(tab);
      rows = s.getLastRow() === 0 ? [] : s.getRange(1, 1, s.getLastRow(), Math.max(1, s.getLastColumn())).getDisplayValues();
      if (cached) cacheWrite_(tab, rows);
    }
    const kind = PLAN_KIND_[tab];
    const plan = kind && rows.length ? columnPlan(kind, rows[0]) : null;
    this.plans[tab] = plan;
    return (this.memo[tab] = virtualize(rows, plan));
  }
  /** Запись ниже последней строки листа: добавляем строки, иначе Google отказывает. */
  grow_(s, row) { if (row > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), row - s.getMaxRows()); }
  set(tab, row, values) {
    const s = this.sheet(tab);
    this.grow_(s, row);
    const plan = this.plan(tab);
    let padded;
    if (plan && !plan.identity) { // значения идут в канонической последовательности, раскладываем по настоящим колонкам
      padded = Array(Math.max(s.getLastColumn(), plan.perm.length)).fill("");
      values.forEach((v, j) => { const at = physicalCol(plan, j); if (at >= 0) padded[at] = String(v); });
    } else {
      const width = Math.max(values.length, s.getLastColumn());
      padded = values.map(String);
      while (padded.length < width) padded.push("");
    }
    const width = padded.length;
    s.getRange(row, 1, 1, width).setNumberFormat("@").setValues([padded]); // текстом: «04.10» не превращается в дату
    this.touch(tab);
  }
  append(tab, values) { this.set(tab, this.sheet(tab).getLastRow() + 1, values); }
  insert(tab, beforeRow) {
    const s = this.sheet(tab);
    if (beforeRow > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), 1);
    else s.insertRowBefore(beforeRow);
    this.touch(tab);
  }
  remove(tab, row) { this.sheet(tab).deleteRow(row); this.touch(tab); }
  clearRow(tab, row) { const s = this.sheet(tab); s.getRange(row, 1, 1, s.getMaxColumns()).clearContent(); this.touch(tab); }
  replaceColumnA(tab, values) {
    const s = this.sheet(tab);
    s.clear();
    if (values.length) s.getRange(1, 1, values.length, 1).setNumberFormat("@").setValues(values.map((v) => [String(v)]));
    this.touch(tab);
  }
}

/**
 * Владелец системы: его данные есть всегда, удалить, заблокировать или понизить его нельзя.
 * Берётся из свойств OWNER_PHONE (и OWNER_NAME). Если не заданы — первый «Админ» в таблице запоминается как владелец.
 * Логин запоминается отдельно, чтобы после случайного удаления строки он остался прежним.
 */
function owner_() {
  const p = PropertiesService.getScriptProperties();
  let phone = prop_("OWNER_PHONE");
  if (!phone) {
    const first = new Store(new GasBook(), {secret: secret_()}).users().find((u) => u.role === "admin" && !u.pending);
    if (!first) return null;
    p.setProperty("OWNER_PHONE", first.phone);
    p.setProperty("OWNER_NAME", first.name);
    if (first.login) p.setProperty("OWNER_LOGIN", first.login);
    propsMemo_ = null;
    phone = first.phone;
  }
  return {phone: normPhone(phone), name: prop_("OWNER_NAME") || "", login: prop_("OWNER_LOGIN") || ""};
}

/** Запоминает логин владельца, как только он появился в таблице. */
function rememberOwnerLogin_(store) {
  const o = store.owner;
  if (!o || o.login) return;
  const me = store.users().find((u) => u.phone === o.phone && u.login);
  if (me) { PropertiesService.getScriptProperties().setProperty("OWNER_LOGIN", me.login); propsMemo_ = null; }
}

const store_ = () => new Store(new GasBook(), {secret: secret_(), owner: owner_()});

// ---------- Telegram ----------
let netMs_ = 0; // сколько миллисекунд ушло на обращения к Telegram/ВК за текущий запуск (для журнала скорости)
const fetchTimed_ = (url, opts) => { const t = Date.now(); try { return UrlFetchApp.fetch(url, opts); } finally { netMs_ += Date.now() - t; } };

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
    const r = fetchTimed_("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/sendMessage",
      {method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true});
    const code = r.getResponseCode();
    if (code === 403) throw new Gone(); // бот заблокирован пользователем
    if (code >= 400) throw new Error("Telegram HTTP " + code + ": " + r.getContentText().slice(0, 200)); // без адреса: в нём токен
  });
}

// ---------- ВКонтакте ----------
const VK_V = "5.199";

function vkCall_(method, params) {
  const payload = Object.assign({access_token: prop_("VK_TOKEN"), v: VK_V}, params);
  Object.keys(payload).forEach((k) => { payload[k] = String(payload[k]); }); // всё строками: числа с плавающей точкой ВК отклоняет (random_id not int64)
  const r = fetchTimed_("https://api.vk.com/method/" + method, {method: "post", payload, muteHttpExceptions: true});
  let data = {};
  try { data = JSON.parse(r.getContentText()); } catch (e) { throw new Error("VK: непонятный ответ (HTTP " + r.getResponseCode() + ")"); }
  if (data.error) {
    if (VK_CANT_WRITE.indexOf(data.error.error_code) >= 0) throw new Gone(); // человек запретил сообщения от сообщества
    throw new Error("VK " + data.error.error_code + ": " + String(data.error.error_msg).slice(0, 160)); // без токена в тексте
  }
  return data.response;
}

/** Имя и фамилия человека из профиля ВК (для заявки на доступ). */
function vkName_(userId) {
  const r = vkCall_("users.get", {user_ids: userId});
  const u = (r && r[0]) || {};
  return [u.first_name, u.last_name].filter(Boolean).join(" ");
}

function vkSend_(peerId, text, options) {
  const pieces = chunkText(htmlToPlain(text));
  pieces.forEach((piece, i) => {
    const params = {user_id: peerId, random_id: Math.floor(Date.now() * 1000 + Math.random() * 1000), message: piece, dont_parse_links: 1};
    if (i === pieces.length - 1) { const kb = vkKeyboard(options); if (kb) params.keyboard = kb; }
    vkCall_("messages.send", params);
  });
}

/** Пост на стену группы от имени сообщества. */
function vkWallPost_(text) {
  vkCall_("wall.post", {owner_id: "-" + String(prop_("VK_GROUP_ID")).replace(/\D/g, ""), from_group: 1, message: text});
}

const SENDERS = {telegram: {name: "telegram", send: tgSend_}, vk: {name: "vk", send: vkSend_}};

/** Куда умеем публиковать афишу: стена группы ВК и/или Telegram-канал (если заданы свойства скрипта). */
function publishers_() {
  const vk = Boolean(prop_("VK_TOKEN") && prop_("VK_GROUP_ID")), tgc = prop_("TG_CHANNEL");
  return {
    targets: () => [vk ? "ВКонтакте" : "", tgc ? "Telegram-канал" : ""].filter(Boolean),
    post: (text) => {
      const lines = [];
      if (vk) { try { vkWallPost_(text); lines.push("✅ ВКонтакте: опубликовано"); } catch (e) { lines.push("⚠️ ВКонтакте: " + String(e.message || e).slice(0, 200)); } }
      if (tgc) { try { tgSend_(tgc, esc(text)); lines.push("✅ Telegram-канал: опубликовано"); } catch (e) { lines.push("⚠️ Telegram-канал: " + (e instanceof Gone ? "бот не добавлен в канал администратором" : String(e.message || e).slice(0, 200))); } }
      return lines;
    },
  };
}

// ---------- цикл: сверка с таблицей, уведомления, напоминания ----------
const runCycle_ = () => { const st = store_(); rememberOwnerLogin_(st); return runCycle({store: st, senders: SENDERS, now: Date.now(), appUrl: prop_("APP_URL") || "", log: console}); };

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// «Версия данных»: приложение раз в несколько секунд спрашивает, не изменилось ли что-то (дёшево: таблицу при этом не читаем)
const getRev_ = () => PropertiesService.getScriptProperties().getProperty("DATA_REV") || "0";
const bumpRev_ = () => PropertiesService.getScriptProperties().setProperty("DATA_REV", String(Date.now()));
const SYNC_DELAY_MS = 2000; // сколько ждём тишины после правки таблицы, чтобы не рассылать недописанное

/** Таймер раз в минуту: страховка (если быстрая сверка не сработала) и проверка напоминаний раз в ~5 минут. */
function everyMinute() {
  const p = PropertiesService.getScriptProperties();
  const now = Date.now();
  const dirty = Number(p.getProperty("dirty") || 0);
  const last = Number(p.getProperty("last_cycle") || 0);
  const dueDirty = dirty && now - dirty >= 15000;
  autoStyle_(p);
  if (p.getProperty("regroup")) { p.deleteProperty("regroup"); try { tidySchedule_(); tidyStaff_(); syncRestoreButtons_(); } catch (err) { diag_("Таблица: ОШИБКА — " + String(err && err.message ? err.message : err)); } }
  if (!dueDirty && now - last < 4 * 60e3 + 30e3) return;
  withLock_(() => {
    if (dueDirty) p.deleteProperty("dirty");
    p.setProperty("last_cycle", String(now));
    runCycle_();
  });
}

/**
 * Срабатывает при любой правке таблицы руками. Отмечает «версия данных изменилась» (приложение подхватит за секунды),
 * ждёт ~5 секунд тишины и сразу рассылает уведомления, не дожидаясь минутного таймера.
 */
function onSheetChange(e) {
  if (e && e.range && handleRestoreClick_(e)) return;
  dropAllCaches_(); // таблицу правили руками: кэшированные листы устарели
  const p = PropertiesService.getScriptProperties();
  p.setProperty("regroup", "1"); // шапки месяцев и сворачивание поправит ближайший минутный таймер
  const mark = String(Date.now());
  p.setProperty("dirty", mark);
  bumpRev_();
  Utilities.sleep(SYNC_DELAY_MS);
  if (p.getProperty("dirty") !== mark) return; // позже была ещё правка — сверку сделает она
  withLock_(() => {
    p.deleteProperty("dirty");
    p.setProperty("last_cycle", String(Date.now()));
    try { // правка в «Сотрудниках» (новая колонка-группа, новый человек): оформляем сразу, не дожидаясь таймера
      if (e && e.range && e.range.getSheet().getName() === TABS.staff) { tidyStaff_(); p.deleteProperty("regroup"); }
      syncRestoreButtons_();
    } catch (err) { diag_("Таблица: ОШИБКА — " + String(err && err.message ? err.message : err)); }
    runCycle_();
  });
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
    if (e && e.parameter && e.parameter.secret) return e.parameter.vk ? vkUpdate_(e) : telegramUpdate_(e);
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
    getRev: getRev_,
    bumpRev: bumpRev_,
    // после правки сразу рассылаем уведомления (не ждём таймера); ошибки рассылки не ломают сохранение
    afterChange: () => { PropertiesService.getScriptProperties().setProperty("regroup", "1"); try { runCycle_(); } catch (err) { console.error(String(err && err.message ? err.message : err)); } },
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
  if (ev) {
    const t0 = Date.now();
    netMs_ = 0;
    const run = () => handleMessage({store: store_(), channel: SENDERS.telegram, ev, appUrl: prop_("APP_URL") || "", now: Date.now(), publishers: publishers_(), log: diag_});
    try {
      if (READ_ONLY_RE_.test(ev.text || "")) run(); else withLock_(run); // чтение расписания блокировки не требует
      diag_("TG " + speed_(ev, t0));
    } catch (err) {
      diag_("TG: ОШИБКА — " + (err && err.message ? err.message : (err && err.constructor && err.constructor.name) || err));
    }
  }
  return ok_();
}

/** Сообщения ВКонтакте (Callback API через посредника). Подтверждение адреса отдаёт посредник; здесь на случай прямого обращения. */
const READ_ONLY_RE_ = /^\/(shifts|schedule)(@\w+)?\s*$/i; // команды, которые только читают таблицу

/** Строка про скорость: сколько секунд сообщение шло до скрипта и сколько скрипт его обрабатывал (без текста сообщения: там может быть логин). */
function speed_(ev, t0) {
  const lag = ev.date ? Math.max(0, Math.round(t0 / 1000 - ev.date)) + " с" : "?";
  const cmd = (/^\/\w+/.exec(ev.text || "") || ["текст"])[0];
  return cmd + ": доставка до скрипта " + lag + ", обработка " + (Date.now() - t0) + " мс, из них отправка в мессенджер " + netMs_ + " мс";
}

/** Короткий журнал для диагностики: лист «_лог» в таблице (время | сообщение). Секреты и токены сюда не пишем. */
function diag_(text) {
  try {
    const book = new GasBook();
    book.ensure("_лог", ["Время (МСК)", "Событие"]);
    const sh = book.sheet("_лог");
    if (sh.getLastRow() > 300) sh.deleteRows(2, 150);
    book.append("_лог", [Utilities.formatDate(new Date(), "Europe/Moscow", "dd.MM HH:mm:ss"), String(text).slice(0, 300)]);
  } catch (err) { console.error("не удалось записать журнал: " + (err && err.message)); }
}

function vkUpdate_(e) {
  try {
    if (e.parameter.secret !== prop_("WEBHOOK_SECRET")) { diag_("VK: пропущено — secret в адресе воркера (GAS_URL) не совпал с WEBHOOK_SECRET"); return ok_(); }
    const update = JSON.parse(e.postData.contents);
    if (update.type === "confirmation") return ContentService.createTextOutput(prop_("VK_CONFIRM") || "");
    if (prop_("VK_SECRET") && update.secret !== prop_("VK_SECRET")) { diag_("VK: пропущено — секретный ключ Callback API не совпал с VK_SECRET"); return ok_(); }
    const ev = vkEvent(update);
    if (!ev) { diag_("VK: пропущено — событие «" + update.type + "» не личное сообщение человека"); return ok_(); }
    const cache = CacheService.getScriptCache();
    const dedupe = "v" + (ev.eventId || ev.chatId + ":" + ev.text);
    if (cache.get(dedupe)) { diag_("VK: повтор того же события, пропущено"); return ok_(); } // ВК повторяет событие, если ответ задержался
    cache.put(dedupe, "1", 21600);
    const t0 = Date.now();
    netMs_ = 0;
    const run = () => handleMessage({store: store_(), channel: SENDERS.vk, ev, appUrl: prop_("APP_URL") || "", now: Date.now(), publishers: publishers_(), log: diag_, lookupName: () => vkName_(ev.chatId)});
    if (READ_ONLY_RE_.test(ev.text || "")) run(); else withLock_(run); // чтение расписания блокировки не требует
    diag_("VK: сообщение от " + ev.chatId + " обработано, ответ отправлен. " + speed_(ev, t0));
  } catch (err) {
    diag_("VK: ОШИБКА — " + (err && err.message ? err.message : (err && err.constructor && err.constructor.name) || err));
  }
  return ok_();
}

// ---------- установка ----------
function setup() {
  const p = PropertiesService.getScriptProperties();
  propsMemo_ = null;
  if (!p.getProperty("WEBHOOK_SECRET")) p.setProperty("WEBHOOK_SECRET", Utilities.getUuid().replace(/-/g, ""));
  secret_();
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t)); // не forEach(deleteTrigger): тот передаёт лишние параметры
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("everyMinute").timeBased().everyMinutes(1).create();
  new GasBook().ensure(TABS.chats, SUBS_HEADER);
  new GasBook().ensure(TABS.venues, VENUES_HEADER);
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
const ROLE_LIST = ["Админ", "Редактор", "Читатель", "Заблокирован", "Заявка"];

function styleSheets() {
  dropAllCaches_();
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  migrateSchedule();
  const book = new GasBook();
  book.ensure(TABS.venues, VENUES_HEADER);
  seedVenues_(book);
  styleSchedule_(ss.getSheetByName(TABS.schedule));
  styleStaff_(ss.getSheetByName(TABS.staff));
  styleVenues_(ss.getSheetByName(TABS.venues));
  const chats = ss.getSheetByName(TABS.chats);
  if (chats) styleHeader_(chats, 4);
  tidyStaff_(); // убирает «хвост» из пустых строк-заготовок и поднимает заявки, улетевшие вниз
  hideHelperSheets_(ss);
  dropAllCaches_();
  console.log("Таблица оформлена.");
}

/**
 * Старый лист (Дата/Время | Спектакль/Сцена | роли) -> новый (Дата | Начало | Конец | Событие | Площадка | роли).
 * Перед переносом делается копия листа «Расписание (копия …)». Если лист уже новый, ничего не делает.
 */
function migrateSchedule() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  const sheet = ss.getSheetByName(TABS.schedule);
  const table = new GasBook().get(TABS.schedule);
  if (layoutOf(table).v === 2) { console.log("Расписание уже в новом формате."); return; }
  const stamp = Utilities.formatDate(new Date(), "Europe/Moscow", "dd.MM HH:mm");
  sheet.copyTo(ss).setName(TABS.schedule + " (копия " + stamp + ")");
  const next = migrateTable(table, todayIso(Date.now()));
  sheet.getDataRange().breakApart();
  sheet.clear();
  sheet.getRange(1, 1, next.length, next[0].length).setNumberFormat("@").setValues(next);
  console.log("Расписание перенесено в новый формат (строк: " + (next.length - 1) + "). Копия старого листа сохранена.");
}

/** В листе «Площадки» после переноса оказываются все площадки, уже встречающиеся в расписании. */
function seedVenues_(book) {
  if (book.get(TABS.venues).length > 1) return;
  const seen = {};
  parseEvents(book.get(TABS.schedule), todayIso(Date.now())).forEach((e) => {
    const key = norm(e.hall);
    if (e.hall && !seen[key]) { seen[key] = true; book.append(TABS.venues, [e.hall.charAt(0).toUpperCase() + e.hall.slice(1), ""]); }
  });
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
  fixMonths_(sheet);

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
  const lay = layoutOf([sheet.getRange(1, 1, 1, Math.max(2, sheet.getLastColumn())).getDisplayValues()[0]]);
  if (lay.v === 2) {
    [110, 80, 80, 260, 160].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    for (let c = 6; c <= cols; c++) sheet.setColumnWidth(c, 160);
    sheet.getRange(2, 2, Math.max(sheet.getMaxRows() - 1, 1), 2).setHorizontalAlignment("center");
    // площадка — выпадающий список из листа «Площадки» (можно вписать и новую)
    const venues = sheet.getParent().getSheetByName(TABS.venues);
    if (venues) sheet.getRange(2, 5, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInRange(venues.getRange("A2:A300"), true).setAllowInvalid(true).build());
  } else {
    sheet.setColumnWidth(1, 120);
    sheet.setColumnWidth(2, 260);
    for (let c = 3; c <= cols; c++) sheet.setColumnWidth(c, 160);
  }
  // чередование строк белый / светло-голубой (кроме шапок месяцев) — правилом, чтобы новые строки красились сами
  const range = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), cols);
  const banding = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(ISEVEN(ROW()),$A2<>"",NOT(REGEXMATCH($A2,"^[А-ЯЁ]+ [0-9]{4}$")))')
    .setBackground(C.light).setRanges([range]).build();
  sheet.setConditionalFormatRules([banding]);
  groupMonths_(sheet, true);
}

const monthTitle_ = (date) => MONTHS_UP[+date.slice(5, 7) - 1] + " " + date.slice(0, 4);
const dateOfRow_ = (cell, today) => { const m = String(cell).match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/); return m ? parseDate(m[1], today) : null; };
const monthRowTitle_ = (row) => { const f = row.filter((c) => String(c).trim() !== ""); return f.length === 1 && MONTH_ROW_RE.test(String(f[0]).trim()) ? String(f[0]).trim() : null; };

/**
 * Месяцы должны идти друг за другом без повторов: у каждого события шапка именно его месяца, шапки по порядку.
 * Если это не так (событие вписали не на своё место, дату поменяли, шапка задублировалась), лист пересобирается:
 * события сортируются по дате (внутри одной даты порядок сохраняется), старые шапки убираются, ставятся новые.
 */
function monthsDisordered_(rows, today) {
  let current = "";
  let lastDate = "";
  const seen = {};
  for (let r = 1; r < rows.length; r++) {
    const t = monthRowTitle_(rows[r]);
    if (t) { if (seen[t]) return true; seen[t] = true; current = t; continue; }
    const d = dateOfRow_(rows[r][0], today);
    if (!d) continue;
    if (d < lastDate || monthTitle_(d) !== current) return true;
    lastDate = d;
  }
  return false;
}

function rebuildMonths_(sheet) {
  const today = todayIso(Date.now());
  const lastRow = sheet.getLastRow();
  const cols = Math.max(2, sheet.getLastColumn());
  const data = sheet.getRange(1, 1, lastRow, cols).getValues();
  const body = [];
  let key = "0000-00-00";
  data.slice(1).forEach((row) => {
    if (monthRowTitle_(row) !== null) return; // старые шапки убираем, новые поставим сами
    if (row.every((c) => String(c).trim() === "")) return; // пустые строки внутри не нужны
    const d = dateOfRow_(row[0], today);
    if (d) key = d; // строка без понятной даты остаётся рядом с предыдущей
    body.push({row, key, n: body.length});
  });
  body.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.n - b.n));
  const out = [];
  let title = "";
  body.forEach((b) => {
    const t = b.key === "0000-00-00" ? "" : monthTitle_(b.key);
    if (t && t !== title) { out.push([t].concat(Array(cols - 1).fill(""))); title = t; }
    out.push(b.row);
  });
  const range = sheet.getRange(2, 1, Math.max(lastRow - 1, 1), cols);
  for (let r = 2; r <= lastRow; r++) { const d = sheet.getRowGroupDepth(r); if (d > 0) sheet.getRange(r, 1, 1, 1).shiftRowGroupDepth(-d); }
  sheet.getDataRange().breakApart();
  range.clear();
  if (out.length) sheet.getRange(2, 1, out.length, cols).setNumberFormat("@").setValues(out);
  console.log("Месяцы пересобраны по порядку (строк: " + out.length + ").");
}

/** Приводит месяцы в порядок: пересборка, если они перепутаны, иначе только недостающие шапки. */
function fixMonths_(sheet) {
  if (sheet.getLastRow() < 2) return 0;
  const rows = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(2, sheet.getLastColumn())).getDisplayValues();
  const plan = columnPlan("schedule", rows[0]);
  if (plan && plan.perm[0] !== 0) return 0; // колонку «Дата» переставили: порядок наводить не будем, пока не вернут вид
  if (monthsDisordered_(rows, todayIso(Date.now()))) { rebuildMonths_(sheet); return 1; }
  return ensureMonthHeaders_(sheet);
}

/** Шапка месяца перед первым событием каждого месяца, если её нет (снизу вверх, чтобы номера строк не съезжали). Возвращает, сколько добавлено. */
function ensureMonthHeaders_(sheet) {
  const today = todayIso(Date.now());
  const values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getDisplayValues();
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
  return heads.length;
}

/**
 * Каждый месяц — группа строк под шапкой: слева значок «−/+» сворачивает месяц целиком.
 * Прошедшие месяцы свёрнуты по умолчанию; то, как человек развернул или свернул месяц руками, сохраняем.
 */
function groupMonths_(sheet, fresh) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const today = todayIso(Date.now());
  const col = sheet.getRange(1, 1, last, 1).getDisplayValues();
  const months = [];
  for (let r = 2; r <= last; r++) {
    const t = String(col[r - 1][0]).trim();
    if (MONTH_ROW_RE.test(t)) months.push({head: r, title: t, end: r});
    else if (months.length) months[months.length - 1].end = r;
  }
  if (!months.length) return;
  const thisMonth = MONTHS_UP[+today.slice(5, 7) - 1] + " " + today.slice(0, 4);
  const monthKey = (t) => { const i = MONTHS_UP.indexOf(t.split(" ")[0]); return t.split(" ")[1] + String(i + 100); };
  sheet.setRowGroupControlPosition(SpreadsheetApp.GroupControlTogglePosition.BEFORE);
  months.forEach((m) => {
    const rows = m.end - m.head;
    if (rows < 1) return;
    let collapsed = monthKey(m.title) < monthKey(thisMonth);
    if (!fresh) { const g = sheet.getRowGroup(m.head + 1, 1); if (g) collapsed = g.isCollapsed(); }
    const range = sheet.getRange(m.head + 1, 1, rows, 1);
    let depth = sheet.getRowGroupDepth(m.head + 1);
    if (depth > 1 || (depth === 1 && !sheet.getRowGroup(m.head + 1, 1))) { range.shiftRowGroupDepth(-depth); depth = 0; }
    if (depth === 0) range.shiftRowGroupDepth(1);
    const g = sheet.getRowGroup(m.head + 1, 1);
    if (g) { if (collapsed) g.collapse(); else g.expand(); }
  });
}

const STYLE_VERSION_ = "6"; // поднимайте, когда меняется оформление: таблица перестроится сама при ближайшем срабатывании таймера

/** После обновления кода один раз оформляет таблицу сама (то же, что ручной запуск styleSheets). */
function autoStyle_(p) {
  if (p.getProperty("STYLE_VER") === STYLE_VERSION_) return;
  p.setProperty("STYLE_VER", STYLE_VERSION_); // помечаем сразу: если что-то сломается, не повторяем каждую минуту
  try { styleSheets(); } catch (err) { console.error("Автооформление не удалось (запустите styleSheets вручную): " + String(err && err.message ? err.message : err)); }
}

/**
 * «Сотрудники»: новая колонка (вид деятельности) сразу получает галочки; у нового человека по умолчанию роль «Читатель» и доступ включён
 * (если не стоит «ЗАЯВКА» без одобрения: заявку одобряют, вписав ФИО — доступ включится сам).
 */
/**
 * Пустые строки «Сотрудников» должны быть пустыми: иначе лист кажется заполненным до самого низа и новые люди и заявки уходят за тысячную строку.
 * Убираем значения-заготовки («Читатель», FALSE) из строк без ФИО и телефона, а строки, залетевшие далеко вниз, поднимаем на первое свободное место.
 */
function cleanStaffRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const cols = Math.max(sheet.getLastColumn(), 6);
  const head = sheet.getRange(1, 1, 1, cols).getDisplayValues()[0];
  const plan = columnPlan("staff", head);
  const nameIdx = plan ? plan.perm[0] : 0;
  const phoneIdx = plan ? plan.perm[1] : 1;
  const vals = sheet.getRange(2, 1, last - 1, cols).getValues();
  const real = (r) => String(r[nameIdx]).trim() !== "" || String(r[phoneIdx]).trim() !== "";
  const out = vals.map((r) => (real(r) ? r.slice() : r.map(() => "")));
  const STRAY_FROM = 100; // строки глубже этого номера считаем «улетевшими» (обычно их там быть не может)
  for (let i = STRAY_FROM; i < out.length; i++) {
    if (!real(out[i])) continue;
    const free = out.findIndex((r, k) => k < i && !real(r));
    if (free < 0) break;
    out[free] = out[i];
    out[i] = out[i].map(() => "");
  }
  if (JSON.stringify(out) === JSON.stringify(vals)) return false;
  sheet.getRange(2, 1, out.length, cols).setValues(out);
  return true;
}

function tidyStaff_() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  const sheet = ss.getSheetByName(TABS.staff);
  if (!sheet || sheet.getLastRow() < 1) return;
  const p = PropertiesService.getScriptProperties();
  if (cleanStaffRows_(sheet)) { dropAllCaches_(); bumpRev_(); }
  const data = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(sheet.getLastColumn(), 6)).getDisplayValues();
  const head = data[0].map((x) => String(x).trim());
  const plan = columnPlan("staff", head);
  const sig = head.join("|");
  const accessIdx = head.findIndex((x) => /^доступ$/i.test(x));
  const canonical = !plan || !plan.modified; // колонки на своих местах: оформляем целиком; двигали — оформляем только то, что можно по названиям
  if (canonical && (accessIdx < 0 || p.getProperty("STAFF_HEAD") !== sig)) { styleStaff_(sheet); p.setProperty("STAFF_HEAD", sig); return tidyStaff_(); }
  if (!canonical && p.getProperty("STAFF_HEAD") !== sig) { // колонки переставили: новым колонкам-группам всё равно нужны галочки
    const fixed = plan.perm.slice(0, 4 + (accessIdx >= 0 ? 1 : 0));
    const rest = head.map((x, i) => ({x, i})).filter((c) => c.x && fixed.indexOf(c.i) < 0 && !/^комментарий$/i.test(c.x) && !c.x.startsWith(RESTORE_MARK));
    const rows = Math.max(sheet.getMaxRows() - 1, 1);
    rest.forEach((c) => sheet.getRange(2, c.i + 1, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build()).setHorizontalAlignment("center"));
    p.setProperty("STAFF_HEAD", sig);
  }
  if (accessIdx < 0) return;
  const roleIdx = plan ? plan.perm[2] : 2;
  const nameIdx = plan ? plan.perm[0] : 0;
  let changed = false;
  for (let r = 2; r <= data.length; r++) {
    const name = String(data[r - 1][nameIdx]).trim();
    if (!name) continue;
    if (String(data[r - 1][roleIdx]).trim() === "" && !/^заявка/i.test(name)) { sheet.getRange(r, roleIdx + 1).setNumberFormat("@").setValue("Читатель"); changed = true; }
    if (/^заявка/i.test(String(data[r - 1][roleIdx]).trim()) && /^(true|да|1)$/i.test(String(data[r - 1][accessIdx]).trim())) { // поставили «Доступ» у заявки: теперь это обычный сотрудник
      sheet.getRange(r, roleIdx + 1).setNumberFormat("@").setValue("Читатель"); changed = true;
    }
    if (!isPendingRow(name, data[r - 1][roleIdx]) && String(data[r - 1][accessIdx]).trim() === "") { sheet.getRange(r, accessIdx + 1).setValue(true); changed = true; }
  }
  if (changed) { dropAllCaches_(); bumpRev_(); }
}

// ---------- «Вернуть исходный вид»: если колонки переставили, система подстраивается (ищет их по названиям), а в шапке появляется красная кнопка ----------
/** Ставит или убирает красную кнопку в шапке «Сотрудников» и «Расписания». */
function syncRestoreButtons_() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  Object.keys(PLAN_KIND_).forEach((tab) => {
    const sheet = ss.getSheetByName(tab);
    if (!sheet || sheet.getLastColumn() < 1) return;
    const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map((x) => String(x).trim());
    const plan = columnPlan(PLAN_KIND_[tab], head);
    const btn = head.findIndex((x) => x.startsWith(RESTORE_MARK));
    let lastIdx = -1;
    head.forEach((x, i) => { if (x && !x.startsWith(RESTORE_MARK)) lastIdx = i; });
    if (plan && plan.modified) {
      if (btn === lastIdx + 1) return; // уже на месте
      if (btn >= 0) sheet.getRange(1, btn + 1).clear();
      const cell = sheet.getRange(1, lastIdx + 2);
      cell.setNumberFormat("@").setValue(RESTORE_LABEL)
        .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList([RESTORE_LABEL, RESTORE_CONFIRM], true).setAllowInvalid(false).build())
        .setBackground(C.coral).setFontColor(C.white).setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle").setWrap(true);
      sheet.setColumnWidth(lastIdx + 2, 200);
    } else if (btn >= 0) {
      sheet.getRange(1, btn + 1).clear();
    }
  });
}

/** Возвращает колонки в исходный порядок (данные переезжают вместе с колонками), заново оформляет лист и убирает кнопку. */
function restoreLayout_(sheet, kind) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return false;
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const plan = columnPlan(kind, data[0].map(String));
  if (!plan) return false;
  const filled = (r) => r.filter((c) => String(c).trim() !== "");
  const out = data.map((r, i) => {
    if (i === 0) return plan.labels.slice();
    const f = filled(r);
    if (f.length === 1 && MONTH_ROW_RE.test(String(f[0]).trim())) return plan.perm.map((_, j) => (j === 0 ? String(f[0]).trim() : "")); // шапка месяца остаётся шапкой
    return plan.perm.map((p) => (p >= 0 ? r[p] : ""));
  });
  sheet.getDataRange().breakApart();
  sheet.getRange(1, 1, lastRow, lastCol).clear();
  plan.perm.forEach((_, j) => { if (!out.some((r, i) => i > 0 && typeof r[j] === "boolean")) sheet.getRange(1, j + 1, lastRow, 1).setNumberFormat("@"); });
  sheet.getRange(1, 1, out.length, plan.perm.length).setValues(out);
  if (kind === "staff") styleStaff_(sheet); else styleSchedule_(sheet);
  dropAllCaches_();
  bumpRev_();
  return true;
}

/** Нажали в красной кнопке «Да, вернуть»: восстанавливаем лист. Возвращает true, если это было нажатие кнопки. */
function handleRestoreClick_(e) {
  try {
    const range = e && e.range;
    if (!range || range.getRow() !== 1) return false;
    if (String(e.value === undefined ? range.getValue() : e.value) !== RESTORE_CONFIRM) return false;
    const sheet = range.getSheet();
    const kind = PLAN_KIND_[sheet.getName()];
    if (!kind) return false;
    withLock_(() => { restoreLayout_(sheet, kind); syncRestoreButtons_(); });
    return true;
  } catch (err) { console.error("Возврат вида: " + String(err && err.message ? err.message : err)); return false; }
}

/** Следит за порядком в «Расписании»: шапки месяцев и сворачивание. Вызывается таймером после изменений. */
function tidySchedule_() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  const sheet = ss.getSheetByName(TABS.schedule);
  if (!sheet) return;
  const added = fixMonths_(sheet);
  if (added) { // добавили шапки или пересобрали порядок: оформляем лист заново, приложению сообщаем об изменении
    styleSchedule_(sheet);
    dropAllCaches_();
    bumpRev_();
    return;
  }
  groupMonths_(sheet, false);
}

/** Видны только три листа: «Сотрудники», «Расписание», «Площадки». Остальные служебные прячем (они работают, как раньше). */
function hideHelperSheets_(ss) {
  const keep = [TABS.staff, TABS.schedule, TABS.venues];
  ss.getSheets().forEach((sh) => {
    const name = sh.getName();
    const helper = keep.indexOf(name) < 0;
    try { if (helper && !sh.isSheetHidden()) sh.hideSheet(); if (!helper && sh.isSheetHidden()) sh.showSheet(); } catch (e) { console.log("Лист «" + name + "» не скрыт: " + String(e.message || e)); }
  });
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
  if (sheet.getLastRow() > 1) {
    const n = sheet.getLastRow() - 1;
    const names = sheet.getRange(2, 1, n, 1).getValues();
    const cur = sheet.getRange(2, 3, n, 1).getValues();
    const next = cur.map(([v], i) => [String(names[i][0]).trim() === "" ? v : ({"": "Читатель"}[String(v).trim()] || (/директор/i.test(v) ? "Админ" : v))]); // пустые строки не трогаем
    sheet.getRange(2, 3, n, 1).setNumberFormat("@").setValues(next);
  }
  rng.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLE_LIST, true).setAllowInvalid(false).build());
  const rule = (text, bg, fg) => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text).setBackground(bg).setFontColor(fg).setBold(true).setRanges([rng]).build();
  sheet.setConditionalFormatRules([rule("Админ", C.navy, C.white), rule("Редактор", C.blue, C.white), rule("Читатель", C.light, C.navy), rule("Заблокирован", C.coral, C.white), rule("Заявка", "#FFF2B3", C.navy)]);
  sheet.setColumnWidth(1, 240);
  sheet.setColumnWidth(2, 170);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 150);
  sheet.getRange(2, 4, Math.max(sheet.getMaxRows() - 1, 1), 1).setFontFamily("Roboto Mono").setHorizontalAlignment("center");

  // «Доступ» (галочка) и «Комментарий» — сразу правее «Логина»; у уже внесённых людей доступ включён, у строк «ЗАЯВКА» — выключен
  let head = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 4)).getDisplayValues()[0].map((x) => String(x).trim());
  if (head.findIndex((x, i) => i >= 4 && /^доступ$/i.test(x)) < 0) {
    sheet.insertColumnsBefore(5, 2);
    sheet.getRange(1, 5, 1, 2).setNumberFormat("@").setValues([["Доступ", "Комментарий"]]);
    const people = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues() : [];
    const ticks = people.map(([n]) => [String(n).trim() === "" ? "" : !/^заявка/i.test(String(n).trim())]); // пустые строки остаются пустыми
    if (ticks.length) sheet.getRange(2, 5, ticks.length, 1).setValues(ticks);
  } else if (head.findIndex((x, i) => i >= 4 && /^комментарий$/i.test(x)) < 0) {
    const at = head.length + 1;
    sheet.getRange(1, at).setNumberFormat("@").setValue("Комментарий");
  }
  head = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 4)).getDisplayValues()[0].map((x) => String(x).trim());
  const accessCol = head.findIndex((x, i) => i >= 4 && /^доступ$/i.test(x)) + 1;
  const commentCol = head.findIndex((x, i) => i >= 4 && /^комментарий$/i.test(x)) + 1;
  const lastRow = Math.max(sheet.getMaxRows(), 2);
  const rows = lastRow - 1;
  const checkbox = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(2, accessCol, rows, 1).setDataValidation(checkbox).setHorizontalAlignment("center");
  sheet.setColumnWidth(accessCol, 80);
  // комментарий — обычный текст: галочек здесь быть не должно (они могли «приехать» от соседней колонки при вставке)
  const commentRange = sheet.getRange(2, commentCol, rows, 1);
  commentRange.clearDataValidations();
  const cv = sheet.getLastRow() > 1 ? sheet.getRange(2, commentCol, sheet.getLastRow() - 1, 1) : null;
  if (cv) {
    const vals = cv.getValues().map(([v]) => [(v === true || v === false || /^(true|false)$/i.test(String(v).trim())) ? "" : v]);
    cv.setNumberFormat("@").setValues(vals);
  }
  commentRange.setWrap(true).setVerticalAlignment("top").setHorizontalAlignment("left");
  sheet.setColumnWidth(commentCol, 320);

  // группы: остальные колонки с названием в шапке; в ячейках галочки «входит в группу»
  const isGroup = (x, i) => i >= 4 && x && i + 1 !== accessCol && i + 1 !== commentCol;
  if (!head.some(isGroup)) { sheet.getRange(1, head.length + 1, 1, 3).setNumberFormat("@").setValues([["Актёры", "Техника", "Зал"]]); head = head.concat(["Актёры", "Техника", "Зал"]); } // примеры, переименуйте как нужно
  for (let c = 5; c <= head.length; c++) {
    if (!isGroup(head[c - 1], c - 1)) continue;
    sheet.getRange(2, c, rows, 1).setDataValidation(checkbox).setHorizontalAlignment("center");
    sheet.setColumnWidth(c, 100);
  }
  styleHeader_(sheet, Math.max(head.length, 6));

  // подсветка: заявка — жёлтым, доступ снят — розовым и серым текстом (правилом, чтобы новые строки красились сами)
  const A = (n) => String.fromCharCode(64 + n);
  const whole = sheet.getRange(2, 1, rows, Math.max(head.length, 6));
  const rules = sheet.getConditionalFormatRules();
  const request = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=OR(REGEXMATCH($A2,"^(?i)заявка"),REGEXMATCH($C2,"^(?i)заявка"))').setBackground("#FFF2B3").setRanges([whole]).build();
  const off = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied("=AND($A2<>\"\",$" + A(accessCol) + "2=FALSE)").setBackground("#FBE0DF").setFontColor("#8A8A8A").setRanges([whole]).build();
  sheet.setConditionalFormatRules(rules.concat([request, off]));
}

function styleVenues_(sheet) {
  styleHeader_(sheet, 2);
  sheet.setColumnWidth(1, 260);
  sheet.setColumnWidth(2, 300);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 2).setFontColor(C.navy).setVerticalAlignment("middle");
}
