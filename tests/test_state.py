import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from datetime import datetime
from zoneinfo import ZoneInfo

import main
import service
from channels import ConsoleChannel
from state import SheetState, from_chunks, to_chunks
from store import Store
from test_bots import Src, now  # noqa

TZ = ZoneInfo("Europe/Moscow")
service.SEND_PAUSE_SEC = 0


class WorksheetNotFound(Exception):
    pass


class FakeWS:
    def __init__(self):
        self.cells = []

    def col_values(self, _):
        return list(self.cells)

    def clear(self):
        self.cells = []

    def update(self, range_name, values, raw=False):
        self.cells = [r[0] for r in values]


class FakeBook:
    def __init__(self):
        self.sheets = {}

    def worksheet(self, t):
        if t not in self.sheets:
            raise WorksheetNotFound(t)
        return self.sheets[t]

    def add_worksheet(self, t, rows, cols):
        self.sheets[t] = FakeWS()
        return self.sheets[t]


class Poller(ConsoleChannel):
    def __init__(self, name, batches):
        super().__init__(name)
        self.batches = batches

    def poll(self, cursor, timeout=30):
        events = self.batches.pop(0) if self.batches else []
        return events, ((cursor or 0) + 1 if events else cursor)  # как в Telegram: курсор растёт только с новыми сообщениями


def test_chunks_roundtrip():
    big = "я" * 100000
    assert from_chunks(to_chunks(big)) == big and len(to_chunks(big)) == 3


def test_state_survives_between_runs_and_avoids_needless_writes():
    book, src = FakeBook(), Src()
    tg = Poller("telegram", [[{"chat_id": 5, "text": "", "phone": "+79000000001"}]])
    main.run_once(Store(), src, SheetState(book), {"telegram": tg}, TZ)  # запуск 1: человек подключился
    assert any("Готово" in t for _, t in tg.sent)

    src.table.append(["06.10", "Репетиция", "", "", "", "Иванова А.А.", ""])  # запуск 2: правка в таблице
    tg2 = Poller("telegram", [[]])
    main.run_once(Store(), src, SheetState(book), {"telegram": tg2}, TZ)     # новый процесс, память пуста
    assert any("Вам назначено" in t for c, t in tg2.sent if c == "5")

    before = list(book.sheets["_служебное"].cells)
    st = SheetState(book)
    main.run_once(Store(), src, st, {"telegram": Poller("telegram", [[]])}, TZ)  # запуск 3: ничего не изменилось
    assert book.sheets["_служебное"].cells == before


def test_repeated_identical_messages_get_one_reply():
    book, src = FakeBook(), Src()
    same = {"chat_id": 5, "text": "/start", "phone": None}
    tg = Poller("telegram", [[same, dict(same), dict(same)]])
    main.run_once(Store(), src, SheetState(book), {"telegram": tg}, TZ)
    assert len([1 for c, t in tg.sent if c == "5"]) == 1
