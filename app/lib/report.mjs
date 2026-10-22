// Отчёты за период: по площадке, по сотруднику, по отделу (должности). Чистые функции: события -> таблица.
import {addDays, daysOf, norm, parseDate, splitPeople} from "./core.mjs";

export const REPORT_KINDS = {venue: "Площадка", person: "Сотрудник", role: "Отдел"};
export const REPORT_WIDTH = 7; // все отчёты в листе одной ширины
export const REPORT_CAP = 30; // и одной высоты: строк под данные в блоке
export const REPORT_HEAD = 4; // строк шапки блока: заголовок, период, итоги, названия колонок
export const REPORT_GAP = 2; // пустых строк между отчётами
export const REPORT_HEIGHT = REPORT_HEAD + REPORT_CAP + 1 + 1 + REPORT_GAP; // + строка «ИТОГО» и строка-примечание

const ddmmyyyy = (iso) => iso.slice(8, 10) + "." + iso.slice(5, 7) + "." + iso.slice(0, 4);
const clockMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const hoursText = (min) => (min == null ? "" : String(Math.round(min / 6) / 10).replace(".", ","));
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 15 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };

/** Длительность одного дня события в минутах: известна, только если указано одно время начала и конец. */
function minutesOf(e) {
  if (e.dateEnd) return null;
  const starts = String(e.time || "").split(/,\s*/).filter(Boolean);
  const s = clockMin(starts[0]), f = clockMin(e.end);
  return starts.length === 1 && s !== null && f !== null && f > s ? f - s : null;
}

/** События -> по одной записи на каждый день внутри периода. */
function occurrences(events, from, to, isMeeting) {
  const out = [];
  for (const e of events) {
    for (const d of daysOf(e)) {
      if (d < from || d > to) continue;
      out.push({date: d, time: e.time || "", end: e.end || "", title: e.title, hall: e.hall || "", roles: e.roles || {}, meeting: Boolean(isMeeting(e)), min: minutesOf(e)});
    }
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time) || a.title.localeCompare(b.title));
}

const span = (o) => (o.time ? o.time + (o.end ? "–" + o.end : "") : "весь день");
const sumMin = (list) => list.reduce((s, o) => s + (o.min || 0), 0);
const unknownMin = (list) => list.filter((o) => o.min == null).length;

/** Строка «По отделу / по всем сотрудникам»: одна строка на человека. */
function peopleRows(occ, roleFilter, personFilter) {
  const by = new Map();
  for (const o of occ) {
    for (const [role, names] of Object.entries(o.roles)) {
      if (roleFilter && norm(role) !== norm(roleFilter)) continue;
      for (const n of names) {
        if (personFilter && norm(n) !== norm(personFilter)) continue;
        const p = by.get(n) || {name: n, shifts: [], roles: new Set()};
        p.shifts.push(o); p.roles.add(role);
        by.set(n, p);
      }
    }
  }
  return [...by.values()].sort((a, b) => b.shifts.length - a.shifts.length || a.name.localeCompare(b.name, "ru"));
}

/**
 * Отчёт. kind: venue | person | role; value — что именно (пусто = все).
 * Возвращает {kind, kindLabel, value, from, to, columns, rows, summary: [[подпись, значение]], total: [..], note}.
 */
export function buildReport(events, {from, to, kind, value = "", isMeeting = () => false}) {
  if (!REPORT_KINDS[kind]) throw new Error("Неизвестный вид отчёта");
  const occ = occurrences(events, from, to, isMeeting);
  const v = String(value || "").trim();
  let columns, rows, summary, total;
  if (kind === "venue") {
    const list = v ? occ.filter((o) => norm(o.hall) === norm(v)) : occ.filter((o) => o.hall);
    columns = ["Дата", "Время", "Площадка", "Событие", "Тип", "Часы", "Состав"];
    rows = list.map((o) => [ddmmyyyy(o.date), span(o), o.hall, o.title, o.meeting ? "Собрание" : "Событие", hoursText(o.min), Object.entries(o.roles).map(([r, n]) => r + ": " + n.join(", ")).join("; ")]);
    const days = new Set(list.map((o) => o.date)).size;
    summary = [["Событий", list.filter((o) => !o.meeting).length], ["Собраний", list.filter((o) => o.meeting).length], ["Часов", hoursText(sumMin(list)) || "0"], ["Дней с событиями", days]];
    total = ["ИТОГО", "", "", list.length + " " + plural(list.length, "запись", "записи", "записей"), "", hoursText(sumMin(list)) || "0", ""];
    var noTime = unknownMin(list);
  } else if (kind === "person" && v) {
    const p = peopleRows(occ, "", v)[0];
    const list = p ? p.shifts : [];
    columns = ["Дата", "Время", "Площадка", "Событие", "Должность", "Часы", "Тип"];
    rows = list.map((o) => [ddmmyyyy(o.date), span(o), o.hall, o.title, Object.entries(o.roles).filter(([, n]) => n.some((x) => norm(x) === norm(v))).map(([r]) => r).join(", "), hoursText(o.min), o.meeting ? "Собрание" : "Событие"]);
    const halls = new Set(list.map((o) => o.hall).filter(Boolean));
    summary = [["Смен", list.length], ["Часов", hoursText(sumMin(list)) || "0"], ["Площадок", halls.size], ["Собраний", list.filter((o) => o.meeting).length]];
    total = ["ИТОГО", "", "", list.length + " " + plural(list.length, "смена", "смены", "смен"), "", hoursText(sumMin(list)) || "0", ""];
    var noTime = unknownMin(list);
  } else {
    const people = peopleRows(occ, kind === "role" ? v : "", "");
    columns = ["Сотрудник", "Смен", "Часов", "Собраний", "Площадки", "Первая смена", "Последняя смена"];
    rows = people.map((p) => {
      const dates = p.shifts.map((o) => o.date).sort();
      const halls = [...new Set(p.shifts.map((o) => o.hall).filter(Boolean))];
      return [p.name, p.shifts.length, hoursText(sumMin(p.shifts)) || "0", p.shifts.filter((o) => o.meeting).length, halls.join(", "), ddmmyyyy(dates[0]), ddmmyyyy(dates[dates.length - 1])];
    });
    const all = people.flatMap((p) => p.shifts);
    summary = [["Сотрудников", people.length], ["Смен", all.length], ["Часов", hoursText(sumMin(all)) || "0"], ["Собраний", all.filter((o) => o.meeting).length]];
    total = ["ИТОГО", all.length, hoursText(sumMin(all)) || "0", all.filter((o) => o.meeting).length, "", "", ""];
    var noTime = unknownMin(all);
  }
  const notes = [];
  if (noTime) notes.push(`у ${noTime} ${plural(noTime, "записи", "записей", "записей")} не указано время начала и конца — их часы не учтены`);
  return {kind, kindLabel: REPORT_KINDS[kind], value: v, from, to, columns, rows: rows.map((r) => r.map(String)), summary: summary.map(([a, b]) => [a, String(b)]), total: total.map(String), note: notes.join("; ")};
}

export const reportTitle = (r) => `${r.kindLabel}: ${r.value || (r.kind === "venue" ? "все площадки" : r.kind === "role" ? "все отделы" : "все сотрудники")}`;
export const periodText = (r) => `${ddmmyyyy(r.from)} – ${ddmmyyyy(r.to)}`;

/** Валидация параметров запроса. */
export function checkParams(p) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!REPORT_KINDS[p.kind]) return "Выберите, по чему готовить отчёт";
  if (!iso.test(p.from || "") || !iso.test(p.to || "")) return "Укажите даты начала и конца периода";
  if (p.to < p.from) return "Конец периода раньше начала";
  if (p.to > addDays(p.from, 4100)) return "Период не больше 10 лет";
  return "";
}

/**
 * Блок отчёта для листа: ровно REPORT_HEIGHT строк по REPORT_WIDTH ячеек. Одинаковая высота у всех отчётов:
 * лишних строк нет, недостающие пусты; если данных больше REPORT_CAP, остальное — в примечании (итоги считаются по всем).
 */
export function reportBlock(r, number, meta) {
  const pad = (a) => [...a.map(String), ...Array(REPORT_WIDTH).fill("")].slice(0, REPORT_WIDTH);
  const rows = [];
  rows.push(pad([`ОТЧЁТ № ${number} · ${reportTitle(r)}`, "", "", "", "", "", ""]));
  rows.push(pad([`Период: ${periodText(r)} · сформирован ${meta.when}${meta.by ? " · " + meta.by : ""}`]));
  rows.push(pad([r.summary.map(([a, b]) => `${a}: ${b}`).join("   ·   ")]));
  rows.push(pad(r.columns));
  const shown = r.rows.slice(0, REPORT_CAP);
  for (let i = 0; i < REPORT_CAP; i++) rows.push(pad(shown[i] || []));
  rows.push(pad(r.total));
  const more = r.rows.length - shown.length;
  rows.push(pad([[more > 0 ? `Показаны первые ${REPORT_CAP} из ${r.rows.length} строк — полный список можно скачать в приложении (итоги выше посчитаны по всем).` : "", r.note ? "Внимание: " + r.note : ""].filter(Boolean).join(" ")]));
  for (let i = 0; i < REPORT_GAP; i++) rows.push(pad([]));
  return {rows, shown: shown.length};
}

/** Файл для скачивания (CSV с разделителем «;» — так его правильно открывает русский Excel). */
export function reportCsv(r) {
  const q = (s) => /[;"\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s);
  return "﻿" + [[reportTitle(r)], [`Период: ${periodText(r)}`], [], r.columns, ...r.rows, r.total].map((row) => row.map(q).join(";")).join("\r\n");
}

// ===== долгое хранение: события старше года уходят в лист «Архив» (и никогда не удаляются), отчёты читают и его =====
export const ARCHIVE_HEADER = ["Дата", "Начало", "Конец", "Событие", "Площадка", "Тип", "Состав", "ID"];
export const DELETED_HEADER = ["Удалено (МСК)", "Кто", ...ARCHIVE_HEADER];
export const rolesText = (roles) => Object.entries(roles || {}).map(([r, names]) => r + ": " + names.join(", ")).join("; ");

/** Событие -> строка архива в понятном человеку виде. */
export function archiveLine(e, meeting = false) {
  return [ddmmyyyy(e.date) + (e.dateEnd ? " до " + ddmmyyyy(e.dateEnd) : ""), e.time || "", e.end || "", e.title || "", e.hall || "", meeting ? "Собрание" : "Событие", rolesText(e.roles), e.id || ""].map(String);
}

/** Строки архива (без шапки) -> события в том же виде, что даёт parseEvents. */
export function parseArchive(rows, today) {
  const out = [];
  rows.forEach((r, i) => {
    const m = /^\s*(\d{1,2}\.\d{2}\.\d{4})(?:\s+до\s+(\d{1,2}\.\d{2}\.\d{4}))?/.exec(String(r[0] || ""));
    const date = m ? parseDate(m[1], today) : null;
    if (!date) return;
    const roles = {};
    for (const part of String(r[6] || "").split(/;\s*/).filter(Boolean)) {
      const at = part.indexOf(": ");
      if (at < 1) continue;
      const people = splitPeople(part.slice(at + 2));
      if (people.length) roles[part.slice(0, at)] = people;
    }
    out.push({row: i + 2, id: String(r[7] || ""), date, dateEnd: (m[2] && parseDate(m[2], today)) || "", time: String(r[1] || ""), end: String(r[2] || ""), title: String(r[3] || ""), hall: String(r[4] || ""), roles, staffed: Object.keys(roles).length > 0, meeting: String(r[5] || "") === "Собрание", archived: true});
  });
  return out;
}

/** Первое число месяца, который был `months` месяцев назад: всё, что закончилось раньше, пора уносить в архив. */
export const archiveCutoff = (today, months = 12) => new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - months, 1)).toISOString().slice(0, 10);
