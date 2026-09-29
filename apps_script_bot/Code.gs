/**
 * Бот расписания театра целиком в Google Apps Script (бесплатно, без сервера).
 * Telegram присылает сообщения сразу (вебхук), ответ приходит за секунды.
 * Расписание читается прямо из таблицы; правки в таблице подхватываются примерно за минуту.
 *
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   SHEET_ID            — ID таблицы
 *   TELEGRAM_BOT_TOKEN  — токен бота
 *   WEBAPP_URL          — адрес веб-приложения (заканчивается на /exec) из окна «Развертывание»
 *   RELAY_URL           — (рекомендуется) адрес посредника Cloudflare, см. relay/worker.js
 *   WEBHOOK_SECRET      — создаётся сам при запуске setup()
 *
 * Установка: setup() → «Начать развертывание → Веб-приложение» → setWebhook(). Подробно — в README.
 */

// ===== настройки =====
const TZ_OFFSET_H = 3; // Москва: UTC+3 круглый год
const DAY_MS = 86400000;
const WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
// Напоминания: за сколько до начала, насколько можно опоздать с отправкой, заголовок.
// Опоздание ограничено, чтобы только что добавленную смену не «догоняли» сразу двумя напоминаниями.
const REMINDERS = [
  {kind: "day", before: 24 * 3600e3, grace: 3 * 3600e3, title: "📅 Завтра"},
  {kind: "hour", before: 3600e3, grace: 30 * 60e3, title: "⏰ Через час"},
];
const EVE_HOUR = 18; // смены без времени: напоминание накануне вечером
const HELP = "/shifts — мои ближайшие смены\n/schedule — афиша ближайших событий\n/stop — отключить уведомления";
const SUBS_HEADER = ["Канал", "ID чата", "Телефон", "ФИО"];

// ===== имена и телефоны =====
function norm_(s) {
  s = String(s).toLowerCase().replace(/ё/g, "е").replace(/\.\s+/g, ".");
  return s.split(/\s+/).filter(Boolean).join(" ");
}

/** Любой вид номера -> цифры без кода страны: «8 (930) 702-91-09», «+7 930 702 91 09», «79307029109» -> «9307029109». */
function normPhone_(s) {
  const d = String(s).replace(/\D/g, "");
  return d.length === 11 && (d[0] === "7" || d[0] === "8") ? d.slice(1) : d;
}

/** В ячейке может быть несколько номеров: через запятую, «;», «/» или с новой строки. */
function phonesIn_(s) {
  return String(s).split(/[;,/\n]/).map(normPhone_).filter((p) => p.length >= 7);
}

/** Сообщение — номер, а не слова или команда: 10–12 цифр и ни одной буквы. */
function looksLikePhone_(t) {
  const d = String(t).replace(/\D/g, "");
  return d.length >= 10 && d.length <= 12 && !/\p{L}/u.test(String(t));
}

/** [фамилия, инициалы] без учёта регистра, точек и пробелов: «Дьячков Н. А» и «дьячков н.а.» -> ["дьячков","на"]. */
function personKey_(name) {
  const w = String(name).toLowerCase().replace(/ё/g, "е").match(/\p{L}+(?:-\p{L}+)*/gu) || [];
  if (!w.length) return ["", ""];
  return [w[0], w.slice(1).map((x) => x[0]).join("")];
}

/**
 * Телефоны сотрудников, которых в расписании обозначает запись `person`.
 * Фамилия должна совпасть; инициалы, если есть с обеих сторон, тоже (можно неполные).
 * Если в расписании только фамилия, а такой фамилии несколько разных сотрудников — никого не выбираем.
 */
function matchPhones_(person, users) {
  const [surname, initials] = personKey_(person);
  if (!surname) return [];
  const found = [];
  for (const u of users) {
    const [s, i] = personKey_(u.name);
    if (s === surname && (!initials || !i || i.startsWith(initials) || initials.startsWith(i))) {
      found.push({phone: u.phone, key: s + "/" + i});
    }
  }
  if (!initials && new Set(found.map((f) => f.key)).size > 1) return [];
  return found.map((f) => f.phone);
}

// ===== даты =====
function isoDate_(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}

function parseDate_(s, todayIso) {
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return isoDate_(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2})$/);
  if (m) return isoDate_(2000 + +m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})\.(\d{1,2})$/); // «04.10» — год берём текущий
  if (m) return isoDate_(+todayIso.slice(0, 4), +m[2], +m[1]);
  return null;
}

function todayIso_(nowMs) {
  return new Date(nowMs + TZ_OFFSET_H * 3600e3).toISOString().slice(0, 10);
}

function addDays_(iso, n) {
  return new Date(Date.parse(iso + "T00:00:00Z") + n * DAY_MS).toISOString().slice(0, 10);
}

// ===== разбор таблицы (сетка театра) =====
// Дата/Время | Спектакль/Сцена | Администратор | Гардероб | Касса | Монтировка | Актёры, свет, звук
// Роль берётся из заголовка колонки, люди — из ячеек.
const NAME_RE = /[А-ЯЁ][а-яё-]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\./g;
const HALL_RE = /\(([^)]*сцен[^)]*)\)/i;

function splitPeople_(text) {
  const names = String(text).match(NAME_RE); // ловит и «Иванова А.А. Петрова Б.Б.» без разделителя
  if (names) return names.map((n) => n.split(/\s+/).join(" "));
  return String(text).split(/[/;,\n]/).map((p) => p.trim()).filter(Boolean);
}

function parseGrid_(table, todayIso) {
  if (!table || !table.length) return [];
  const header = table[0].map((c) => String(c).split(/\s+/).filter(Boolean).join(" "));
  const out = [];
  for (const raw of table.slice(1)) {
    const cells = raw.map((c) => String(c).trim());
    while (cells.length < header.length) cells.push("");
    const dm = cells[0].match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/);
    const first = dm ? parseDate_(dm[1], todayIso) : null;
    if (!first) continue;
    let rest = cells[0].slice(dm[0].length);
    let dates = [first];
    const rm = rest.match(/до\s+(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/); // «25.10 до 31.10» — диапазон
    if (rm) {
      const end = parseDate_(rm[1], todayIso);
      const days = end ? Math.round((Date.parse(end) - Date.parse(first)) / DAY_MS) : 0;
      if (days > 0 && days <= 31) dates = Array.from({length: days + 1}, (_, i) => addDays_(first, i));
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
    const staffed = [];
    for (let i = 2; i < header.length; i++) for (const p of splitPeople_(cells[i])) staffed.push([header[i], p]);
    if (!title && !staffed.length) continue; // пустой день
    for (const day of dates) {
      if (!staffed.length) out.push({date: day, time, event: title, hall, role: "", person: ""});
      for (const [role, person] of staffed) out.push({date: day, time, event: title || "Смена", hall, role, person});
    }
  }
  return out;
}

// ===== строки расписания =====
function rowKey_(r) {
  return [r.date, norm_(r.event), norm_(r.role), norm_(r.person)].join("|");
}

function when_(r) {
  const wd = WEEKDAYS[(new Date(Date.parse(r.date + "T00:00:00Z")).getUTCDay() + 6) % 7];
  const text = `${r.date.slice(8, 10)}.${r.date.slice(5, 7)} (${wd})`;
  return r.time ? `${text} ${r.time}` : text;
}

function describe_(r) {
  return `${when_(r)} — ${r.event}${r.hall ? ` (${r.hall})` : ""}${r.role ? `, ${r.role}` : ""}`;
}

/** Начало смены (самое раннее из указанных времён) в мс UTC или null, если времени нет. */
function startMs_(r) {
  const m = /\b(\d{1,2})[.:](\d{2})\b/.exec(r.time || "");
  if (!m) return null;
  const [y, mo, d] = r.date.split("-").map(Number);
  const ms = Date.UTC(y, mo - 1, d, +m[1], +m[2]) - TZ_OFFSET_H * 3600e3;
  return isNaN(ms) ? null : ms;
}

/** Что изменилось между двумя версиями расписания -> [{kind, person, text}]. Прошлое и строки без ФИО игнорируются. */
function diff_(oldRows, newRows, todayIso) {
  const o = new Map(oldRows.filter((r) => r.person).map((r) => [rowKey_(r), r]));
  const n = new Map(newRows.filter((r) => r.person).map((r) => [rowKey_(r), r]));
  const out = [];
  for (const [k, r] of n) {
    if (r.date < todayIso) continue;
    if (!o.has(k)) out.push({kind: "added", person: r.person, text: `🆕 Вам назначено: ${describe_(r)}`});
    else if (o.get(k).time !== r.time || o.get(k).hall !== r.hall) out.push({kind: "changed", person: r.person, text: `✏️ Изменение: ${describe_(r)}`});
  }
  for (const [k, r] of o) if (!n.has(k) && r.date >= todayIso) out.push({kind: "removed", person: r.person, text: `❌ Снято: ${describe_(r)}`});
  return out;
}

/** За сутки и за час до смены (если время указано), иначе накануне вечером. Каждое напоминание — один раз. */
function reminders_(rows, users, sent, nowMs) {
  const batches = new Map();
  const newKeys = [];
  for (const r of rows) {
    if (!r.person) continue;
    const phones = matchPhones_(r.person, users);
    if (!phones.length) continue;
    const start = startMs_(r);
    let rules;
    if (start !== null) {
      rules = REMINDERS.map((x) => ({kind: x.kind, trigger: start - x.before, grace: x.grace, title: x.title}));
    } else {
      const [y, m, d] = r.date.split("-").map(Number);
      rules = [{kind: "eve", trigger: Date.UTC(y, m - 1, d - 1, EVE_HOUR, 0) - TZ_OFFSET_H * 3600e3, grace: 6 * 3600e3, title: "📅 Завтра"}];
    }
    for (const x of rules) {
      if (!(x.trigger <= nowMs && nowMs < x.trigger + x.grace)) continue;
      if (start !== null && nowMs >= start) continue;
      const key = `${x.kind}|${rowKey_(r)}|${r.time}`;
      for (const phone of phones) {
        if (sent.has(phone + "\t" + key)) continue;
        sent.add(phone + "\t" + key);
        newKeys.push([phone, key]);
        const b = phone + "\t" + x.title;
        if (!batches.has(b)) batches.set(b, []);
        batches.get(b).push(describe_(r));
      }
    }
  }
  const notes = [];
  for (const [b, lines] of batches) {
    const [phone, title] = b.split("\t");
    notes.push({phone, text: `${title}:\n${lines.join("\n")}`});
  }
  return {notes, newKeys};
}

function dateOfKey_(key) {
  return key.includes("|") ? key.split("|")[1] : key;
}

// ===== диалог с сотрудником (одинаков для любого мессенджера) =====
function myShifts_(schedule, user, users, today) {
  const rows = schedule
    .filter((r) => r.date >= today && r.person && matchPhones_(r.person, users).includes(user.phone))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  return rows.map(describe_).join("\n") || "Ближайших смен нет.";
}

function afisha_(schedule, today, limit) {
  const events = new Map();
  const rows = schedule.filter((r) => r.date >= today)
    .sort((a, b) => (a.date + "|" + a.time + "|" + a.event).localeCompare(b.date + "|" + b.time + "|" + b.event));
  for (const r of rows) {
    const k = [r.date, r.time, r.event].join("|");
    if (!events.has(k)) events.set(k, [`${when_(r)} — ${r.event}${r.hall ? ` (${r.hall})` : ""}`]);
    if (r.person) events.get(k).push(`   ${r.role ? r.role + ": " : ""}${r.person}`);
  }
  return [...events.values()].slice(0, limit || 15).map((v) => v.join("\n")).join("\n\n") || "Событий пока нет.";
}

/**
 * env: {users, schedule, phoneOf(chatId), bind(chatId, phone, name), unbind(chatId), send(chatId, text, keyboard)}
 * ev: {chatId, text, phone}; keyboard: "contact" | "remove" | undefined
 */
function handleEvent_(env, ev, nowMs) {
  const chat = ev.chatId;
  const text = String(ev.text || "").trim();
  let phone = ev.phone ? normPhone_(ev.phone) : null;
  if (!phone && looksLikePhone_(text)) phone = normPhone_(text); // номер, введённый вручную

  if (phone) {
    const u = env.users.find((x) => x.phone === phone);
    if (!u) return env.send(chat, "Этого номера нет в списке сотрудников. Обратитесь к администратору.");
    env.bind(chat, phone, u.name);
    return env.send(chat, `Готово, ${u.name}! Теперь я буду присылать уведомления о ваших сменах.\n\n${HELP}`, "remove");
  }

  const me = env.phoneOf(chat);
  const user = me ? env.users.find((x) => x.phone === me) : null;
  if (!user) {
    return env.send(chat, "Здравствуйте! Чтобы получать уведомления о сменах, поделитесь номером телефона (кнопка ниже) или напишите его сообщением.", "contact");
  }
  const cmd = (text.split(/\s+/)[0] || "").toLowerCase().split("@")[0];
  const today = todayIso_(nowMs);
  if (cmd === "/shifts") return env.send(chat, myShifts_(env.schedule, user, env.users, today));
  if (cmd === "/schedule") return env.send(chat, afisha_(env.schedule, today));
  if (cmd === "/stop") {
    env.unbind(chat);
    return env.send(chat, "Уведомления отключены. Чтобы включить снова, напишите /start.", "remove");
  }
  return env.send(chat, `${user.name}, вы подключены.\n\n${HELP}`);
}

/** Один проход: сравнить с прошлой версией расписания, найти напоминания. Ничего не отправляет. */
function planCycle_(table, users, snap, nowMs) {
  const today = todayIso_(nowMs);
  const rows = parseGrid_(table, today);
  const meta = snap.meta || {};
  const notes = [];
  if (meta.initialized) { // первый запуск — молча запоминаем, чтобы не завалить всех уведомлениями
    for (const c of diff_(meta.schedule || [], rows, today)) {
      for (const phone of matchPhones_(c.person, users)) notes.push({phone, text: c.text});
    }
  }
  const digests = snap.digests || [];
  const sent = new Set(digests.map(([p, k]) => p + "\t" + k));
  const rem = reminders_(rows, users, sent, nowMs);
  notes.push(...rem.notes);
  const cutoff = addDays_(today, -2);
  const keptDigests = digests.concat(rem.newKeys).filter(([, k]) => dateOfKey_(k) >= cutoff);
  return {notes, snap: {chats: [], digests: keptDigests, meta: Object.assign({}, meta, {schedule: rows, initialized: true})}};
}

// ===== Google Таблица: сотрудники, чаты, состояние =====
function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k);
}

function book_() {
  return SpreadsheetApp.openById(prop_("SHEET_ID"));
}

function sheet_(name, header) {
  const b = book_();
  let s = b.getSheetByName(name);
  if (!s) {
    s = b.insertSheet(name);
    if (header) {
      s.getRange(1, 1, 1, header.length).setNumberFormat("@").setValues([header]);
    }
  }
  return s;
}

function loadUsers_() {
  const out = [];
  for (const [name, phones] of sheet_("Сотрудники").getDataRange().getDisplayValues().slice(1)) {
    for (const phone of phonesIn_(phones)) if (String(name).trim()) out.push({name: String(name).trim(), phone});
  }
  return out;
}

function loadChats_() {
  return sheet_("Подписчики", SUBS_HEADER).getDataRange().getDisplayValues().slice(1)
    .filter((r) => r[0] && r[1]).map((r) => ({channel: String(r[0]), chatId: String(r[1]), phone: normPhone_(r[2])}));
}

function bindChat_(channel, chatId, phone, name) {
  const s = sheet_("Подписчики", SUBS_HEADER);
  const vals = s.getDataRange().getDisplayValues();
  for (let i = 1; i < vals.length; i++) {
    if (vals[i][0] === channel && vals[i][1] === String(chatId)) {
      s.getRange(i + 1, 1, 1, 4).setNumberFormat("@").setValues([[channel, String(chatId), phone, name]]);
      return;
    }
  }
  const row = s.getLastRow() + 1;
  s.getRange(row, 1, 1, 4).setNumberFormat("@").setValues([[channel, String(chatId), phone, name]]);
}

function unbindChat_(channel, chatId) {
  const s = sheet_("Подписчики", SUBS_HEADER);
  const vals = s.getDataRange().getDisplayValues();
  for (let i = vals.length - 1; i >= 1; i--) {
    if (vals[i][0] === channel && vals[i][1] === String(chatId)) s.deleteRow(i + 1);
  }
}

function loadSnap_() {
  const s = sheet_("_служебное");
  const n = Math.max(1, s.getLastRow());
  const text = s.getRange(1, 1, n, 1).getValues().map((r) => r[0]).join("");
  try { return text.trim() ? JSON.parse(text) : {}; } catch (e) { return {}; }
}

function saveSnap_(snap) {
  const s = sheet_("_служебное");
  const text = JSON.stringify(snap);
  const chunks = [];
  for (let i = 0; i < text.length; i += 40000) chunks.push([text.slice(i, i + 40000)]); // лимит ячейки — 50 000
  s.clear();
  s.getRange(1, 1, chunks.length, 1).setNumberFormat("@").setValues(chunks);
}

// ===== Telegram =====
class Gone_ extends Error {}

function tgSend_(chatId, text, keyboard) {
  const body = {chat_id: chatId, text: String(text).slice(0, 4000)};
  if (keyboard === "contact") {
    body.reply_markup = {keyboard: [[{text: "📱 Поделиться номером", request_contact: true}]], resize_keyboard: true, one_time_keyboard: true};
  } else if (keyboard === "remove") {
    body.reply_markup = {remove_keyboard: true};
  }
  const r = UrlFetchApp.fetch(`https://api.telegram.org/bot${prop_("TELEGRAM_BOT_TOKEN")}/sendMessage`,
    {method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true});
  const code = r.getResponseCode();
  if (code === 403) throw new Gone_(); // бот заблокирован пользователем
  if (code >= 400) throw new Error("Telegram HTTP " + code + ": " + r.getContentText().slice(0, 200)); // без адреса: в нём токен
}

const SENDERS = {telegram: tgSend_};

function telegramEvent_(update) {
  const m = update.message;
  if (!m || !m.chat || m.chat.type !== "private") return null;
  const own = m.contact && m.from && m.contact.user_id === m.from.id; // только собственный контакт, не чужой
  return {chatId: m.chat.id, text: m.text || "", phone: own ? m.contact.phone_number : null};
}

// ===== точки входа =====
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function ok_() {
  return ContentService.createTextOutput("ok");
}

function doGet() {
  return ok_();
}

/** Сюда Telegram присылает каждое сообщение. */
function doPost(e) {
  try {
    if (!e || !e.parameter || e.parameter.secret !== prop_("WEBHOOK_SECRET")) return ok_();
    const update = JSON.parse(e.postData.contents);
    const cache = CacheService.getScriptCache();
    if (cache.get("u" + update.update_id)) return ok_(); // Telegram может прислать то же сообщение повторно
    cache.put("u" + update.update_id, "1", 21600);
    const ev = telegramEvent_(update);
    if (ev) withLock_(() => handleEvent_(realEnv_("telegram"), ev, Date.now()));
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
  }
  return ok_();
}

function realEnv_(channel) {
  const chats = loadChats_().filter((c) => c.channel === channel);
  return {
    users: loadUsers_(),
    schedule: (loadSnap_().meta || {}).schedule || [],
    phoneOf: (chatId) => (chats.find((c) => c.chatId === String(chatId)) || {}).phone,
    bind: (chatId, phone, name) => bindChat_(channel, chatId, phone, name),
    unbind: (chatId) => unbindChat_(channel, chatId),
    send: (chatId, text, keyboard) => {
      try { SENDERS[channel](chatId, text, keyboard); } catch (err) {
        if (err instanceof Gone_) unbindChat_(channel, chatId); else throw err;
      }
    },
  };
}

/** Сверяется с таблицей, рассылает уведомления и напоминания. */
function cycle_(nowMs) {
  const users = loadUsers_();
  const table = sheet_("Расписание").getDataRange().getDisplayValues();
  const snap = loadSnap_();
  const plan = planCycle_(table, users, snap, nowMs);
  if (JSON.stringify(plan.snap) !== JSON.stringify(Object.assign({chats: []}, snap))) saveSnap_(plan.snap);
  const chats = loadChats_();
  for (const n of plan.notes) {
    for (const c of chats.filter((x) => x.phone === n.phone)) {
      try {
        SENDERS[c.channel](c.chatId, n.text);
      } catch (err) {
        if (err instanceof Gone_) unbindChat_(c.channel, c.chatId); else console.error(String(err.message || err));
      }
      Utilities.sleep(40); // мягкий лимит запросов
    }
  }
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
    cycle_(now);
  });
}

/** Срабатывает при любой правке таблицы; только отмечает время, работа — в everyMinute. */
function onSheetChange() {
  PropertiesService.getScriptProperties().setProperty("dirty", String(Date.now()));
}

// ===== установка =====
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty("WEBHOOK_SECRET")) p.setProperty("WEBHOOK_SECRET", Utilities.getUuid().replace(/-/g, ""));
  ScriptApp.getProjectTriggers().forEach(ScriptApp.deleteTrigger);
  const ss = book_();
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("everyMinute").timeBased().everyMinutes(1).create();
  sheet_("Подписчики", SUBS_HEADER);
  console.log("Готово: таймеры созданы. Теперь разверните веб-приложение и запустите setWebhook().");
}

/**
 * Говорит Telegram, куда присылать сообщения. Если задано свойство RELAY_URL (адрес посредника Cloudflare, см. relay/worker.js),
 * сообщения идут через него: Apps Script отвечает на POST перенаправлением (302), Telegram считает это ошибкой и тормозит.
 * Без посредника используется адрес веб-приложения /exec (из свойства WEBAPP_URL).
 */
function setWebhook() {
  let target = prop_("RELAY_URL");
  if (!target) {
    // Из редактора getUrl() отдаёт тестовый адрес /dev (даёт Telegram ошибку 401), поэтому нужен публичный адрес /exec.
    const url = prop_("WEBAPP_URL") || ScriptApp.getService().getUrl();
    if (!url || !/\/exec$/.test(url)) throw new Error("Нужен адрес веб-приложения, оканчивающийся на /exec (свойство WEBAPP_URL) или RELAY_URL.");
    target = url + "?secret=" + encodeURIComponent(prop_("WEBHOOK_SECRET"));
  }
  console.log("Вебхук будет на: " + new URL(target).host); // только адрес сайта, без секретов
  const r = UrlFetchApp.fetch(`https://api.telegram.org/bot${prop_("TELEGRAM_BOT_TOKEN")}/setWebhook`, {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    payload: JSON.stringify({url: target, allowed_updates: ["message"]}),
  });
  console.log(r.getContentText());
}

/** Показывает состояние вебхука (ошибки доставки, очередь). */
function webhookInfo() {
  const r = UrlFetchApp.fetch(`https://api.telegram.org/bot${prop_("TELEGRAM_BOT_TOKEN")}/getWebhookInfo`, {muteHttpExceptions: true});
  const info = JSON.parse(r.getContentText()).result || {};
  console.log(JSON.stringify({host: info.url ? new URL(info.url).host : "", pending: info.pending_update_count, last_error: info.last_error_message}));
}

function deleteWebhook() {
  UrlFetchApp.fetch(`https://api.telegram.org/bot${prop_("TELEGRAM_BOT_TOKEN")}/deleteWebhook`, {muteHttpExceptions: true});
}
