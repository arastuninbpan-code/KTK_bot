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


def test_views():
    store, src, tg, _, chans = setup()
    handle(store, tg, {"chat_id": 5, "text": "", "phone": "9000000001"}, now(1))
    handle(store, tg, {"chat_id": 5, "text": "/shifts", "phone": None}, now(3))
    assert "Спектакль «Бука»" in texts(tg, 5)[-1]
    handle(store, tg, {"chat_id": 5, "text": "/schedule", "phone": None}, now(3))
    assert "Администратор: Иванова А.А." in texts(tg, 5)[-1]


def reminders_for(store, src, chans, tg, *moments):
    for m in moments:
        service.cycle(store, src, chans, m)
    return [t for c, t in tg.sent if c == "5" and ("Завтра" in t or "Через час" in t)]


def test_day_and_hour_reminders_once_each():
    store, src, tg, _, chans = setup()  # смена 04.10 в 11:00
    handle(store, tg, {"chat_id": 5, "text": "", "phone": "9000000001"}, now(1))
    got = reminders_for(store, src, chans, tg, now(3, 10), now(3, 12))  # до срока за сутки и внутри окна
    assert len(got) == 1 and got[0].startswith("📅 Завтра")
    got = reminders_for(store, src, chans, tg, now(3, 12), now(4, 9))  # повтор не шлём; за час ещё рано
    assert len(got) == 1
    got = reminders_for(store, src, chans, tg, now(4, 10), now(4, 10), now(4, 11))  # за час: один раз; после начала — нет
    assert len(got) == 2 and got[1].startswith("⏰ Через час")


def test_shift_without_time_reminds_evening_before():
    store, src, tg, _, chans = setup()
    src.table.append(["07.10", "Репетиция", "", "", "", "", ""])
    src.table[-1][2] = "Иванова А.А."
    handle(store, tg, {"chat_id": 5, "text": "", "phone": "9000000001"}, now(1))
    got = reminders_for(store, src, chans, tg, now(6, 17), now(6, 18), now(6, 19))
    assert len(got) == 1 and "Репетиция" in got[0]


def test_late_added_shift_is_not_chased_by_day_reminder():
    store, src, tg, _, chans = setup()
    handle(store, tg, {"chat_id": 5, "text": "", "phone": "9000000001"}, now(1))
    service.cycle(store, src, chans, now(4, 6))  # за 5 часов до смены: «за сутки» уже не актуально
    assert reminders_for(store, src, chans, tg) == []
    assert len(reminders_for(store, src, chans, tg, now(4, 10))) == 1  # а за час напомним


def test_stop_and_removed_employee():
    store, src, tg, _, chans = setup()
    handle(store, tg, {"chat_id": 5, "text": "", "phone": "9000000002"}, now(1))
    handle(store, tg, {"chat_id": 5, "text": "/stop", "phone": None}, now(1))
    assert store.phone_by_chat("telegram", 5) is None
    handle(store, tg, {"chat_id": 6, "text": "", "phone": "9000000002"}, now(1))
    src.emps.pop()
    service.cycle(store, src, chans, now(1))
    assert store.chats_for("9000000002") == []
