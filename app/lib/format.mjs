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

/**
 * Один человек может стоять на одном событии сразу на нескольких должностях: такие строки сводим в одну («👤 Актёры, Техника»),
 * чтобы в сообщении было одно событие, а не по сообщению на каждую должность.
 */
export function mergeRoles(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = [r.date, r.time, r.event, r.hall].join("|");
    const cur = by.get(k);
    if (!cur) { by.set(k, {...r, _roles: r.role ? [r.role] : []}); continue; }
    if (r.role && !cur._roles.includes(r.role)) cur._roles.push(r.role);
  }
  return [...by.values()].map(({_roles, ...r}) => ({...r, role: _roles.join(", ")}));
}

export const msgAdded = (r) => `✈️ <b>Вам назначена смена</b>\n\n${shiftBlock(r)}`;
export const msgChanged = (r, old) => `💬 <b>Смена изменена</b>\n\n${shiftBlock(r, {old})}`;
export const msgRemoved = (r) => `💬 <b>Смена отменена</b>\n\n${shiftBlock(r, {strike: true})}`;

export function msgChange(kind, row, old) {
  return kind === "added" ? msgAdded(row) : kind === "removed" ? msgRemoved(row) : msgChanged(row, old);
}

/** Несколько изменений в сменах одного человека — одно сообщение со всем сразу. items: [{kind, row, old}]. */
export function msgChangesDigest(items) {
  const section = (it) => {
    const title = it.kind === "added" ? "🆕 <b>Назначена смена</b>" : it.kind === "removed" ? "❌ <b>Смена отменена</b>" : "✏️ <b>Смена изменена</b>";
    return title + "\n" + shiftBlock(it.row, it.kind === "removed" ? {strike: true} : it.kind === "changed" ? {old: it.old} : {});
  };
  return "✈️ <b>Изменения в ваших сменах</b>\n\n" + items.map(section).join("\n\n");
}

/** Напоминание: kind = "day" (за сутки / накануне) или "hour" (❗ срочное); rows — смены одного человека. */
export function msgReminder(kind, rows) {
  rows = mergeRoles(rows);
  const many = rows.length > 1;
  const head = kind === "hour"
    ? `❗ <b>${many ? "Через час у вас смены" : "Через час у вас смена"}</b>`
    : `💬 <b>${many ? "Завтра у вас смены" : "Завтра у вас смена"}</b>`;
  return `${head}\n\n${mergeRoles(rows).map((r) => shiftBlock(r, {withDate: kind !== "hour"})).join("\n\n")}`;
}

const byDate = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);

/** Список смен человека, сгруппированный по дням. */
export function shiftsText(rows) {
  if (!rows.length) return "💬 <b>Ближайших смен пока нет</b>";
  const out = ["💬 <b>Ваши ближайшие смены</b>"];
  let day = "";
  for (const r of mergeRoles(rows).sort(byDate)) {
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

// ---------- главное меню: кнопки под полем ввода (и в Telegram, и во ВКонтакте); нажатие приходит как обычное сообщение с этой подписью ----------
export const MENU_LABELS = {shifts: "📅 Мои смены", schedule: "🎭 Расписание", app: "📱 Приложение", login: "🔑 Мой логин", post: "📣 В группу", confirmPost: "✅ Опубликовать афишу", stop: "🔕 Отключить", menu: "🏠 Меню"};
/** Подпись кнопки (или слово) -> команда бота. */
export const MENU_COMMANDS = {
  [MENU_LABELS.shifts]: "/shifts", [MENU_LABELS.schedule]: "/schedule", [MENU_LABELS.app]: "/app", [MENU_LABELS.login]: "/login",
  [MENU_LABELS.post]: "/post", [MENU_LABELS.confirmPost]: "/post да", [MENU_LABELS.stop]: "/stop", [MENU_LABELS.menu]: "/menu", "меню": "/menu", "menu": "/menu",
};
/** Ряды кнопок меню. menu: {editor, confirm}. Кнопка «Приложение» во ВК открывается ссылкой, в Telegram — отдельным сообщением с кнопкой. */
export function menuRows(menu = {}) {
  const rows = [];
  if (menu.confirm) rows.push([MENU_LABELS.confirmPost]);
  rows.push([MENU_LABELS.shifts, MENU_LABELS.schedule], [MENU_LABELS.app, MENU_LABELS.login]);
  rows.push(menu.editor ? [MENU_LABELS.post, MENU_LABELS.stop] : [MENU_LABELS.stop]);
  return rows;
}
export const msgMenu = "🏠 <b>Главное меню</b>\nЧто открыть?";
export const msgApp = "📱 <b>Приложение КТК</b>\nСмены, площадки, переписка по событиям — всё там.";
export const msgNoApp = "💬 Адрес приложения пока не задан. Спросите у администратора.";

const loginLine = (login) => (login ? `\n\n🔑 Логин для входа в приложение: <code>${esc(login)}</code>` : "");
export const msgWelcome = (name, login = "") => `✈️ <b>Готово, ${esc(name)}!</b>\nТеперь я буду присылать уведомления о ваших сменах. Меню — внизу.${loginLine(login)}`;
export const msgIntro = "👋 <b>Добро пожаловать в КТК!</b>\nЭто рабочее пространство сотрудников театра. Здесь ваши смены, расписание, собрания и обсуждения, а я сам напомню, когда и где вы работаете.\n\n<b>Как начать</b>\n1️⃣ Нажмите кнопку «Поделиться номером» ниже (или напишите свой номер сообщением). Я пришлю ваш логин.\n2️⃣ Откройте приложение и введите логин (кнопка появится после подключения).\n3️⃣ Добавьте приложение на экран телефона.\n\nЕсли вас нет в списке, я передам заявку администратору. Хорошей работы!";
export const msgAskPhone = "💬 <b>Здравствуйте!</b>\nЧтобы получать уведомления о сменах, поделитесь номером телефона (кнопка ниже, если она есть) или просто напишите сообщением свой номер либо логин, который выдал администратор.";
export const msgUnknownPhone = "💬 <b>Этого номера нет в списке сотрудников.</b>\nОбратитесь к администратору, чтобы вас добавили. Если у вас есть логин, просто пришлите его сюда.";
export const msgStopped = "💬 <b>Уведомления отключены.</b>\nЧтобы включить снова, напишите /start.";
export const msgConnected = (name) => `💬 <b>${esc(name)}</b>, вы подключены.\n\n${msgMenu}`;
export const msgAlreadyConnected = (name) => `✈️ <b>Этот чат уже подключён: ${esc(name)}.</b>\nЧтобы подключить другой номер, сначала отправьте /stop.`;
export const msgBlocked = "💬 <b>Доступ закрыт.</b>\nОбратитесь к администратору.";
export const msgRequestSent = "💬 <b>Вашего номера нет в списке сотрудников.</b>\nЗаявка передана администратору, он увидит её в таблице. Если хотите, напишите одним сообщением, кто вы (ФИО и должность): оно попадёт администратору.\n\nКак только доступ откроют, я напишу вам сам.";
export const msgCommentSaved = "💬 <b>Передал администратору.</b>\nКак только откроют доступ, я напишу вам сам.";
export const msgAccessGranted = (name, login = "") => `✈️ <b>Доступ открыт, ${esc(name)}!</b>\nТеперь я буду присылать уведомления о ваших сменах. Меню — внизу.${loginLine(login)}`;
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

// ---------- собрания: рассылка всем и пост в группу ----------
const meetingWhen = (e) => {
  const day = e.dateEnd ? `${dateShort(e.date)} — ${dateShort(e.dateEnd)}` : dateLong(e.date);
  const time = timeRange(e);
  return time ? `${day}, ${time}` : day;
};
/** Уведомление о новом собрании (всем сотрудникам в личные сообщения): что, когда, где и текст документа/повестки. */
export function msgMeeting(e, note = "") {
  const place = e.hall ? `\n📍 ${esc(cap(e.hall))}` : "";
  return `📋 <b>Собрание: ${esc(e.title)}</b>\n🗓 ${esc(meetingWhen(e))}${place}${note ? `\n\n${esc(note)}` : ""}`;
}
/** Текст для стены группы ВК и канала. */
export function meetingPostText(e, note = "") {
  const place = e.hall ? `\n📍 ${cap(e.hall)}` : "";
  return `📋 Собрание: ${e.title}\n🗓 ${meetingWhen(e)}${place}${note ? `\n\n${note}` : ""}`;
}

// ---- подтверждение смены: две кнопки под уведомлением ----
export const ACK_LABELS = {ok: "✅ Увидел(а)", no: "🚫 Не могу"};
/** Подпись кнопки; выбранная помечена галочкой. */
export const ackLabel = (status, chosen) => ACK_LABELS[status] + (chosen === status ? " ✓" : "");
export const ackCallback = (status, eventId) => `ack:${status}:${eventId}`;
/** "ack:ok:4284e0ea" -> {status, eventId} или null. */
export function parseAck(data) {
  const m = /^ack:(ok|no):([0-9a-f]{8})$/.exec(String(data || ""));
  return m ? {status: m[1], eventId: m[2]} : null;
}
export const ackToast = {ok: "Отмечено: вы увидели ✅", no: "Отмечено: вы не можете 🚫. Администратору сообщили."};
export const msgAckNo = (name, e) => `⚠️ <b>${esc(name)}</b> отметил(а), что <b>не может</b>:\n${esc(e.title || "Смена")}, ${e.date.slice(8, 10)}.${e.date.slice(5, 7)}${e.time ? " " + esc(e.time) : ""}${e.hall ? " · " + esc(e.hall) : ""}`;
