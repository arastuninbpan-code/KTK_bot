"""Откуда берём данные: Google Таблица (только чтение) или локальные CSV для демо."""
import csv
import pathlib


class CsvSource:
    def __init__(self, folder: str):
        self.folder = pathlib.Path(folder)

    def _read(self, name: str) -> list:
        with open(self.folder / name, encoding="utf-8", newline="") as f:
            return list(csv.reader(f))

    def employees(self) -> list:
        return [(r[1], r[0]) for r in self._read("employees.csv")[1:] if len(r) > 1]

    def rows(self) -> list:
        return self._read("schedule.csv")


class SheetSource:
    """Листы: «Расписание» (Дата | Время | Событие | Зал | Роль | ФИО) и «Сотрудники» (ФИО | Телефон).
    В листы «Расписание» и «Сотрудники» программа ничего не пишет."""

    def __init__(self, creds_file: str, sheet_id: str, creds_json: str = ""):
        import json

        import gspread  # лениво: демо и тесты работают без Google-зависимостей

        client = (gspread.service_account_from_dict(json.loads(creds_json)) if creds_json
                  else gspread.service_account(filename=creds_file))
        self.book = client.open_by_key(sheet_id)

    def employees(self) -> list:
        rows = self.book.worksheet("Сотрудники").get_all_values()[1:]
        return [(r[1], r[0]) for r in rows if len(r) > 1]

    def rows(self) -> list:
        return self.book.worksheet("Расписание").get_all_values()


def make_demo(folder: str):
    """Создаёт демо-файлы с датами от сегодняшнего дня (выдуманные имена). Существующие не трогает."""
    from datetime import date, timedelta

    folder = pathlib.Path(folder)
    folder.mkdir(exist_ok=True)
    if not (folder / "employees.csv").exists():
        with open(folder / "employees.csv", "w", encoding="utf-8", newline="") as f:
            csv.writer(f).writerows([
                ["ФИО", "Телефон"],
                ["Иванова А.А.", "+7 900 000-00-01"],
                ["Петрова Б.Б.", "+7 900 000-00-02"],
                ["Сидорова В.В.", "+7 900 000-00-03"],
            ])
    if not (folder / "schedule.csv").exists():
        d = lambda n: (date.today() + timedelta(days=n)).strftime("%d.%m.%Y")
        with open(folder / "schedule.csv", "w", encoding="utf-8", newline="") as f:
            csv.writer(f).writerows([
                ["Дата", "Время", "Событие", "Зал", "Роль", "ФИО"],
                [d(1), "11:00", "Спектакль «Бука»", "Малая сцена", "Администратор", "Иванова А.А."],
                [d(1), "11:00", "Спектакль «Бука»", "Малая сцена", "Гардероб", "Петрова Б.Б."],
                [d(2), "", "Репетиция «Игра в солдатики»", "Большая сцена", "Монтировка", "Сидорова В.В."],
                [d(3), "15:00", "Экскурсия по театру", "", "Администратор", "Иванова А.А. / Петрова Б.Б."],
            ])
