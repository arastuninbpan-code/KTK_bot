import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
from datetime import date

from core import diff, norm, parse_rows

TODAY = date(2026, 9, 29)
HEAD = ["4Дата/\nВремя", "Спектакль/\nСцена", "Администратор/\nКапельдинер", "Гардероб/\nУборщица",
        "Касса", "Монтировка", "Актеры, свет,\nзвук"]


def g(*rows):
    return parse_rows([HEAD, *rows], TODAY)


def test_rehearsal_with_hall_and_two_admins():
    r = g(["01.10", "Спектакль «Игра в солдатики» репетиция (большая сцена)", "Иванова М.В./ Петрова Л.Н.",
           "Сидорова Л.Р.", "", "", ""])
    assert {(x.person, x.role) for x in r} == {
        ("Иванова М.В.", "Администратор/ Капельдинер"), ("Петрова Л.Н.", "Администратор/ Капельдинер"),
        ("Сидорова Л.Р.", "Гардероб/ Уборщица")}
    assert r[0].hall == "большая сцена" and r[0].event == "Спектакль «Игра в солдатики» репетиция"
    assert r[0].date == "2026-10-01"


def test_two_show_times_and_empty_day():
    r = g(["04.10\n11.00 и 13.00", "Спектакль «Бука»\n(малая сцена)", "Иванова М.В.", "Морозова Н.М.", "Орлова А.В.", "", ""],
          ["05.10", "", "", "", "", "", ""])
    assert {x.time for x in r} == {"11:00, 13:00"}
    assert all(x.date == "2026-10-04" for x in r) and len(r) == 3


def test_names_without_separator_and_date_range():
    r = g(["15.10", "Выезд в Сеченово\nСпектакль «Игра в солдатики»", "Кузнецова Е.Н. Иванова М.В.", "", "", "", ""],
          ["25.10 до 31.10", "Фестиваль в Барнауле", "", "", "", "", ""])
    assert {x.person for x in r if x.date == "2026-10-15"} == {"Кузнецова Е.Н.", "Иванова М.В."}
    fest = [x for x in r if x.event == "Фестиваль в Барнауле"]
    assert len(fest) == 7 and fest[-1].date == "2026-10-31" and fest[0].person == ""


def test_initials_spacing_matches_and_changes_detected():
    assert norm("Сидорова Л. Р.") == norm("сидорова Л.Р.")
    old = [x.to_dict() for x in g(["01.10", "Репетиция", "", "Сидорова Л.Р.", "", "", ""])]
    new = [x.to_dict() for x in g(["01.10", "Репетиция", "", "", "", "", "Сидорова Л.Р."])]  # перенесли в другую роль
    kinds = sorted(k for k, _, _ in diff(old, new, TODAY))
    assert kinds == ["added", "removed"]
