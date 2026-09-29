import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))
import httpx
import pytest

from channels import Telegram


def test_errors_do_not_leak_token():
    token = "123456:SECRET-TOKEN"
    tg = Telegram(token)
    tg.http = httpx.Client(base_url=f"https://api.telegram.org/bot{token}",
                           transport=httpx.MockTransport(lambda req: httpx.Response(500, text="boom")))
    with pytest.raises(RuntimeError) as e:
        tg.send(1, "hi")
    assert token not in str(e.value) and "500" in str(e.value)
