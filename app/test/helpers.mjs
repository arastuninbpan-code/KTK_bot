import "../lib/platform-node.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";
import {Store, TABS} from "../lib/store.mjs";

export const msk = (day, hour = 10, min = 0) => Date.UTC(2026, 9, day, hour - 3, min); // октябрь 2026, время по Москве
export const HEAD = ["Дата/\nВремя", "Спектакль/\nСцена", "Администратор/\nКапельдинер", "Гардероб/\nУборщица", "Касса", "Монтировка", "Актеры, свет,\nзвук"];
export const STAFF = [["ФИО", "Телефон", "Роль"],
  ["Иванова М.В.", "+7 900 000-00-01", "Админ"], ["Петрова Л.Н.", "8 900 000 00 02", "Читатель"], ["Сидорова Л.Р.", "9000000003", ""],
  ["Морозова Н.М.", "9000000004", "Редактор"], ["Орлова А.В.", "9000000005", "Заблокирован"]];
export const SCHEDULE = [
  HEAD,
  ["01.10", "Спектакль «Игра» репетиция\n(большая сцена)", "Иванова М.В./ Петрова Л.Н.", "Сидорова Л.Р.", "", "", ""],
  ["04.10\n11.00 и 13.00", "Спектакль «Бука»\n(малая сцена)", "Иванова М.В.", "Морозова Н.М.", "", "", ""],
  ["05.10", "", "", "", "", "", ""],
  ["10.10", "Сказки из старого чемодана", "Петрова Л.Н.", "", "", "", ""],
];

export function setup(now = msk(1, 10)) {
  const book = new MemoryBook({[TABS.schedule]: SCHEDULE, [TABS.staff]: STAFF});
  const store = new Store(book, {secret: "test-secret", now: () => now});
  return {book, store};
}

export function fakeChannel(name = "telegram") {
  const sent = [];
  return {name, sent, send: (chatId, text, options) => { sent.push({chatId: String(chatId), text, options}); }};
}
export const lastTo = (ch, chatId) => ch.sent.filter((s) => s.chatId === String(chatId)).pop();
