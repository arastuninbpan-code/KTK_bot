// Доступ галочкой, заявки незнакомых номеров с комментариями, автоподключение после одобрения, /start <логин>.
import test from "node:test";
import assert from "node:assert/strict";
import "../lib/platform-node.mjs";
import {handleMessage, runCycle} from "../lib/bot.mjs";
import {MemoryBook} from "../lib/memory-book.mjs";
import {Store, TABS} from "../lib/store.mjs";
import {HEAD, msk, SCHEDULE, fakeChannel} from "./helpers.mjs";

const STAFF = [["ФИО", "Телефон", "Роль", "Логин", "Доступ", "Комментарий", "Актёры"],
  ["Иванова М.В.", "9000000001", "Админ", "ADM111", "TRUE", "", ""],
  ["Петрова Л.Н.", "9000000002", "Читатель", "RDR222", "TRUE", "", "TRUE"],
  ["Сидорова Л.Р.", "9000000003", "Читатель", "SID333", "", "", ""]]; // у Сидоровой галочка «Доступ» снята
const NOW = msk(1, 10);
function make(staff = STAFF) {
  const book = new MemoryBook({[TABS.staff]: staff, [TABS.schedule]: SCHEDULE});
  const store = new Store(book, {secret: "t", now: () => NOW});
  const ch = fakeChannel("telegram");
  const say = (chat, text, extra = {}) => handleMessage({store, channel: ch, ev: {chatId: chat, text, phone: null, ...extra}, now: NOW});
  const last = (chat) => ch.sent.filter((s) => s.chatId === String(chat)).at(-1);
  return {book, store, ch, say, last};
}

test("колонка «Доступ»: снятая галочка = нет доступа; колонки «Доступ» и «Комментарий» не считаются группами", () => {
  const {store, say, last} = make();
  const u = store.users();
  assert.deepEqual(u.map((x) => [x.name, x.role]), [["Иванова М.В.", "admin"], ["Петрова Л.Н.", "reader"], ["Сидорова Л.Р.", "blocked"]]);
  assert.deepEqual(store.groups(), [{name: "Актёры", members: ["Петрова Л.Н."]}]);
  say(7, "", {phone: "9000000003"});
  assert.match(last(7).text, /Доступ закрыт/);
  say(8, "", {phone: "9000000002"});
  assert.match(last(8).text, /Готово, Петрова/);
});

test("без колонки «Доступ» (старая таблица) доступ есть у всех, кроме роли «Заблокирован»", () => {
  const {store} = make([["ФИО", "Телефон", "Роль"], ["Иванова М.В.", "9000000001", "Админ"], ["Орлова А.В.", "9000000005", "Заблокирован"]]);
  assert.deepEqual(store.users().map((x) => x.role), ["admin", "blocked"]);
});

test("незнакомый номер: доступа нет, но в «Сотрудниках» появляется строка-заявка с комментарием; дальше слова человека дописываются", () => {
  const {book, store, say, last} = make();
  say(50, "89001112233", {label: "Telegram Иван Новиков @inovikov", name: "Иван Новиков"});
  assert.match(last(50).text, /Заявка передана администратору/);
  let row = book.get(TABS.staff).at(-1);
  assert.equal(row[0], "Иван Новиков", "в ФИО сразу имя человека из мессенджера");
  assert.equal(row[2], "Заявка");
  assert.equal(row[1], "9001112233");
  assert.match(row[5], /^\[01\.10 10:00\] Telegram Иван Новиков @inovikov: запросил доступ$/);
  assert.equal(store.chats().length, 0, "чат не подключён");
  // человек пишет, кто он: попадает в комментарий
  say(50, "Я новый гардеробщик, Иван Новиков", {label: "Telegram Иван Новиков @inovikov"});
  assert.match(last(50).text, /Передал администратору/);
  row = book.get(TABS.staff).at(-1);
  assert.match(row[5], /запросил доступ\n\[01\.10 10:00\] Telegram Иван Новиков @inovikov: Я новый гардеробщик, Иван Новиков$/);
  assert.equal(book.get(TABS.staff).length, STAFF.length + 1, "вторая строка не создаётся");
  // другой номер от того же чата не плодит строки, а попадает в комментарий
  say(50, "89005556677");
  assert.equal(book.get(TABS.staff).length, STAFF.length + 1);
  assert.match(book.get(TABS.staff).at(-1)[5], /пишет другой номер 9005556677/);
  // доступа к командам у него по-прежнему нет
  say(50, "/shifts");
  assert.match(last(50).text, /Заявка передана/);
  assert.equal(store.users().find((u) => u.phone === "9001112233").role, "blocked");
});

test("администратор открыл доступ (поставил галочку и вписал ФИО): минутный проход сам подключает чат и пишет «Доступ открыт»", () => {
  const {book, store, ch, say} = make();
  say(50, "89001112233", {label: "Telegram Иван"});
  const rows = book.get(TABS.staff);
  const i = rows.length; // номер строки (1-based) последней = rows.length
  book.setCell(TABS.staff, i, 1, "Новиков И.А.");
  book.setCell(TABS.staff, i, 5, "TRUE");
  runCycle({store, senders: {telegram: ch}, now: NOW});
  const hello = ch.sent.filter((s) => s.chatId === "50").at(-1);
  assert.match(hello.text, /Доступ открыт, Новиков И\.А\./);
  assert.deepEqual(store.chats().map((c) => [c.chatId, c.phone]), [["50", "9001112233"]]);
  assert.equal(store.requests().length, 0, "заявка закрыта");
  say(50, "/shifts");
  assert.match(ch.sent.filter((s) => s.chatId === "50").at(-1).text, /смен/);
});

test("повторная заявка с номером, который уже есть как заявка, не дублирует строку; без одобрения доступа нет", () => {
  const {book, say, last} = make();
  say(50, "89001112233");
  const n = book.get(TABS.staff).length;
  say(51, "89001112233", {label: "ВК https://vk.com/id51"}); // другой человек/мессенджер с тем же номером
  assert.equal(book.get(TABS.staff).length, n);
  assert.match(last(51).text, /Заявка передана/);
  assert.match(book.get(TABS.staff).at(-1)[5] || "", /запросил доступ/);
});

test("/start ЛОГИН (кнопка «Подключить Telegram» в приложении) и текстовый логин подключают сразу", () => {
  const {store, say, last} = make();
  say(60, "/start rdr222");
  assert.match(last(60).text, /Готово, Петрова/);
  assert.equal(store.chats().length, 1);
  say(61, "", {start: "ADM111"}); // ВК: логин из ссылки vk.me/club…?ref=ADM111
  assert.match(last(61).text, /Готово, Иванова/);
  say(62, "/start SID333"); // у Сидоровой снята галочка
  assert.match(last(62).text, /Доступ закрыт/);
});

test("«Доступ открыт» приходит каждый раз, когда доступ дают заново; при первом запуске и в обычных циклах — тишина", () => {
  const {book, store, ch, say} = make();
  say(7, "", {phone: "9000000002"}); // Петрова подключена
  const granted = () => ch.sent.filter((s) => s.chatId === "7" && /Доступ открыт/.test(s.text)).length;
  runCycle({store, senders: {telegram: ch}, now: NOW}); // первый проход: запоминаем, не рассылаем
  runCycle({store, senders: {telegram: ch}, now: NOW});
  assert.equal(granted(), 0);
  const row = book.get(TABS.staff).findIndex((r) => r[0] === "Петрова Л.Н.") + 1;
  const col = store.staffCols_(book.get(TABS.staff)).access + 1;
  for (let n = 1; n <= 3; n++) {
    book.setCell(TABS.staff, row, col, "FALSE"); // сняли доступ
    runCycle({store, senders: {telegram: ch}, now: NOW});
    book.setCell(TABS.staff, row, col, "TRUE"); // открыли снова
    runCycle({store, senders: {telegram: ch}, now: NOW});
    runCycle({store, senders: {telegram: ch}, now: NOW}); // лишний проход не дублирует
    assert.equal(granted(), n, `открытие №${n}`);
  }
});

test("подключённый чат не «угоняется» чужим номером: заявка не заводится, а старый мусор-«заявка» в подписчиках чистится", () => {
  const {book, store, ch, say, last} = make();
  say(7, "", {phone: "9000000002"}); // чат 7 подключён к Петровой
  say(7, "89009998877"); // тот же чат шлёт номер, которого нет в таблице
  assert.match(last(7).text, /уже подключён: Петрова Л\.Н\./);
  assert.equal(store.requests().length, 0, "заявки нет");
  assert.equal(book.get(TABS.staff).length, STAFF.length, "строк в «Сотрудниках» не прибавилось");
  assert.deepEqual(store.chats().map((c) => [c.chatId, c.phone]), [["7", "9000000002"]]);
  // хвост от старых заявок: чат привязан к строке «ЗАЯВКА» — при проходе отвязывается
  store.bind("vk", "55", "9209120551", "ЗАЯВКА");
  runCycle({store, senders: {telegram: ch}, now: NOW});
  assert.ok(!store.chats().some((c) => c.chatId === "55"));
  // заявка чата, который уже у другого сотрудника, при одобрении ничего не перепривязывает
  store.addRequest("telegram", "7", "9000000001"); // Иванова «одобрена» (есть в таблице), но чат 7 уже принадлежит Петровой
  runCycle({store, senders: {telegram: ch}, now: NOW});
  assert.deepEqual(store.chats().map((c) => [c.chatId, c.phone]), [["7", "9000000002"]]);
  assert.equal(store.requests().length, 0);
});

test("главное меню: после подключения кнопки вместо списка команд; нажатие кнопки = команда; /start и любое слово — меню; у редактора есть «В группу»", async () => {
  const {MENU_LABELS, menuRows} = await import("../lib/format.mjs");
  const {vkKeyboard} = await import("../lib/vk.mjs");
  const {store, ch, say, last} = make();
  say(7, "", {phone: "9000000002"}); // Петрова (читатель)
  assert.doesNotMatch(last(7).text, /\/shifts|\/schedule|Что я умею/, "длинного списка команд больше нет");
  const rows = menuRows(last(7).options.menu).flat();
  assert.ok(rows.includes(MENU_LABELS.shifts) && rows.includes(MENU_LABELS.schedule) && rows.includes(MENU_LABELS.login) && !rows.includes(MENU_LABELS.post));
  say(7, MENU_LABELS.shifts);
  assert.match(last(7).text, /смен|Ближайших/);
  say(7, MENU_LABELS.schedule);
  assert.match(last(7).text, /./);
  say(7, MENU_LABELS.login);
  assert.match(last(7).text, /логин/i);
  say(7, "/start");
  assert.match(last(7).text, /Главное меню/);
  say(7, "что-то непонятное");
  assert.match(last(7).text, /Главное меню/);
  assert.ok(last(7).options.menu);
  // ВК: клавиатура не «inline», приложение открывается ссылкой
  const kb = JSON.parse(vkKeyboard({menu: {editor: true, appUrl: "https://app.test"}}));
  assert.equal(kb.inline, false);
  assert.equal(kb.one_time, false);
  const flat = kb.buttons.flat();
  assert.ok(flat.some((b) => b.action.type === "open_link" && b.action.link === "https://app.test"));
  assert.ok(flat.some((b) => b.action.type === "text" && b.action.label === MENU_LABELS.post));
  // «Опубликовать» — отдельная кнопка внизу при предпросмотре
  assert.equal(menuRows({editor: true, confirm: true})[0][0], MENU_LABELS.confirmPost);
});
