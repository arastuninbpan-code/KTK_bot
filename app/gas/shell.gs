
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
  constructor() { this.ss = SpreadsheetApp.openById(prop_("SHEET_ID")); }
  sheet(tab) {
    const s = this.ss.getSheetByName(tab);
    if (!s) throw new Error("Нет листа «" + tab + "»");
    return s;
  }
  ensure(tab, header) {
    if (this.ss.getSheetByName(tab)) return;
    const s = this.ss.insertSheet(tab);
    if (header) s.getRange(1, 1, 1, header.length).setNumberFormat("@").setValues([header.map(String)]);
  }
  get(tab) {
    const s = this.sheet(tab);
    if (s.getLastRow() === 0) return [];
    return s.getRange(1, 1, s.getLastRow(), Math.max(1, s.getLastColumn())).getDisplayValues();
  }
  set(tab, row, values) {
    const s = this.sheet(tab);
    const width = Math.max(values.length, s.getLastColumn());
    const padded = values.map(String);
    while (padded.length < width) padded.push("");
    s.getRange(row, 1, 1, width).setNumberFormat("@").setValues([padded]); // текстом: «04.10» не превращается в дату
  }
  append(tab, values) { this.set(tab, this.sheet(tab).getLastRow() + 1, values); }
  insert(tab, beforeRow) {
    const s = this.sheet(tab);
    if (beforeRow > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), 1);
    else s.insertRowBefore(beforeRow);
  }
  remove(tab, row) { this.sheet(tab).deleteRow(row); }
  clearRow(tab, row) { const s = this.sheet(tab); s.getRange(row, 1, 1, s.getMaxColumns()).clearContent(); }
  replaceColumnA(tab, values) {
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
      else if (options && options.button) body.reply_markup = {inline_keyboard: [[{text: options.button.text, url: options.button.url}]]};
    }
    const r = UrlFetchApp.fetch("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/sendMessage",
      {method: "post", contentType: "application/json", payload: JSON.stringify(body), muteHttpExceptions: true});
    const code = r.getResponseCode();
    if (code === 403) throw new Gone(); // бот заблокирован пользователем
    if (code >= 400) throw new Error("Telegram HTTP " + code + ": " + r.getContentText().slice(0, 200)); // без адреса: в нём токен
  });
}

const SENDERS = {telegram: {name: "telegram", send: tgSend_}};

// ---------- цикл: сверка с таблицей, уведомления, напоминания ----------
const runCycle_ = () => runCycle({store: store_(), senders: SENDERS, now: Date.now(), appUrl: prop_("APP_URL") || "", log: console});

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/** Таймер раз в минуту: подхватывает правки таблицы (через ~15 с тишины) и раз в ~5 минут проверяет напоминания. */
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

/** Срабатывает при любой правке таблицы руками; только отмечает время, работа — в everyMinute. */
function onSheetChange() {
  PropertiesService.getScriptProperties().setProperty("dirty", String(Date.now()));
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
    if (e && e.parameter && e.parameter.secret) return telegramUpdate_(e);
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
  if (ev) withLock_(() => handleMessage({store: store_(), channel: SENDERS.telegram, ev, appUrl: prop_("APP_URL") || "", now: Date.now()}));
  return ok_();
}

// ---------- установка ----------
function setup() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty("WEBHOOK_SECRET")) p.setProperty("WEBHOOK_SECRET", Utilities.getUuid().replace(/-/g, ""));
  secret_();
  ScriptApp.getProjectTriggers().forEach(ScriptApp.deleteTrigger);
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onChange().create();
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("everyMinute").timeBased().everyMinutes(1).create();
  new GasBook().ensure(TABS.chats, SUBS_HEADER);
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
  styleSchedule_(ss.getSheetByName(TABS.schedule));
  styleStaff_(ss.getSheetByName(TABS.staff));
  const chats = ss.getSheetByName(TABS.chats);
  if (chats) styleHeader_(chats, 4);
  console.log("Таблица оформлена.");
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
  sheet.setColumnWidth(1, 120);
  sheet.setColumnWidth(2, 260);
  for (let c = 3; c <= cols; c++) sheet.setColumnWidth(c, 160);
  // чередование строк белый / светло-голубой (кроме шапок месяцев) — правилом, чтобы новые строки красились сами
  const range = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), cols);
  const banding = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(ISEVEN(ROW()),$A2<>"",NOT(REGEXMATCH($A2,"^[А-ЯЁ]+ [0-9]{4}$")))')
    .setBackground(C.light).setRanges([range]).build();
  sheet.setConditionalFormatRules([banding]);
}

/** Роли выпадающим списком с цветом: Админ / Редактор / Читатель / Заблокирован. */
function styleStaff_(sheet) {
  const cols = Math.max(3, sheet.getLastColumn());
  if (String(sheet.getRange(1, 3).getValue()).trim() === "") sheet.getRange(1, 3).setValue("Роль");
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
}
