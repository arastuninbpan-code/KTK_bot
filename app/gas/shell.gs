
// =====================================================================================
// Оболочка Google Apps Script: доступ к таблице, Telegram, точки входа, таймеры, оформление таблицы.
// Всё, что выше, — общий код из app/lib (собирается автоматически, руками не править).
// =====================================================================================

// ---------- платформа ----------
const toB64url_ = (bytes) => Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, "");
Object.assign(platform, {
  sha256hex: (s) => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map((b) => ((b + 256) % 256).toString(16).padStart(2, "0")).join(""),
  hmacB64url: (data, secret) => toB64url_(Utilities.computeHmacSha256Signature(data, secret)),
  b64urlEncode: (s) => toB64url_(Utilities.newBlob(s).getBytes()),
  b64urlDecode: (s) => Utilities.newBlob(Utilities.base64DecodeWebSafe(s + "===".slice((s.length + 3) % 4))).getDataAsString(),
  randomInt: (max) => parseInt(Utilities.getUuid().replace(/-/g, "").slice(0, 8), 16) % max,
  sleep: (ms) => Utilities.sleep(ms),
});

// ---------- свойства ----------
function prop_(k) {
  return PropertiesService.getScriptProperties().getProperty(k);
}

function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty("SESSION_SECRET");
  if (!s) { s = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, ""); p.setProperty("SESSION_SECRET", s); }
  return s;
}

// ---------- книга: тот же интерфейс, что у MemoryBook в тестах ----------
class GasBook {
  constructor() { this.ss = SpreadsheetApp.openById(prop_("SHEET_ID")); this.memo = {}; } // memo: лист читаем один раз за запрос (это самое медленное место)
  sheet(tab) {
    const s = this.ss.getSheetByName(tab);
    if (!s) throw new Error("Нет листа «" + tab + "»");
    return s;
  }
  ensure(tab, header) {
    this.memo = {};
    if (this.ss.getSheetByName(tab)) return;
    const s = this.ss.insertSheet(tab);
    if (header) s.getRange(1, 1, 1, header.length).setNumberFormat("@").setValues([header.map(String)]);
  }
  has(tab) { return this.ss.getSheetByName(tab) !== null; }
  /** Одна ячейка текстом (остальные в строке, например галочки групп, не трогаем). */
  setCell(tab, row, col, value) {
    this.memo = {};
    this.sheet(tab).getRange(row, col).setNumberFormat("@").setValue(String(value));
  }
  get(tab) {
    if (this.memo[tab]) return this.memo[tab];
    const s = this.sheet(tab);
    const rows = s.getLastRow() === 0 ? [] : s.getRange(1, 1, s.getLastRow(), Math.max(1, s.getLastColumn())).getDisplayValues();
    return (this.memo[tab] = rows);
  }
  set(tab, row, values) {
    this.memo = {};
    const s = this.sheet(tab);
    const width = Math.max(values.length, s.getLastColumn());
    const padded = values.map(String);
    while (padded.length < width) padded.push("");
    s.getRange(row, 1, 1, width).setNumberFormat("@").setValues([padded]); // текстом: «04.10» не превращается в дату
  }
  append(tab, values) { this.set(tab, this.sheet(tab).getLastRow() + 1, values); }
  insert(tab, beforeRow) {
    this.memo = {};
    const s = this.sheet(tab);
    if (beforeRow > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), 1);
    else s.insertRowBefore(beforeRow);
  }
  remove(tab, row) { this.memo = {}; this.sheet(tab).deleteRow(row); }
  clearRow(tab, row) { this.memo = {}; const s = this.sheet(tab); s.getRange(row, 1, 1, s.getMaxColumns()).clearContent(); }
  replaceColumnA(tab, values) {
    this.memo = {};
    const s = this.sheet(tab);
    s.clear();
    if (values.length) s.getRange(1, 1, values.length, 1).setNumberFormat("@").setValues(values.map((v) => [String(v)]));
  }
}

const store_ = () => new Store(new GasBook(), {secret: secret_()});

// ---------- Telegram ----------
function tgSend_(chatId, text, options) {
  const pieces = chunkText(text);
  pieces.forEach((piece, i) => {
    const body = {chat_id: chatId, text: piece, parse_mode: "HTML", link_preview_options: {is_disabled: true}};
    if (i === pieces.length - 1) {
      if (options === "contact") body.reply_markup = {keyboard: [[{text: "📱 Поделиться номером", request_contact: true}]], resize_keyboard: true, one_time_keyboard: true};
      else if (options === "remove") body.reply_markup = {remove_keyboard: true};
      else if (options && (options.button || options.copy)) {
        const rows = [];
        if (options.copy) rows.push([{text: options.copy.text, copy_text: {text: options.copy.value}}]); // кнопка «скопировать» одним нажатием
        if (options.button) rows.push([{text: options.button.text, url: options.button.url}]);
        body.reply_markup = {inline_keyboard: rows};
      }
    }
    const r = UrlFetchApp.fetch("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/sendMessage",
      {method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true});
    const code = r.getResponseCode();
    if (code === 403) throw new Gone(); // бот заблокирован пользователем
    if (code >= 400) throw new Error("Telegram HTTP " + code + ": " + r.getContentText().slice(0, 200)); // без адреса: в нём токен
  });
}

// ---------- ВКонтакте ----------
const VK_V = "5.199";

function vkCall_(method, params) {
  const payload = Object.assign({access_token: prop_("VK_TOKEN"), v: VK_V}, params);
  Object.keys(payload).forEach((k) => { payload[k] = String(payload[k]); }); // всё строками: числа с плавающей точкой ВК отклоняет (random_id not int64)
  const r = UrlFetchApp.fetch("https://api.vk.com/method/" + method, {method: "post", payload, muteHttpExceptions: true});
  let data = {};
  try { data = JSON.parse(r.getContentText()); } catch (e) { throw new Error("VK: непонятный ответ (HTTP " + r.getResponseCode() + ")"); }
  if (data.error) {
    if (VK_CANT_WRITE.indexOf(data.error.error_code) >= 0) throw new Gone(); // человек запретил сообщения от сообщества
    throw new Error("VK " + data.error.error_code + ": " + String(data.error.error_msg).slice(0, 160)); // без токена в тексте
  }
  return data.response;
}

function vkSend_(peerId, text, options) {
  const pieces = chunkText(htmlToPlain(text));
  pieces.forEach((piece, i) => {
    const params = {user_id: peerId, random_id: Math.floor(Date.now() * 1000 + Math.random() * 1000), message: piece, dont_parse_links: 1};
    if (i === pieces.length - 1) { const kb = vkKeyboard(options); if (kb) params.keyboard = kb; }
    vkCall_("messages.send", params);
  });
}

/** Пост на стену группы от имени сообщества. */
function vkWallPost_(text) {
  vkCall_("wall.post", {owner_id: "-" + String(prop_("VK_GROUP_ID")).replace(/\D/g, ""), from_group: 1, message: text});
}

const SENDERS = {telegram: {name: "telegram", send: tgSend_}, vk: {name: "vk", send: vkSend_}};

/** Куда умеем публиковать афишу: стена группы ВК и/или Telegram-канал (если заданы свойства скрипта). */
function publishers_() {
  const vk = Boolean(prop_("VK_TOKEN") && prop_("VK_GROUP_ID")), tgc = prop_("TG_CHANNEL");
  return {
    targets: () => [vk ? "ВКонтакте" : "", tgc ? "Telegram-канал" : ""].filter(Boolean),
    post: (text) => {
      const lines = [];
      if (vk) { try { vkWallPost_(text); lines.push("✅ ВКонтакте: опубликовано"); } catch (e) { lines.push("⚠️ ВКонтакте: " + String(e.message || e).slice(0, 200)); } }
      if (tgc) { try { tgSend_(tgc, esc(text)); lines.push("✅ Telegram-канал: опубликовано"); } catch (e) { lines.push("⚠️ Telegram-канал: " + (e instanceof Gone ? "бот не добавлен в канал администратором" : String(e.message || e).slice(0, 200))); } }
      return lines;
    },
  };
}

// ---------- цикл: сверка с таблицей, уведомления, напоминания ----------
const runCycle_ = () => runCycle({store: store_(), senders: SENDERS, now: Date.now(), appUrl: prop_("APP_URL") || "", log: console});

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// «Версия данных»: приложение раз в несколько секунд спрашивает, не изменилось ли что-то (дёшево: таблицу при этом не читаем)
const getRev_ = () => prop_("DATA_REV") || "0";
const bumpRev_ = () => PropertiesService.getScriptProperties().setProperty("DATA_REV", String(Date.now()));
const SYNC_DELAY_MS = 5000; // сколько ждём тишины после правки таблицы, чтобы не рассылать недописанное

/** Таймер раз в минуту: страховка (если быстрая сверка не сработала) и проверка напоминаний раз в ~5 минут. */
function everyMinute() {
  const p = PropertiesService.getScriptProperties();
  const now = Date.now();
  const dirty = Number(p.getProperty("dirty") || 0);
  const last = Number(p.getProperty("last_cycle") || 0);
  const dueDirty = dirty && now - dirty >= 15000;
  if (!dueDirty && now - last < 4 * 60e3 + 30e3) return;
  withLock_(() => {
    if (dueDirty) p.deleteProperty("dirty");
    p.setProperty("last_cycle", String(now));
    runCycle_();
  });
}

/**
 * Срабатывает при любой правке таблицы руками. Отмечает «версия данных изменилась» (приложение подхватит за секунды),
 * ждёт ~5 секунд тишины и сразу рассылает уведомления, не дожидаясь минутного таймера.
 */
function onSheetChange() {
  const p = PropertiesService.getScriptProperties();
  const mark = String(Date.now());
  p.setProperty("dirty", mark);
  bumpRev_();
  Utilities.sleep(SYNC_DELAY_MS);
  if (p.getProperty("dirty") !== mark) return; // позже была ещё правка — сверку сделает она
  withLock_(() => {
    p.deleteProperty("dirty");
    p.setProperty("last_cycle", String(Date.now()));
    runCycle_();
  });
}

// ---------- точки входа ----------
const json_ = (obj) => ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
const ok_ = () => ContentService.createTextOutput("ok");

function doGet() {
  return ok_();
}

/** Сюда приходят: (1) сообщения Telegram (через посредника, с ?secret=), (2) запросы приложения (JSON с полем path). */
function doPost(e) {
  try {
    if (e && e.parameter && e.parameter.secret) return e.parameter.vk ? vkUpdate_(e) : telegramUpdate_(e);
    const req = JSON.parse(e.postData.contents);
    if (!req || typeof req.path !== "string" || req.path.indexOf("/api/") !== 0) return json_({error: "Не найдено"});
    return json_(apiCall_(req));
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    return json_({error: "Что-то пошло не так. Попробуйте ещё раз."});
  }
}

function apiCall_(req) {
  const call = () => handleApi({method: req.method || "GET", path: req.path, token: req.token, body: req.body || {}}, {
    store: store_(),
    secret: secret_(),
    getRev: getRev_,
    bumpRev: bumpRev_,
    // после правки сразу рассылаем уведомления (не ждём таймера); ошибки рассылки не ломают сохранение
    afterChange: () => { try { runCycle_(); } catch (err) { console.error(String(err && err.message ? err.message : err)); } },
  });
  const r = req.method && req.method !== "GET" ? withLock_(call) : call();
  return Object.assign({}, r.body, {_status: r.status});
}

function telegramUpdate_(e) {
  if (e.parameter.secret !== prop_("WEBHOOK_SECRET")) return ok_();
  const update = JSON.parse(e.postData.contents);
  const cache = CacheService.getScriptCache();
  if (cache.get("u" + update.update_id)) return ok_(); // Telegram может прислать то же сообщение повторно
  cache.put("u" + update.update_id, "1", 21600);
  const ev = telegramEvent(update);
  if (ev) withLock_(() => handleMessage({store: store_(), channel: SENDERS.telegram, ev, appUrl: prop_("APP_URL") || "", now: Date.now(), publishers: publishers_()}));
  return ok_();
}

/** Сообщения ВКонтакте (Callback API через посредника). Подтверждение адреса отдаёт посредник; здесь на случай прямого обращения. */
/** Короткий журнал для диагностики: лист «_лог» в таблице (время | сообщение). Секреты и токены сюда не пишем. */
function diag_(text) {
  try {
    const book = new GasBook();
    book.ensure("_лог", ["Время (МСК)", "Событие"]);
    const sh = book.sheet("_лог");
    if (sh.getLastRow() > 300) sh.deleteRows(2, 150);
    book.append("_лог", [Utilities.formatDate(new Date(), "Europe/Moscow", "dd.MM HH:mm:ss"), String(text).slice(0, 300)]);
  } catch (err) { console.error("не удалось записать журнал: " + (err && err.message)); }
}

function vkUpdate_(e) {
  try {
    if (e.parameter.secret !== prop_("WEBHOOK_SECRET")) { diag_("VK: пропущено — secret в адресе воркера (GAS_URL) не совпал с WEBHOOK_SECRET"); return ok_(); }
    const update = JSON.parse(e.postData.contents);
    if (update.type === "confirmation") return ContentService.createTextOutput(prop_("VK_CONFIRM") || "");
    if (prop_("VK_SECRET") && update.secret !== prop_("VK_SECRET")) { diag_("VK: пропущено — секретный ключ Callback API не совпал с VK_SECRET"); return ok_(); }
    const ev = vkEvent(update);
    if (!ev) { diag_("VK: пропущено — событие «" + update.type + "» не личное сообщение человека"); return ok_(); }
    const cache = CacheService.getScriptCache();
    const dedupe = "v" + (ev.eventId || ev.chatId + ":" + ev.text);
    if (cache.get(dedupe)) { diag_("VK: повтор того же события, пропущено"); return ok_(); } // ВК повторяет событие, если ответ задержался
    cache.put(dedupe, "1", 21600);
    withLock_(() => handleMessage({store: store_(), channel: SENDERS.vk, ev, appUrl: prop_("APP_URL") || "", now: Date.now(), publishers: publishers_()}));
    diag_("VK: сообщение от " + ev.chatId + " обработано, ответ отправлен");
  } catch (err) {
    diag_("VK: ОШИБКА — " + (err && err.message ? err.message : (err && err.constructor && err.constructor.name) || err));
  }
  return ok_();
}

// ---------- установка ----------
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty("WEBHOOK_SECRET")) p.setProperty("WEBHOOK_SECRET", Utilities.getUuid().replace(/-/g, ""));
  secret_();
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t)); // не forEach(deleteTrigger): тот передаёт лишние параметры
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("everyMinute").timeBased().everyMinutes(1).create();
  new GasBook().ensure(TABS.chats, SUBS_HEADER);
  new GasBook().ensure(TABS.venues, VENUES_HEADER);
  console.log("Готово: таймеры созданы. Теперь запустите setWebhook() и styleSheets().");
}

/** Только адрес сайта из ссылки (в Apps Script нет встроенного URL); секретную часть не показываем. */
const hostOf_ = (u) => String(u || "").replace(/^https?:\/\/([^\/?#]+).*$/, "$1");

/**
 * Говорит Telegram, куда присылать сообщения. Если задано RELAY_URL (посредник Cloudflare), сообщения идут через него:
 * Apps Script отвечает на POST перенаправлением (302), Telegram считает это ошибкой и тормозит.
 */
function setWebhook() {
  let target = prop_("RELAY_URL");
  if (!target) {
    const url = prop_("WEBAPP_URL"); // из редактора getUrl() отдаёт тестовый адрес /dev (даёт Telegram ошибку 401)
    if (!url || !/\/exec$/.test(url)) throw new Error("Нужен адрес веб-приложения, оканчивающийся на /exec (свойство WEBAPP_URL) или RELAY_URL.");
    target = url + "?secret=" + encodeURIComponent(prop_("WEBHOOK_SECRET"));
  }
  console.log("Вебхук будет на: " + hostOf_(target));
  const r = UrlFetchApp.fetch("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/setWebhook", {
    method: "post", contentType: "application/json", muteHttpExceptions: true,
    payload: JSON.stringify({url: target, allowed_updates: ["message"]}),
  });
  console.log(r.getContentText());
}

/** Показывает состояние вебхука (ошибки доставки, очередь). */
function webhookInfo() {
  const r = UrlFetchApp.fetch("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/getWebhookInfo", {muteHttpExceptions: true});
  const info = JSON.parse(r.getContentText()).result || {};
  console.log(JSON.stringify({host: hostOf_(info.url), pending: info.pending_update_count, last_error: info.last_error_message}));
}

function deleteWebhook() {
  UrlFetchApp.fetch("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/deleteWebhook", {muteHttpExceptions: true});
}

// ---------- оформление таблицы (запустить один раз: styleSheets) ----------
const C = {navy: "#1B3560", blue: "#0A96DC", light: "#D4F1FC", cream: "#FBF6DC", coral: "#F04E4A", orange: "#F2961E", white: "#FFFFFF"};
const MONTHS_UP = ["ЯНВАРЬ", "ФЕВРАЛЬ", "МАРТ", "АПРЕЛЬ", "МАЙ", "ИЮНЬ", "ИЮЛЬ", "АВГУСТ", "СЕНТЯБРЬ", "ОКТЯБРЬ", "НОЯБРЬ", "ДЕКАБРЬ"];
const MONTH_ROW_RE = /^[А-ЯЁ]+ \d{4}$/;
const ROLE_LIST = ["Админ", "Редактор", "Читатель", "Заблокирован"];

function styleSheets() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  migrateSchedule();
  const book = new GasBook();
  book.ensure(TABS.venues, VENUES_HEADER);
  seedVenues_(book);
  styleSchedule_(ss.getSheetByName(TABS.schedule));
  styleStaff_(ss.getSheetByName(TABS.staff));
  styleVenues_(ss.getSheetByName(TABS.venues));
  const chats = ss.getSheetByName(TABS.chats);
  if (chats) styleHeader_(chats, 4);
  console.log("Таблица оформлена.");
}

/**
 * Старый лист (Дата/Время | Спектакль/Сцена | роли) -> новый (Дата | Начало | Конец | Событие | Площадка | роли).
 * Перед переносом делается копия листа «Расписание (копия …)». Если лист уже новый, ничего не делает.
 */
function migrateSchedule() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  const sheet = ss.getSheetByName(TABS.schedule);
  const table = new GasBook().get(TABS.schedule);
  if (layoutOf(table).v === 2) { console.log("Расписание уже в новом формате."); return; }
  const stamp = Utilities.formatDate(new Date(), "Europe/Moscow", "dd.MM HH:mm");
  sheet.copyTo(ss).setName(TABS.schedule + " (копия " + stamp + ")");
  const next = migrateTable(table, todayIso(Date.now()));
  sheet.getDataRange().breakApart();
  sheet.clear();
  sheet.getRange(1, 1, next.length, next[0].length).setNumberFormat("@").setValues(next);
  console.log("Расписание перенесено в новый формат (строк: " + (next.length - 1) + "). Копия старого листа сохранена.");
}

/** В листе «Площадки» после переноса оказываются все площадки, уже встречающиеся в расписании. */
function seedVenues_(book) {
  if (book.get(TABS.venues).length > 1) return;
  const seen = {};
  parseEvents(book.get(TABS.schedule), todayIso(Date.now())).forEach((e) => {
    const key = norm(e.hall);
    if (e.hall && !seen[key]) { seen[key] = true; book.append(TABS.venues, [e.hall.charAt(0).toUpperCase() + e.hall.slice(1), ""]); }
  });
}

function styleHeader_(sheet, cols) {
  sheet.getRange(1, 1, 1, cols).setBackground(C.blue).setFontColor(C.white).setFontWeight("bold").setHorizontalAlignment("center")
    .setVerticalAlignment("middle").setWrap(true);
  sheet.setRowHeight(1, 44);
  sheet.setFrozenRows(1);
}

/** Шапки месяцев («СЕНТЯБРЬ 2026»), заголовки колонок, чередование строк. */
function styleSchedule_(sheet) {
  const today = todayIso(Date.now());
  // 1) шапки месяцев перед первым событием каждого месяца (снизу вверх, чтобы номера строк не съезжали)
  const values = sheet.getRange(1, 1, sheet.getLastRow(), 1).getDisplayValues();
  const heads = [];
  let prevMonth = "";
  for (let r = 2; r <= values.length; r++) {
    const cell = String(values[r - 1][0]).trim();
    if (MONTH_ROW_RE.test(cell)) { prevMonth = cell; continue; }
    const m = cell.match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/);
    const d = m ? parseDate(m[1], today) : null;
    if (!d) continue;
    const title = MONTHS_UP[+d.slice(5, 7) - 1] + " " + d.slice(0, 4);
    if (title !== prevMonth) { heads.push({row: r, title}); prevMonth = title; }
  }
  heads.reverse().forEach((h) => { sheet.insertRowBefore(h.row); sheet.getRange(h.row, 1).setNumberFormat("@").setValue(h.title); });

  // 2) оформление
  const lastRow = Math.max(2, sheet.getLastRow());
  const cols = Math.max(2, sheet.getLastColumn());
  const all = sheet.getRange(2, 1, lastRow - 1, cols);
  all.setBackground(C.white).setFontColor(C.navy).setWrap(true).setVerticalAlignment("top").setNumberFormat("@")
    .setBorder(true, true, true, true, true, true, "#9CB6D3", SpreadsheetApp.BorderStyle.SOLID);
  styleHeader_(sheet, cols);
  const all2 = sheet.getRange(1, 1, sheet.getLastRow(), 1).getDisplayValues();
  for (let r = 2; r <= all2.length; r++) {
    if (!MONTH_ROW_RE.test(String(all2[r - 1][0]).trim())) continue;
    const row = sheet.getRange(r, 1, 1, cols);
    row.merge().setBackground(C.navy).setFontColor(C.white).setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle").setFontSize(13);
    sheet.setRowHeight(r, 38);
  }
  const lay = layoutOf([sheet.getRange(1, 1, 1, Math.max(2, sheet.getLastColumn())).getDisplayValues()[0]]);
  if (lay.v === 2) {
    [110, 80, 80, 260, 160].forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    for (let c = 6; c <= cols; c++) sheet.setColumnWidth(c, 160);
    sheet.getRange(2, 2, Math.max(sheet.getMaxRows() - 1, 1), 2).setHorizontalAlignment("center");
    // площадка — выпадающий список из листа «Площадки» (можно вписать и новую)
    const venues = sheet.getParent().getSheetByName(TABS.venues);
    if (venues) sheet.getRange(2, 5, Math.max(sheet.getMaxRows() - 1, 1), 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInRange(venues.getRange("A2:A300"), true).setAllowInvalid(true).build());
  } else {
    sheet.setColumnWidth(1, 120);
    sheet.setColumnWidth(2, 260);
    for (let c = 3; c <= cols; c++) sheet.setColumnWidth(c, 160);
  }
  // чередование строк белый / светло-голубой (кроме шапок месяцев) — правилом, чтобы новые строки красились сами
  const range = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), cols);
  const banding = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(ISEVEN(ROW()),$A2<>"",NOT(REGEXMATCH($A2,"^[А-ЯЁ]+ [0-9]{4}$")))')
    .setBackground(C.light).setRanges([range]).build();
  sheet.setConditionalFormatRules([banding]);
}

/** Роли выпадающим списком с цветом: Админ / Редактор / Читатель / Заблокирован. */
function styleStaff_(sheet) {
  const cols = Math.max(4, sheet.getLastColumn());
  if (String(sheet.getRange(1, 3).getValue()).trim() === "") sheet.getRange(1, 3).setValue("Роль");
  if (String(sheet.getRange(1, 4).getValue()).trim() === "") sheet.getRange(1, 4).setValue("Логин");
  styleHeader_(sheet, cols);
  const last = Math.max(sheet.getMaxRows(), 2);
  const rng = sheet.getRange(2, 3, last - 1, 1);
  // старые значения приводим к новым названиям
  const cur = sheet.getRange(2, 3, Math.max(sheet.getLastRow() - 1, 1), 1).getValues();
  const next = cur.map(([v]) => [{"": "Читатель"}[String(v).trim()] || (/директор/i.test(v) ? "Админ" : v)]);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 3, next.length, 1).setNumberFormat("@").setValues(next);
  rng.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLE_LIST, true).setAllowInvalid(false).build());
  const rule = (text, bg, fg) => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text).setBackground(bg).setFontColor(fg).setBold(true).setRanges([rng]).build();
  sheet.setConditionalFormatRules([rule("Админ", C.navy, C.white), rule("Редактор", C.blue, C.white), rule("Читатель", C.light, C.navy), rule("Заблокирован", C.coral, C.white)]);
  sheet.setColumnWidth(1, 240);
  sheet.setColumnWidth(2, 170);
  sheet.setColumnWidth(3, 150);
  sheet.setColumnWidth(4, 150);
  sheet.getRange(2, 4, Math.max(sheet.getMaxRows() - 1, 1), 1).setFontFamily("Roboto Mono").setHorizontalAlignment("center");

  // группы: каждая колонка правее «Логина» с названием в шапке — группа; в ячейках галочки «входит в группу»
  let head = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 4)).getDisplayValues()[0];
  if (head.slice(4).every((x) => !String(x).trim())) { sheet.getRange(1, 5, 1, 3).setNumberFormat("@").setValues([["Актёры", "Техника", "Зал"]]); } // примеры, переименуйте как нужно
  head = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 4)).getDisplayValues()[0];
  const lastRow = Math.max(sheet.getMaxRows(), 2);
  for (let c = 5; c <= head.length; c++) {
    if (!String(head[c - 1]).trim()) continue;
    sheet.getRange(2, c, lastRow - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build()).setHorizontalAlignment("center");
    sheet.setColumnWidth(c, 100);
  }
  styleHeader_(sheet, Math.max(head.length, 4));
}

function styleVenues_(sheet) {
  styleHeader_(sheet, 2);
  sheet.setColumnWidth(1, 260);
  sheet.setColumnWidth(2, 300);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 2).setFontColor(C.navy).setVerticalAlignment("middle");
}
