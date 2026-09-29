import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import pytest

from core import looks_like_phone, norm_phone, phones_in

SAME = ["89307029109", "+79307029109", "79307029109", "8 930 702 91 09", "8 (930) 702-91-09", "+7 (930) 702-91-09",
        "+7 930 702-91-09", "8-930-702-91-09", "930.702.91.09", "9307029109", "8 930 702 91 09 ",
        "+7 930 702 91 09", "тел. 8 930 702 91 09", "‎+7 930 702 91 09"]


@pytest.mark.parametrize("raw", SAME)
def test_any_format_gives_same_number(raw):
    assert norm_phone(raw) == "9307029109"


@pytest.mark.parametrize("raw", [x for x in SAME if "тел" not in x])
def test_typed_number_is_recognised(raw):
    assert looks_like_phone(raw)


def test_words_and_commands_are_not_numbers():
    assert not looks_like_phone("/start") and not looks_like_phone("привет") and not looks_like_phone("тел. 8 930 702 91 09")
    assert not looks_like_phone("12345")


def test_several_numbers_in_one_cell_and_junk_ignored():
    assert phones_in("8 930 702-91-09, +7 900 000-00-01;\n89001112233") == ["9307029109", "9000000001", "9001112233"]
    assert phones_in("") == [] and phones_in("нет") == []


# --- сверка людей: расписание и список сотрудников пишут имена по-разному ---
from core import match_phones, person_key  # noqa: E402

EMP = [{"name": "Дьячков Н. А", "phone": "9307029109"}, {"name": "Иванова М.В.", "phone": "9000000001"}]


@pytest.mark.parametrize("written", ["Дьячков", "дьячков н.а.", "Дьячков Н. А", "Дьячков Н.А", "ДЬЯЧКОВ Н.", "Дьячков Никита Александрович"])
def test_person_matches_despite_format(written):
    assert match_phones(written, EMP) == ["9307029109"]


def test_wrong_person_is_not_matched():
    assert match_phones("Дьячков М.В.", EMP) == [] and match_phones("Петров", EMP) == [] and match_phones("", EMP) == []


def test_surname_only_is_ambiguous_with_namesakes_but_not_with_two_phones_of_one_person():
    twins = EMP + [{"name": "Дьячков М.В.", "phone": "9000000009"}]
    assert match_phones("Дьячков", twins) == []                      # два разных Дьячковых: не гадаем
    assert match_phones("Дьячков Н.А.", twins) == ["9307029109"]      # с инициалами всё однозначно
    two_phones = EMP + [{"name": "Дьячков Н. А", "phone": "9001112233"}]
    assert sorted(match_phones("Дьячков", two_phones)) == ["9001112233", "9307029109"]


def test_hyphenated_surname():
    assert person_key("Иванова-Петрова А.Б.") == ("иванова-петрова", "аб")
