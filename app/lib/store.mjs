// Хранилище поверх таблицы: сотрудники и роли, чаты, снимок расписания, коды входа, блокировка.
import {normPhone, phonesIn} from "./core.mjs";
import {platform} from "./platform.mjs";

export const TABS = {schedule: "Расписание", staff: "Сотрудники", chats: "Подписчики", state: "_служебное", codes: "_вход", lock: "_замок"};
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
export const canEdit = (role) => role === "admin" || role === "editor";

export class Store {
  constructor(book, {secret = "dev", now = () => Date.now()} = {}) {
    this.book = book;
    this.secret = secret;
    this.now = now;
  }

  // --- сотрудники: ФИО | Телефон | Роль (Админ / Редактор / Читатель / Заблокирован) ---
  users() {
    const out = [];
    for (const [name = "", phones = "", role = ""] of this.book.get(TABS.staff).slice(1)) {
      const n = String(name).trim();
      if (!n) continue;
      for (const phone of phonesIn(phones)) out.push({name: n, phone, role: parseRole(role)});
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

  // --- коды входа: лист «_вход» (хеш кода | телефон | срок в мс) ---
  hash(code) { return platform.sha256hex(`${this.secret}:${code}`).slice(0, 32); }

  issueCode(phone) {
    this.book.ensure(TABS.codes, ["Хеш", "Телефон", "Действует до"]);
    const code = String(platform.randomInt(1000000)).padStart(6, "0");
    const rows = this.book.get(TABS.codes);
    for (let i = rows.length; i >= 2; i--) {
      if (!rows[i - 1]?.[0] || Number(rows[i - 1][2]) < this.now() || rows[i - 1][1] === phone) this.book.clearRow(TABS.codes, i);
    }
    this.book.append(TABS.codes, [this.hash(code), phone, this.now() + 24 * 3600 * 1000]);
    return code;
  }

  /** Возвращает телефон, если код верный и не просрочен (код многоразовый, живёт сутки); иначе null. */
  consumeCode(code) {
    const h = this.hash(String(code).replace(/\D/g, ""));
    const rows = this.book.get(TABS.codes);
    for (let i = 1; i < rows.length; i++) {
      const [hash, phone, exp] = rows[i];
      if (hash === h && Number(exp) >= this.now()) {
        return phone;
      }
    }
    return null;
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
