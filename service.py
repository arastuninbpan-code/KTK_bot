"""Один цикл работы: синхронизация с таблицей -> уведомления об изменениях -> напоминания -> рассылка."""
import logging
import re
import time
from datetime import date, datetime, timedelta
from datetime import time as dtime

from core import Row, diff, match_phones, parse_rows, phones_in

log = logging.getLogger("planner")
SEND_PAUSE_SEC = 0.05


def sync_users(store, source):
    users = [(phone, name.strip()) for raw, name in source.employees() for phone in phones_in(raw)]
    store.set_users([(p, n) for p, n in users if n])


def sync(store, source, now: datetime):
    sync_users(store, source)
    rows = [r.to_dict() for r in parse_rows(source.rows(), now.date())]
    first_run = store.meta("initialized") is None
    if not first_run:  # первый запуск — молча запоминаем, чтобы не завалить всех уведомлениями
        users = store.users()
        for _kind, person, text in diff(store.schedule(), rows, now.date()):
            for phone in match_phones(person, users):
                store.add_note(phone, text, now.isoformat(timespec="minutes"))
    store.set_schedule(rows)
    store.set_meta("initialized", True)


# Напоминания перед сменой: (вид, за сколько до начала, насколько можно опоздать с отправкой, заголовок).
# Опоздание ограничено, чтобы только что добавленную смену не «догоняли» сразу двумя напоминаниями.
REMINDERS = [
    ("day", timedelta(hours=24), timedelta(hours=3), "📅 Завтра"),
    ("hour", timedelta(hours=1), timedelta(minutes=30), "⏰ Через час"),
]
EVE_HOUR = 18  # смены без времени: напоминание накануне вечером
FIRST_TIME = re.compile(r"\b(\d{1,2})[.:](\d{2})\b")


def start_of(row: Row, tz):
    """Начало смены (самое раннее из указанных времён) или None, если время не указано."""
    m = FIRST_TIME.search(row.time)
    if not m:
        return None
    d = date.fromisoformat(row.date)
    try:
        return datetime(d.year, d.month, d.day, int(m.group(1)), int(m.group(2)), tzinfo=tz)
    except ValueError:
        return None


def reminders(store, now: datetime):
    """За сутки и за час до смены (если время указано), иначе накануне вечером. Каждое напоминание — один раз."""
    users = store.users()
    batches = {}
    for r in map(lambda d: Row(**d), store.schedule()):
        phones = match_phones(r.person, users) if r.person else []
        if not phones:
            continue
        start = start_of(r, now.tzinfo)
        if start:
            rules = [(kind, start - off, grace, title) for kind, off, grace, title in REMINDERS]
        else:
            eve = datetime.combine(date.fromisoformat(r.date) - timedelta(days=1), dtime(EVE_HOUR), tzinfo=now.tzinfo)
            rules = [("eve", eve, timedelta(hours=6), "📅 Завтра")]
        for kind, trigger, grace, title in rules:
            if not (trigger <= now < trigger + grace) or (start and now >= start):
                continue
            for phone in phones:
                key = f"{kind}|{r.key}|{r.time}"
                if not store.digest_sent(phone, key):
                    store.set_digest(phone, key)
                    batches.setdefault((phone, title), []).append(r.describe())
    for (phone, title), lines in batches.items():
        store.add_note(phone, f"{title}:\n" + "\n".join(lines), now.isoformat(timespec="minutes"))
    store.prune_digests((now.date() - timedelta(days=2)).isoformat())


class Gone(Exception):
    """Чат больше недоступен (человек заблокировал бота): отвязываем его."""


def deliver(store, channels: dict):
    """Рассылает непереданные уведомления во все привязанные чаты. channels: {"telegram": ..., "max": ...}."""
    for n in store.pending_notes():
        for name, chat_id in store.chats_for(n["phone"]):
            ch = channels.get(name)
            if not ch:
                continue
            try:
                ch.send(chat_id, n["text"])
            except Gone:
                store.unbind(name, chat_id)
            except Exception:
                log.exception("send to %s:%s failed", name, chat_id)
        store.mark_sent(n["id"])
        time.sleep(SEND_PAUSE_SEC)  # мягкий лимит запросов к API


def cycle(store, source, channels: dict, now: datetime):
    sync(store, source, now)
    reminders(store, now)
    deliver(store, channels)
