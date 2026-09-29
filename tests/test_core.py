import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from datetime import date

from core import diff, norm_phone, parse_date, parse_rows

TODAY = date(2026, 10, 1)
HEAD = ["Дата", "Время", "Событие", "Зал", "Роль", "ФИО"]


def rows(*data):
    return [r.to_dict() for r in parse_rows([HEAD, *data], TODAY)]


def test_parse_dates():
    assert parse_date("04.10", TODAY) == date(2026, 10, 4)
    assert parse_date("04.10.2026", TODAY) == date(2026, 10, 4)
    assert parse_date("мусор", TODAY) is None


def test_multiple_people_in_one_cell_and_unstaffed_event():
    r = parse_rows([HEAD, ["04.10", "11:00", "Бука", "Малая", "Админ", "Иванова А.А. / Петрова Б.Б."],
                    ["05.10", "", "Экскурсия", "", "", ""], ["bad", "", "x"]], TODAY)
    assert [x.person for x in r] == ["Иванова А.А.", "Петрова Б.Б.", ""]


def test_phone_normalization():
    assert norm_phone("+7 (900) 000-00-01") == norm_phone("8 900 000 00 01") == "9000000001"


def test_diff_added_removed_changed():
    old = rows(["04.10", "11:00", "Бука", "Малая", "Админ", "Иванова А.А."],
               ["06.10", "", "Репетиция", "", "Свет", "Петрова Б.Б."])
    new = rows(["04.10", "12:00", "Бука", "Малая", "Админ", "Иванова А.А."],   # перенос
               ["07.10", "", "Репетиция", "", "Свет", "Сидорова В.В."])          # снята Петрова, добавлена Сидорова
    kinds = {(k, p) for k, p, _ in diff(old, new, TODAY)}
    assert kinds == {("changed", "Иванова А.А."), ("removed", "Петрова Б.Б."), ("added", "Сидорова В.В.")}


def test_diff_ignores_past_and_unstaffed():
    old = rows(["01.09", "", "Старое", "", "", "Иванова А.А."])
    assert diff(old, [], TODAY) == []
    assert diff([], rows(["05.10", "", "Экскурсия", "", "", ""]), TODAY) == []
