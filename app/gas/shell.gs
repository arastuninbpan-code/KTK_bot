
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
const CACHED_TABS_ = [TABS.schedule, TABS.staff, TABS.venues, TABS.chats, TABS.requests, TABS.off, TABS.meta, TABS.comments, TABS.avatars]; // каждый запрос расписания читает и их: без кеша это лишние ~0,5 с на лист
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
  if (json.length > 400000) return; // слишком большой лист в кеш не кладём (читается напрямую)
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
    if ([TABS.staff, TABS.schedule, TABS.venues, TABS.reports].indexOf(tab) < 0) { try { s.hideSheet(); } catch (e) { /* служебный лист просто останется видимым */ } }
    if (header) s.getRange(1, 1, 1, header.length).setNumberFormat("@").setValues([header.map(String)]);
    this.touch(tab);
  }
  /** Одна ячейка текстом (остальные в строке, например галочки групп, не трогаем). */
  setCell(tab, row, col, value) {
    const at = physicalCol(this.plan(tab), col - 1);
    if (at < 0) return; // такой колонки в таблице нет
    this.grow_(this.sheet(tab), row);
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
  /** Запись ниже последней строки листа: добавляем строки, иначе Google отказывает. */
  grow_(s, row) { if (row > s.getMaxRows()) s.insertRowsAfter(s.getMaxRows(), row - s.getMaxRows()); }
  set(tab, row, values) {
    const s = this.sheet(tab);
    this.grow_(s, row);
    const plan = this.plan(tab);
    let padded;
    if (plan && !plan.identity) { // значения идут в канонической последовательности, раскладываем по настоящим колонкам
      padded = Array(Math.max(s.getLastColumn(), plan.perm.length)).fill("");
      values.forEach((v, j) => { const at = physicalCol(plan, j); if (at >= 0) padded[at] = String(v); });
    } else if (tab === TABS.venues) {
      padded = values.map(String); // не трогаем таблицу занятости справа
    } else {
      const width = Math.max(values.length, s.getLastColumn());
      padded = values.map(String);
      while (padded.length < width) padded.push("");
    }
    const width = padded.length;
    s.getRange(row, 1, 1, width).setNumberFormat("@").setValues([padded]); // текстом: «04.10» не превращается в дату
    this.touch(tab);
  }
  append(tab, values) {
    const s = this.sheet(tab);
    let last = s.getLastRow();
    if (tab === TABS.venues && last > 0) { // справа от списка площадок лежит таблица занятости: «последняя строка» считается по названиям площадок
      const names = s.getRange(1, 1, last, 1).getDisplayValues();
      while (last > 1 && String(names[last - 1][0]).trim() === "") last--;
    }
    this.set(tab, last + 1, values);
  }
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
      else if (options && options.menu) body.reply_markup = {keyboard: menuRows(options.menu).map((row) => row.map((text) => ({text}))), resize_keyboard: true, is_persistent: true}; // главное меню под полем ввода
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

/** Имя и фамилия человека из профиля ВК (для заявки на доступ). */
function vkName_(userId) {
  const r = vkCall_("users.get", {user_ids: userId});
  const u = (r && r[0]) || {};
  return [u.first_name, u.last_name].filter(Boolean).join(" ");
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
/**
 * Собрание: уведомление ВСЕМ сотрудникам с доступом (в личные сообщения Telegram и ВК) и, если нужно, пост в группу ВК / канал.
 * Текст собрания (повестка / текст приложенного документа) уходит текстом.
 */
// ---------- аватарки из профилей ----------
const AVATAR_TTL_ = 7 * 24 * 3600e3; // обновляем раз в неделю

/** ВК: ссылка на фото 100×100 из профиля. */
function vkAvatar_(userId) {
  const r = vkCall_("users.get", {user_ids: userId, fields: "photo_100"});
  return (r && r[0] && r[0].photo_100) || "";
}

/** Telegram: маленькая (≈160 px) фотография профиля, кладём в таблицу картинкой внутри (ссылка Telegram содержит токен бота и наружу не отдаётся). */
function tgAvatar_(userId) {
  const base = "https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN");
  const get = (url) => JSON.parse(fetchTimed_(url, {muteHttpExceptions: true}).getContentText());
  const photos = get(base + "/getUserProfilePhotos?user_id=" + encodeURIComponent(userId) + "&limit=1");
  const sizes = photos.result && photos.result.photos && photos.result.photos[0];
  if (!sizes || !sizes.length) return "";
  const pick = sizes.find((s) => s.width >= 120) || sizes[sizes.length - 1];
  const file = get(base + "/getFile?file_id=" + encodeURIComponent(pick.file_id));
  if (!file.result || !file.result.file_path) return "";
  const blob = fetchTimed_("https://api.telegram.org/file/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/" + file.result.file_path, {muteHttpExceptions: true}).getBlob();
  const data = "data:image/jpeg;base64," + Utilities.base64Encode(blob.getBytes());
  return data.length < 45000 ? data : ""; // в одну ячейку таблицы больше не влезает
}

/** После ответа боту: если у человека нет свежей аватарки — берём из его профиля (раз в неделю). Любая ошибка молча пропускается. */
function refreshAvatar_(channel, ev) {
  try {
    const st = store_();
    const chat = st.chats().find((c) => c.channel === channel && c.chatId === String(ev.chatId));
    if (!chat || Date.now() - st.avatarAge(chat.phone, channel) < AVATAR_TTL_) return;
    const photo = channel === "vk" ? vkAvatar_(ev.chatId) : tgAvatar_(ev.chatId);
    st.setAvatar(chat.phone, channel, photo || ""); // пустое значение тоже запоминаем (нет фото) — чтобы не спрашивать при каждом сообщении
    bumpRev_();
  } catch (err) { console.error("Аватарка: " + String(err && err.message ? err.message : err)); }
}

function announce_(a) {
  const st = store_();
  const appUrl = prop_("APP_URL") || "";
  const e = a.event;
  const text = msgMeeting(e, a.note || "");
  const btn = appButton(appUrl ? appUrl + "#event=" + encodeURIComponent(e.id || "") : "");
  const people = new Set(st.activeUsers().map((u) => u.phone));
  let sent = 0;
  st.chats().filter((c) => people.has(c.phone)).forEach((c) => {
    try { if (SENDERS[c.channel]) { SENDERS[c.channel].send(c.chatId, text, btn); sent++; } }
    catch (err) { if (err instanceof Gone) st.unbind(c.channel, c.chatId); else console.error(String(err && err.message ? err.message : err)); }
  });
  let posted = [];
  if (a.kind === "meeting" && a.publish) { try { posted = publishers_().post(meetingPostText(e, a.note || "")); } catch (err) { console.error(String(err && err.message ? err.message : err)); } }
  diag_("Собрание «" + e.title + "»: разослано " + sent + (posted.length ? "; " + posted.join(" ") : ""));
  return {sent, posted};
}

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
  seedTestUsers_(p);
  const todayStr = todayIso(Date.now());
  if (p.getProperty("months_day") !== todayStr) { p.setProperty("months_day", todayStr); p.setProperty("regroup", "1"); } // новый день: месяц мог стать прошедшим, перекладываем вниз
  if (p.getProperty("regroup")) { p.deleteProperty("regroup"); try { tidyStaff_(); renderPeopleList_(); syncRoleColumns_(); ensureEventIds_(); tidySchedule_(); syncRestoreButtons_(); fillVenueColors_(); renderOccupancy_(); } catch (err) { diag_("Таблица: ОШИБКА — " + String(err && err.message ? err.message : err)); } }
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
      if (e && e.range && e.range.getSheet().getName() === TABS.staff) { tidyStaff_(); renderPeopleList_(); syncRoleColumns_(); p.deleteProperty("regroup"); }
      if (e && e.range && e.range.getSheet().getName() === TABS.schedule && e.range.getRow() === 1) applyPeopleValidation_(e.range.getSheet()); // добавили новую роль-колонку: сразу список
      syncRestoreButtons_();
      if (e && e.range) { const nm = e.range.getSheet().getName(); if (nm === TABS.venues) fillVenueColors_(); if (nm === TABS.schedule || nm === TABS.venues) renderOccupancy_(); } // занятость площадок обновляем сразу
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
    if (!req || typeof req.path !== "string" || req.path.indexOf("/api/") !== 0) return json_({error: "Не найдено", _status: 404});
    return json_(apiCall_(req));
  } catch (err) {
    const why = String(err && err.message ? err.message : err);
    console.error(why);
    try { diag_("API: ОШИБКА — " + why); } catch (e2) { /* журнал недоступен */ }
    return json_({error: "Что-то пошло не так. Попробуйте ещё раз.", _status: 500}); // со статусом 500 приложение не считает правку сохранённой и пробует снова
  }
}

function apiCall_(req) {
  const call = () => handleApi({method: req.method || "GET", path: req.path, token: req.token, body: req.body || {}}, {
    store: store_(),
    secret: secret_(),
    announce: announce_,
    saveReport: saveReport_,
    getRev: getRev_,
    bumpRev: bumpRev_,
    // после правки сразу рассылаем уведомления (не ждём таймера); ошибки рассылки не ломают сохранение
    afterChange: () => { PropertiesService.getScriptProperties().setProperty("regroup", "1"); try { runCycle_(); } catch (err) { console.error(String(err && err.message ? err.message : err)); } },
  });
  const lockFree = !req.method || req.method === "GET"; // чтение блокировку не держит
  const r = lockFree ? call() : withLock_(call);
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
      refreshAvatar_("telegram", ev);
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
    const run = () => handleMessage({store: store_(), channel: SENDERS.vk, ev, appUrl: prop_("APP_URL") || "", now: Date.now(), publishers: publishers_(), log: diag_, lookupName: () => vkName_(ev.chatId)});
    if (READ_ONLY_RE_.test(ev.text || "")) run(); else withLock_(run); // чтение расписания блокировки не требует
    diag_("VK: сообщение от " + ev.chatId + " обработано, ответ отправлен. " + speed_(ev, t0));
    refreshAvatar_("vk", ev);
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
const MONTH_ROW_RE = /^[А-ЯЁ]+ \d{4}$/;
const ROLE_LIST = ["Админ", "Редактор", "Читатель", "Заблокирован", "Заявка"];

function styleSheets() {
  dropAllCaches_();
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  migrateSchedule();
  const book = new GasBook();
  book.ensure(TABS.venues, VENUES_HEADER);
  seedVenues_(book);
  fillVenueColors_();
  styleStaff_(ss.getSheetByName(TABS.staff));
  dropAllCaches_(); // «Сотрудники» только что поменялись: дальше читаем их заново
  renderPeopleList_();
  syncRoleColumns_();
  ensureEventIds_();
  styleSchedule_(ss.getSheetByName(TABS.schedule));
  styleVenues_(ss.getSheetByName(TABS.venues));
  const chats = ss.getSheetByName(TABS.chats);
  if (chats) styleHeader_(chats, 4);
  renderOccupancy_();
  tidyStaff_(); // убирает «хвост» из пустых строк-заготовок и поднимает заявки, улетевшие вниз
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
  fixMonths_(sheet, true);

  // 2) оформление
  const lastRow = Math.max(2, sheet.getLastRow());
  const cols = Math.max(2, sheet.getLastColumn());
  const all = sheet.getRange(2, 1, lastRow - 1, cols);
  all.setBackground(C.white).setFontColor(C.navy).setWrap(true).setVerticalAlignment("top").setNumberFormat("@")
    .setBorder(true, true, true, true, true, true, "#9CB6D3", SpreadsheetApp.BorderStyle.SOLID);
  styleHeader_(sheet, cols);
  const all2 = sheet.getRange(1, 1, sheet.getLastRow(), 1).getDisplayValues();
  for (let r = 2; r <= all2.length; r++) {
    if (String(all2[r - 1][0]).trim() === PAST_DIVIDER_) {
      sheet.getRange(r, 1, 1, cols).merge().setBackground("#B8C4D6").setFontColor(C.navy).setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle");
      sheet.setRowHeight(r, 28);
      continue;
    }
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
  sheet.setConditionalFormatRules(scheduleRules_(sheet));
  groupMonths_(sheet, true);
  applyPeopleValidation_(sheet);
}

const monthTitle_ = monthTitleOf;
const dateOfRow_ = (cell, today) => { const m = String(cell).match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/); return m ? parseDate(m[1], today) : null; };
const monthRowTitle_ = (row) => { const f = row.filter((c) => String(c).trim() !== ""); return f.length === 1 && MONTH_ROW_RE.test(String(f[0]).trim()) ? String(f[0]).trim() : null; };

/**
 * Месяцы должны идти друг за другом без повторов: у каждого события шапка именно его месяца, шапки по порядку.
 * Если это не так (событие вписали не на своё место, дату поменяли, шапка задублировалась), лист пересобирается:
 * события сортируются по дате (внутри одной даты порядок сохраняется), старые шапки убираются, ставятся новые.
 */
const PAST_DIVIDER_ = "▼ ПРОШЕДШИЕ МЕСЯЦЫ";
const PAST_GAP_ = 2; // сколько пустых строк между последним событием и разделителем (всегда одинаково; блок прошлого просто «едет» вниз вместе с новыми событиями)
const isDividerRow_ = (row) => String(row[0] || "").trim() === PAST_DIVIDER_;
const isBlankRow_ = (row) => row.every((c) => String(c).trim() === "");

function monthsDisordered_(rows, today) {
  let current = "";
  let last = null;
  let pastHead = -1; // номер строки первой шапки прошедшего месяца
  let divider = -1;
  const seen = {};
  for (let r = 1; r < rows.length; r++) {
    if (isDividerRow_(rows[r])) { if (divider >= 0) return true; divider = r; continue; }
    const t = monthRowTitle_(rows[r]);
    if (t) {
      if (seen[t]) return true;
      seen[t] = true; current = t;
      const m = MONTHS_UP.indexOf(t.split(" ")[0]);
      if (pastHead < 0 && rankOf(t.split(" ")[1] + "-" + String(m + 1).padStart(2, "0") + "-01", today)[0] === 1) pastHead = r;
      continue;
    }
    const d = dateOfRow_(rows[r][0], today);
    if (!d) continue;
    const rank = rankOf(d, today);
    if ((last && cmpRank(rank, last) < 0) || monthTitle_(d) !== current) return true;
    last = rank;
  }
  if (!seen[monthTitle_(today)]) return true; // шапка текущего месяца должна быть всегда, даже если событий в нём нет
  // разделитель стоит прямо перед первым прошедшим месяцем, перед ним ровно PAST_GAP_ пустых строк; без прошлого разделителя нет
  if (pastHead < 0) return divider >= 0;
  if (divider < 0 || divider !== pastHead - 1) return true;
  for (let k = 1; k <= PAST_GAP_; k++) if (!rows[divider - k] || !isBlankRow_(rows[divider - k])) return true;
  return divider - PAST_GAP_ - 1 >= 1 && isBlankRow_(rows[divider - PAST_GAP_ - 1]);
}

function rebuildMonths_(sheet) {
  const today = todayIso(Date.now());
  const lastRow = sheet.getLastRow();
  const cols = Math.max(2, sheet.getLastColumn());
  const data = sheet.getRange(1, 1, lastRow, cols).getValues();
  const body = [];
  let key = "0000-00-00";
  const rankOfKey = (k) => (k === "0000-00-00" ? [-1, 0, ""] : rankOf(k, today));
  data.slice(1).forEach((row) => {
    if (monthRowTitle_(row) !== null || isDividerRow_(row)) return; // старые шапки и разделитель убираем, новые поставим сами
    if (row.every((c) => String(c).trim() === "")) return; // пустые строки внутри не нужны
    const d = dateOfRow_(row[0], today);
    if (d) key = d; // строка без понятной даты остаётся рядом с предыдущей
    body.push({row, key, n: body.length});
  });
  body.sort((a, b) => cmpRank(rankOfKey(a.key), rankOfKey(b.key)) || a.n - b.n);
  const out = [];
  let title = "";
  let dividerDone = false;
  const curTitle = monthTitle_(today);
  if (!body.some((b) => b.key !== "0000-00-00" && monthTitle_(b.key) === curTitle)) { // в текущем месяце событий нет — шапка всё равно остаётся
    out.push([curTitle].concat(Array(cols - 1).fill("")));
    title = curTitle;
  }
  body.forEach((b) => {
    const t = b.key === "0000-00-00" ? "" : monthTitle_(b.key);
    if (t && t !== title) {
      if (rankOfKey(b.key)[0] === 1 && !dividerDone && out.length) { // перед прошедшими месяцами — всегда одинаковый просвет и разделитель
        for (let k = 0; k < PAST_GAP_; k++) out.push(Array(cols).fill(""));
        out.push([PAST_DIVIDER_].concat(Array(cols - 1).fill("")));
        dividerDone = true;
      }
      out.push([t].concat(Array(cols - 1).fill(""))); title = t;
    }
    out.push(b.row);
  });
  const range = sheet.getRange(2, 1, Math.max(lastRow - 1, 1), cols);
  for (let r = 2; r <= lastRow; r++) { const d = sheet.getRowGroupDepth(r); if (d > 0) sheet.getRange(r, 1, 1, 1).shiftRowGroupDepth(-d); }
  sheet.getDataRange().breakApart();
  range.clear();
  if (out.length) sheet.getRange(2, 1, out.length, cols).setNumberFormat("@").setValues(out);
  sheet.autoResizeRows(2, Math.max(lastRow - 1, out.length, 1)); // высоты строк от удалённых событий больше не нужны
  console.log("Месяцы пересобраны по порядку (строк: " + out.length + ").");
}

/** Приводит месяцы в порядок: пересборка, если они перепутаны, иначе только недостающие шапки. */
function fixMonths_(sheet, force) {
  if (sheet.getLastRow() < 2) { // в листе нет ни одного события: шапка текущего месяца всё равно нужна
    const head = sheet.getLastRow() >= 1 ? sheet.getRange(1, 1, 1, Math.max(2, sheet.getLastColumn())).getDisplayValues() : [];
    if (!head.length || layoutOf(head).v !== 2) return 0;
    sheet.getRange(2, 1).setNumberFormat("@").setValue(monthTitle_(todayIso(Date.now())));
    return 1;
  }
  const rows = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(2, sheet.getLastColumn())).getDisplayValues();
  if (layoutOf(rows).v !== 2) return force ? ensureMonthHeaders_(sheet) : 0; // старый формат ещё не перенесён: порядок не трогаем
  const plan = columnPlan("schedule", rows[0]);
  if (plan && plan.perm[0] !== 0) return 0; // колонку «Дата» переставили: порядок наводить не будем, пока не вернут вид
  if (monthsDisordered_(rows, todayIso(Date.now()))) { rebuildMonths_(sheet); return 1; }
  return ensureMonthHeaders_(sheet);
}

const colLetter_ = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
/** Цвет текста на цветной ячейке: тёмный на светлых цветах, белый на тёмных. */
const inkHex_ = (hex) => { const n = parseInt(String(hex).slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 170 ? C.navy : C.white; };

/**
 * Правила окраски «Расписания»: выбранная площадка красится в свой цвет (правило выше всех), остальное — чередование строк белый / светло-голубой
 * (кроме шапок месяцев). Правилами, чтобы новые строки красились сами.
 */
function scheduleRules_(sheet) {
  const cols = Math.max(2, sheet.getLastColumn());
  const rows = Math.max(sheet.getMaxRows() - 1, 1);
  const banding = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND(ISEVEN(ROW()),$A2<>"",NOT(REGEXMATCH($A2,"^[А-ЯЁ]+ [0-9]{4}$")),LEFT($A2,1)<>"▼")')
    .setBackground(C.light).setRanges([sheet.getRange(2, 1, rows, cols)]).build();
  const head = sheet.getRange(1, 1, 1, cols).getDisplayValues()[0];
  const out = [];
  const plan = layoutOf([head]).v === 2 ? columnPlan("schedule", head) : null;
  if (plan) {
    const hall = sheet.getRange(2, plan.perm[4] + 1, rows, 1);
    const letter = colLetter_(plan.perm[4] + 1);
    store_().venueList().forEach((v) => out.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=LOWER(TRIM($' + letter + '2))=LOWER("' + v.name.replace(/"/g, '""') + '")')
      .setBackground(v.hex).setFontColor(inkHex_(v.hex)).setBold(true).setRanges([hall]).build()));
  }
  // собрание (тип хранится в скрытом листе «_события» по ID события): вся строка в золотистой заливке, название жирным; цвет площадки остаётся
  const idIdx = head.findIndex((x) => isIdColumn(x));
  if (plan && idIdx >= 0) {
    const idL = colLetter_(idIdx + 1);
    const isMeeting = '=COUNTIFS(INDIRECT("\'' + TABS.meta + '\'!A:A"),$' + idL + '2,INDIRECT("\'' + TABS.meta + '\'!B:B"),"meeting")>0';
    const titleRange = sheet.getRange(2, plan.perm[3] + 1, rows, 1);
    out.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(isMeeting).setBackground("#FFE8A3").setBold(true).setRanges([titleRange]).build());
    out.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(isMeeting).setBackground("#FFF1C2").setRanges([sheet.getRange(2, 1, rows, cols)]).build());
  }
  return out.concat([banding]);
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
    if (MONTH_ROW_RE.test(t)) months.push({head: r, title: t, end: r, closed: false});
    else if (t === PAST_DIVIDER_) { if (months.length) months[months.length - 1].closed = true; }
    else if (months.length && !months[months.length - 1].closed && !isBlankRow_([col[r - 1][0]])) months[months.length - 1].end = r; // пустые строки и разделитель в группу месяца не входят
  }
  if (!months.length) return;
  const thisMonth = MONTHS_UP[+today.slice(5, 7) - 1] + " " + today.slice(0, 4);
  const monthKey = (t) => { const i = MONTHS_UP.indexOf(t.split(" ")[0]); return t.split(" ")[1] + String(i + 100); };
  sheet.setRowGroupControlPosition(SpreadsheetApp.GroupControlTogglePosition.BEFORE);
  months.forEach((m) => {
    const rows = m.end - m.head;
    if (rows < 1) return;
    let collapsed = false; // прошедшие месяцы не прячем: они просто лежат ниже разделителя
    if (!fresh) { const g = sheet.getRowGroup(m.head + 1, 1); if (g) collapsed = g.isCollapsed(); }
    const range = sheet.getRange(m.head + 1, 1, rows, 1);
    let depth = sheet.getRowGroupDepth(m.head + 1);
    if (depth > 1 || (depth === 1 && !sheet.getRowGroup(m.head + 1, 1))) { range.shiftRowGroupDepth(-depth); depth = 0; }
    if (depth === 0) range.shiftRowGroupDepth(1);
    const g = sheet.getRowGroup(m.head + 1, 1);
    if (g) { if (collapsed) g.collapse(); else g.expand(); }
  });
}

/**
 * Два тестовых сотрудника для проверки приложения «чужими глазами» (один раз, без повторов, если их удалят):
 *  • «Читатель Тестовый» — роль «Читатель», доступ есть: заходит в приложение и бот, но ничего не правит;
 *  • «Заблокированный Тестовый» — доступа нет (галочка «Доступ» снята): при входе увидит «Доступ закрыт».
 * Логины выдаются автоматически (колонка «Логин»). Номера выдуманные; удалить строки можно в любой момент.
 */
function seedTestUsers_(p) {
  if (p.getProperty("TEST_USERS")) return;
  p.setProperty("TEST_USERS", "1");
  try {
    const store = store_();
    const sheet = SpreadsheetApp.openById(prop_("SHEET_ID")).getSheetByName(TABS.staff);
    const rows = store.book.get(TABS.staff);
    const cols = store.staffCols_(rows);
    const plan = columnPlan("staff", sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 6)).getDisplayValues()[0]);
    const phys = (virtual) => (plan ? plan.perm[virtual] : virtual);
    const people = [
      ["Читатель Тестовый", "9990000001", "Читатель", true, "Тестовый пользователь: проверка приложения от лица читателя. Можно удалить."],
      ["Заблокированный Тестовый", "9990000002", "Читатель", false, "Тестовый пользователь без доступа: вход должен быть закрыт. Можно удалить."],
    ];
    people.forEach(([name, phone, role, access, note]) => {
      const cur = store.book.get(TABS.staff);
      if (cur.some((r, i) => i > 0 && String(r[1] || "").replace(/\D/g, "").endsWith(phone))) return;
      let at = cur.findIndex((r, i) => i > 0 && !String(r[0] || "").trim() && !String(r[1] || "").trim());
      if (at < 0) at = cur.length;
      store.book.setCell(TABS.staff, at + 1, 1, name);
      store.book.setCell(TABS.staff, at + 1, 2, phone);
      store.book.setCell(TABS.staff, at + 1, 3, role);
      if (cols.access >= 0 && sheet) sheet.getRange(at + 1, phys(cols.access) + 1).setValue(access); // галочка «Доступ»
      if (cols.comment >= 0) store.book.setCell(TABS.staff, at + 1, cols.comment + 1, note);
    });
    dropAllCaches_();
    bumpRev_();
  } catch (err) { diag_("Тестовые пользователи: ОШИБКА — " + String(err && err.message ? err.message : err)); }
}

const STYLE_VERSION_ = "16"; // поднимайте, когда меняется оформление: таблица перестроится сама при ближайшем срабатывании таймера

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
/**
 * Пустые строки «Сотрудников» должны быть пустыми: иначе лист кажется заполненным до самого низа и новые люди и заявки уходят за тысячную строку.
 * Убираем значения-заготовки («Читатель», FALSE) из строк без ФИО и телефона, а строки, залетевшие далеко вниз, поднимаем на первое свободное место.
 */
function cleanStaffRows_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return false;
  const cols = Math.max(sheet.getLastColumn(), 6);
  const head = sheet.getRange(1, 1, 1, cols).getDisplayValues()[0];
  const plan = columnPlan("staff", head);
  const nameIdx = plan ? plan.perm[0] : 0;
  const phoneIdx = plan ? plan.perm[1] : 1;
  const vals = sheet.getRange(2, 1, last - 1, cols).getValues();
  const real = (r) => String(r[nameIdx]).trim() !== "" || String(r[phoneIdx]).trim() !== "";
  const out = vals.map((r) => (real(r) ? r.slice() : r.map(() => "")));
  const STRAY_FROM = 100; // строки глубже этого номера считаем «улетевшими» (обычно их там быть не может)
  for (let i = STRAY_FROM; i < out.length; i++) {
    if (!real(out[i])) continue;
    const free = out.findIndex((r, k) => k < i && !real(r));
    if (free < 0) break;
    out[free] = out[i];
    out[i] = out[i].map(() => "");
  }
  if (JSON.stringify(out) === JSON.stringify(vals)) return false;
  sheet.getRange(2, 1, out.length, cols).setValues(out);
  return true;
}

function tidyStaff_() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  const sheet = ss.getSheetByName(TABS.staff);
  if (!sheet || sheet.getLastRow() < 1) return;
  const p = PropertiesService.getScriptProperties();
  if (cleanStaffRows_(sheet)) { dropAllCaches_(); bumpRev_(); }
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
    if (String(data[r - 1][roleIdx]).trim() === "" && !/^заявка/i.test(name)) { sheet.getRange(r, roleIdx + 1).setNumberFormat("@").setValue("Читатель"); changed = true; }
    if (/^заявка/i.test(String(data[r - 1][roleIdx]).trim()) && /^(true|да|1)$/i.test(String(data[r - 1][accessIdx]).trim())) { // поставили «Доступ» у заявки: теперь это обычный сотрудник
      sheet.getRange(r, roleIdx + 1).setNumberFormat("@").setValue("Читатель"); changed = true;
    }
    if (!isPendingRow(name, data[r - 1][roleIdx]) && String(data[r - 1][accessIdx]).trim() === "") { sheet.getRange(r, accessIdx + 1).setValue(true); changed = true; }
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
  applyPeopleValidation_(sheet);
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
  if (sheet.getLastRow() > 1) {
    const n = sheet.getLastRow() - 1;
    const names = sheet.getRange(2, 1, n, 1).getValues();
    const cur = sheet.getRange(2, 3, n, 1).getValues();
    const next = cur.map(([v], i) => [String(names[i][0]).trim() === "" ? v : ({"": "Читатель"}[String(v).trim()] || (/директор/i.test(v) ? "Админ" : v))]); // пустые строки не трогаем
    sheet.getRange(2, 3, n, 1).setNumberFormat("@").setValues(next);
  }
  rng.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ROLE_LIST, true).setAllowInvalid(false).build());
  const rule = (text, bg, fg) => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(text).setBackground(bg).setFontColor(fg).setBold(true).setRanges([rng]).build();
  sheet.setConditionalFormatRules([rule("Админ", C.navy, C.white), rule("Редактор", C.blue, C.white), rule("Читатель", C.light, C.navy), rule("Заблокирован", C.coral, C.white), rule("Заявка", "#FFF2B3", C.navy)]);
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
    const ticks = people.map(([n]) => [String(n).trim() === "" ? "" : !/^заявка/i.test(String(n).trim())]); // пустые строки остаются пустыми
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
  const request = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=OR(REGEXMATCH($A2,"^(?i)заявка"),REGEXMATCH($C2,"^(?i)заявка"))').setBackground("#FFF2B3").setRanges([whole]).build();
  const off = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied("=AND($A2<>\"\",$" + A(accessCol) + "2=FALSE)").setBackground("#FBE0DF").setFontColor("#8A8A8A").setRanges([whole]).build();
  sheet.setConditionalFormatRules(rules.concat([request, off]));
}

/**
 * Скрытый лист «_люди»: актуальный список сотрудников с доступом (по алфавиту). Из него берутся выпадающие списки в «Расписании»,
 * поэтому в списках всегда все сотрудники и только они. Обновляется при любой правке «Сотрудников».
 */
function renderPeopleList_() {
  const names = store_().staffNames();
  const book = new GasBook();
  book.ensure(TABS.people, ["Сотрудники"]);
  const sh = book.sheet(TABS.people);
  const old = sh.getLastRow();
  const cur = old > 1 ? sh.getRange(2, 1, old - 1, 1).getDisplayValues().map((r) => r[0]) : [];
  if (JSON.stringify(cur) === JSON.stringify(names)) return false;
  if (old > 1) sh.getRange(2, 1, old - 1, 1).clearContent();
  if (names.length) sh.getRange(2, 1, names.length, 1).setNumberFormat("@").setValues(names.map((n) => [n]));
  return true;
}

/** Площадки без выбранного цвета получают свободный из палитры и записывают его в таблицу: цвет больше не «плавает» при добавлении новых. */
function fillVenueColors_() {
  const store = store_();
  const list = store.venueList();
  const todo = list.filter((v) => v.auto);
  todo.forEach((v) => store.book.setCell(TABS.venues, v.row, 3, v.color));
  // площадки поменялись (название или цвет): перекрашиваем столбец «Площадка» в «Расписании»
  const sig = JSON.stringify(list.map((v) => [v.name, v.hex]));
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty("VENUE_SIG") !== sig) {
    const sch = SpreadsheetApp.openById(prop_("SHEET_ID")).getSheetByName(TABS.schedule);
    if (sch) sch.setConditionalFormatRules(scheduleRules_(sch));
    p.setProperty("VENUE_SIG", sig);
  }
  return todo.length > 0;
}

/**
 * Должности = колонки-группы в «Сотрудниках».
 *  • Переименовали группу — в «Расписании» переименуется её колонка, все назначенные люди остаются (это не новая должность).
 *  • Добавили группу — в «Расписании» появляется новая колонка справа.
 *  • Удалили группу — колонка в «Расписании» и данные в ней остаются (ничего не стираем).
 * Названия групп запоминаются в свойстве GROUP_NAMES, по ним отличается «переименовали» от «добавили».
 */
function syncRoleColumns_() {
  const sheet = SpreadsheetApp.openById(prop_("SHEET_ID")).getSheetByName(TABS.schedule);
  if (!sheet || sheet.getLastColumn() < 1) return false;
  const readHead = () => sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map((x) => String(x).trim());
  let head = readHead();
  if (layoutOf([head]).v !== 2) return false;
  const p = PropertiesService.getScriptProperties();
  const names = store_().groups().map((g) => g.name);
  let prev = null;
  try { prev = JSON.parse(p.getProperty("GROUP_NAMES") || "null"); } catch (e) { prev = null; }
  const indexOfName = (n) => head.findIndex((x) => x && !x.startsWith(RESTORE_MARK) && norm(x) === norm(n));
  let changed = false;
  const rename = (from, to) => {
    const i = indexOfName(from);
    if (i < 0 || indexOfName(to) >= 0) return;
    sheet.getRange(1, i + 1).setNumberFormat("@").setValue(to);
    head = readHead();
    changed = true;
  };
  if (Array.isArray(prev) && prev.length === names.length) {
    names.forEach((n, i) => { if (norm(prev[i]) !== norm(n)) rename(prev[i], n); }); // та же колонка, новое название
  } else if (!prev) {
    // первое включение: чиним уже случившийся «дубль» (группу переименовали, а в расписании остался старый столбец и добавился пустой новый)
    const history = ["Актёры", "Техника", "Зал"].map(norm);
    const nowSet = new Set(names.map(norm));
    const idxs = head.map((x, i) => i).filter((i) => head[i] && !head[i].startsWith(RESTORE_MARK) && i >= 5 && !isIdColumn(head[i]));
    const orphans = idxs.filter((i) => history.indexOf(norm(head[i])) >= 0 && !nowSet.has(norm(head[i])));
    const lastRow = Math.max(sheet.getLastRow(), 1);
    const isEmpty = (i) => lastRow < 2 || sheet.getRange(2, i + 1, lastRow - 1, 1).getDisplayValues().every(([v]) => String(v).trim() === "");
    const fresh = idxs.filter((i) => nowSet.has(norm(head[i])) && history.indexOf(norm(head[i])) < 0 && isEmpty(i));
    if (orphans.length === 1 && fresh.length === 1) {
      const to = head[fresh[0]];
      sheet.deleteColumn(fresh[0] + 1); // пустой «лишний» столбец убираем
      head = readHead();
      const from = head[orphans[0] > fresh[0] ? orphans[0] - 1 : orphans[0]];
      const i = head.findIndex((x) => x === from);
      sheet.getRange(1, i + 1).setNumberFormat("@").setValue(to); // а в старом остаются все данные, он просто получает новое название
      head = readHead();
      changed = true;
    }
  }
  const have = new Set(head.filter((x) => x && !x.startsWith(RESTORE_MARK)).map((x) => norm(x)));
  const missing = names.filter((n) => !have.has(norm(n)));
  if (missing.length) {
    let at = 0;
    head.forEach((x, i) => { if (x && !x.startsWith(RESTORE_MARK)) at = i + 1; });
    const btn = head.findIndex((x) => x.startsWith(RESTORE_MARK));
    if (btn >= 0 && btn === at) sheet.getRange(1, btn + 1).clear(); // красная кнопка стояла на этом месте: ближайшая проверка поставит её правее
    sheet.getRange(1, at + 1, 1, missing.length).setNumberFormat("@").setValues([missing]);
    changed = true;
  }
  p.setProperty("GROUP_NAMES", JSON.stringify(names));
  if (!changed) return false;
  styleSchedule_(sheet);
  dropAllCaches_();
  bumpRev_();
  return true;
}

/**
 * Служебная колонка «ID» (скрытая) в «Расписании»: у каждого события свой короткий номер, по нему находятся комментарии, файлы и тип «Собрание».
 * Добавляется справа сама; строкам без номера (например, вписанным руками) номера выдаются при ближайшей проверке.
 */
function ensureEventIds_() {
  const sheet = SpreadsheetApp.openById(prop_("SHEET_ID")).getSheetByName(TABS.schedule);
  if (!sheet || sheet.getLastColumn() < 1) return false;
  const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map((x) => String(x).trim());
  if (layoutOf([head]).v !== 2) return false;
  let changed = false;
  if (!head.some((x) => isIdColumn(x))) {
    let at = 0;
    head.forEach((x, i) => { if (x && !x.startsWith(RESTORE_MARK)) at = i + 1; });
    const btn = head.findIndex((x) => x.startsWith(RESTORE_MARK));
    if (btn >= 0 && btn === at) sheet.getRange(1, btn + 1).clear();
    sheet.getRange(1, at + 1).setNumberFormat("@").setValue("ID");
    styleHeaderRange_(sheet.getRange(1, at + 1));
    sheet.setColumnWidth(at + 1, 80);
    sheet.hideColumns(at + 1);
    dropAllCaches_();
    changed = true;
  }
  const book = new GasBook();
  const table = book.get(TABS.schedule);
  const col = rowColumns(table).findIndex((c) => isIdColumn(c));
  if (col < 0) return changed;
  const vcol = col + layoutOf(table).roleStart + 1; // номер колонки в «каноническом» виде (учитывает переставленные колонки)
  const events = parseEvents(table, todayIso(Date.now()));
  const used = new Set(events.map((e) => e.id).filter(Boolean));
  events.filter((e) => !e.id).forEach((e) => {
    let id;
    do { id = Utilities.getUuid().replace(/-/g, "").slice(0, 8); } while (used.has(id));
    used.add(id);
    book.setCell(TABS.schedule, e.row, vcol, id);
    changed = true;
  });
  if (changed) { dropAllCaches_(); bumpRev_(); }
  return changed;
}

/** Колонки с людьми в «Расписании» (всё правее «Площадки») — выпадающие списки сотрудников. Вписать другое можно, но клетка получит отметку. */
function applyPeopleValidation_(sheet) {
  const people = sheet.getParent().getSheetByName(TABS.people);
  if (!people || sheet.getLastColumn() < 1) return;
  const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  if (layoutOf([head]).v !== 2) return;
  const plan = columnPlan("schedule", head);
  if (!plan) return;
  const rule = SpreadsheetApp.newDataValidation().requireValueInRange(people.getRange("A2:A1000"), true).setAllowInvalid(true).build();
  const rows = Math.max(sheet.getMaxRows() - 1, 1);
  plan.perm.slice(5).filter((col) => !isIdColumn(head[col])).forEach((col) => sheet.getRange(2, col + 1, rows, 1).setDataValidation(rule));
}

const OCC_COL_ = 4; // таблица занятости лежит в листе «Площадки» правее названий: колонки D–H
const OCC_HEAD_ = ["Дата", "Время", "Площадка", "Событие", "Пересечение"];

/**
 * Занятость площадок по месяцам и по времени: справа от списка площадок. Текущий и будущие месяцы сверху, прошедшие внизу (серым).
 * Строки с пересечением по времени подсвечены. Обновляется само при любой правке расписания.
 */
function renderOccupancy_() {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  const sheet = ss.getSheetByName(TABS.venues);
  if (!sheet) return;
  const today = todayIso(Date.now());
  const book = new GasBook();
  const table = book.get(TABS.schedule);
  const metaMap = store_().metaMap();
  const rows = occupancyRows(parseEvents(table, today), today, (e) => Boolean(e.id && metaMap[e.id] && metaMap[e.id].kind === "meeting"));
  const hexOf = {};
  store_().venueList().forEach((v) => { hexOf[norm(v.name)] = v.hex; });
  const width = OCC_HEAD_.length;
  const total = Math.max(sheet.getMaxRows(), rows.length + 2);
  if (sheet.getMaxRows() < rows.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  const area = sheet.getRange(1, OCC_COL_, Math.max(sheet.getMaxRows(), 2), width);
  area.breakApart();
  area.clear();
  sheet.getRange(1, OCC_COL_, 1, width).setNumberFormat("@").setValues([OCC_HEAD_]);
  styleHeaderRange_(sheet.getRange(1, OCC_COL_, 1, width));
  [90, 120, 170, 260, 220].forEach((w, i) => sheet.setColumnWidth(OCC_COL_ + i, w));
  if (!rows.length) {
    sheet.getRange(2, OCC_COL_, 1, width).setNumberFormat("@").setValues([["Событий с площадкой пока нет", "", "", "", ""]]);
    return;
  }
  const values = rows.map((r) => (r.kind === "month" ? [r.title, "", "", "", ""] : [r.date, r.time, r.venue, (r.meeting ? "📋 " : "") + r.title, r.clash ? "⚠ " + r.clash : ""]));
  sheet.getRange(2, OCC_COL_, values.length, width).setNumberFormat("@").setValues(values).setWrap(true).setVerticalAlignment("middle").setFontColor(C.navy);
  rows.forEach((r, i) => {
    const line = sheet.getRange(2 + i, OCC_COL_, 1, width);
    if (r.kind === "month") {
      line.merge().setBackground(r.past ? "#6B7F9E" : C.navy).setFontColor(C.white).setFontWeight("bold").setHorizontalAlignment("center").setFontSize(12);
      sheet.setRowHeight(2 + i, 30);
    } else {
      if (r.clash) line.setBackground("#FBE0DF");
      else if (r.meeting) line.setBackground("#FFF1C2"); // собрание выделено золотистым
      else if (r.past) line.setFontColor("#8A8A8A");
      const hex = hexOf[norm(r.venue)];
      if (hex) sheet.getRange(2 + i, OCC_COL_ + 2).setBackground(hex).setFontColor(C.white).setFontWeight("bold"); // цвет площадки
    }
  });
}

/**
 * Лист «Отчёты»: каждый отчёт — отдельный блок одного размера (REPORT_HEIGHT строк, 7 колонок). Новый встаёт на самый верх,
 * на нём красная метка «ПОСЛЕДНИЙ»; прежние сдвигаются вниз. Хранится последние REPORT_KEEP_ отчётов.
 */
const REPORT_KEEP_ = 15;
const REPORT_WIDTHS_ = [130, 110, 160, 250, 130, 90, 330];
function saveReport_(report, by) {
  const ss = SpreadsheetApp.openById(prop_("SHEET_ID"));
  let sheet = ss.getSheetByName(TABS.reports);
  if (!sheet) {
    sheet = ss.insertSheet(TABS.reports);
    REPORT_WIDTHS_.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    sheet.setHiddenGridlines(true);
  }
  const p = PropertiesService.getScriptProperties();
  const number = Number(p.getProperty("REPORT_NO") || "0") + 1;
  p.setProperty("REPORT_NO", String(number));
  const H = REPORT_HEIGHT, W = REPORT_WIDTH;
  const when = Utilities.formatDate(new Date(), "Europe/Moscow", "dd.MM.yyyy HH:mm");
  const block = reportBlock(report, number, {when, by: by || ""});
  sheet.insertRowsBefore(1, H);
  const area = sheet.getRange(1, 1, H, W);
  area.breakApart();
  area.clear();
  if (sheet.getLastRow() > H) sheet.getRange(H + 1, W).setValue(""); // у прежнего отчёта метка «последний» снимается
  area.setNumberFormat("@").setValues(block.rows).setFontColor(C.navy).setVerticalAlignment("middle").setFontFamily("Arial");
  sheet.getRange(1, 1, 1, W - 1).merge().setBackground(C.navy).setFontColor(C.white).setFontWeight("bold").setFontSize(14);
  sheet.getRange(1, W).setValue("● ПОСЛЕДНИЙ").setBackground(C.coral).setFontColor(C.white).setFontWeight("bold").setHorizontalAlignment("center");
  sheet.getRange(2, 1, 1, W).merge().setBackground(C.light);
  sheet.getRange(3, 1, 1, W).merge().setBackground(C.cream).setFontWeight("bold");
  styleHeaderRange_(sheet.getRange(4, 1, 1, W));
  const first = REPORT_HEAD + 1, last = REPORT_HEAD + REPORT_CAP;
  sheet.getRange(first, 1, REPORT_CAP, W).setWrap(true).setBackground(C.white);
  for (let i = 1; i < REPORT_CAP; i += 2) sheet.getRange(first + i, 1, 1, W).setBackground("#F1F8FC");
  sheet.getRange(4, 1, REPORT_CAP + 2, W).setBorder(true, true, true, true, true, true, "#B7CDE0", SpreadsheetApp.BorderStyle.SOLID);
  sheet.getRange(last + 1, 1, 1, W).setBackground(C.light).setFontWeight("bold");
  sheet.getRange(last + 2, 1, 1, W).merge().setFontColor(C.coral).setFontSize(9).setWrap(true);
  sheet.setRowHeight(1, 34); sheet.setRowHeight(2, 24); sheet.setRowHeight(3, 28); sheet.setRowHeight(4, 30);
  for (let r = first; r <= last; r++) sheet.setRowHeight(r, 34);
  sheet.setRowHeight(last + 1, 28); sheet.setRowHeight(last + 2, 24);
  for (let r = last + 3; r <= H; r++) sheet.setRowHeight(r, 21);
  const keep = REPORT_KEEP_ * H;
  if (sheet.getMaxRows() > keep) sheet.deleteRows(keep + 1, sheet.getMaxRows() - keep);
  return {number, rows: block.shown, url: "https://docs.google.com/spreadsheets/d/" + prop_("SHEET_ID") + "/edit#gid=" + sheet.getSheetId()};
}

function styleHeaderRange_(range) {
  range.setBackground(C.blue).setFontColor(C.white).setFontWeight("bold").setHorizontalAlignment("center").setVerticalAlignment("middle").setWrap(true);
}

function styleVenues_(sheet) {
  if (String(sheet.getRange(1, 3).getValue()).trim() === "") sheet.getRange(1, 3).setNumberFormat("@").setValue("Цвет");
  styleHeader_(sheet, 3);
  sheet.setColumnWidth(1, 220);
  sheet.setColumnWidth(2, 200);
  sheet.setColumnWidth(3, 130);
  sheet.setColumnWidth(4, 90);
  sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 2).setFontColor(C.navy).setVerticalAlignment("middle");
  // цвет площадки: выбирается из списка, ячейка красится в этот цвет (тот же цвет у плашек в приложении)
  const colors = sheet.getRange(2, 3, Math.max(sheet.getMaxRows() - 1, 1), 1);
  colors.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(VENUE_COLORS.map((c) => c.name), true).setAllowInvalid(false).build())
    .setHorizontalAlignment("center").setVerticalAlignment("middle").setFontWeight("bold");
  const names = sheet.getRange(2, 1, Math.max(sheet.getMaxRows() - 1, 1), 1);
  sheet.setConditionalFormatRules([].concat(
    VENUE_COLORS.map((c) => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(c.name).setBackground(c.hex).setFontColor(inkHex_(c.hex)).setRanges([colors]).build()),
    VENUE_COLORS.map((c) => SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=AND($A2<>"",$C2="' + c.name + '")').setBackground(c.hex).setFontColor(inkHex_(c.hex)).setBold(true).setRanges([names]).build())));
}
