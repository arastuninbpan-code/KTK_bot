
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
// Настройки читаем одним обращением за запуск (каждое отдельное чтение — около 50 мс). Меняющиеся значения (метки правок,
// версия данных) читаем напрямую, мимо этой копии.
let propsMemo_ = null;
function prop_(k) {
  if (!propsMemo_) propsMemo_ = PropertiesService.getScriptProperties().getProperties();
  const v = propsMemo_[k];
  return v === undefined ? null : v;
}

function secret_() {
  const p = PropertiesService.getScriptProperties();
  let s = p.getProperty("SESSION_SECRET");
  if (!s) { s = Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, ""); p.setProperty("SESSION_SECRET", s); }
  return s;
}

// ---------- кэш листов ----------
// Чтение листа из таблицы — самое медленное место (около 0,4 с на лист). Часто нужные листы держим в кэше Google и
// сбрасываем при любой правке: скриптом (GasBook), на сайте (тоже через GasBook) и руками (onSheetChange).
const PLAN_KIND_ = {[TABS.staff]: "staff", [TABS.schedule]: "schedule"};
const CACHED_TABS_ = [TABS.schedule, TABS.staff, TABS.venues, TABS.chats, TABS.requests];
const CACHE_TTL_ = 600; // запас: даже если сброс почему-то не сработал, через 10 минут данные обновятся
const CACHE_PART_ = 30000; // значение в кэше Google ограничено 100 КБ, режем на куски

function cacheRead_(tab) {
  const c = CacheService.getScriptCache();
  const token = c.get("T:" + tab);
  if (!token) return null;
  const n = Number(token.split(":")[0]);
  const keys = [];
  for (let i = 0; i < n; i++) keys.push("T:" + tab + ":" + token + ":" + i);
  const got = c.getAll(keys);
  let json = "";
  for (const k of keys) { if (got[k] == null) return null; json += got[k]; }
  try { return JSON.parse(json); } catch (e) { return null; }
}

function cacheWrite_(tab, rows) {
  const json = JSON.stringify(rows);
  const n = Math.max(1, Math.ceil(json.length / CACHE_PART_));
  const token = n + ":" + Utilities.getUuid().slice(0, 8);
  const parts = {};
  for (let i = 0; i < n; i++) parts["T:" + tab + ":" + token + ":" + i] = json.slice(i * CACHE_PART_, (i + 1) * CACHE_PART_);
  const c = CacheService.getScriptCache();
  c.putAll(parts, CACHE_TTL_);
  c.put("T:" + tab, token, CACHE_TTL_);
}

const cacheDrop_ = (tab) => CacheService.getScriptCache().remove("T:" + tab);
const dropAllCaches_ = () => CacheService.getScriptCache().removeAll(CACHED_TABS_.map((t) => "T:" + t));

// ---------- книга: тот же интерфейс, что у MemoryBook в тестах ----------
class GasBook {
  constructor() { this.memo = {}; this.opened = null; this.plans = {}; } // memo: лист читаем один раз за запрос
  get ss() { return this.opened || (this.opened = SpreadsheetApp.openById(prop_("SHEET_ID"))); } // таблицу открываем только когда без неё не обойтись
  sheet(tab) {
    const s = this.ss.getSheetByName(tab);
    if (!s) throw new Error("Нет листа «" + tab + "»");
    return s;
  }
  touch(tab) { this.memo = {}; this.plans = {}; cacheDrop_(tab); } // после любой записи в лист
  has(tab) {
    if (CACHED_TABS_.indexOf(tab) >= 0 && CacheService.getScriptCache().get("T:" + tab)) return true;
    return this.ss.getSheetByName(tab) !== null;
  }
  ensure(tab, header) {
    if (this.has(tab)) return;
    const s = this.ss.insertSheet(tab);
    if ([TABS.staff, TABS.schedule, TABS.venues].indexOf(tab) < 0) { try { s.hideSheet(); } catch (e) { /* служебный лист просто останется видимым */ } }
    if (header) s.getRange(1, 1, 1, header.length).setNumberFormat("@").setValues([header.map(String)]);
    this.touch(tab);
  }
  /** Одна ячейка текстом (остальные в строке, например галочки групп, не трогаем). */
  setCell(tab, row, col, value) {
    const at = physicalCol(this.plan(tab), col - 1);
    if (at < 0) return; // такой колонки в таблице нет
    this.sheet(tab).getRange(row, at + 1).setNumberFormat("@").setValue(String(value));
    this.touch(tab);
  }
  /** Как читать колонки листа: людей и расписание находим по названиям в шапке, поэтому колонки можно двигать. */
  plan(tab) {
    if (!(tab in this.plans)) { this.get(tab); }
    return this.plans[tab] || null;
  }
  get(tab) {
    if (this.memo[tab]) return this.memo[tab];
    const cached = CACHED_TABS_.indexOf(tab) >= 0;
    let rows = cached ? cacheRead_(tab) : null;
    if (!rows) {
      const s = this.sheet(tab);
      rows = s.getLastRow() === 0 ? [] : s.getRange(1, 1, s.getLastRow(), Math.max(1, s.getLastColumn())).getDisplayValues();
      if (cached) cacheWrite_(tab, rows);
    }
    const kind = PLAN_KIND_[tab];
    const plan = kind && rows.length ? columnPlan(kind, rows[0]) : null;
    this.plans[tab] = plan;
    return (this.memo[tab] = virtualize(rows, plan));
  }
  set(tab, row, values) {
    const s = this.sheet(tab);
    const plan = this.plan(tab);
    let padded;
    if (plan && !plan.identity) { // значения идут в канонической последовательности, раскладываем по настоящим колонкам
      padded = Array(Math.max(s.getLastColumn(), plan.perm.length)).fill("");
      values.forEach((v, j) => { const at = physicalCol(plan, j); if (at >= 0) padded[at] = String(v); });
    } else {
      const width = Math.max(values.length, s.getLastColumn());
      padded = values.map(String);
      while (padded.length < width) padded.push("");
    }
    const width = padded.length;
    s.getRange(row, 1, 1, width).setNumberFormat("@").setValues([padded]); // текстом: «04.10» не превращается в дату
    this.touch(tab);
  }
  append(tab, values) { this.set(tab, this.sheet(tab).getLastRow() + 1, values); }
  insert(tab, beforeRow) {
    const s = this.sheet(tab);
    if (beforeRow > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), 1);
    else s.insertRowBefore(beforeRow);
    this.touch(tab);
  }
  remove(tab, row) { this.sheet(tab).deleteRow(row); this.touch(tab); }
  clearRow(tab, row) { const s = this.sheet(tab); s.getRange(row, 1, 1, s.getMaxColumns()).clearContent(); this.touch(tab); }
  replaceColumnA(tab, values) {
    const s = this.sheet(tab);
    s.clear();
    if (values.length) s.getRange(1, 1, values.length, 1).setNumberFormat("@").setValues(values.map((v) => [String(v)]));
    this.touch(tab);
  }
}

/**
 * Владелец системы: его данные есть всегда, удалить, заблокировать или понизить его нельзя.
 * Берётся из свойств OWNER_PHONE (и OWNER_NAME). Если не заданы — первый «Админ» в таблице запоминается как владелец.
 * Логин запоминается отдельно, чтобы после случайного удаления строки он остался прежним.
 */
function owner_() {
  const p = PropertiesService.getScriptProperties();
  let phone = prop_("OWNER_PHONE");
  if (!phone) {
    const first = new Store(new GasBook(), {secret: secret_()}).users().find((u) => u.role === "admin" && !u.pending);
    if (!first) return null;
    p.setProperty("OWNER_PHONE", first.phone);
    p.setProperty("OWNER_NAME", first.name);
    if (first.login) p.setProperty("OWNER_LOGIN", first.login);
    propsMemo_ = null;
    phone = first.phone;
  }
  return {phone: normPhone(phone), name: prop_("OWNER_NAME") || "", login: prop_("OWNER_LOGIN") || ""};
}

/** Запоминает логин владельца, как только он появился в таблице. */
function rememberOwnerLogin_(store) {
  const o = store.owner;
  if (!o || o.login) return;
  const me = store.users().find((u) => u.phone === o.phone && u.login);
  if (me) { PropertiesService.getScriptProperties().setProperty("OWNER_LOGIN", me.login); propsMemo_ = null; }
}

const store_ = () => new Store(new GasBook(), {secret: secret_(), owner: owner_()});

// ---------- Telegram ----------
let netMs_ = 0; // сколько миллисекунд ушло на обращения к Telegram/ВК за текущий запуск (для журнала скорости)
const fetchTimed_ = (url, opts) => { const t = Date.now(); try { return UrlFetchApp.fetch(url, opts); } finally { netMs_ += Date.now() - t; } };

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
    const r = fetchTimed_("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/sendMessage",
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
  const r = fetchTimed_("https://api.vk.com/method/" + method, {method: "post", payload, muteHttpExceptions: true});
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
const runCycle_ = () => { const st = store_(); rememberOwnerLogin_(st); return runCycle({store: st, senders: SENDERS, now: Date.now(), appUrl: prop_("APP_URL") || "", log: console}); };

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// «Версия данных»: приложение раз в несколько секунд спрашивает, не изменилось ли что-то (дёшево: таблицу при этом не читаем)
const getRev_ = () => PropertiesService.getScriptProperties().getProperty("DATA_REV") || "0";
const bumpRev_ = () => PropertiesService.getScriptProperties().setProperty("DATA_REV", String(Date.now()));
const SYNC_DELAY_MS = 2000; // сколько ждём тишины после правки таблицы, чтобы не рассылать недописанное

/** Таймер раз в минуту: страховка (если быстрая сверка не сработала) и проверка напоминаний раз в ~5 минут. */
function everyMinute() {
  const p = PropertiesService.getScriptProperties();
  const now = Date.now();
  const dirty = Number(p.getProperty("dirty") || 0);
  const last = Number(p.getProperty("last_cycle") || 0);
  const dueDirty = dirty && now - dirty >= 15000;
  autoStyle_(p);
  if (p.getProperty("regroup")) { p.deleteProperty("regroup"); try { tidySchedule_(); tidyStaff_(); syncRestoreButtons_(); } catch (err) { diag_("Таблица: ОШИБКА — " + String(err && err.message ? err.message : err)); } }
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
function onSheetChange(e) {
  if (e && e.range && handleRestoreClick_(e)) return;
  dropAllCaches_(); // таблицу правили руками: кэшированные листы устарели
  const p = PropertiesService.getScriptProperties();
  p.setProperty("regroup", "1"); // шапки месяцев и сворачивание поправит ближайший минутный таймер
  const mark = String(Date.now());
  p.setProperty("dirty", mark);
  bumpRev_();
  Utilities.sleep(SYNC_DELAY_MS);
  if (p.getProperty("dirty") !== mark) return; // позже была ещё правка — сверку сделает она
  withLock_(() => {
    p.deleteProperty("dirty");
    p.setProperty("last_cycle", String(Date.now()));
    try { // правка в «Сотрудниках» (новая колонка-группа, новый человек): оформляем сразу, не дожидаясь таймера
      if (e && e.range && e.range.getSheet().getName() === TABS.staff) { tidyStaff_(); p.deleteProperty("regroup"); }
      syncRestoreButtons_();
    } catch (err) { diag_("Таблица: ОШИБКА — " + String(err && err.message ? err.message : err)); }
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
    afterChange: () => { PropertiesService.getScriptProperties().setProperty("regroup", "1"); try { runCycle_(); } catch (err) { console.error(String(err && err.message ? err.message : err)); } },
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
  if (ev) {
    const t0 = Date.now();
    netMs_ = 0;
    const run = () => handleMessage({store: store_(), channel: SENDERS.telegram, ev, appUrl: prop_("APP_URL") || "", now: Date.now(), publishers: publishers_(), log: diag_});
    try {
      if (READ_ONLY_RE_.test(ev.text || "")) run(); else withLock_(run); // чтение расписания блокировки не требует
      diag_("TG " + speed_(ev, t0));
    } catch (err) {
      diag_("TG: ОШИБКА — " + (err && err.message ? err.message : (err && err.constructor && err.constructor.name) || err));
    }
  }
  return ok_();
}

/** Сообщения ВКонтакте (Callback API через посредника). Подтверждение адреса отдаёт посредник; здесь на случай прямого обращения. */
const READ_ONLY_RE_ = /^\/(shifts|schedule)(@\w+)?\s*$/i; // команды, которые только читают таблицу

/** Строка про скорость: сколько секунд сообщение шло до скрипта и сколько скрипт его обрабатывал (без текста сообщения: там может быть логин). */
function speed_(ev, t0) {
  const lag = ev.date ? Math.max(0, Math.round(t0 / 1000 - ev.date)) + " с" : "?";
  const cmd = (/^\/\w+/.exec(ev.text || "") || ["текст"])[0];
  return cmd + ": доставка до скрипта " + lag + ", обработка " + (Date.now() - t0) + " мс, из них отправка в мессенджер " + netMs_ + " мс";
}

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
    const t0 = Date.now();
    netMs_ = 0;
    const run = () => handleMessage({store: store_(), channel: SENDERS.vk, ev, appUrl: prop_("APP_URL") || "", now: Date.now(), publishers: publishers_(), log: diag_});
    if (READ_ONLY_RE_.test(ev.text || "")) run(); else withLock_(run); // чтение расписания блокировки не требует
    diag_("VK: сообщение от " + ev.chatId + " обработано, ответ отправлен. " + speed_(ev, t0));
  } catch (err) {
    diag_("VK: ОШИБКА — " + (err && err.message ? err.message : (err && err.constructor && err.constructor.name) || err));
  }
  return ok_();
}

// ---------- установка ----------
function setup() {
  const p = PropertiesService.getScriptProperties();
  propsMemo_ = null;
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
  dropAllCaches_();
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
  hideHelperSheets_(ss);
  dropAllCaches_();
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
  fixMonths_(sheet);

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
  groupMonths_(sheet, true);
}

const monthTitle_ = (date) => MONTHS_UP[+date.slice(5, 7) - 1] + " " + date.slice(0, 4);
const dateOfRow_ = (cell, today) => { const m = String(cell).match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/); return m ? parseDate(m[1], today) : null; };
const monthRowTitle_ = (row) => { const f = row.filter((c) => String(c).trim() !== ""); return f.length === 1 && MONTH_ROW_RE.test(String(f[0]).trim()) ? String(f[0]).trim() : null; };

/**
 * Месяцы должны идти друг за другом без повторов: у каждого события шапка именно его месяца, шапки по порядку.
 * Если это не так (событие вписали не на своё место, дату поменяли, шапка задублировалась), лист пересобирается:
 * события сортируются по дате (внутри одной даты порядок сохраняется), старые шапки убираются, ставятся новые.
 */
function monthsDisordered_(rows, today) {
  let current = "";
  let lastDate = "";
  const seen = {};
  for (let r = 1; r < rows.length; r++) {
    const t = monthRowTitle_(rows[r]);
    if (t) { if (seen[t]) return true; seen[t] = true; current = t; continue; }
    const d = dateOfRow_(rows[r][0], today);
    if (!d) continue;
    if (d < lastDate || monthTitle_(d) !== current) return true;
    lastDate = d;
  }
  return false;
}

function rebuildMonths_(sheet) {
  const today = todayIso(Date.now());
  const lastRow = sheet.getLastRow();
  const cols = Math.max(2, sheet.getLastColumn());
  const data = sheet.getRange(1, 1, lastRow, cols).getValues();
  const body = [];
  let key = "0000-00-00";
  data.slice(1).forEach((row) => {
    if (monthRowTitle_(row) !== null) return; // старые шапки убираем, новые поставим сами
    if (row.every((c) => String(c).trim() === "")) return; // пустые строки внутри не нужны
    const d = dateOfRow_(row[0], today);
    if (d) key = d; // строка без понятной даты остаётся рядом с предыдущей
    body.push({row, key, n: body.length});
  });
  body.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.n - b.n));
  const out = [];
  let title = "";
  body.forEach((b) => {
    const t = b.key === "0000-00-00" ? "" : monthTitle_(b.key);
    if (t && t !== title) { out.push([t].concat(Array(cols - 1).fill(""))); title = t; }
    out.push(b.row);
  });
  const range = sheet.getRange(2, 1, Math.max(lastRow - 1, 1), cols);
  for (let r = 2; r <= lastRow; r++) { const d = sheet.getRowGroupDepth(r); if (d > 0) sheet.getRange(r, 1, 1, 1).shiftRowGroupDepth(-d); }
  sheet.getDataRange().breakApart();
  range.clear();
  if (out.length) sheet.getRange(2, 1, out.length, cols).setNumberFormat("@").setValues(out);
  console.log("Месяцы пересобраны по порядку (строк: " + out.length + ").");
}

/** Приводит месяцы в порядок: пересборка, если они перепутаны, иначе только недостающие шапки. */
function fixMonths_(sheet) {
  if (sheet.getLastRow() < 2) return 0;
  const rows = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(2, sheet.getLastColumn())).getDisplayValues();
  const plan = columnPlan("schedule", rows[0]);
  if (plan && plan.perm[0] !== 0) return 0; // колонку «Дата» переставили: порядок наводить не будем, пока не вернут вид
  if (monthsDisordered_(rows, todayIso(Date.now()))) { rebuildMonths_(sheet); return 1; }
  return ensureMonthHeaders_(sheet);
}

/** Шапка месяца перед первым событием каждого месяца, если её нет (снизу вверх, чтобы номера строк не съезжали). Возвращает, сколько добавлено. */
function ensureMonthHeaders_(sheet) {
  const today = todayIso(Date.now());
  const values = sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), 1).getDisplayValues();
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
  return heads.length;
}

/**
 * Каждый месяц — группа строк под шапкой: слева значок «−/+» сворачивает месяц целиком.
 * Прошедшие месяцы свёрнуты по умолчанию; то, как человек развернул или свернул месяц руками, сохраняем.
 */
function groupMonths_(sheet, fresh) {
  const last = sheet.getLastRow();
  if (last < 2) return;
  const today = todayIso(Date.now());
  const col = sheet.getRange(1, 1, last, 1).getDisplayValues();
  const months = [];
  for (let r = 2; r <= last; r++) {
    const t = String(col[r - 1][0]).trim();
    if (MONTH_ROW_RE.test(t)) months.push({head: r, title: t, end: r});
    else if (months.length) months[months.length - 1].end = r;
  }
  if (!months.length) return;
  const thisMonth = MONTHS_UP[+today.slice(5, 7) - 1] + " " + today.slice(0, 4);
  const monthKey = (t) => { const i = MONTHS_UP.indexOf(t.split(" ")[0]); return t.split(" ")[1] + String(i + 100); };
  sheet.setRowGroupControlPosition(SpreadsheetApp.GroupControlTogglePosition.BEFORE);
  months.forEach((m) => {
    const rows = m.end - m.head;
    if (rows < 1) return;
    let collapsed = monthKey(m.title) < monthKey(thisMonth);
    if (!fresh) { const g = sheet.getRowGroup(m.head + 1, 1); if (g) collapsed = g.isCollapsed(); }
    const range = sheet.getRange(m.head + 1, 1, rows, 1);
    let depth = sheet.getRowGroupDepth(m.head + 1);
    if (depth > 1 || (depth === 1 && !sheet.getRowGroup(m.head + 1, 1))) { range.shiftRowGroupDepth(-depth); depth = 0; }
    if (depth === 0) range.shiftRowGroupDepth(1);
    const g = sheet.getRowGroup(m.head + 1, 1);
    if (g) { if (collapsed) g.collapse(); else g.expand(); }
  });
}

const STYLE_VERSION_ = "5"; // поднимайте, когда меняется оформление: таблица перестроится сама при ближайшем срабатывании таймера

/** После обновления кода один раз оформляет таблицу сама (то же, что ручной запуск styleSheets). */
function autoStyle_(p) {
  if (p.getProperty("STYLE_VER") === STYLE_VERSION_) return;
  p.setProperty("STYLE_VER", STYLE_VERSION_); // помечаем сразу: если что-то сломается, не повторяем каждую минуту
  try { styleSheets(); } catch (err) { console.error("Автооформление не удалось (запустите styleSheets вручную): " + String(err && err.message ? err.message : err)); }
}

/**
 * «Сотрудники»: новая колонка (вид деятельности) сразу получает галочки; у нового человека по умолчанию роль «Читатель» и доступ включён
 * (если не стоит «ЗАЯВКА» без одобрения: заявку одобряют, вписав ФИО — доступ включится сам).
 */
function tidyStaff_() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  const sheet = ss.getSheetByName(TABS.staff);
  if (!sheet || sheet.getLastRow() < 1) return;
  const p = PropertiesService.getScriptProperties();
  const data = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(sheet.getLastColumn(), 6)).getDisplayValues();
  const head = data[0].map((x) => String(x).trim());
  const plan = columnPlan("staff", head);
  const sig = head.join("|");
  const accessIdx = head.findIndex((x) => /^доступ$/i.test(x));
  const canonical = !plan || !plan.modified; // колонки на своих местах: оформляем целиком; двигали — оформляем только то, что можно по названиям
  if (canonical && (accessIdx < 0 || p.getProperty("STAFF_HEAD") !== sig)) { styleStaff_(sheet); p.setProperty("STAFF_HEAD", sig); return tidyStaff_(); }
  if (!canonical && p.getProperty("STAFF_HEAD") !== sig) { // колонки переставили: новым колонкам-группам всё равно нужны галочки
    const fixed = plan.perm.slice(0, 4 + (accessIdx >= 0 ? 1 : 0));
    const rest = head.map((x, i) => ({x, i})).filter((c) => c.x && fixed.indexOf(c.i) < 0 && !/^комментарий$/i.test(c.x) && !c.x.startsWith(RESTORE_MARK));
    const rows = Math.max(sheet.getMaxRows() - 1, 1);
    rest.forEach((c) => sheet.getRange(2, c.i + 1, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build()).setHorizontalAlignment("center"));
    p.setProperty("STAFF_HEAD", sig);
  }
  if (accessIdx < 0) return;
  const roleIdx = plan ? plan.perm[2] : 2;
  const nameIdx = plan ? plan.perm[0] : 0;
  let changed = false;
  for (let r = 2; r <= data.length; r++) {
    const name = String(data[r - 1][nameIdx]).trim();
    if (!name) continue;
    if (String(data[r - 1][roleIdx]).trim() === "") { sheet.getRange(r, roleIdx + 1).setNumberFormat("@").setValue("Читатель"); changed = true; }
    if (!/^заявка/i.test(name) && String(data[r - 1][accessIdx]).trim() === "") { sheet.getRange(r, accessIdx + 1).setValue(true); changed = true; }
  }
  if (changed) { dropAllCaches_(); bumpRev_(); }
}

// ---------- «Вернуть исходный вид»: если колонки переставили, система подстраивается (ищет их по названиям), а в шапке появляется красная кнопка ----------
/** Ставит или убирает красную кнопку в шапке «Сотрудников» и «Расписания». */
function syncRestoreButtons_() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  Object.keys(PLAN_KIND_).forEach((tab) => {
    const sheet = ss.getSheetByName(tab);
    if (!sheet || sheet.getLastColumn() < 1) return;
    const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map((x) => String(x).trim());
    const plan = columnPlan(PLAN_KIND_[tab], head);
    const btn = head.findIndex((x) => x.startsWith(RESTORE_MARK));
    let lastIdx = -1;
    head.forEach((x, i) => { if (x && !x.startsWith(RESTORE_MARK)) lastIdx = i; });
    if (plan && plan.modified) {
      if (btn === lastIdx + 1) return; // уже на месте
      if (btn >= 0) sheet.getRange(1, btn + 1).clear();
      const cell = sheet.getRange(1, lastIdx + 2);
      cell.setNumberFormat("@").setValue(RESTORE_LABEL)
        .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList([RESTORE_LABEL, RESTORE_CONFIRM], true).setAllowInvalid(false).build())
        .setBackground(C.coral).setFontColor(C.white).setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle").setWrap(true);
      sheet.setColumnWidth(lastIdx + 2, 200);
    } else if (btn >= 0) {
      sheet.getRange(1, btn + 1).clear();
    }
  });
}

/** Возвращает колонки в исходный порядок (данные переезжают вместе с колонками), заново оформляет лист и убирает кнопку. */
function restoreLayout_(sheet, kind) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return false;
  const data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const plan = columnPlan(kind, data[0].map(String));
  if (!plan) return false;
  const filled = (r) => r.filter((c) => String(c).trim() !== "");
  const out = data.map((r, i) => {
    if (i === 0) return plan.labels.slice();
    const f = filled(r);
    if (f.length === 1 && MONTH_ROW_RE.test(String(f[0]).trim())) return plan.perm.map((_, j) => (j === 0 ? String(f[0]).trim() : "")); // шапка месяца остаётся шапкой
    return plan.perm.map((p) => (p >= 0 ? r[p] : ""));
  });
  sheet.getDataRange().breakApart();
  sheet.getRange(1, 1, lastRow, lastCol).clear();
  plan.perm.forEach((_, j) => { if (!out.some((r, i) => i > 0 && typeof r[j] === "boolean")) sheet.getRange(1, j + 1, lastRow, 1).setNumberFormat("@"); });
  sheet.getRange(1, 1, out.length, plan.perm.length).setValues(out);
  if (kind === "staff") styleStaff_(sheet); else styleSchedule_(sheet);
  dropAllCaches_();
  bumpRev_();
  return true;
}

/** Нажали в красной кнопке «Да, вернуть»: восстанавливаем лист. Возвращает true, если это было нажатие кнопки. */
function handleRestoreClick_(e) {
  try {
    const range = e && e.range;
    if (!range || range.getRow() !== 1) return false;
    if (String(e.value === undefined ? range.getValue() : e.value) !== RESTORE_CONFIRM) return false;
    const sheet = range.getSheet();
    const kind = PLAN_KIND_[sheet.getName()];
    if (!kind) return false;
    withLock_(() => { restoreLayout_(sheet, kind); syncRestoreButtons_(); });
    return true;
  } catch (err) { console.error("Возврат вида: " + String(err && err.message ? err.message : err)); return false; }
}

/** Следит за порядком в «Расписании»: шапки месяцев и сворачивание. Вызывается таймером после изменений. */
function tidySchedule_() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  const sheet = ss.getSheetByName(TABS.schedule);
  if (!sheet) return;
  const added = fixMonths_(sheet);
  if (added) { // добавили шапки или пересобрали порядок: оформляем лист заново, приложению сообщаем об изменении
    styleSchedule_(sheet);
    dropAllCaches_();
    bumpRev_();
    return;
  }
  groupMonths_(sheet, false);
}

/** Видны только три листа: «Сотрудники», «Расписание», «Площадки». Остальные служебные прячем (они работают, как раньше). */
function hideHelperSheets_(ss) {
  const keep = [TABS.staff, TABS.schedule, TABS.venues];
  ss.getSheets().forEach((sh) => {
    const name = sh.getName();
    const helper = keep.indexOf(name) < 0;
    try { if (helper && !sh.isSheetHidden()) sh.hideSheet(); if (!helper && sh.isSheetHidden()) sh.showSheet(); } catch (e) { console.log("Лист «" + name + "» не скрыт: " + String(e.message || e)); }
  });
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

  // «Доступ» (галочка) и «Комментарий» — сразу правее «Логина»; у уже внесённых людей доступ включён, у строк «ЗАЯВКА» — выключен
  let head = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 4)).getDisplayValues()[0].map((x) => String(x).trim());
  if (head.findIndex((x, i) => i >= 4 && /^доступ$/i.test(x)) < 0) {
    sheet.insertColumnsBefore(5, 2);
    sheet.getRange(1, 5, 1, 2).setNumberFormat("@").setValues([["Доступ", "Комментарий"]]);
    const people = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues() : [];
    const ticks = people.map(([n]) => [String(n).trim() !== "" && !/^заявка/i.test(String(n).trim())]);
    if (ticks.length) sheet.getRange(2, 5, ticks.length, 1).setValues(ticks);
  } else if (head.findIndex((x, i) => i >= 4 && /^комментарий$/i.test(x)) < 0) {
    const at = head.length + 1;
    sheet.getRange(1, at).setNumberFormat("@").setValue("Комментарий");
  }
  head = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 4)).getDisplayValues()[0].map((x) => String(x).trim());
  const accessCol = head.findIndex((x, i) => i >= 4 && /^доступ$/i.test(x)) + 1;
  const commentCol = head.findIndex((x, i) => i >= 4 && /^комментарий$/i.test(x)) + 1;
  const lastRow = Math.max(sheet.getMaxRows(), 2);
  const rows = lastRow - 1;
  const checkbox = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(2, accessCol, rows, 1).setDataValidation(checkbox).setHorizontalAlignment("center");
  sheet.setColumnWidth(accessCol, 80);
  // комментарий — обычный текст: галочек здесь быть не должно (они могли «приехать» от соседней колонки при вставке)
  const commentRange = sheet.getRange(2, commentCol, rows, 1);
  commentRange.clearDataValidations();
  const cv = sheet.getLastRow() > 1 ? sheet.getRange(2, commentCol, sheet.getLastRow() - 1, 1) : null;
  if (cv) {
    const vals = cv.getValues().map(([v]) => [(v === true || v === false || /^(true|false)$/i.test(String(v).trim())) ? "" : v]);
    cv.setNumberFormat("@").setValues(vals);
  }
  commentRange.setWrap(true).setVerticalAlignment("top").setHorizontalAlignment("left");
  sheet.setColumnWidth(commentCol, 320);

  // группы: остальные колонки с названием в шапке; в ячейках галочки «входит в группу»
  const isGroup = (x, i) => i >= 4 && x && i + 1 !== accessCol && i + 1 !== commentCol;
  if (!head.some(isGroup)) { sheet.getRange(1, head.length + 1, 1, 3).setNumberFormat("@").setValues([["Актёры", "Техника", "Зал"]]); head = head.concat(["Актёры", "Техника", "Зал"]); } // примеры, переименуйте как нужно
  for (let c = 5; c <= head.length; c++) {
    if (!isGroup(head[c - 1], c - 1)) continue;
    sheet.getRange(2, c, rows, 1).setDataValidation(checkbox).setHorizontalAlignment("center");
    sheet.setColumnWidth(c, 100);
  }
  styleHeader_(sheet, Math.max(head.length, 6));

  // подсветка: заявка — жёлтым, доступ снят — розовым и серым текстом (правилом, чтобы новые строки красились сами)
  const A = (n) => String.fromCharCode(64 + n);
  const whole = sheet.getRange(2, 1, rows, Math.max(head.length, 6));
  const rules = sheet.getConditionalFormatRules();
  const request = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=REGEXMATCH($A2,"^(?i)заявка")').setBackground("#FFF2B3").setRanges([whole]).build();
  const off = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied("=AND($A2<>\"\",$" + A(accessCol) + "2=FALSE)").setBackground("#FBE0DF").setFontColor("#8A8A8A").setRanges([whole]).build();
  sheet.setConditionalFormatRules(rules.concat([request, off]));
}

function styleVenues_(sheet) {
  styleHeader_(sheet, 2);
  sheet.setColumnWidth(1, 260);
  sheet.setColumnWidth(2, 300);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 2).setFontColor(C.navy).setVerticalAlignment("middle");
}
