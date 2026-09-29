"""Состояние бота хранится в самой Google Таблице, чтобы запускам по расписанию не нужен был диск/сервер.
Лист «_служебное» — снимок в JSON (кусками по ячейкам), лист «Подписчики» — то же в читаемом виде для администратора."""
import json

CHUNK = 40000  # лимит ячейки Google — 50 000 символов


def to_chunks(text: str) -> list:
    return [text[i:i + CHUNK] for i in range(0, len(text), CHUNK)] or [""]


def from_chunks(chunks: list) -> str:
    return "".join(chunks)


class SheetState:
    def __init__(self, book):
        self.book = book
        self.raw = None  # что было загружено: чтобы не писать в таблицу, если ничего не изменилось

    def _ws(self, title: str):
        try:
            return self.book.worksheet(title)
        except Exception as e:  # gspread.WorksheetNotFound; по имени, чтобы не тянуть gspread в тесты
            if type(e).__name__ != "WorksheetNotFound":
                raise
            return self.book.add_worksheet(title, rows=100, cols=4)

    def load(self, store):
        text = from_chunks(self._ws("_служебное").col_values(1))
        self.raw = text
        if text.strip():
            store.load(json.loads(text))

    def save(self, store):
        text = json.dumps(store.dump(), ensure_ascii=False, sort_keys=True)
        if text == self.raw:
            return False
        ws = self._ws("_служебное")
        ws.clear()
        ws.update(range_name="A1", values=[[c] for c in to_chunks(text)], raw=True)
        names = {u["phone"]: u["name"] for u in store.users()}
        rows = [["Канал", "ID чата", "Телефон", "ФИО"]] + [
            [ch, cid, phone, names.get(phone, "")] for ch, cid, phone in store.dump()["chats"]]
        subs = self._ws("Подписчики")
        subs.clear()
        subs.update(range_name="A1", values=rows)
        self.raw = text
        return True
