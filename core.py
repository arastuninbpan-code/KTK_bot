"""Чистая логика без сети и БД: разбор таблицы расписания и сравнение версий."""
import re
from dataclasses import asdict, dataclass
from datetime import date, datetime

WEEKDAYS = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"]
PERSON_SPLIT = re.compile(r"[/;,\n]")


def norm(s) -> str:
    s = str(s).lower().replace("ё", "е")
    return " ".join(re.sub(r"\.\s+", ".", s).split())  # «М. В.» и «М.В.» — одно и то же


def norm_phone(s) -> str:
    digits = re.sub(r"\D", "", str(s))
    return digits[-10:] if len(digits) >= 10 else digits


@dataclass(frozen=True)
class Row:
    """Одна строка расписания: один человек в одной роли на одном событии."""
    date: str  # ISO, YYYY-MM-DD
    time: str
    event: str
    hall: str
    role: str
    person: str

    @property
    def key(self) -> str:
        return f"{self.date}|{norm(self.event)}|{norm(self.role)}|{norm(self.person)}"

    def to_dict(self) -> dict:
        return asdict(self)

    def when(self) -> str:
        d = date.fromisoformat(self.date)
        text = f"{d:%d.%m} ({WEEKDAYS[d.weekday()]})"
        return f"{text} {self.time}" if self.time else text

    def describe(self) -> str:
        where = f" ({self.hall})" if self.hall else ""
        role = f", {self.role}" if self.role else ""
        return f"{self.when()} — {self.event}{where}{role}"


def parse_date(s: str, today: date) -> "date | None":
    s = str(s).strip()
    for fmt in ("%d.%m.%Y", "%d.%m.%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    try:  # «04.10» — год берём текущий
        d = datetime.strptime(f"{s}.{today.year}", "%d.%m.%Y").date()
        return d
    except ValueError:
        return None


def parse_flat(table: list, today: date) -> list:
    """Плоский вид. Колонки: Дата | Время | Событие | Зал | Роль | ФИО. Первая строка — заголовок.
    Несколько людей в одной ячейке («Иванова А.А. / Петрова Б.Б.») разворачиваются в отдельные строки.
    Строка без ФИО — событие без назначенных людей (видно в афише, уведомлений нет)."""
    out = []
    for cells in table[1:]:
        cells = [str(c).strip() for c in cells] + [""] * 6
        d = parse_date(cells[0], today)
        event = cells[2]
        if not d or not event:
            continue
        people = [p.strip() for p in PERSON_SPLIT.split(cells[5]) if p.strip()] or [""]
        for person in people:
            out.append(Row(d.isoformat(), cells[1], event, cells[3], cells[4], person))
    return out


def diff(old: list, new: list, today: date) -> list:
    """old/new — списки dict (Row.to_dict). Возвращает [(kind, person, text)].
    kind: added | removed | changed. Прошедшие даты и строки без ФИО игнорируются."""
    o = {Row(**r).key: Row(**r) for r in old if r["person"]}
    n = {Row(**r).key: Row(**r) for r in new if r["person"]}
    horizon = today.isoformat()
    changes = []
    for k, r in n.items():
        if r.date < horizon:
            continue
        if k not in o:
            changes.append(("added", r.person, f"🆕 Вам назначено: {r.describe()}"))
        elif (o[k].time, o[k].hall) != (r.time, r.hall):
            changes.append(("changed", r.person, f"✏️ Изменение: {r.describe()}"))
    for k, r in o.items():
        if k not in n and r.date >= horizon:
            changes.append(("removed", r.person, f"❌ Снято: {r.describe()}"))
    return changes


# ---------- сетка, как её ведут в театре ----------
# Дата/Время | Спектакль/Сцена | Администратор | Гардероб | Касса | Монтировка | Актёры, свет, звук
# Роль берётся из заголовка колонки, люди — из ячеек.
NAME_RE = re.compile(r"[А-ЯЁ][а-яё\-]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\.")
TIME_RE = re.compile(r"\b(\d{1,2})[.:](\d{2})\b")
DATE_AT_START = re.compile(r"^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)")
HALL_RE = re.compile(r"\(([^)]*сцен[^)]*)\)", re.I)


def split_people(text: str) -> list:
    names = NAME_RE.findall(text)  # ловит и «Кузнецова Е.Н. Иванова М.В.» без разделителя
    if names:
        return [" ".join(n.split()) for n in names]
    return [p.strip() for p in PERSON_SPLIT.split(text) if p.strip()]


def parse_grid(table: list, today: date) -> list:
    header = [" ".join(str(c).split()) for c in table[0]]
    out = []
    for cells in table[1:]:
        cells = [str(c).strip() for c in cells] + [""] * len(header)
        m = DATE_AT_START.match(cells[0])
        d = parse_date(m.group(1), today) if m else None
        if not d:
            continue
        rest = cells[0][m.end():]
        dates = [d]
        m2 = re.search(r"до\s+(\d{1,2}\.\d{2}(?:\.\d{2,4})?)", rest)  # «25.10 до 31.10» — диапазон
        if m2:
            end = parse_date(m2.group(1), today)
            if end and 0 < (end - d).days <= 31:
                dates = [date.fromordinal(d.toordinal() + i) for i in range((end - d).days + 1)]
            rest = rest[:m2.start()] + rest[m2.end():]
        time = ", ".join(f"{int(h)}:{mm}" if int(h) > 9 else f"0{int(h)}:{mm}" for h, mm in TIME_RE.findall(rest))
        title = " / ".join(x.strip() for x in cells[1].splitlines() if x.strip())
        hall = ""
        h = HALL_RE.search(title)
        if h:
            hall = h.group(1).strip()
            title = " ".join((title[:h.start()] + title[h.end():]).split()).strip(" /")
        staffed = [(header[i], p) for i in range(2, len(header)) for p in split_people(cells[i])]
        if not title and not staffed:
            continue  # пустой день
        for day in dates:
            if not staffed:
                out.append(Row(day.isoformat(), time, title, hall, "", ""))
            for role, person in staffed:
                out.append(Row(day.isoformat(), time, title or "Смена", hall, role, person))
    return out


def parse_rows(table: list, today: date) -> list:
    """Определяет вид листа сам: плоский (в 4-й колонке заголовка «Зал») или сетка театра."""
    if not table:
        return []
    head = [str(c).strip().lower() for c in table[0]]
    if len(head) > 3 and head[3].startswith("зал"):
        return parse_flat(table, today)
    return parse_grid(table, today)
