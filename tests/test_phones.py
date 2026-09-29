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
