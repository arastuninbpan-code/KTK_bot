// Хранилище поверх таблицы: сотрудники, чаты, снимок расписания, коды входа, блокировка.
import {createHash, randomInt} from "node:crypto";
import {normPhone, phonesIn} from "./core.mjs";

export const TABS = {schedule: "Расписание", staff: "Сотрудники", chats: "Подписчики", state: "_служебное", codes: "_вход", lock: "_замок"};
export const SUBS_HEADER = ["Канал", "ID чата", "Телефон", "ФИО"];
const CHUNK = 40000; // лимит ячейки Google — 50 000 знаков

export class Store {
  constructor(book, {secret = "dev", now = () => Date.now()} = {}) {
    this.book = book;
    this.secret = secret;
    this.now = now;
  }

  // --- сотрудники: ФИО | Телефон | Роль ---
  async users() {
    const out = [];
    for (const [name = "", phones = "", role = ""] of (await this.book.get(TABS.staff)).slice(1)) {
      const n = String(name).trim();
      if (!n) continue;
      const isDirector = /директор/i.test(role);
      for (const phone of phonesIn(phones)) out.push({name: n, phone, role: isDirector ? "director" : "staff"});
    }
    return out;
  }

  async staffNames() {
    return [...new Set((await this.users()).map((u) => u.name))].sort((a, b) => a.localeCompare(b, "ru"));
  }

  // --- чаты (Telegram / MAX) ---
  async chats() {
    await this.book.ensure(TABS.chats, SUBS_HEADER);
    return (await this.book.get(TABS.chats)).slice(1)
      .map((r, i) => ({row: i + 2, channel: String(r[0] || ""), chatId: String(r[1] || ""), phone: normPhone(r[2] || "")}))
      .filter((c) => c.channel && c.chatId);
  }

  async bind(channel, chatId, phone, name) {
    const existing = (await this.chats()).find((c) => c.channel === channel && c.chatId === String(chatId));
    const values = [channel, String(chatId), phone, name];
    if (existing) await this.book.set(TABS.chats, existing.row, values);
    else await this.book.append(TABS.chats, values);
  }

  async unbind(channel, chatId) {
    for (const c of (await this.chats()).filter((c) => c.channel === channel && c.chatId === String(chatId)).reverse()) {
      await this.book.clearRow(TABS.chats, c.row);
    }
  }

  // --- снимок расписания и отметки о напоминаниях (лист «_служебное», JSON кусками по ячейкам) ---
  async snapshot() {
    await this.book.ensure(TABS.state);
    const text = (await this.book.get(TABS.state)).map((r) => r[0] || "").join("");
    try { return text.trim() ? JSON.parse(text) : {}; } catch { return {}; }
  }

  async saveSnapshot(snap) {
    const text = JSON.stringify(snap);
    const chunks = [];
    for (let i = 0; i < text.length; i += CHUNK) chunks.push(text.slice(i, i + CHUNK));
    await this.book.replaceColumnA(TABS.state, chunks.length ? chunks : [""]);
  }

  // --- коды входа: лист «_вход» (хеш кода | телефон | срок в мс) ---
  hash(code) { return createHash("sha256").update(`${this.secret}:${code}`).digest("hex").slice(0, 32); }

  async issueCode(phone) {
    await this.book.ensure(TABS.codes, ["Хеш", "Телефон", "Действует до"]);
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const rows = await this.book.get(TABS.codes);
    for (let i = rows.length; i >= 2; i--) if (!rows[i - 1]?.[0] || Number(rows[i - 1][2]) < this.now() || rows[i - 1][1] === phone) await this.book.clearRow(TABS.codes, i);
    await this.book.append(TABS.codes, [this.hash(code), phone, this.now() + 10 * 60 * 1000]);
    return code;
  }

  /** Возвращает телефон и гасит код, если он верный и не просрочен; иначе null. */
  async consumeCode(code) {
    const h = this.hash(String(code).replace(/\D/g, ""));
    const rows = await this.book.get(TABS.codes);
    for (let i = 1; i < rows.length; i++) {
      const [hash, phone, exp] = rows[i];
      if (hash === h && Number(exp) >= this.now()) {
        await this.book.clearRow(TABS.codes, i + 1);
        return phone;
      }
    }
    return null;
  }

  // --- блокировка, чтобы два прохода не разослали одно и то же дважды (в пределах возможного для таблицы) ---
  async withLock(fn, ttlMs = 50000) {
    await this.book.ensure(TABS.lock);
    const t = this.now();
    const held = Number((await this.book.get(TABS.lock))[0]?.[0] || 0);
    if (held && t - held < ttlMs) return {skipped: true};
    await this.book.set(TABS.lock, 1, [t]);
    try {
      return await fn();
    } finally {
      await this.book.clearRow(TABS.lock, 1);
    }
  }
}
