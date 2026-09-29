"""Мессенджеры. Оба канала отдают одинаковые события: {"chat_id", "text", "phone"} (phone — только у «Поделиться номером»)
и умеют send(chat_id, text, keyboard=None), где keyboard: "contact" (кнопка «Поделиться номером») или "remove"."""
import re

import httpx

from service import Gone


class Telegram:
    name = "telegram"

    def __init__(self, token: str):
        self.http = httpx.Client(base_url=f"https://api.telegram.org/bot{token}", timeout=45)

    def send(self, chat_id, text: str, keyboard=None):
        body = {"chat_id": chat_id, "text": text}
        if keyboard == "contact":
            body["reply_markup"] = {"keyboard": [[{"text": "📱 Поделиться номером", "request_contact": True}]],
                                    "resize_keyboard": True, "one_time_keyboard": True}
        elif keyboard == "remove":
            body["reply_markup"] = {"remove_keyboard": True}
        r = self.http.post("/sendMessage", json=body)
        if r.status_code == 403:  # бот заблокирован пользователем
            raise Gone()
        r.raise_for_status()

    def poll(self, cursor, timeout=30):
        r = self.http.get("/getUpdates", params={"timeout": timeout, "offset": cursor or 0})
        r.raise_for_status()
        events = []
        for u in r.json()["result"]:
            cursor = u["update_id"] + 1
            m = u.get("message")
            if not m or m["chat"].get("type") != "private":
                continue
            phone = None
            c = m.get("contact")
            if c and c.get("user_id") == m["from"]["id"]:  # только собственный контакт, не чужой
                phone = c["phone_number"]
            events.append({"chat_id": m["chat"]["id"], "text": m.get("text", ""), "phone": phone})
        return events, cursor


class Max:
    """MAX Bot API (https://dev.max.ru/docs-api)."""
    name = "max"

    def __init__(self, token: str):
        self.http = httpx.Client(base_url="https://platform-api.max.ru", headers={"Authorization": token}, timeout=45)

    def send(self, chat_id, text: str, keyboard=None):
        body = {"text": text}
        if keyboard == "contact":
            body["attachments"] = [{"type": "inline_keyboard", "payload": {
                "buttons": [[{"type": "request_contact", "text": "📱 Поделиться номером"}]]}}]
        r = self.http.post("/messages", params={"user_id": chat_id}, json=body)
        if r.status_code == 403:
            raise Gone()
        r.raise_for_status()

    def poll(self, cursor, timeout=30):
        params = {"timeout": timeout, "types": "message_created,bot_started"}
        if cursor is not None:
            params["marker"] = cursor
        r = self.http.get("/updates", params=params)
        r.raise_for_status()
        data = r.json()
        events = []
        for u in data.get("updates", []):
            if u["update_type"] == "bot_started":
                events.append({"chat_id": u["user"]["user_id"], "text": "/start", "phone": None})
            elif u["update_type"] == "message_created":
                msg, sender = u["message"], u["message"]["sender"]
                if sender.get("is_bot"):
                    continue
                body = msg.get("body") or {}
                phone = None
                for a in body.get("attachments") or []:
                    if a.get("type") == "contact":
                        m = re.search(r"TEL[^:]*:([+\d\-\s()]+)", (a.get("payload") or {}).get("vcf_info", ""))
                        phone = m.group(1) if m else None
                events.append({"chat_id": sender["user_id"], "text": body.get("text") or "", "phone": phone})
        return events, data.get("marker", cursor)


class ConsoleChannel:
    """Печатает вместо отправки: для демо и тестов."""

    def __init__(self, name="console"):
        self.name = name
        self.sent = []

    def send(self, chat_id, text: str, keyboard=None):
        self.sent.append((str(chat_id), text))
        print(f"  -> [{self.name}:{chat_id}] " + text.replace("\n", "\n     ")
              + ("\n     [кнопка: Поделиться номером]" if keyboard == "contact" else ""))
