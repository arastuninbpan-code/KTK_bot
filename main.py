"""Запуск: python main.py --once (один прогон, для GitHub Actions), python main.py (постоянно, на сервере),
python main.py --demo (без мессенджеров и Google)."""
import logging
import os
import sys
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

import service
from bots import handle
from channels import ConsoleChannel, Max, Telegram
from sources import CsvSource, make_demo
from store import Store

log = logging.getLogger("planner")


def poll_loop(store, channel, tz):
    cursor = None
    while True:
        try:
            events, cursor = channel.poll(cursor)
            for e in events:
                handle(store, channel, e, datetime.now(tz))
        except Exception:
            log.exception("polling %s failed", channel.name)
            time.sleep(5)


def cycle_loop(store, source, channels, tz, interval):
    while True:
        try:
            service.cycle(store, source, channels, datetime.now(tz))
        except Exception:
            log.exception("cycle failed")
        time.sleep(interval)


def demo(tz):
    """Ввод: `<номер чата>: <текст>` или `<номер чата>: контакт +7 900 000-00-01`; `time +23h` двигает часы."""
    make_demo("demo")
    store, source, ch, offset = Store(), CsvSource("demo"), ConsoleChannel("demo"), timedelta()
    service.SEND_PAUSE_SEC = 0
    print("Демо. Примеры: `1: /start`, `1: контакт +7 900 000-00-01`, `1: /shifts`, `time +30h`, `exit` "
          "(правьте demo/schedule.csv — уведомления придут после следующей команды)")
    while True:
        try:
            line = input("> ").strip()
        except EOFError:
            return
        if line == "exit":
            return
        if line.startswith("time "):
            n, unit = int(line[5:-1]), line[-1]
            offset += timedelta(**{"m": {"minutes": n}, "h": {"hours": n}, "d": {"days": n}}[unit])
        else:
            chat, _, text = line.partition(":")
            phone = text.split("контакт", 1)[1].strip() if "контакт" in text else None
            handle(store, ch, {"chat_id": chat.strip(), "text": text.strip(), "phone": phone}, datetime.now(tz) + offset)
        service.cycle(store, source, {"demo": ch}, datetime.now(tz) + offset)


def run_once(store, source, state, channels, tz):
    """Один прогон без сервера: загрузить состояние -> ответить на сообщения -> разослать уведомления -> сохранить."""
    state.load(store)
    service.sync_users(store, source)  # нужны до обработки сообщений: по ним проверяем номера
    for name, ch in channels.items():
        key = f"cursor:{name}"
        events, cursor = ch.poll(store.meta(key), timeout=0)
        seen = set()
        for e in events:
            sig = (e["chat_id"], e["text"], e["phone"])
            if sig in seen:  # несколько одинаковых сообщений подряд (например, /start) — отвечаем один раз
                continue
            seen.add(sig)
            handle(store, ch, e, datetime.now(tz))
        if cursor is not None:
            store.set_meta(key, cursor)
    service.cycle(store, source, channels, datetime.now(tz))
    state.save(store)


def build_channels():
    channels = {}
    if os.getenv("TELEGRAM_BOT_TOKEN"):
        channels["telegram"] = Telegram(os.environ["TELEGRAM_BOT_TOKEN"])
    if os.getenv("MAX_BOT_TOKEN"):
        channels["max"] = Max(os.environ["MAX_BOT_TOKEN"])
    if not channels:
        sys.exit("Задайте TELEGRAM_BOT_TOKEN и/или MAX_BOT_TOKEN")
    return channels


def main():
    load_dotenv()
    logging.basicConfig(level=logging.INFO)
    tz = ZoneInfo(os.getenv("TIMEZONE", "Europe/Moscow"))
    if "--demo" in sys.argv:
        return demo(tz)
    from sources import SheetSource
    source = SheetSource(os.getenv("GOOGLE_CREDENTIALS_FILE", "service-account.json"), os.environ["SHEET_ID"],
                         os.getenv("GOOGLE_CREDENTIALS_JSON", ""))
    channels = build_channels()
    if "--once" in sys.argv:  # GitHub Actions: состояние живёт в таблице
        from state import SheetState
        return run_once(Store(), source, SheetState(source.book), channels, tz)
    store = Store(os.getenv("DB_PATH", "planner.db"))  # обычный сервер: работает постоянно
    for ch in channels.values():
        threading.Thread(target=poll_loop, args=(store, ch, tz), daemon=True).start()
    cycle_loop(store, source, channels, tz, int(os.getenv("CHECK_INTERVAL_SEC", "60")))


if __name__ == "__main__":
    main()
