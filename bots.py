"""Диалог с сотрудником: одинаков для Telegram и MAX."""
import re
from datetime import datetime

from core import Row, looks_like_phone, match_phones, norm_phone

HELP = "/shifts — мои ближайшие смены\n/schedule — афиша ближайших событий\n/stop — отключить уведомления"


def my_shifts(store, user: dict, today: str) -> str:
    users = store.users()
    rows = sorted((r for r in map(lambda d: Row(**d), store.schedule())
                   if r.date >= today and r.person and user["phone"] in match_phones(r.person, users)),
                  key=lambda r: (r.date, r.time))
    return "\n".join(r.describe() for r in rows) or "Ближайших смен нет."


def afisha(store, today: str, limit: int = 15) -> str:
    events = {}
    for r in sorted((Row(**d) for d in store.schedule() if d["date"] >= today), key=lambda r: (r.date, r.time, r.event)):
        e = events.setdefault((r.date, r.time, r.event), [r.when() + " — " + r.event + (f" ({r.hall})" if r.hall else "")])
        if r.person:
            e.append(f"   {r.role + ': ' if r.role else ''}{r.person}")
    return "\n\n".join("\n".join(v) for v in list(events.values())[:limit]) or "Событий пока нет."


def handle(store, channel, event: dict, now: datetime):
    chat, text = event["chat_id"], (event.get("text") or "").strip()
    phone = norm_phone(event["phone"]) if event.get("phone") else None
    if not phone and looks_like_phone(text):  # номер, введённый вручную
        phone = norm_phone(text)

    if phone:
        user = store.user(phone)
        if not user:
            channel.send(chat, "Этого номера нет в списке сотрудников. Обратитесь к администратору.")
            return
        store.bind(channel.name, chat, phone)
        channel.send(chat, f"Готово, {user['name']}! Теперь я буду присылать уведомления о ваших сменах.\n\n" + HELP,
                     keyboard="remove")
        return

    me = store.phone_by_chat(channel.name, chat)
    user = store.user(me) if me else None
    if not user:
        channel.send(chat, "Здравствуйте! Чтобы получать уведомления о сменах, поделитесь номером телефона "
                           "(кнопка ниже) или напишите его сообщением.", keyboard="contact")
        return

    cmd = text.split()[0].lower() if text else ""
    today = now.date().isoformat()
    if cmd == "/shifts":
        channel.send(chat, my_shifts(store, user, today))
    elif cmd == "/schedule":
        channel.send(chat, afisha(store, today))
    elif cmd == "/stop":
        store.unbind(channel.name, chat)
        channel.send(chat, "Уведомления отключены. Чтобы включить снова, напишите /start.", keyboard="remove")
    else:
        channel.send(chat, f"{user['name']}, вы подключены.\n\n" + HELP)
