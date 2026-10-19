// Хранилище поверх таблицы: сотрудники и роли, чаты, снимок расписания, коды входа, блокировка.
import {normPhone, phonesIn} from "./core.mjs";
import {platform} from "./platform.mjs";

export const TABS = {schedule: "Расписание", staff: "Сотрудники", venues: "Площадки", chats: "Подписчики", requests: "_заявки", state: "_служебное", lock: "_замок"};
export const REQUESTS_HEADER = ["Канал", "ID чата", "Телефон"];
export const VENUES_HEADER = ["Площадка", "Заметка"];
const CHECKED_RE = /^(true|да|yes|1|✓|✔|x|х)$/i; // галочка в таблице: TRUE / ✓ / «да»
export const SUBS_HEADER = ["Канал", "ID чата", "Телефон", "ФИО"];
export const ROLE_LABELS = {admin: "Админ", editor: "Редактор", reader: "Читатель", blocked: "Заблокирован"};
const CHUNK = 40000; // лимит ячейки Google — 50 000 знаков

/** Текст из колонки «Роль» -> код роли. Пусто — читатель; «директор» (старое название) — админ. */
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
      const hasAccess = access < 0 || CHECKED_RE.test(String(row[access] || "").trim()); // галочка «Доступ» снята — как «Заблокирован»
      const groups = defs.filter((g) => CHECKED_RE.test(String(row[g.col] || "").trim())).map((g) => g.name);
      for (const phone of phonesIn(phones)) {
        out.push({name: n, phone, role: hasAccess ? parseRole(role) : "blocked", login: String(login).trim(), groups, pending: /^заявка/i.test(n)});
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

  /** Добавляет или дополняет заявку на доступ; администратор видит строку и комментарий прямо в таблице. */
  addAccessRequest(phone, note) {
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
      return at + 1;
    }
    at = rows.findIndex((r, i) => i > 0 && !String(r[0] || "").trim() && !String(r[1] || "").trim()); // сначала свободная строка внутри списка
    if (at < 0) at = rows.length;
    this.book.setCell(TABS.staff, at + 1, 1, "ЗАЯВКА");
    this.book.setCell(TABS.staff, at + 1, 2, phone);
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
