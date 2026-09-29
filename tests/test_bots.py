import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from datetime import datetime
from zoneinfo import ZoneInfo

import service
from bots import handle
from channels import ConsoleChannel
from store import Store

TZ = ZoneInfo("Europe/Moscow")
HEAD = ["Дата/Время", "Спектакль/Сцена", "Администратор", "Гардероб", "Касса", "Монтировка", "Актеры"]
service.SEND_PAUSE_SEC = 0


class Src:
    def __init__(self):
        self.emps = [("Иванова А.А.", "+7 900 000-00-01"), ("Петрова Б.Б.", "+7 900 000-00-02")]
        self.table = [HEAD, ["04.10\n11.00", "Спектакль «Бука»\n(малая сцена)", "Иванова А.А.", "", "", "", ""]]

    def employees(self):
        return [(p, n) for n, p in self.emps]

    def rows(self):
        return self.table


def now(day, hour=10):
    return datetime(2026, 10, day, hour, 0, tzinfo=TZ)


def setup():
    store, src = Store(), Src()
    tg, mx = ConsoleChannel("telegram"), ConsoleChannel("max")
    service.cycle(store, src, {}, now(1))  # тихий первый снимок
    return store, src, tg, mx, {"telegram": tg, "max": mx}


def texts(ch, chat):
    return [t for c, t in ch.sent if c == str(chat)]


def test_registration_by_contact_and_by_typed_number():
    store, _, tg, mx, _ = setup()
    handle(store, tg, {"chat_id": 5, "text": "/start", "phone": None}, now(1))
    assert "поделитесь номером" in texts(tg, 5)[-1]
    handle(store, tg, {"chat_id": 5, "text": "", "phone": "+79000000001"}, now(1))
    assert "Иванова А.А." in texts(tg, 5)[-1] and store.phone_by_chat("telegram", 5) == "9000000001"
    handle(store, mx, {"chat_id": 7, "text": "8 (900) 000-00-02", "phone": None}, now(1))
    assert store.phone_by_chat("max", 7) == "9000000002"
    handle(store, mx, {"chat_id": 8, "text": "+7 999 999-99-99", "phone": None}, now(1))
    assert "нет в списке" in texts(mx, 8)[-1] and store.phone_by_chat("max", 8) is None


def test_unregistered_cannot_use_commands():
    store, _, tg, _, _ = setup()
    handle(store, tg, {"chat_id": 9, "text": "/shifts", "phone": None}, now(1))
    assert "поделитесь номером" in texts(tg, 9)[-1]


def test_changes_go_to_all_bound_channels_only_for_that_person():
    store, src, tg, mx, chans = setup()
    handle(store, tg, {"chat_id": 5, "text": "", "phone": "9000000001"}, now(1))
    handle(store, mx, {"chat_id": 7, "text": "", "phone": "9000000001"}, now(1))  # тот же человек в двух мессенджерах
    handle(store, tg, {"chat_id": 6, "text": "", "phone": "9000000002"}, now(1))
    tg.sent.clear(); mx.sent.clear()
    src.table[1][3] = "Иванова А.А."  # ещё и гардероб в тот же день
    src.table.append(["06.10", "Репетиция", "", "", "", "Иванова А.А.", ""])
    service.cycle(store, src, chans, now(1))
    assert any("Вам назначено" in t for t in texts(tg, 5)) and any("Вам назначено" in t for t in texts(mx, 7))
    assert texts(tg, 6) == []
    n = len(tg.sent)
    service.cycle(store, src, chans, now(1))
    assert len(tg.sent) == n  # повторов нет


def test_digest_and_views():
    store, src, tg, _, chans = setup()
    handle(store, tg, {"chat_id": 5, "text": "", "phone": "9000000001"}, now(1))
    service.cycle(store, src, chans, now(3, 18))
    assert "Завтра у вас" in texts(tg, 5)[-1]
    handle(store, tg, {"chat_id": 5, "text": "/shifts", "phone": None}, now(3))
    assert "Спектакль «Бука»" in texts(tg, 5)[-1]
    handle(store, tg, {"chat_id": 5, "text": "/schedule", "phone": None}, now(3))
    assert "Администратор: Иванова А.А." in texts(tg, 5)[-1]


def test_stop_and_removed_employee():
    store, src, tg, _, chans = setup()
    handle(store, tg, {"chat_id": 5, "text": "", "phone": "9000000002"}, now(1))
    handle(store, tg, {"chat_id": 5, "text": "/stop", "phone": None}, now(1))
    assert store.phone_by_chat("telegram", 5) is None
    handle(store, tg, {"chat_id": 6, "text": "", "phone": "9000000002"}, now(1))
    src.emps.pop()
    service.cycle(store, src, chans, now(1))
    assert store.chats_for("9000000002") == []
