"""Один цикл работы: синхронизация с таблицей -> уведомления -> вечерняя сводка -> доставка push."""
import logging
import time
from datetime import datetime, timedelta

from core import Row, diff, norm, norm_phone, parse_rows

log = logging.getLogger("planner")
SEND_PAUSE_SEC = 0.05
DIGEST_HOUR = 18  # вечером накануне присылаем «завтра у вас…»


def sync_users(store, source):
    users = [(norm_phone(p), name.strip()) for p, name in source.employees()]
    store.set_users([(p, n) for p, n in users if p and n])


def sync(store, source, now: datetime):
    sync_users(store, source)
    rows = [r.to_dict() for r in parse_rows(source.rows(), now.date())]
    first_run = store.meta("initialized") is None
    if not first_run:  # первый запуск — молча запоминаем, чтобы не завалить всех уведомлениями
        for _kind, person, text in diff(store.schedule(), rows, now.date()):
            for phone in store.phones_by_name(person):
                store.add_note(phone, text, now.isoformat(timespec="minutes"))
    store.set_schedule(rows)
    store.set_meta("initialized", True)


def digests(store, now: datetime):
    if now.hour < DIGEST_HOUR:
        return
    tomorrow = (now.date() + timedelta(days=1)).isoformat()
    schedule = [Row(**r) for r in store.schedule()]
    for u in store.users():
        if store.digest_sent(u["phone"], tomorrow):
            continue
        mine = [r for r in schedule if r.date == tomorrow and norm(r.person) == u["name_norm"]]
        if mine:
            body = "\n".join(r.describe() for r in mine)
            store.add_note(u["phone"], f"⏰ Завтра у вас:\n{body}", now.isoformat(timespec="minutes"))
        store.set_digest(u["phone"], tomorrow)


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
    digests(store, now)
    deliver(store, channels)
