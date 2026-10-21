// Занятость площадок «по месяцам и по времени»: список для листа «Площадки» (и общий порядок месяцев для листа «Расписание»).
import {findConflicts, norm, slotsOf} from "./core.mjs";

export const MONTHS_UP = ["ЯНВАРЬ", "ФЕВРАЛЬ", "МАРТ", "АПРЕЛЬ", "МАЙ", "ИЮНЬ", "ИЮЛЬ", "АВГУСТ", "СЕНТЯБРЬ", "ОКТЯБРЬ", "НОЯБРЬ", "ДЕКАБРЬ"];
export const monthTitleOf = (date) => MONTHS_UP[+date.slice(5, 7) - 1] + " " + date.slice(0, 4);

/**
 * Порядок месяцев: сначала текущий и будущие (по возрастанию), ниже — прошедшие, самый недавний первым.
 * Ранг даты: [0, месяц] для текущих и будущих, [1, -месяц] для прошедших, дальше сама дата.
 */
export function rankOf(date, today) {
  const idx = +date.slice(0, 4) * 12 + +date.slice(5, 7);
  const nowIdx = +today.slice(0, 4) * 12 + +today.slice(5, 7);
  return idx >= nowIdx ? [0, idx, date] : [1, -idx, date];
}
export const cmpRank = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);

const hhmm = (m) => String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const ddmm = (iso) => iso.slice(8, 10) + "." + iso.slice(5, 7);
const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * События с площадкой -> строки для таблицы занятости: шапки месяцев и занятые отрезки времени.
 * [{kind: "month", title, past} | {kind: "slot", date, time, venue, title, clash, past}]
 */
export function occupancyRows(events, today, isMeeting = () => false) {
  const items = [];
  for (const e of events) {
    if (!String(e.hall || "").trim()) continue;
    const clashes = findConflicts(events, e);
    const slots = slotsOf(e);
    const days = e.dateEnd ? ddmm(e.date) + "–" + ddmm(e.dateEnd) : ddmm(e.date);
    const wholeDay = Boolean(e.dateEnd) || !String(e.time || "").trim();
    slots.forEach(([a, b], i) => {
      items.push({
        rank: rankOf(e.date, today), a: wholeDay ? -1 : a, hall: norm(e.hall), date: e.date, i,
        row: {kind: "slot", date: days, time: wholeDay ? "весь день" : hhmm(a) + (e.end && slots.length === 1 ? "–" + hhmm(b) : ""), venue: capital(String(e.hall).trim()),
          title: e.title, meeting: Boolean(isMeeting(e)), clash: clashes.length ? clashes.map((c) => c.title).join(", ") : "", past: e.date < today},
      });
    });
  }
  items.sort((x, y) => cmpRank(x.rank, y.rank) || x.a - y.a || (x.hall < y.hall ? -1 : x.hall > y.hall ? 1 : 0) || x.i - y.i);
  const out = [];
  let title = "";
  for (const it of items) {
    const t = monthTitleOf(it.date);
    if (t !== title) { out.push({kind: "month", title: t, past: it.rank[0] === 1}); title = t; }
    out.push(it.row);
  }
  return out;
}
