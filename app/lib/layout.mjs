// Колонки таблицы можно двигать и переименовывать: система находит нужные по названиям в шапке.
// columnPlan говорит, в каком порядке читать физические колонки, чтобы остальной код видел привычный («канонический») порядок.
export const RESTORE_MARK = "↺";
export const RESTORE_LABEL = "↺ Вернуть исходный вид";
export const RESTORE_CONFIRM = "✔ Да, вернуть";

// Основные колонки по порядку: [подпись в исходном виде, как узнать в шапке]
const STAFF_MAIN = [["ФИО", /^(фио|сотрудник|имя)/i], ["Телефон", /телефон|номер/i], ["Роль", /^роль/i], ["Логин", /^логин/i]];
const STAFF_EXTRA = [["Доступ", /^доступ$/i], ["Комментарий", /^комментарий$/i]];
const SCHEDULE_MAIN = [["Дата", /^дата/i], ["Начало", /начал/i], ["Конец", /конец|оконч/i], ["Событие", /событие|спектакль|мероприят/i], ["Площадка", /площадк/i]];

/**
 * tab: "staff" | "schedule". head — шапка как в таблице.
 * -> null (план не нужен: старый формат расписания или шапку не узнали) или
 *    {perm, labels, modified, identity}: perm[i] — номер физической колонки для i-й колонки канонического порядка ,
 *    labels — шапка канонического вида, modified — порядок отличается от исходного (нужна красная кнопка),
 *    identity — читать таблицу как есть.
 */
export function columnPlan(tab, head) {
  const h = head.map((x) => String(x || "").trim());
  const isButton = (x) => x.startsWith(RESTORE_MARK);
  if (tab === "schedule" && !(h.some((x) => /начал/i.test(x)) && h.some((x) => /конец|оконч/i.test(x)))) return null; // старый формат
  const main = tab === "staff" ? STAFF_MAIN : SCHEDULE_MAIN;
  const used = new Set();
  const find = (re) => { const i = h.findIndex((x, k) => !used.has(k) && x && !isButton(x) && re.test(x)); if (i >= 0) used.add(i); return i; };
  const perm = main.map(([, re]) => find(re));
  if (perm.some((p) => p < 0)) return null; // шапку не узнали (переименована или колонку удалили): читаем как раньше, по положению
  const labels = main.map(([l]) => l);
  if (tab === "staff") for (const [l, re] of STAFF_EXTRA) { const i = find(re); if (i >= 0) { perm.push(i); labels.push(l); } }
  const fixed = perm.length;
  h.forEach((x, k) => { if (!used.has(k) && !isButton(x)) { perm.push(k); labels.push(x); } });
  while (perm.length > fixed && perm[perm.length - 1] >= 0 && !h[perm[perm.length - 1]]) { perm.pop(); labels.pop(); } // пустые колонки в конце шапки не считаем
  const modified = perm.some((p, i) => p !== i);
  const identity = !modified && !h.some(isButton);
  return {perm, labels, modified, identity};
}

/** Физические строки -> канонический порядок колонок . */
export function virtualize(rows, plan) {
  if (!plan || plan.identity) return rows;
  return rows.map((r, i) => plan.perm.map((p, j) => (i === 0 ? (p >= 0 ? r[p] : plan.labels[j]) : (p >= 0 ? (r[p] ?? "") : ""))));
}

/** Номер физической колонки (с нуля) для колонки канонического порядка; за пределами плана — как есть. */
export const physicalCol = (plan, col) => (!plan || plan.identity ? col : col < plan.perm.length ? plan.perm[col] : col);
