// Хранилище поверх таблицы: сотрудники и роли, чаты, снимок расписания, коды входа, блокировка.
import {normPhone, phonesIn} from "./core.mjs";
import {platform} from "./platform.mjs";

export const TABS = {schedule: "Расписание", staff: "Сотрудники", venues: "Площадки", reports: "Отчёты", chats: "Подписчики", requests: "_заявки", people: "_люди", off: "_недоступность", comments: "_комментарии", meta: "_события", avatars: "_аватары", photos: "_фото", state: "_служебное", lock: "_замок"};
export const REQUESTS_HEADER = ["Канал", "ID чата", "Телефон"];
export const COMMENT_HEADER = ["ID события", "ID", "Время", "Телефон", "Имя", "Текст", "Фото"];
export const META_HEADER = ["ID события", "Тип", "Описание", "—", "Автор", "Создано"];
export const AVATAR_HEADER = ["Телефон", "Канал", "Фото", "Обновлено"];
/** Фото в сообщении переписки: храним только короткие номера (сами картинки лежат в скрытом служебном листе кусками). */
export const cleanPhotoIds = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((id) => /^[0-9a-f]{12}$/.test(id)))].slice(0, 4);
export const PHOTO_HEADER = ["ID фото", "Часть", "Данные"];
const PHOTO_CHUNK = 40000; // в ячейку таблицы помещается до 50 000 знаков
const parseJson = (t, fallback) => { try { const v = JSON.parse(t); return v == null ? fallback : v; } catch { return fallback; } };
export const OFF_HEADER = ["Телефон", "ФИО", "Дата"];
export const VENUES_HEADER = ["Площадка", "Заметка", "Цвет"];
/** Цвета площадок: название (оно выбирается в таблице из списка) и цвет в приложении. */
export const VENUE_COLORS = [
  {name: "Красный", hex: "#E5484D"}, {name: "Оранжевый", hex: "#F2961E"}, {name: "Жёлтый", hex: "#E8C21A"}, {name: "Зелёный", hex: "#3DB16B"},
  {name: "Бирюзовый", hex: "#1BA8A0"}, {name: "Голубой", hex: "#0A96DC"}, {name: "Синий", hex: "#3B5BDB"}, {name: "Фиолетовый", hex: "#8E5BD0"},
  {name: "Розовый", hex: "#E0509A"}, {name: "Серый", hex: "#7A8699"},
];
/** Название цвета из таблицы (или #RRGGBB) -> название из палитры или "". */
export function colorName(value) {
  const t = String(value || "").trim().toLowerCase().replace(/ё/g, "е");
  const hit = VENUE_COLORS.find((c) => c.name.toLowerCase().replace(/ё/g, "е") === t || c.hex.toLowerCase() === t);
  return hit ? hit.name : "";
}
export const colorHex = (name) => (VENUE_COLORS.find((c) => c.name === name) || {}).hex || "";
const CHECKED_RE = /^(true|да|yes|1|✓|✔|x|х)$/i; // галочка в таблице: TRUE / ✓ / «да»
export const SUBS_HEADER = ["Канал", "ID чата", "Телефон", "ФИО"];
export const ROLE_LABELS = {admin: "Админ", editor: "Редактор", reader: "Читатель", blocked: "Заблокирован"};
const CHUNK = 40000; // лимит ячейки Google — 50 000 знаков

/** Текст из колонки «Роль» -> код роли. Пусто — читатель; «директор» (старое название) — админ. */
/** Строка — заявка на доступ: в колонке «Роль» стоит «Заявка» (или, как раньше, вместо ФИО написано «ЗАЯВКА»). */
export const isPendingRow = (name, role) => /^заявка/i.test(String(role || "").trim()) || /^заявка/i.test(String(name || "").trim());

export function parseRole(text) {
  const t = String(text || "").toLowerCase();
  if (/заблок/.test(t)) return "blocked";
  if (/админ|директор/.test(t)) return "admin";
  if (/редактор/.test(t)) return "editor";
  return "reader";
}
/** Логин для сравнения: без регистра, пробелов и дефисов. */
export const normLogin = (t) => String(t || "").toLowerCase().replace(/[\s\-_.]/g, "");
const LOGIN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const canEdit = (role) => role === "admin" || role === "editor";

export class Store {
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

  // --- «Не могу работать»: даты, которые сотрудник отметил в приложении (скрытый лист «_недоступность»: телефон | ФИО | дата) ---
  offRows() {
    if (!this.book.has(TABS.off)) return [];
    return this.book.get(TABS.off).slice(1)
      .map((r, i) => ({row: i + 2, phone: normPhone(r[0] || ""), name: String(r[1] || "").trim(), date: String(r[2] || "").trim()}))
      .filter((r) => r.phone && /^\d{4}-\d{2}-\d{2}$/.test(r.date));
  }

  offDates(phone) { return [...new Set(this.offRows().filter((r) => r.phone === phone).map((r) => r.date))].sort(); }

  /** {ФИО: Set(даты)} по текущим именам из «Сотрудников» (у одного человека может быть несколько номеров). */
  offByName() {
    const nameOf = new Map(this.users().map((u) => [u.phone, u.name]));
    const out = new Map();
    for (const r of this.offRows()) {
      const name = nameOf.get(r.phone) || r.name;
      if (!out.has(name)) out.set(name, new Set());
      out.get(name).add(r.date);
    }
    return out;
  }

  /** Отмечает/снимает недоступные даты у одного человека (без дублей). */
  setOff(phone, name, add = [], remove = []) {
    this.book.ensure(TABS.off, OFF_HEADER);
    const rows = this.offRows().filter((r) => r.phone === phone);
    const have = new Set(rows.map((r) => r.date));
    for (const date of [...new Set(add)]) if (!have.has(date)) this.book.append(TABS.off, [phone, name, date]);
    const drop = new Set(remove);
    for (const r of rows.filter((x) => drop.has(x.date)).sort((a, b) => b.row - a.row)) this.book.remove(TABS.off, r.row); // снизу вверх, чтобы номера строк не съезжали
  }

  // --- «имя» человека для чужих глаз: короткий код вместо телефона ---
  uid(phone) { return this.hash("uid:" + phone).slice(0, 10); }

  // --- метаданные события: тип (событие/собрание), описание, прикреплённые файлы. Ключ — ID события (скрытая колонка «ID» в расписании) ---
  metaMap() {
    if (!this.book.has(TABS.meta)) return {};
    const out = {};
    for (const r of this.book.get(TABS.meta).slice(1)) {
      const id = String(r[0] || "").trim();
      if (!id) continue;
      out[id] = {kind: String(r[1] || "") === "meeting" ? "meeting" : "event", note: String(r[2] || ""), author: String(r[4] || ""), created: Number(r[5]) || 0, row: 0};
    }
    return out;
  }

  /** Создаёт или обновляет метаданные события; поля, которых нет в `patch`, не меняются. */
  setMeta(eventId, patch) {
    this.book.ensure(TABS.meta, META_HEADER);
    const rows = this.book.get(TABS.meta);
    const at = rows.findIndex((r, i) => i > 0 && String(r[0] || "").trim() === eventId);
    const cur = at >= 0 ? rows[at] : [eventId, "event", "", "[]", "", String(this.now())];
    const next = [eventId,
      patch.kind ? (patch.kind === "meeting" ? "meeting" : "event") : String(cur[1] || "event"),
      patch.note !== undefined ? String(patch.note).slice(0, 12000) : String(cur[2] || ""),
      "[]",
      patch.author !== undefined ? String(patch.author) : String(cur[4] || ""),
      String(cur[5] || this.now())];
    if (at >= 0) this.book.set(TABS.meta, at + 1, next); else this.book.append(TABS.meta, next);
  }

  // --- комментарии к событию (переписка) ---
  comments(eventId) {
    if (!this.book.has(TABS.comments)) return [];
    return this.book.get(TABS.comments).slice(1)
      .filter((r) => String(r[0] || "").trim() === eventId)
      .map((r) => ({id: String(r[1] || ""), ts: Number(r[2]) || 0, phone: normPhone(r[3] || ""), name: String(r[4] || ""), text: String(r[5] || ""), photos: cleanPhotoIds(parseJson(r[6], []))}))
      .sort((a, b) => a.ts - b.ts);
  }

  commentCounts() {
    if (!this.book.has(TABS.comments)) return {};
    const out = {};
    for (const r of this.book.get(TABS.comments).slice(1)) {
      const id = String(r[0] || "").trim();
      if (!id) continue;
      const o = out[id] || (out[id] = {n: 0, last: 0});
      o.n++;
      o.last = Math.max(o.last, Number(r[2]) || 0);
    }
    return out;
  }

  addComment(eventId, user, text, photos = []) {
    this.book.ensure(TABS.comments, COMMENT_HEADER);
    const c = {id: platform.sha256hex(`${eventId}:${user.phone}:${this.now()}:${platform.randomInt(1e9)}`).slice(0, 12), ts: this.now(), phone: user.phone, name: user.name, text: String(text || "").trim().slice(0, 2000), photos: cleanPhotoIds(photos)};
    this.book.append(TABS.comments, [eventId, c.id, String(c.ts), c.phone, c.name, c.text, JSON.stringify(c.photos)]);
    return c;
  }

  /** Удаляет сообщение: своё — любой, чужое — только тот, кто может править расписание. */
  deleteComment(id, user) {
    if (!this.book.has(TABS.comments)) return false;
    const rows = this.book.get(TABS.comments);
    const at = rows.findIndex((r, i) => i > 0 && String(r[1] || "") === id);
    if (at < 0) return false;
    if (normPhone(rows[at][3] || "") !== user.phone && !canEdit(user.role)) return null;
    this.book.remove(TABS.comments, at + 1);
    return true;
  }

  // --- фото из переписки: сжатая картинка (base64) режется на куски по ячейкам скрытого листа «_фото» ---
  addPhoto(base64) {
    this.book.ensure(TABS.photos, PHOTO_HEADER);
    const id = platform.sha256hex(`${base64.length}:${this.now()}:${platform.randomInt(1e9)}`).slice(0, 12);
    for (let i = 0, n = 0; i < base64.length; i += PHOTO_CHUNK, n++) this.book.append(TABS.photos, [id, String(n), base64.slice(i, i + PHOTO_CHUNK)]);
    return id;
  }

  /** Картинка целиком (data-ссылка) или "" если такой нет. */
  photo(id) {
    if (!this.book.has(TABS.photos)) return "";
    const parts = this.book.get(TABS.photos).slice(1).filter((r) => String(r[0] || "") === id).sort((a, b) => Number(a[1]) - Number(b[1]));
    return parts.length ? "data:image/jpeg;base64," + parts.map((r) => String(r[2] || "")).join("") : "";
  }

  // --- аватарки: из профиля ВК (ссылка) и Telegram (маленькая картинка внутри). Ключ — телефон ---
  setAvatar(phone, channel, photo) {
    this.book.ensure(TABS.avatars, AVATAR_HEADER);
    const rows = this.book.get(TABS.avatars);
    const at = rows.findIndex((r, i) => i > 0 && normPhone(r[0] || "") === phone && String(r[1] || "") === channel);
    const row = [phone, channel, photo, String(this.now())];
    if (at >= 0) this.book.set(TABS.avatars, at + 1, row); else this.book.append(TABS.avatars, row);
  }

  /** Когда в последний раз обновляли аватарку этого человека в этом канале (мс), 0 — никогда. */
  avatarAge(phone, channel) {
    if (!this.book.has(TABS.avatars)) return 0;
    const r = this.book.get(TABS.avatars).slice(1).find((x) => normPhone(x[0] || "") === phone && String(x[1] || "") === channel);
    return r ? Number(r[3]) || 0 : 0;
  }

  /** {uid: фото}: у кого два канала — берём свежее. */
  avatarsByUid() {
    if (!this.book.has(TABS.avatars)) return {};
    const best = {};
    for (const r of this.book.get(TABS.avatars).slice(1)) {
      const phone = normPhone(r[0] || "");
      const photo = String(r[2] || "");
      const ts = Number(r[3]) || 0;
      if (phone && photo && (!best[phone] || ts > best[phone].ts)) best[phone] = {photo, ts};
    }
    return Object.fromEntries(Object.entries(best).map(([phone, v]) => [this.uid(phone), v.photo]));
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

  /** Площадки с цветами: [{name, color, hex, row}]. Если цвет в таблице не выбран — даём свободный из палитры по порядку (в таблицу его вписывает таймер). */
  venueList() {
    if (!this.book.has(TABS.venues)) return [];
    const seen = new Set();
    const out = [];
    this.book.get(TABS.venues).forEach((r, i) => {
      if (i === 0) return;
      const n = String(r[0] || "").split(/\s+/).filter(Boolean).join(" ");
      if (!n || seen.has(n.toLowerCase())) return;
      seen.add(n.toLowerCase());
      out.push({name: n, color: colorName(r[2]), row: i + 1});
    });
    const used = new Set(out.map((v) => v.color).filter(Boolean));
    let k = 0;
    for (const v of out) {
      if (v.color) continue;
      while (k < VENUE_COLORS.length && used.has(VENUE_COLORS[k].name)) k++;
      v.color = VENUE_COLORS[k % VENUE_COLORS.length].name;
      v.auto = true;
      used.add(v.color);
    }
    for (const v of out) v.hex = colorHex(v.color);
    return out;
  }

  addVenue(name, color) {
    const n = String(name || "").split(/\s+/).filter(Boolean).join(" ");
    if (!n) return false;
    this.book.ensure(TABS.venues, VENUES_HEADER);
    if (this.venues().some((v) => v.toLowerCase() === n.toLowerCase())) return false;
    const list = this.venueList();
    let chosen = colorName(color);
    if (!chosen) chosen = (VENUE_COLORS.find((c) => !list.some((v) => v.color === c.name)) || VENUE_COLORS[list.length % VENUE_COLORS.length]).name;
    this.book.append(TABS.venues, [n, "", chosen]);
    return true;
  }

  /** Меняет цвет площадки; вписывает и «автоматические» цвета остальных, чтобы они больше не менялись при добавлении площадок. */
  setVenueColor(name, color) {
    const c = colorName(color);
    if (!c) return false;
    const want = String(name || "").trim().toLowerCase();
    const list = this.venueList();
    const v = list.find((x) => x.name.toLowerCase() === want);
    if (!v) return false;
    for (const o of list) if (o.auto && o !== v) this.book.setCell(TABS.venues, o.row, 3, o.color);
    this.book.setCell(TABS.venues, v.row, 3, c);
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
      .map((r, i) => ({row: i + 2, channel: String(r[0] || ""), chatId: String(r[1] || ""), phone: normPhone(r[2] || ""), name: String(r[3] || "")}))
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
