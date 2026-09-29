"""SQLite-хранилище: сотрудники, привязанные чаты, уведомления, последний снимок расписания."""
import json
import sqlite3
import threading

from core import norm

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(phone TEXT PRIMARY KEY, name TEXT, name_norm TEXT);
CREATE TABLE IF NOT EXISTS chats(channel TEXT, chat_id TEXT, phone TEXT, PRIMARY KEY(channel, chat_id));
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, text TEXT,
                                 ts TEXT, sent INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS digests(phone TEXT, day TEXT, PRIMARY KEY(phone, day));
"""


class Store:
    def __init__(self, path: str = ":memory:"):
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.db.executescript(SCHEMA)

    def _run(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            self.db.commit()
            return cur

    # --- сотрудники ---
    def set_users(self, users: list):
        """users: [(phone, name)]. Убранные из списка перестают получать уведомления."""
        with self.lock:
            phones = {p for p, _ in users}
            for p, name in users:
                self.db.execute("INSERT INTO users VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE "
                                "SET name=excluded.name, name_norm=excluded.name_norm",
                                (p, name, norm(name)))
            for (p,) in self.db.execute("SELECT phone FROM users").fetchall():
                if p not in phones:
                    self.db.execute("DELETE FROM users WHERE phone=?", (p,))
                    self.db.execute("DELETE FROM chats WHERE phone=?", (p,))
            self.db.commit()

    def users(self) -> list:
        return [dict(r) for r in self._run("SELECT * FROM users").fetchall()]

    def user(self, phone: str):
        r = self._run("SELECT * FROM users WHERE phone=?", (phone,)).fetchone()
        return dict(r) if r else None

    # --- чаты (Telegram / MAX) ---
    def bind(self, channel: str, chat_id, phone: str):
        self._run("INSERT INTO chats VALUES(?,?,?) ON CONFLICT(channel,chat_id) DO UPDATE SET phone=excluded.phone",
                  (channel, str(chat_id), phone))

    def unbind(self, channel: str, chat_id):
        self._run("DELETE FROM chats WHERE channel=? AND chat_id=?", (channel, str(chat_id)))

    def phone_by_chat(self, channel: str, chat_id):
        r = self._run("SELECT phone FROM chats WHERE channel=? AND chat_id=?", (channel, str(chat_id))).fetchone()
        return r["phone"] if r else None

    def chats_for(self, phone: str) -> list:
        return [(r["channel"], r["chat_id"]) for r in
                self._run("SELECT channel,chat_id FROM chats WHERE phone=?", (phone,)).fetchall()]

    # --- служебное ---
    def meta(self, k: str):
        r = self._run("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return json.loads(r["v"]) if r else None

    def set_meta(self, k: str, v):
        self._run("INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                  (k, json.dumps(v, ensure_ascii=False)))

    def schedule(self) -> list:
        return self.meta("schedule") or []

    def set_schedule(self, rows: list):
        self.set_meta("schedule", rows)

    # --- уведомления ---
    def add_note(self, phone: str, text: str, ts: str) -> int:
        return self._run("INSERT INTO notes(phone,text,ts) VALUES(?,?,?)", (phone, text, ts)).lastrowid

    def pending_notes(self) -> list:
        return [dict(r) for r in self._run("SELECT id,phone,text FROM notes WHERE sent=0").fetchall()]

    def mark_sent(self, note_id: int):
        self._run("UPDATE notes SET sent=1 WHERE id=?", (note_id,))

    def digest_sent(self, phone: str, day: str) -> bool:
        return self._run("SELECT 1 FROM digests WHERE phone=? AND day=?", (phone, day)).fetchone() is not None

    def prune_digests(self, before_iso: str):
        """Забывает отметки о напоминаниях для прошедших дат (ключ вида «вид|ГГГГ-ММ-ДД|…» или просто дата)."""
        self._run("DELETE FROM digests WHERE substr(day, instr(day, '|') + 1, 10) < ?", (before_iso,))

    def set_digest(self, phone: str, day: str):
        self._run("INSERT OR IGNORE INTO digests VALUES(?,?)", (phone, day))

    # --- перенос состояния между запусками (для GitHub Actions) ---
    def dump(self) -> dict:
        """Всё, что нельзя восстановить из таблицы: чаты, снимок расписания, курсоры, отметки сводок."""
        with self.lock:
            return {
                "chats": [[r["channel"], r["chat_id"], r["phone"]] for r in self.db.execute("SELECT * FROM chats")],
                "meta": {r["k"]: json.loads(r["v"]) for r in self.db.execute("SELECT * FROM meta")},
                "digests": [[r["phone"], r["day"]] for r in self.db.execute("SELECT * FROM digests")],
            }

    def load(self, d: dict):
        with self.lock:
            for channel, chat_id, phone in d.get("chats", []):
                self.db.execute("INSERT OR REPLACE INTO chats VALUES(?,?,?)", (channel, chat_id, phone))
            for k, v in d.get("meta", {}).items():
                self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (k, json.dumps(v, ensure_ascii=False)))
            for phone, day in d.get("digests", []):
                self.db.execute("INSERT OR IGNORE INTO digests VALUES(?,?)", (phone, day))
            self.db.commit()
