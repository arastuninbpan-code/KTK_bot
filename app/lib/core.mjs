// Чистая логика без сети: разбор таблицы театра, сверка людей, сравнение версий, напоминания.
// Таблица: Дата/Время | Спектакль/Сцена | Администратор | Гардероб | Касса | Монтировка | Актёры, свет, звук
// Роль берётся из заголовка колонки, люди — из ячеек. Одна строка таблицы = одно событие.

export const TZ_OFFSET_H = 3; // Москва: UTC+3 круглый год
export const DAY_MS = 86400000;
export const REMINDERS = [
  // за сколько до начала, насколько можно опоздать с отправкой (чтобы новую смену не «догоняли» сразу двумя напоминаниями)
  {kind: "day", before: 24 * 3600e3, grace: 3 * 3600e3},
  {kind: "hour", before: 3600e3, grace: 30 * 60e3},
];
export const EVE_HOUR = 18; // смены без времени: напоминание накануне вечером

// ===== имена и телефоны =====
export function norm(s) {
  s = String(s).toLowerCase().replace(/ё/g, "е").replace(/\.\s+/g, ".");
  return s.split(/\s+/).filter(Boolean).join(" ");
}

/** Любой вид номера -> цифры без кода страны: «8 (930) 702-91-09», «+7 930 702 91 09», «79307029109» -> «9307029109». */
export function normPhone(s) {
  const d = String(s).replace(/\D/g, "");
  return d.length === 11 && (d[0] === "7" || d[0] === "8") ? d.slice(1) : d;
}

/** В ячейке может быть несколько номеров: через запятую, «;», «/» или с новой строки. */
export function phonesIn(s) {
  return String(s).split(/[;,/\n]/).map(normPhone).filter((p) => p.length >= 7);
}

/** Сообщение — номер, а не слова или команда: 10–12 цифр и ни одной буквы. */
export function looksLikePhone(t) {
  const d = String(t).replace(/\D/g, "");
  return d.length >= 10 && d.length <= 12 && !/\p{L}/u.test(String(t));
}

/** [фамилия, инициалы] без учёта регистра, точек и пробелов: «Дьячков Н. А» и «дьячков н.а.» -> ["дьячков","на"]. */
export function personKey(name) {
  const w = String(name).toLowerCase().replace(/ё/g, "е").match(/\p{L}+(?:-\p{L}+)*/gu) || [];
  if (!w.length) return ["", ""];
  return [w[0], w.slice(1).map((x) => x[0]).join("")];
}

/**
 * Телефоны сотрудников, которых в расписании обозначает запись `person`.
 * Фамилия должна совпасть; инициалы, если есть с обеих сторон, тоже (можно неполные).
 * Если в расписании только фамилия, а такой фамилии несколько разных сотрудников — никого не выбираем.
 */
export function matchPhones(person, users) {
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
export function isoDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}

export function parseDate(s, todayIso) {
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return isoDate(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (m) return isoDate(2000 + +m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})\.(\d{1,2})$/); // «04.10» — год берём текущий
  if (m) return isoDate(+todayIso.slice(0, 4), +m[2], +m[1]);
  return null;
}

export const todayIso = (nowMs) => new Date(nowMs + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
export const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);

// ===== разбор таблицы =====
const NAME_RE = /[А-ЯЁ][а-яё-]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\./g;
const HALL_RE = /\(([^)]*сцен[^)]*)\)/i;

export function splitPeople(text) {
  const names = String(text).match(NAME_RE); // ловит и «Иванова А.А. Петрова Б.Б.» без разделителя
  if (names) return names.map((n) => n.split(/\s+/).join(" "));
  return String(text).split(/[/;,\n]/).map((p) => p.trim()).filter(Boolean);
}

/**
 * Формат листа «Расписание». v1 — как вело театр: Дата/Время | Спектакль/Сцена | роли…
 * v2 — Дата | Начало | Конец | Событие | Площадка | роли… (определяем по заголовку, оба читаются).
 */
export function layoutOf(table) {
  const head = (table && table[0]) || [];
  if (/начал/i.test(String(head[1] || "")) && /конец|оконч/i.test(String(head[2] || ""))) return {v: 2, roleStart: 5};
  return {v: 1, roleStart: 2};
}

/** Все колонки правее «Площадки»: должности и служебная колонка «ID» (скрытая; по ней находятся комментарии и файлы события). */
export const rowColumns = (table) => (table[0] || []).slice(layoutOf(table).roleStart).map((c) => String(c).split(/\s+/).filter(Boolean).join(" "));
export const isIdColumn = (name) => /^id$/i.test(String(name || "").trim());
/** Должности (колонки с людьми). */
export const headerRoles = (table) => rowColumns(table).filter((c) => !isIdColumn(c));

/** Время из текста -> «09:05» или «». */
export function clock(s) {
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
export function parseEvents(table, today) {
  if (!table || !table.length) return [];
  const lay = layoutOf(table);
  const columns = rowColumns(table);
  const out = [];
  table.slice(1).forEach((raw, idx) => {
    const cells = raw.map((c) => String(c).trim());
    while (cells.length < columns.length + lay.roleStart) cells.push("");
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
    let id = "";
    columns.forEach((role, i) => {
      if (isIdColumn(role)) { id = cells[i + lay.roleStart]; return; }
      const people = splitPeople(cells[i + lay.roleStart]);
      if (people.length) { byRole[role] = people; staffed += people.length; }
    });
    if (!title && !staffed) return;
    out.push({row: idx + 2, id, date: d.date, dateEnd: d.dateEnd, time, end, title: title || "Смена", hall, roles: byRole, staffed: staffed > 0});
  });
  return out;
}

// ===== занятость площадок =====
export const DEFAULT_MINUTES = 120; // если конец не указан, считаем, что событие идёт 2 часа
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
export const daysOf = (e) => { const out = []; for (let d = e.date; d <= (e.dateEnd || e.date); d = addDays(d, 1)) out.push(d); return out; };

/** Интервалы занятости события внутри дня (минуты от полуночи). Без времени или многодневное — занято весь день. */
export function slotsOf(e) {
  const starts = String(e.time || "").split(/,\s*/).map(toMin).filter((x) => x !== null);
  if (e.dateEnd || !starts.length) return [[0, 1440]];
  const end = starts.length === 1 ? toMin(e.end) : null;
  return starts.map((s) => [s, end !== null && end > s ? end : Math.min(s + DEFAULT_MINUTES, 24 * 60 + 60)]);
}

/** События на той же площадке, которые пересекаются по времени с `cand` (сам `cand`, row = cand.row, не считается). */
export function findConflicts(events, cand) {
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
export function eventsToRows(events) {
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

export const parseGrid = (table, today) => eventsToRows(parseEvents(table, today));

// ===== строки расписания =====
export const rowKey = (r) => [r.date, norm(r.event), norm(r.role), norm(r.person)].join("|") + (r.seq ? "#" + r.seq : "");

/** Начало смены (самое раннее из указанных времён) в мс UTC или null, если времени нет. */
export function startMs(r) {
  const m = /\b(\d{1,2})[.:](\d{2})\b/.exec(r.time || "");
  if (!m) return null;
  const [y, mo, d] = r.date.split("-").map(Number);
  const ms = Date.UTC(y, mo - 1, d, +m[1], +m[2]) - TZ_OFFSET_H * 3600e3;
  return isNaN(ms) ? null : ms;
}

/** Что изменилось между версиями расписания -> [{kind, person, row, old}]. Прошлое и строки без ФИО игнорируются. */
export function diffRows(oldRows, newRows, today) {
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
export function findReminders(rows, users, sent, nowMs) {
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

export const dateOfKey = (key) => (key.includes("|") ? key.split("|")[1] : key);

/** Один проход: сравнить с прошлой версией, найти напоминания. Ничего не отправляет. */
export function planCycle(table, users, snap, nowMs) {
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
export function buildRow(event, roles, today, layout = {v: 1}, id = "") {
  const title = String(event.title || "").trim();
  const hall = String(event.hall || "").trim();
  const people = roles.map((r) => (isIdColumn(r) ? String(id || "") : (event.roles?.[r] || []).join("/ ")));
  if (layout.v === 2) {
    return [dateRangeText(event, today), clock(String(event.time || "").split(/[,;]|\s+и\s+/)[0]), clock(event.end), title, hall, ...people];
  }
  const times = String(event.time || "").split(/[,;]|\s+и\s+/).map((t) => t.trim()).filter(Boolean).map((t) => t.replace(":", "."));
  const dateCell = [dateRangeText(event, today), times.join(" и ")].filter(Boolean).join("\n");
  const titleCell = [title, hall ? `(${hall})` : ""].filter(Boolean).join("\n");
  return [dateCell, titleCell, ...people];
}

/** Старый лист -> новый (Дата | Начало | Конец | Событие | Площадка | роли…). События с двумя временами делятся на две строки. */
export function migrateTable(table, today) {
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

export function validateEvent(e) {
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
