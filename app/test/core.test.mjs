import test from "node:test";
import assert from "node:assert/strict";
import {buildRow, diffRows, eventsToRows, findReminders, looksLikePhone, matchPhones, normPhone, parseEvents, parseGrid, personKey, phonesIn, planCycle, validateEvent} from "../lib/core.mjs";
import {HEAD, msk, SCHEDULE} from "./helpers.mjs";

const TODAY = "2026-10-01";

test("телефоны в любом формате", () => {
  for (const raw of ["89307029109", "+79307029109", "79307029109", "8 930 702 91 09", "8 (930) 702-91-09", "8-930-702-91-09", "930.702.91.09", "9307029109", "+7 930 702 91 09", "тел. 8 930 702 91 09", "‎+7 930 702 91 09"]) {
    assert.equal(normPhone(raw), "9307029109", raw);
  }
  assert.ok(looksLikePhone("8 (930) 702-91-09") && !looksLikePhone("/start") && !looksLikePhone("тел. 8 930 702 91 09") && !looksLikePhone("12345"));
  assert.deepEqual(phonesIn("8 930 702-91-09, +7 900 000-00-01;\n89001112233"), ["9307029109", "9000000001", "9001112233"]);
});

const EMP = [{name: "Дьячков Н. А", phone: "9307029109"}, {name: "Иванова М.В.", phone: "9000000001"}];

test("людей узнаём при любой записи фамилии и инициалов", () => {
  for (const w of ["Дьячков", "дьячков н.а.", "Дьячков Н. А", "ДЬЯЧКОВ Н.", "Дьячков Никита Александрович"]) assert.deepEqual(matchPhones(w, EMP), ["9307029109"], w);
  for (const w of ["Дьячков М.В.", "Петров", ""]) assert.deepEqual(matchPhones(w, EMP), [], w);
  const twins = [...EMP, {name: "Дьячков М.В.", phone: "9000000009"}];
  assert.deepEqual(matchPhones("Дьячков", twins), []); // однофамильцы: не гадаем
  assert.deepEqual(matchPhones("Дьячков Н.А.", twins), ["9307029109"]);
  assert.deepEqual(personKey("Иванова-Петрова А.Б."), ["иванова-петрова", "аб"]);
});

test("сетка театра: события со строками, залом, временем, диапазоном", () => {
  const ev = parseEvents(SCHEDULE, TODAY);
  assert.deepEqual(ev.map((e) => e.row), [2, 3, 5]); // 05.10 пустой день пропущен
  assert.equal(ev[0].hall, "большая сцена");
  assert.equal(ev[0].title, "Спектакль «Игра» репетиция");
  assert.deepEqual(ev[0].roles["Администратор/ Капельдинер"], ["Иванова М.В.", "Петрова Л.Н."]);
  assert.equal(ev[1].time, "11:00, 13:00");

  const r = parseEvents([HEAD, ["25.10 до 31.10", "Фестиваль", "", "", "", "", ""], ["30.09.2026\n12.00", "", "Дьячков", "", "", "", ""], ["15.10", "Выезд\nСпектакль", "Кузнецова Е.Н. Иванова М.В.", "", "", "", ""]], TODAY);
  assert.equal(r[0].dateEnd, "2026-10-31");
  assert.deepEqual([r[1].title, r[1].time], ["Смена", "12:00"]);
  assert.deepEqual(r[2].roles["Администратор/ Капельдинер"], ["Кузнецова Е.Н.", "Иванова М.В."]);
  assert.equal(eventsToRows([r[0]]).length, 7); // диапазон разворачивается по дням
});

test("запись события обратно в таблицу читается тем же разбором", () => {
  const roles = HEAD.slice(2).map((c) => c.replace(/\s+/g, " ").trim());
  const event = {date: "2026-10-12", dateEnd: "", time: "11:00, 13:00", title: "Спектакль «Бука»", hall: "малая сцена", roles: {[roles[0]]: ["Иванова М.В."], [roles[1]]: ["Морозова Н.М.", "Сидорова Л.Р."]}};
  const cells = buildRow(event, roles, TODAY);
  assert.deepEqual(cells.slice(0, 2), ["12.10\n11.00 и 13.00", "Спектакль «Бука»\n(малая сцена)"]);
  const [back] = parseEvents([HEAD, cells], TODAY);
  assert.deepEqual({date: back.date, time: back.time, title: back.title, hall: back.hall, roles: back.roles}, {date: event.date, time: event.time, title: event.title, hall: event.hall, roles: event.roles});
});

test("проверка события", () => {
  assert.deepEqual(validateEvent({date: "2026-10-12", title: "X", time: "11:00, 13.00"}), []);
  assert.ok(validateEvent({date: "2026-13-40", title: ""}).length === 2);
  assert.ok(validateEvent({date: "2026-10-12", title: "X", time: "утром"}).length === 1);
  assert.ok(validateEvent({date: "2026-10-12", dateEnd: "2026-10-01", title: "X"}).length === 1);
});

test("diff: назначили / сняли / перенесли; прошлое и строки без ФИО молчат", () => {
  const rows = (...r) => parseGrid([HEAD, ...r], TODAY);
  const old = rows(["04.10\n11.00", "Бука (малая сцена)", "Иванова М.В.", "", "", "", ""], ["06.10", "Репетиция", "", "", "", "Петрова Б.Б.", ""]);
  const neu = rows(["04.10\n12.00", "Бука (малая сцена)", "Иванова М.В.", "", "", "", ""], ["07.10", "Репетиция", "", "", "", "Сидорова В.В.", ""]);
  assert.deepEqual(diffRows(old, neu, TODAY).map((c) => c.kind + ":" + c.person).sort(), ["added:Сидорова В.В.", "changed:Иванова М.В.", "removed:Петрова Б.Б."]);
  assert.deepEqual(diffRows(rows(["01.09", "Старое", "Иванова М.В.", "", "", "", ""]), [], TODAY), []);
});

const IV = [{name: "Иванова М.В.", phone: "9000000001"}];
const shift = parseGrid([HEAD, ["04.10\n11.00", "Спектакль «Бука» (малая сцена)", "Иванова М.В.", "", "", "", ""]], TODAY);
const remind = (rows, sent, now) => findReminders(rows, IV, sent, now).items;

test("напоминания за сутки и за час: по одному разу, не после начала, не догоняют поздно добавленную смену", () => {
  const sent = new Set();
  assert.equal(remind(shift, sent, msk(3, 10)).length, 0);
  assert.deepEqual(remind(shift, sent, msk(3, 12)).map((x) => x.kind), ["day"]);
  assert.equal(remind(shift, sent, msk(3, 12, 30)).length, 0);
  assert.equal(remind(shift, sent, msk(4, 9)).length, 0);
  assert.deepEqual(remind(shift, sent, msk(4, 10)).map((x) => x.kind), ["hour"]);
  assert.equal(remind(shift, new Set(), msk(4, 11, 1)).length, 0);
  assert.deepEqual(remind(shift, new Set(), msk(4, 6)).length, 0); // «за сутки» уже не актуально
  const noTime = parseGrid([HEAD, ["07.10", "Репетиция", "Иванова М.В.", "", "", "", ""]], TODAY);
  assert.equal(remind(noTime, new Set(), msk(6, 17)).length, 0);
  assert.equal(remind(noTime, new Set(), msk(6, 18)).length, 1);
});

test("planCycle: первый запуск молчит, дальше уведомления только тому, кого касается", () => {
  const t1 = [HEAD, ["04.10\n11.00", "Бука (малая сцена)", "Иванова М.В.", "", "", "", ""]];
  let plan = planCycle(t1, EMP, {}, msk(1, 10));
  assert.equal(plan.changes.length, 0);
  const t2 = [...t1, ["05.10\n10.00", "Репетиция", "Дьячков", "", "", "", ""]];
  plan = planCycle(t2, EMP, JSON.parse(JSON.stringify(plan.snap)), msk(1, 10));
  assert.deepEqual(plan.changes.map((c) => [c.phone, c.kind]), [["9307029109", "added"]]);
});
