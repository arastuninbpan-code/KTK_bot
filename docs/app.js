"use strict";
const CFG = window.KTK || {};
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
// цвета меток разделов (Администратор, Гардероб, Касса…): по порядку колонок таблицы, из палитры
const TAG_COLORS = [["#0A96DC", "#fff"], ["#F2961E", "#fff"], ["#F04E4A", "#fff"], ["#F4C79A", "#1B3560"], ["#1B3560", "#fff"], ["#D4F1FC", "#1B3560"]];

const state = {token: localStorage.getItem("ktk_token") || "", me: null, events: [], roles: [], allRoles: [], staff: [], venues: [], venueColors: {}, palette: [], groups: [], layout: 2, rev: "", today: "", day: "", calMonth: "", tab: "all", ready: false, offline: false, savedAt: 0, unavailable: {}, avatars: {}, avatarKey: ""};
const root = document.getElementById("root");

// ---------- разметка без innerHTML ----------
const BOOL_ATTRS = new Set(["disabled", "checked", "selected", "hidden", "inert", "readonly", "required", "autofocus"]);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null || (BOOL_ATTRS.has(k) && !v)) continue; // disabled: 0 и т.п. не должно включать атрибут
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};

// ---------- рисованные значки: толстый контур, скруглённые концы ----------
const ICONS = {
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.3M4 4v4h4M4 13a8 8 0 0 0 14.5 4.3M20 20v-4h-4"/>',
  exit: '<path class="fill-l" d="M4 3h9v18H4z"/><path d="M16 8l4 4-4 4M20 12H10"/>',
  pencil: '<path class="fill-c" d="M4 20l1.2-4.6L16.6 4a2.2 2.2 0 0 1 3.2 3.2L8.4 18.8z"/><path d="M14.6 6.2l3.2 3.2"/>',
  trash: '<path class="fill-l" d="M6 8h12l-1 12H7z"/><path d="M4 8h16M9 8V5h6v3M10 12v5M14 12v5"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  plane: '<path class="fill-l" d="M3 11.5L21 3l-7.5 18-2.7-7.3z"/><path d="M10.8 13.7L21 3"/>',
  pin: '<path class="fill-o" d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle class="fill-w" cx="12" cy="10" r="2.2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path class="fill-r" d="M12 3l10 18H2z"/><path d="M12 10v5M12 18.2v.1"/>',
  chart: '<path class="fill-l" d="M4 4h16v16H4z"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
  group: '<circle class="fill-l" cx="9" cy="8" r="3.2"/><circle class="fill-c" cx="17" cy="9" r="2.6"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6M15.5 14.3c3 0 5.5 2 5.5 5"/>',
};
const icon = (name, cls = "") => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("class", "ico " + cls); s.setAttribute("aria-hidden", "true"); s.innerHTML = ICONS[name]; return s; };
// «брызги» — срочное
const splash = () => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 30 30"); s.setAttribute("class", "splash"); s.setAttribute("aria-hidden", "true"); s.innerHTML = '<path d="M15 2v9M4 6l6 6M26 6l-6 6"/>'; return s; };
// облачко с тремя точками — загрузка и пустые состояния
const cloud = () => { const w = h("div", {class: "cloud", "aria-hidden": "true"}); w.innerHTML = '<svg viewBox="0 0 132 104"><path d="M22 12h78a14 14 0 0 1 14 14v34a14 14 0 0 1-14 14H62l-22 22V74H22a14 14 0 0 1-14-14V26a14 14 0 0 1 14-14z"/></svg><div class="dots"><i></i><i></i><i></i></div>'; return w; };

// ---------- мелочи ----------
const roleText = (r) => String(r || "").replace(/\s*\/\s*/g, " / ");
const dateParts = (iso) => { const [y, m, d] = iso.split("-").map(Number); return {d, m: MONTHS[m - 1], wd: WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}; };
const dayTitle = (iso) => { const p = dateParts(iso); return `${p.wd}, ${p.d} ${p.m}`; };
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const shortDate = (iso) => { const p = dateParts(iso); return `${p.d} ${p.m.slice(0, 3)}`; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// ---------- занятость площадок (те же правила, что на сервере) ----------
const DEFAULT_MIN = 120; // нет времени окончания — считаем, что событие идёт 2 часа
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const fmtMin = (m) => String(Math.floor(m / 60) % 24).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const hallKey = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").split(/\s+/).filter(Boolean).join(" ");
function slotsOf(e) {
  const starts = String(e.time || "").split(/,\s*/).map(toMin).filter((x) => x !== null);
  if (e.dateEnd || !starts.length) return [[0, 1440]];
  const end = starts.length === 1 ? toMin(e.end) : null;
  return starts.map((a) => [a, end !== null && end > a ? end : Math.min(a + DEFAULT_MIN, 1500)]);
}
const onDay = (e, day) => e.date <= day && day <= (e.dateEnd || e.date);
const rangesMeet = (a, b) => a.date <= (b.dateEnd || b.date) && b.date <= (a.dateEnd || a.date);
const slotsMeet = (a, b) => slotsOf(a).some(([x, y]) => slotsOf(b).some(([u, v]) => x < v && u < y));
/** События, которые мешают `draft` на той же площадке. */
const conflictsFor = (draft) => (!draft.hall || !draft.date ? [] : state.events.filter((e) => e.row !== draft.row && hallKey(e.hall) === hallKey(draft.hall) && rangesMeet(e, draft) && slotsMeet(e, draft)));
const timeLabel = (e) => (e.time ? e.time.split(/,\s*/).join(" и ") + (e.end ? "–" + e.end : "") : e.dateEnd ? "несколько дней" : "весь день");
const tagStyle = (role) => { const all = state.allRoles && state.allRoles.length ? state.allRoles : state.roles; const i = Math.max(0, all.indexOf(role)) % TAG_COLORS.length; return `background:${TAG_COLORS[i][0]};color:${TAG_COLORS[i][1]}`; };
const tag = (role) => h("span", {class: "tag", style: tagStyle(role)}, roleText(role));

/** Смена начинается в ближайший час (по Москве)? Тогда карточка «срочная». */
/** Событие идёт прямо сейчас: сегодня, время начала уже наступило, конец (или 2 часа без указанного конца) ещё нет. */
function isNow(e) {
  if (e.dateEnd || !e.time) return false;
  const now = new Date(Date.now() + 3 * 3600e3);
  if (e.date !== now.toISOString().slice(0, 10)) return false;
  const m = /(\d{1,2}):(\d{2})/.exec(e.time);
  if (!m) return false;
  const start = +m[1] * 60 + +m[2];
  const em = /(\d{1,2}):(\d{2})/.exec(e.end || "");
  let end = em ? +em[1] * 60 + +em[2] : start + 120;
  if (end <= start) end = start + 120;
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  return cur >= start && cur < end;
}
function isSoon(e) {
  if (e.date !== state.today || !e.time) return false;
  const m = /(\d{1,2}):(\d{2})/.exec(e.time);
  if (!m) return false;
  const now = new Date(Date.now() + 3 * 3600e3);
  const diff = (+m[1] * 60 + +m[2]) - (now.getUTCHours() * 60 + now.getUTCMinutes());
  return diff > 0 && diff <= 60;
}

let toastTimer;
function toast(text, {bad = false, plane = false} = {}) {
  const t = document.getElementById("toast");
  t.replaceChildren(icon(bad ? "alert" : plane ? "plane" : "check", plane && !bad ? "sway" : ""), text);
  t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 3400);
}

// ---------- запросы к серверу ----------
const UPDATING_MSG = "Сервер Google сейчас обновляется. Повторим через несколько секунд.";
async function api(method, path, body) {
  let status, data;
  if (window.KTK_DEMO) {
    ({status, data} = window.KTK_DEMO.call(method, path, body, state.token));
  } else if (CFG.API_URL) {
    // text/plain — «простой» запрос, без предварительной проверки CORS (Apps Script её не поддерживает)
    let r, raw = "";
    try {
      // Apps Script иногда «просыпается» долго и обрывает первый запрос — пробуем ещё раз (только чтение: запись повторять нельзя)
      for (let attempt = 0; ; attempt++) {
        try {
          const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
          try {
            r = await fetch(CFG.API_URL, {method: "POST", headers: {"Content-Type": "text/plain;charset=utf-8"}, redirect: "follow", signal: ctl.signal, body: JSON.stringify({method, path, token: state.token, body})});
            raw = await r.text();
          } finally { clearTimeout(timer); }
          break;
        } catch (e) { if (method !== "GET" || attempt >= 1) throw e; }
      }
    } catch (e) {
      const err = new Error(navigator.onLine === false ? "Нет интернета" : "Нет связи с сервером (" + e.message + "). Проверьте, что доступ веб-приложения «Все», а не «Только я».");
      err.offline = true;
      throw err;
    }
    try { data = JSON.parse(raw); } catch (e) { const er = new Error(UPDATING_MSG); er.transient = true; throw er; } // страница ошибки Google (обычно во время обновления сервера)
    status = data._status || (data && data.error ? 500 : (r.ok ? 200 : r.status));
  } else {
    const r = await fetch(method === "GET" && body ? path + "?" + new URLSearchParams(body) : path, {method, headers: {"Content-Type": "application/json", ...(state.token ? {Authorization: "Bearer " + state.token} : {})}, body: method === "GET" ? undefined : JSON.stringify(body || {})});
    data = await r.json().catch(() => ({}));
    status = r.status;
  }
  if (status === 401 && state.token) { logout(true); throw new Error("Войдите заново"); }
  if (status >= 400) {
    const msg = String(data.error || "Ошибка");
    const transient = /^Google ответил не так|^Воркер не дождался Google/.test(msg); // сервер Google обновляется или не успел ответить: это временно
    const e = new Error(transient ? UPDATING_MSG : msg); e.status = status; e.data = data; if (transient) e.transient = true; throw e;
  }
  return data;
}

// ---------- «сразу и красиво»: всё меняется на экране мгновенно, а на сервер уходит своим ходом ----------
// Каждая правка — маленькая запись в очереди. Очередь хранится на телефоне: если сервер не отвечает или нет интернета, запись
// ждёт и уходит позже (даже после перезапуска приложения). Пока она не ушла, правка накладывается поверх данных с сервера,
// поэтому на экране всё выглядит так, как задумал пользователь. Если сервер отказал по существу — покажем причину и вернём то, что у него.
const QKEY = "ktk_queue";
let queue = (() => { try { const q = JSON.parse(localStorage.getItem(QKEY) || "[]"); return Array.isArray(q) ? q : []; } catch (_) { return []; } })();
let sending = false, retryTimer = 0, retryMs = 4000, flushTimer = 0, needFlush = false;
const syncEl = (() => { const d = document.createElement("div"); d.className = "syncdot"; d.setAttribute("aria-hidden", "true"); document.body.append(d); return d; })();
const syncMark = () => syncEl.classList.toggle("on", queue.length > 0);
const saveQueue = () => { try { localStorage.setItem(QKEY, JSON.stringify(queue)); } catch (_) {} syncMark(); };
syncMark();
const newEventId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
const colorHex = (name) => ((state.palette || []).find((c) => c.name === name) || {}).hex || FALLBACK_HEX;
const tmpRow = (id) => -((parseInt(id || "0", 16) || Date.now()) + 1); // у ещё не отправленного события временный отрицательный номер строки

/** Накладывает одну правку из очереди на то, что показано на экране (повторное наложение ничего не портит). */
function applyOp(op) {
  if (op.t === "evNew" || op.t === "evEdit") {
    const prev = state.events.find((x) => (op.id ? x.id === op.id : x.row === op.row));
    const mine = Object.entries(op.event.roles || {}).filter(([, names]) => names.includes(state.me.name)).map(([role]) => role);
    const local = {...op.event, id: op.id || "", mine, rev: "tmp", pending: true, row: prev ? prev.row : tmpRow(op.id), comments: prev ? prev.comments : 0, meta: op.meta || (prev && prev.meta) || {kind: "event", note: ""}};
    state.events = prev ? state.events.map((x) => (x === prev ? local : x)) : [...state.events, local];
    sortEvents();
  } else if (op.t === "evDel") {
    state.events = state.events.filter((x) => (op.id ? x.id !== op.id : x.row !== op.row));
  } else if (op.t === "vAdd") {
    if (!state.venues.some((v) => hallKey(v) === hallKey(op.name))) state.venues = [...state.venues, op.name];
    state.venueColors[op.name] = colorHex(op.color);
  } else if (op.t === "vColor") {
    state.venueColors[op.name] = colorHex(op.color);
  } else if (op.t === "vDel") {
    state.venues = state.venues.filter((v) => hallKey(v) !== hallKey(op.name));
    delete state.venueColors[op.name];
  } else if (op.t === "off") {
    state.me.off = [...new Set([...(state.me.off || []).filter((d) => !op.remove.includes(d)), ...op.add])].sort();
  }
}
const applyQueue = () => { for (const op of queue) { try { applyOp(op); } catch (_) {} } };

/** Добавляет правку в очередь и сразу показывает её. Несколько правок одного события, ещё не ушедшие на сервер, сливаются в одну. */
/** Через несколько секунд тишины просим сервер разослать уведомления о правках расписания одним сообщением. */
function scheduleFlush() {
  clearTimeout(flushTimer);
  if (!needFlush || !state.token) return;
  flushTimer = setTimeout(async () => {
    if (!state.token || queue.length) return;
    try { const r = await api("POST", "/api/flush"); if (r && r.pending) { flushTimer = setTimeout(() => api("POST", "/api/flush").catch(() => {}), 5000); } else needFlush = false; }
    catch (e) { /* не дошло: разошлёт минутный таймер сервера */ needFlush = false; }
  }, 10000);
}
function enqueue(op) {
  clearTimeout(flushTimer); // идут новые правки: пауза до рассылки начинается заново
  const evt = op.t.startsWith("ev");
  const busy = (i) => sending && i === 0; // первая запись, пока уходит, не трогаем
  if (evt && op.id) {
    const at = queue.findIndex((q, i) => q.id === op.id && q.t.startsWith("ev") && !busy(i));
    const found = at >= 0 ? queue[at] : null;
    if (found && op.t === "evEdit" && (found.t === "evNew" || found.t === "evEdit")) { Object.assign(found, {event: op.event, meta: op.meta || found.meta, force: op.force || found.force}); }
    else if (found && op.t === "evDel" && found.t === "evNew") { queue.splice(at, 1); } // создали и удалили, не отправив: на сервере ничего нет
    else if (found && op.t === "evDel") { queue.splice(at, 1); queue.push(op); }
    else queue.push(op);
  } else queue.push(op);
  applyOp(op);
  saveQueue();
  pumpQueue();
}
const sendOp = (op) => {
  const target = op.id ? "id-" + op.id : String(op.row);
  const byRow = op.id ? {} : {rev: op.rev};
  switch (op.t) {
    case "evNew": return api("POST", "/api/events", {event: op.event, id: op.id, force: op.force || undefined, meta: op.meta || undefined});
    case "evEdit": return api("PUT", `/api/events/${target}`, {event: op.event, ...byRow, force: op.force || undefined, meta: op.meta || undefined});
    case "evDel": return api("DELETE", `/api/events/${target}`, byRow);
    case "vAdd": return api("POST", "/api/venues", {name: op.name, color: op.color});
    case "vColor": return api("PUT", "/api/venues", {name: op.name, color: op.color});
    case "vDel": return api("DELETE", "/api/venues", {name: op.name});
    case "off": return api("POST", "/api/off", {add: op.add, remove: op.remove});
  }
  return Promise.resolve();
};
/** Сервер просто не ответил (нет сети, сбой Google): правку не теряем, пробуем позже. Отказ по существу (4xx) — нет. */
// «Не найдено» (адрес, а не событие) значит, что сервер ещё не обновился до этой версии сайта: правку не теряем, повторим позже
const retryable = (e) => Boolean(e.offline) || !e.status || e.status >= 500 || (e.status === 404 && e.message === "Не найдено");
async function pumpQueue() {
  if (sending || !state.token || !queue.length) return;
  clearTimeout(retryTimer);
  sending = true;
  let drained = true;
  while (queue.length && state.token) {
    const op = queue[0];
    try { await sendOp(op); if (op.t.startsWith("ev")) needFlush = true; queue.shift(); saveQueue(); retryMs = 4000; }
    catch (e) {
      if (!state.token) break;
      if (retryable(e)) {
        if (!e.offline && !e.transient) op.tries = (op.tries || 0) + 1; // пока сервер обновляется, правки ждут сколько нужно
        if ((op.tries || 0) < 6) { saveQueue(); drained = false; retryTimer = setTimeout(pumpQueue, retryMs); retryMs = Math.min(retryMs * 1.7, 30000); break; }
      }
      queue.shift(); saveQueue(); // отказ: правка не принята
      toast(e.message || "Не удалось сохранить", {bad: true});
    }
  }
  sending = false;
  if (state.token && drained) { scheduleFlush(); await load(false, true); } // сверяемся с сервером: события получают настоящие номера, отклонённое откатывается
}
const sortEvents = () => state.events.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
const offlineNow = () => state.offline || navigator.onLine === false;

/** Пустое обязательное поле: краснеет, трясётся, получает фокус; под ним — подсказка. */
function shakeBad(input, err, text) {
  err.textContent = text;
  input.classList.remove("bad"); void input.offsetWidth; input.classList.add("bad");
  try { input.scrollIntoView({block: "center", behavior: "smooth"}); input.focus({preventScroll: true}); } catch (_) {}
}

/** keepQueue: вход «истёк» сам, не по кнопке — несохранённые правки не выбрасываем, они уйдут после нового входа. */
function logout(keepQueue = false) {
  clearTimeout(retryTimer);
  if (!keepQueue) queue = [];
  try { localStorage.removeItem("ktk_token"); localStorage.removeItem("ktk_cache"); if (!keepQueue) localStorage.removeItem(QKEY); } catch (_) {}
  sending = false;
  syncMark();
  Object.assign(state, {token: "", me: null, events: [], ready: false});
  render();
}

// ---------- панели как в DNA ----------
// Пока панель открыта, всё, что за ней, «заморожено» (inert): нельзя нажать, выделить, пролистать. Панели можно стопкой.
const overlays = [];
const setInert = (el, on) => (on ? el.setAttribute("inert", "") : el.removeAttribute("inert"));

function overlay(content, {center = false} = {}) {
  const ov = h("div", {class: "overlay" + (center ? " center" : ""), onclick: (e) => { if (e.target === ov) close(); }}, content);
  const onKey = (e) => { if (e.key === "Escape" && overlays[overlays.length - 1] === ov) close(); };
  const close = () => {
    ov.remove();
    document.removeEventListener("keydown", onKey);
    const i = overlays.indexOf(ov);
    if (i >= 0) overlays.splice(i, 1);
    const top = overlays[overlays.length - 1];
    if (top) setInert(top, false);
    else { setInert(root, false); document.body.classList.remove("modal-open"); }
  };
  overlays.forEach((o) => setInert(o, true));
  setInert(root, true);
  overlays.push(ov);
  document.body.classList.add("modal-open");
  document.addEventListener("keydown", onKey);
  document.body.append(ov);
  if (!center) swipeToClose(ov, close);
  return {ov, close};
}

/** Нижнюю панель можно «смахнуть» вниз: за ручку, а если содержимое прокручено до верха — за любое место. */
function swipeToClose(ov, close) {
  let y0 = null, dy = 0, t0 = 0, dragging = false;
  const sheetEl = () => ov.querySelector(".sheet");
  const begin = (y, target) => {
    const sh = sheetEl();
    if (!sh || !sh.contains(target)) return;
    if (sh.scrollTop > 0 && !target.closest(".handle")) return;
    const inner = target.closest && target.closest(".msgs"); // внутри переписки свайп вниз — это прокрутка сообщений
    if (inner && inner.scrollTop > 0 && !target.closest(".handle")) return;
    y0 = y; dy = 0; t0 = Date.now(); dragging = false;
  };
  const move = (y, ev) => {
    if (y0 === null) return;
    const sh = sheetEl();
    const d = y - y0;
    if (!dragging) {
      if (d < -6) { y0 = null; return; } // потянули вверх — это обычная прокрутка
      if (d < 8 || sh.scrollTop > 0) return;
      dragging = true; sh.style.animation = "none"; sh.style.transition = "none";
    }
    dy = Math.max(0, d);
    if (ev.cancelable) ev.preventDefault();
    sh.style.transform = `translateY(${dy}px)`;
    ov.style.background = `rgba(27,53,96,${0.55 * (1 - Math.min(1, dy / 420))})`;
  };
  const end = () => {
    if (y0 === null) return;
    const wasDragging = dragging, sh = sheetEl();
    y0 = null; dragging = false;
    if (!wasDragging || !sh) return;
    const fast = dy / Math.max(1, Date.now() - t0) > 0.6;
    if (dy > 110 || (fast && dy > 40)) {
      sh.style.transition = "transform .18s ease-in"; sh.style.transform = "translateY(105%)"; ov.style.background = "rgba(27,53,96,0)";
      setTimeout(close, 170);
    } else {
      sh.style.transition = "transform .2s"; sh.style.transform = ""; ov.style.background = "";
    }
  };
  ov.addEventListener("touchstart", (e) => begin(e.touches[0].clientY, e.target), {passive: true});
  ov.addEventListener("touchmove", (e) => move(e.touches[0].clientY, e), {passive: false});
  ov.addEventListener("touchend", end);
  ov.addEventListener("touchcancel", end);
  // мышь и перо: тянем за ручку
  ov.addEventListener("pointerdown", (e) => { if (e.pointerType !== "touch" && e.target.closest && e.target.closest(".handle")) { begin(e.clientY, e.target); ov.setPointerCapture(e.pointerId); } });
  ov.addEventListener("pointermove", (e) => { if (e.pointerType !== "touch") move(e.clientY, e); });
  ov.addEventListener("pointerup", (e) => { if (e.pointerType !== "touch") end(); });
}
const sheet = (...kids) => h("div", {class: "sheet", role: "dialog", "aria-modal": "true"}, h("div", {class: "handle"}), ...kids);

function confirmDialog(title, text, okLabel, onOk) {
  const {close} = overlay(h("div", {class: "modal", role: "alertdialog"}, h("h2", {}, title), h("p", {}, text),
    h("div", {class: "actions"}, h("button", {class: "btn light", onclick: () => close()}, "Отмена"), h("button", {class: "btn coral", onclick: async () => { close(); await onOk(); }}, okLabel))), {center: true});
}

// ---------- вход ----------
const LOGIN_LEN = 6; // логины, которые выдаёт таблица, — 6 знаков
function loginView() {
  let busy = false;
  const err = h("div", {class: "error", role: "alert"});
  const input = h("input", {class: "code-input", autocomplete: "username", autocapitalize: "characters", spellcheck: "false", maxlength: "32", placeholder: "ЛОГИН", "aria-label": "Ваш логин",
    oninput: () => { err.className = "error"; err.textContent = ""; input.classList.remove("bad"); if (input.value.trim().length > LOGIN_LEN) reject("Логин — " + LOGIN_LEN + " знаков. Проверьте, что не вставили лишнее."); },
    onkeydown: (e) => { if (e.key === "Enter") go(); }});
  const btn = h("button", {class: "btn", onclick: () => go()}, "Войти");
  // красная подсветка и дрожание поля при неверном логине
  function reject(text) {
    err.className = "error"; err.textContent = text;
    input.classList.remove("bad"); void input.offsetWidth; input.classList.add("bad");
  }
  async function go() {
    if (busy) return;
    if (!input.value.trim()) return reject("Введите ваш логин");
    if (input.value.trim().length > LOGIN_LEN) return reject("Логин — " + LOGIN_LEN + " знаков. Проверьте, что не вставили лишнее.");
    busy = true; btn.disabled = true; btn.textContent = "Входим…"; err.className = "hint"; err.textContent = "Идёт загрузка, подождите несколько секунд…"; input.disabled = true;
    try {
      const r = await api("POST", "/api/login", {login: input.value.trim()});
      state.token = r.token; localStorage.setItem("ktk_token", r.token);
      if (queue.length) pumpQueue(); // правки, оставшиеся с прошлого входа
      await load();
    } catch (e) { input.disabled = false; reject(e.message); input.focus(); } finally { busy = false; btn.disabled = false; btn.textContent = "Войти"; }
  }
  return h("main", {class: "login"},
    h("div", {class: "hero-wrap"}, h("img", {class: "hero", src: "avatar.webp", alt: "Пилот с бумажным самолётиком"}), splash()),
    h("h1", {}, "Расписание театра"),
    h("p", {class: "sub"}, "Ваши смены и события в одном месте"),
    h("div", {class: "card"},
      h("ol", {class: "steps"},
        h("li", {}, h("span", {}, "Откройте бота и поделитесь номером (или пришлите логин)")),
        h("li", {}, h("span", {}, ["Напишите боту ", h("b", {}, "/login"), ": он пришлёт ваш логин"])),
        h("li", {}, h("span", {}, "Введите логин здесь"))),
      input, err,
      h("div", {class: "stack"}, btn, h("a", {class: "btn light", href: CFG.BOT_URL || "#", target: "_blank", rel: "noopener"}, icon("plane"), "Открыть бота"))));
}

// ---------- расписание ----------
function eventCard(e) {
  const canEdit = state.me.canEdit;
  const starts = e.time ? e.time.split(/,\s*/) : [];
  const time = starts.length
    ? h("div", {class: "time"}, starts.map((t) => h("div", {}, t)), e.end ? h("div", {class: "until"}, "до " + e.end) : null)
    : h("div", {class: "time none"}, e.dateEnd ? "несколько дней" : "весь день");
  const range = e.dateEnd ? h("span", {class: "hall", style: "background:var(--cream)"}, `${shortDate(e.date)} — ${shortDate(e.dateEnd)}`) : null;
  const hall = e.hall ? h("span", {class: "hall"}, icon("pin"), cap(e.hall)) : null;
  const roles = Object.entries(e.roles).filter(([r]) => state.tab !== "mine" || e.mine.includes(r));
  const list = h("ul", {class: "roles"}, roles.map(([role, names]) => h("li", {class: e.mine.includes(role) ? "me" : ""}, tag(role), h("div", {class: "n"}, names.join(", ")))));
  const live = isNow(e);
  const urgent = !live && isSoon(e);
  const hex = e.hall ? hexOfHall(e.hall) : "";
  const outline = hex ? `border-color:${hex};box-shadow:3px 3px 0 ${hex}` : ""; // обводка цвета площадки (у «скоро» тоже: срочность видна по метке и времени)
  const meeting = Boolean(e.meta && e.meta.kind === "meeting");
  return h("button", {class: "ev" + (e.mine.length ? " mine" : "") + (urgent ? " urgent" : "") + (live ? " live" : "") + (meeting ? " meeting" : ""), style: outline, onclick: () => eventDetails(e), "aria-label": `Открыть: ${e.title}`},
    time,
    h("div", {}, live ? h("span", {class: "nowtag"}, "Идёт сейчас") : urgent ? h("span", {class: "soontag"}, "Скоро") : null, h("h3", {}, meeting ? h("span", {class: "mtag"}, "📋 Собрание") : null, e.title), range, hall, roles.length ? list : null, e.comments ? h("span", {class: "ccount"}, "💬 " + e.comments) : null),
    canEdit ? h("span", {class: "edit-hint"}, icon("pencil")) : (e.mine.length ? h("span", {class: "pill mine-tag"}, "вы") : null),
    urgent ? splash() : null);
}

function scheduleBody(canEdit) {
  const list = state.events.filter((e) => upcoming(e) && (state.tab === "all" || e.mine.length));
  const byDay = new Map();
  for (const e of list) {
    const key = e.date < state.today ? state.today : e.date; // многодневные события, которые уже идут, показываем под «Сегодня»
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }
  const body = h("div", {});
  if (!list.length) {
    body.append(h("div", {class: "empty"}, cloud(), h("h3", {}, state.tab === "mine" ? "Пока нет ваших смен" : "Событий пока нет"),
      canEdit ? h("div", {}, "Нажмите «+», чтобы добавить первое") : h("div", {}, "Как только появятся, мы пришлём сообщение в бота")));
  }
  let first = true;
  for (const [date, evs] of byDay) {
    const pill = date === state.today ? h("span", {class: "pill"}, "Сегодня") : date === addDays(state.today, 1) ? h("span", {class: "pill tom"}, "Завтра") : null;
    if (!first) body.append(h("hr", {class: "trail"}));
    first = false;
    body.append(h("div", {class: "day"}, h("h2", {}, dayTitle(date)), pill), ...evs.map(eventCard));
  }
  return body;
}

// ---------- площадки: календарь на месяц ----------
const FALLBACK_HEX = "#7A8699";
const MONTH_NAMES = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const hexOfHall = (hall) => {
  const k = hallKey(hall);
  if (!k) return FALLBACK_HEX;
  for (const [name, hex] of Object.entries(state.venueColors || {})) if (hallKey(name) === k) return hex;
  return FALLBACK_HEX;
};
/** Цвет текста на цветной плашке: тёмный на светлых цветах, белый на тёмных. */
const inkOn = (hex) => { const n = parseInt(String(hex).slice(1), 16); return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 170 ? "#1B3560" : "#fff"; };
const monthShift = (ym, n) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };
const upcoming = (e) => (e.dateEnd || e.date) >= state.today;
const startMin = (e) => { const m = toMin(String(e.time || "").split(/,\s*/)[0]); return m === null ? -1 : m; };

/** События по дням в промежутке [from, to] (многодневные попадают во все свои дни). */
function eventsByDay(from, to) {
  const map = new Map();
  for (const e of state.events) {
    const a = e.date > from ? e.date : from, b = (e.dateEnd || e.date) < to ? (e.dateEnd || e.date) : to;
    for (let d = a, guard = 0; d <= b && guard < 70; d = addDays(d, 1), guard++) { if (!map.has(d)) map.set(d, []); map.get(d).push(e); }
  }
  for (const list of map.values()) list.sort((x, y) => startMin(x) - startMin(y) || String(x.title).localeCompare(y.title));
  return map;
}

/** Ряд цветных кружков на выбор цвета площадки. */
function swatches(selected, onPick) {
  const palette = state.palette && state.palette.length ? state.palette : [{name: "Голубой", hex: "#0A96DC"}];
  return h("div", {class: "swatches", role: "radiogroup", "aria-label": "Цвет площадки"}, palette.map((c) =>
    h("button", {class: "swatch" + (selected === c.name ? " on" : ""), role: "radio", "aria-checked": String(selected === c.name), "aria-label": c.name, title: c.name, style: `background:${c.hex}`, onclick: () => onPick(c.name)}, selected === c.name ? icon("check") : null)));
}

// ---------- аватарки ----------
const AV_COLORS = ["#0A96DC", "#F2961E", "#E5484D", "#3DB16B", "#8E5BD0", "#E0509A", "#1BA8A0", "#3B5BDB"];
const initials = (name) => String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");
/** Кружок с аватаркой человека (из его профиля ВК/Telegram) или с инициалами, если фото нет. */
function avatarEl(uid, name, cls = "") {
  const color = AV_COLORS[[...String(uid || name)].reduce((a, c) => a + c.charCodeAt(0), 0) % AV_COLORS.length];
  const fallback = () => h("span", {class: "av " + cls, style: `background:${color}`, "aria-hidden": "true"}, initials(name));
  const url = state.avatars && state.avatars[uid];
  if (!url) return fallback();
  const img = h("img", {class: "av " + cls, src: url, alt: "", referrerpolicy: "no-referrer", loading: "lazy"});
  img.addEventListener("error", () => img.replaceWith(fallback()));
  return img;
}

async function loadAvatars(key) {
  try {
    const r = await api("GET", "/api/avatars");
    state.avatars = r.items || {}; state.avatarKey = r.key || key;
    try { localStorage.setItem("ktk_avatars", JSON.stringify({key: state.avatarKey, items: state.avatars})); } catch (_) {}
    render();
  } catch (_) { /* нет связи — останутся прошлые */ }
}

// ---------- фото в переписке и текст из документа ----------
const PHOTO_MAX_CHARS = 150000; // сколько знаков base64 принимает сервер (≈110 КБ картинки)
const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = () => rej(new Error("Не удалось прочитать файл")); r.readAsDataURL(blob); });

/** Фото сжимаем до размера, который помещается в хранилище: уменьшаем сторону и качество, пока не влезет. */
async function compressPhoto(file) {
  if (!/^image\//.test(file.type || "")) throw new Error(`«${file.name || "файл"}» — не фото. В переписку можно прикладывать только фотографии.`);
  let bmp;
  try { bmp = await createImageBitmap(file); } catch (_) { throw new Error("Не удалось открыть фото. Попробуйте другое."); }
  for (const side of [1280, 1024, 800, 640, 480]) {
    const k = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    for (const q of [0.78, 0.64, 0.5, 0.4]) {
      const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", q));
      if (blob && Math.ceil(blob.size * 4 / 3) <= PHOTO_MAX_CHARS) return {blob, preview: URL.createObjectURL(blob), name: file.name};
    }
  }
  throw new Error("Фото не удалось уменьшить. Попробуйте другое.");
}
async function uploadPhoto(p) {
  const r = await api("POST", "/api/photos", {data: await toBase64(p.blob)});
  return r.id;
}
const photoCache = new Map(); // номер -> data-ссылка (в памяти страницы)
/** Фото неизменяемы (у каждого свой номер), поэтому после первой загрузки хранятся на телефоне и в следующий раз появляются сразу. */
async function photoData(id) {
  if (photoCache.has(id)) return photoCache.get(id);
  try {
    if (window.caches) {
      const hit = await (await caches.open("ktk-photos")).match("/photo/" + id);
      if (hit) { const d = await hit.text(); photoCache.set(id, d); return d; }
    }
  } catch (_) { /* кеш недоступен — грузим с сервера */ }
  const r = await api("GET", "/api/photos", {id});
  photoCache.set(id, r.data);
  try { if (window.caches) (await caches.open("ktk-photos")).put("/photo/" + id, new Response(r.data)); } catch (_) {}
  return r.data;
}

// ---------- переписка: что видели в прошлый раз, показываем сразу ----------
const chatKey = (id) => "ktk_chat_" + id;
function chatCacheRead(id) { try { const c = JSON.parse(localStorage.getItem(chatKey(id)) || "null"); return c && Array.isArray(c.items) ? c : null; } catch (_) { return null; } }
function chatCacheWrite(id, items) {
  try {
    const clean = items.filter((m) => !m.failed && !String(m.id).startsWith("tmp")).slice(-80).map(({_prep, previews, pending, wasFailed, ...m}) => m);
    localStorage.setItem(chatKey(id), JSON.stringify({items: clean, at: Date.now()}));
    const idx = JSON.parse(localStorage.getItem("ktk_chat_idx") || "[]").filter((x) => x !== id); idx.push(id);
    while (idx.length > 40) { try { localStorage.removeItem(chatKey(idx.shift())); } catch (_) {} } // старые переписки не копим
    localStorage.setItem("ktk_chat_idx", JSON.stringify(idx));
  } catch (_) { /* не поместилось — не страшно */ }
}
/** Фоном подгружаем переписки событий, где появились новые сообщения, чтобы при входе они уже были на телефоне. */
let prefetching = false;
async function prefetchChats() {
  if (prefetching || offlineNow() || queue.length > 0) return;
  prefetching = true;
  try {
    const todo = state.events.filter((e) => e.id && e.comments > 0 && upcoming(e) && ((chatCacheRead(e.id) || {items: []}).items.length !== e.comments)).slice(0, 6);
    for (const e of todo) {
      if (offlineNow() || queue.length > 0) break;
      try { const r = await api("GET", "/api/comments", {event: e.id}); chatCacheWrite(e.id, r.items); for (const m of r.items.slice(-6)) for (const pid of m.photos || []) photoData(pid).catch(() => {}); } catch (_) { break; }
    }
  } finally { prefetching = false; }
}
/** Фото из переписки: пока грузится — серая заглушка; по нажатию открывается крупно. */
function photoEl(id, preview) {
  const img = h("img", {alt: "Фото", class: "chatimg"});
  const box = h("button", {class: "mimg", "aria-label": "Открыть фото", onclick: () => { if (img.src) showPhoto(img.src); }}, img);
  if (preview) img.src = preview;
  else photoData(id).then((d) => { img.src = d; }).catch(() => { box.classList.add("broken"); img.alt = "Фото не загрузилось"; });
  return box;
}
/** Просмотр фото: щипок двумя пальцами, двойное касание, колесо мыши, перетаскивание; кнопки «Скачать» и закрыть. */
function showPhoto(src) {
  let scale = 1, x = 0, y = 0, moved = false;
  const pts = new Map();
  let startDist = 0, startScale = 1, last = null, lastTap = 0;
  const img = h("img", {src, alt: "Фото", draggable: "false"});
  const stage = h("div", {class: "lbstage"}, img);
  const apply = () => {
    const w = stage.clientWidth, hh = stage.clientHeight; // нельзя утащить фото совсем за экран
    const mx = Math.max(0, (img.clientWidth * scale - w) / 2), my = Math.max(0, (img.clientHeight * scale - hh) / 2);
    x = Math.min(mx, Math.max(-mx, x)); y = Math.min(my, Math.max(-my, y));
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  const zoomTo = (v) => { scale = Math.min(6, Math.max(1, v)); if (scale === 1) { x = 0; y = 0; } apply(); };
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  stage.addEventListener("pointerdown", (e) => { stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, {x: e.clientX, y: e.clientY}); moved = false; if (pts.size === 2) { startDist = dist(); startScale = scale; } last = {x: e.clientX, y: e.clientY}; });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pts.size === 2) { moved = true; zoomTo(startScale * dist() / (startDist || 1)); return; }
    if (scale > 1 && last) { x += e.clientX - last.x; y += e.clientY - last.y; apply(); }
    if (last && Math.hypot(e.clientX - last.x, e.clientY - last.y) > 3) moved = true;
    last = {x: e.clientX, y: e.clientY};
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size) return;
    if (!moved) { // короткое касание: двойное приближает/возвращает, одиночное по фону закрывает
      const now = Date.now();
      if (now - lastTap < 320) { zoomTo(scale > 1 ? 1 : 2.5); lastTap = 0; }
      else { lastTap = now; setTimeout(() => { if (lastTap && Date.now() - lastTap >= 320 && scale === 1 && e.target === stage) close(); }, 340); }
    }
  };
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
  stage.addEventListener("wheel", (e) => { e.preventDefault(); zoomTo(scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2)); }, {passive: false});
  const save = () => {
    const mime = (/^data:([^;,]+)/.exec(src) || [])[1] || "image/jpeg";
    const a = h("a", {href: src, download: `photo-${Date.now()}.${mime.split("/")[1] === "jpeg" ? "jpg" : (mime.split("/")[1] || "jpg").replace(/[^a-z0-9]/gi, "")}`});
    document.body.append(a); a.click(); a.remove();
  };
  const {close} = overlay(h("div", {class: "lightbox"}, stage,
    h("div", {class: "lbbar"},
      h("button", {class: "lbbtn", "aria-label": "Уменьшить", onclick: () => zoomTo(scale / 1.5)}, "−"),
      h("button", {class: "lbbtn", "aria-label": "Приблизить", onclick: () => zoomTo(scale * 1.5)}, "+"),
      h("button", {class: "lbbtn wide", "aria-label": "Скачать фото", onclick: save}, "⬇ Скачать")),
    h("button", {class: "lbclose", "aria-label": "Закрыть", onclick: () => close()}, "×")), {center: true});
}
/** Окно выбора файла телефона/компьютера. */
function chooseFiles(multiple, cb, accept = "") {
  const input = h("input", {type: "file", multiple: multiple, accept: accept || null, style: "display:none"});
  input.addEventListener("change", () => { const list = [...input.files]; input.remove(); if (list.length) cb(list); });
  document.body.append(input); input.click();
}

// ----- текст из документа (docx / odt / txt / md): читается прямо на телефоне, никуда не загружается -----
const u16 = (v, o) => v.getUint16(o, true), u32 = (v, o) => v.getUint32(o, true);
/** Достаёт один файл из zip-архива (docx и odt — это zip). Нужны только «хранение» и deflate; распаковка средствами браузера. */
async function unzipEntry(buf, wanted) {
  const v = new DataView(buf), bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 70000); i--) if (u32(v, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Это не документ Word/ODT");
  let p = u32(v, eocd + 16);
  const count = u16(v, eocd + 10);
  for (let n = 0; n < count && u32(v, p) === 0x02014b50; n++) {
    const method = u16(v, p + 10), csize = u32(v, p + 20), nlen = u16(v, p + 28), elen = u16(v, p + 30), clen = u16(v, p + 32), local = u32(v, p + 42);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen));
    if (name === wanted) {
      const start = local + 30 + u16(v, local + 26) + u16(v, local + 28);
      const data = bytes.subarray(start, start + csize);
      if (method === 0) return new TextDecoder().decode(data);
      if (method !== 8 || typeof DecompressionStream === "undefined") throw new Error("Этот браузер не умеет открывать такие документы. Сохраните документ как .txt или вставьте текст вручную.");
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new TextDecoder().decode(await new Response(stream).arrayBuffer());
    }
    p += 46 + nlen + elen + clen;
  }
  throw new Error("В документе не нашлось текста");
}
/** Абзацы из XML документа: docx — w:p/w:t, odt — text:p/text:h. */
function xmlParagraphs(xml, para, run) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const out = [];
  const walk = (node) => {
    let text = "";
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { if (run === "odt") text += c.nodeValue; continue; }
      const t = c.localName;
      if (run === "docx" && t === "t") text += c.textContent;
      else if (t === "tab") text += "\t";
      else if (t === "br" || t === "line-break") text += "\n";
      else if (t === "s") text += " ".repeat(+c.getAttribute("text:c") || 1);
      else text += walk(c);
    }
    return text;
  };
  const all = [...doc.getElementsByTagName("*")].filter((n) => n.localName === para || (run === "odt" && n.localName === "h"));
  for (const n of all) { if (n.parentNode && [...(n.getElementsByTagName("*"))].some((x) => x.localName === para)) continue; out.push(walk(n).replace(/[ \t]+$/g, "")); }
  return out;
}
async function extractDocText(file) {
  if (file.size > 6 * 1024 * 1024) throw new Error("Документ слишком большой (больше 6 МБ).");
  const name = String(file.name || "").toLowerCase();
  let paragraphs;
  if (/\.(txt|md|csv|log)$/.test(name) || /^text\//.test(file.type || "")) paragraphs = (await file.text()).split(/\r?\n/);
  else if (/\.docx$/.test(name)) paragraphs = xmlParagraphs(await unzipEntry(await file.arrayBuffer(), "word/document.xml"), "p", "docx");
  else if (/\.odt$/.test(name)) paragraphs = xmlParagraphs(await unzipEntry(await file.arrayBuffer(), "content.xml"), "p", "odt");
  else throw new Error("Умею читать документы Word (.docx), .odt и текстовые (.txt). Для PDF откройте файл и скопируйте текст в описание.");
  const text = paragraphs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("В документе нет текста.");
  return text;
}

// ---------- переписка по событию ----------
const dayLabel = (ts) => {
  const d = new Date(ts), now = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, now)) return "Сегодня";
  if (same(d, new Date(now - 864e5))) return "Вчера";
  return d.toLocaleDateString("ru-RU", {day: "numeric", month: "long"});
};
const clockOf = (ts) => new Date(ts).toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit"});
const chatQueue = [];
let chatRunning = false;
async function pumpChat() {
  if (chatRunning) return;
  chatRunning = true;
  while (chatQueue.length) { const job = chatQueue.shift(); try { await job(); } catch (_) { /* ошибка уже показана в самом сообщении */ } }
  chatRunning = false;
}

/** Переписка по событию: как в мессенджере — пузыри, аватарки, вложения, поле ввода внизу. Писать и прикладывать файлы может любой сотрудник. */
function chatSheet(e) {
  if (e.pending) return toast("Обсуждение откроется, когда событие дойдёт до сервера", {bad: true});
  if (!e.id) return toast("Событие ещё готовится. Попробуйте через минуту.", {bad: true});
  const cached = chatCacheRead(e.id);
  let polling = false, items = cached ? cached.items.slice() : [], lastTs = items.reduce((a, m) => Math.max(a, m.ts), 0), attach = [], loaded = Boolean(cached);
  const msgs = h("div", {class: "msgs", role: "log", "aria-live": "polite"});
  const chips = h("div", {class: "attach-row"});
  const ta = h("textarea", {class: "input chat-input", rows: "1", placeholder: "Сообщение", "aria-label": "Сообщение",
    oninput: () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; }});
  const sendBtn = h("button", {class: "send", "aria-label": "Отправить", onclick: () => send()}, icon("plane"));
  const attachBtn = h("button", {class: "clip", "aria-label": "Прикрепить фото", onclick: () => {
    if (attach.length >= 4) return toast("К сообщению можно приложить до 4 фото", {bad: true});
    chooseFiles(true, async (list) => { for (const f of list.slice(0, 4 - attach.length)) { try { attach.push(await compressPhoto(f)); } catch (err) { toast(err.message, {bad: true}); } } paintChips(); }, "image/*");
  }}, "📷");
  const paintChips = () => chips.replaceChildren(...attach.map((a, i) => h("span", {class: "achip"}, h("img", {src: a.preview, alt: ""}), h("button", {"aria-label": "Убрать фото", onclick: () => { attach.splice(i, 1); paintChips(); }}, "×"))));
  const stick = () => { msgs.scrollTop = msgs.scrollHeight; };
  const paint = (toBottom) => {
    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    let lastDay = "";
    const nodes = [];
    for (const m of items) {
      const day = dayLabel(m.ts);
      if (day !== lastDay) { nodes.push(h("div", {class: "dsep"}, h("span", {}, day))); lastDay = day; }
      const files = (m.photos || []).map((id, i) => photoEl(id, m.previews && m.previews[i]));
      // пока сообщение уходит на сервер, оно выглядит как обычное отправленное: пользователю не важно, как система доставляет его в фоне
      const status = m.failed ? " · не отправлено, нажмите, чтобы повторить" : "";
      nodes.push(h("div", {class: "msg" + (m.mine ? " mine" : "") + (m.failed ? " failed" : ""), onclick: m.failed ? () => retry(m) : null},
        m.mine ? null : avatarEl(m.uid, m.name, "sm"),
        h("div", {class: "bubble"},
          m.mine ? null : h("b", {class: "mname"}, m.name),
          m.text ? h("p", {}, m.text) : null,
          files.length ? h("div", {class: "mfiles"}, ...files) : null,
          h("small", {class: "mtime"}, clockOf(m.ts) + status, m.canDelete && !m.failed ? h("button", {class: "mdel", "aria-label": "Удалить сообщение", onclick: (ev) => { ev.stopPropagation(); confirmDialog("Удалить сообщение?", "Оно пропадёт у всех.", "Удалить", () => del(m)); }}, "удалить") : null))));
    }
    if (!items.length) nodes.push(h("div", {class: "empty small"}, h("div", {}, loaded ? "Сообщений пока нет. Напишите первым: например, сможете ли вы быть на событии." : "Загружаю переписку…")));
    msgs.replaceChildren(...nodes);
    if (toBottom || nearBottom) stick();
  };
  const merge = (list) => {
    let added = false;
    for (const m of list) { lastTs = Math.max(lastTs, m.ts); if (!items.some((x) => x.id === m.id)) { items = items.filter((x) => !(x.pending && false)); items.push(m); added = true; } }
    items.sort((a, b) => a.ts - b.ts);
    return added;
  };
  const poll = async () => {
    if (!document.body.contains(ov) || offlineNow() || polling) return;
    polling = true;
    try { const r = await api("GET", "/api/comments", {event: e.id, since: lastTs}); if (merge(r.items)) { paint(); chatCacheWrite(e.id, items); } } catch (_) { /* нет связи — следующий раз */ } finally { polling = false; }
  };
  const push = (m) => {
    chatQueue.push(async () => {
      m.pending = true; m.failed = false;
      if (m.wasFailed) { m.wasFailed = false; paint(); }
      try {
        const ids = [];
        for (const a of m._prep || []) ids.push(await uploadPhoto(a));
        const r = await api("POST", "/api/comments", {event: e.id, text: m.text, photos: ids});
        // тихо подменяем «временные» данные настоящими, не перерисовывая пузырь (фото остаются те же, что были на экране)
        Object.assign(m, r.item, {pending: false, failed: false, previews: m.previews, photos: r.item.photos});
        items = items.filter((x) => x === m || x.id !== m.id);
        lastTs = Math.max(lastTs, m.ts);
        e.comments = (e.comments || 0) + 1;
        chatCacheWrite(e.id, items);
      } catch (err) { m.pending = false; m.failed = true; m.wasFailed = true; toast(err.message, {bad: true}); paint(); }
    });
    pumpChat();
  };
  const retry = (m) => push(m);
  const send = () => {
    const text = ta.value.trim();
    if (!text && !attach.length) return;
    if (offlineNow()) return toast("Нет интернета: сообщение можно отправить, когда появится сеть", {bad: true});
    const prep = attach;
    const m = {id: "tmp" + Date.now(), ts: Date.now(), uid: state.me.uid, name: state.me.name, text, mine: true, pending: true, canDelete: false,
      photos: prep.map((_, i) => "local" + i), previews: prep.map((a) => a.preview), _prep: prep};
    attach = []; ta.value = ""; ta.style.height = "auto"; paintChips();
    items.push(m); paint(true); push(m);
  };
  const del = async (m) => {
    items = items.filter((x) => x.id !== m.id); paint(); chatCacheWrite(e.id, items);
    if (String(m.id).startsWith("tmp")) return;
    try { await api("DELETE", "/api/comments", {id: m.id}); e.comments = Math.max(0, (e.comments || 1) - 1); } catch (err) { toast(err.message, {bad: true}); poll(); }
  };
  const title = h("div", {class: "chathead"}, h("b", {}, e.title), h("small", {}, `${shortDate(e.date)} · ${timeLabel(e)}`));
  const sh = sheet(title, msgs, chips, h("div", {class: "composer"}, attachBtn, ta, sendBtn));
  sh.classList.add("chat");
  const {ov} = overlay(sh);
  ta.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); send(); } });
  paint();
  if (items.length) paint(true);
  // сервер присылает полный список: убираем то, что удалили другие, а свои ещё не отправленные сообщения оставляем
  api("GET", "/api/comments", {event: e.id}).then((r) => {
    loaded = true;
    const mine = items.filter((m) => m.pending || m.failed || String(m.id).startsWith("tmp"));
    items = [...r.items, ...mine.filter((m) => !r.items.some((x) => x.id === m.id))].sort((a, b) => a.ts - b.ts);
    lastTs = items.reduce((a, m) => Math.max(a, m.ts), 0);
    chatCacheWrite(e.id, items); paint(true);
  }).catch((err) => { loaded = true; if (!items.length) msgs.replaceChildren(h("div", {class: "empty small"}, offlineNow() ? "Нет интернета. Переписка появится, когда сеть вернётся." : err.message)); });
  const timer = setInterval(() => { if (!document.body.contains(ov)) clearInterval(timer); else if (!document.hidden) poll(); }, 2500); // пока переписка открыта, новое подтягивается каждые ~2,5 с
}

/** Подробная карточка события: открывается из календаря площадок и из списка расписания. */
function eventDetails(e) {
  const canEdit = state.me.canEdit;
  const hex = e.hall ? hexOfHall(e.hall) : null;
  const when = e.dateEnd ? `${dayTitle(e.date)} — ${dayTitle(e.dateEnd)}` : dayTitle(e.date);
  const roles = Object.entries(e.roles || {});
  const {close} = overlay(sheet(
    h("h2", {}, e.title),
    h("div", {class: "dmeta"},
      h("div", {class: "drow"}, h("span", {}, "Когда"), h("b", {}, when)),
      h("div", {class: "drow"}, h("span", {}, "Время"), h("b", {}, timeLabel(e))),
      e.hall ? h("div", {class: "drow"}, h("span", {}, "Площадка"), h("b", {class: "vtag", style: `background:${hex};color:${inkOn(hex)}`}, cap(e.hall))) : null),
    e.meta && e.meta.kind === "meeting" ? h("div", {class: "meet-tag"}, "📋 Собрание") : null,
    e.meta && e.meta.note ? h("p", {class: "meet-note"}, e.meta.note) : null,
    e.mine && e.mine.length ? h("div", {class: "note ok"}, icon("check"), h("span", {}, "Вы заняты: " + e.mine.map(roleText).join(", "))) : null,
    roles.length ? h("div", {class: "field"}, h("span", {}, "Кто занят"), h("ul", {class: "roles"}, roles.map(([role, names]) => h("li", {class: (e.mine || []).includes(role) ? "me" : ""}, tag(role), h("div", {class: "n"}, names.join(", ")))))) : h("div", {class: "hint-line"}, "Людей на событие пока не назначили"),
    h("button", {class: "btn chat-open", onclick: () => { close(); chatSheet(e); }}, "💬 Обсуждение" + (e.comments ? ` · ${e.comments}` : "")),
    h("div", {class: "actions"},
      canEdit ? h("button", {class: "btn light", onclick: () => { close(); confirmDialog("Удалить событие?", `«${e.title}» пропадёт из расписания, а сотрудникам придёт сообщение об отмене.`, "Удалить", () => remove(e)); }}, icon("trash"), "Удалить") : null,
      canEdit ? h("button", {class: "btn", onclick: () => { close(); editor(e); }}, icon("pencil"), "Редактировать") : h("button", {class: "btn", onclick: () => close()}, "Закрыть"))));
}

function plaque(e) {
  const hex = e.hall ? hexOfHall(e.hall) : FALLBACK_HEX;
  const meeting = Boolean(e.meta && e.meta.kind === "meeting");
  return h("button", {class: "plaque" + (meeting ? " meeting" : ""), style: `background-color:${hex};color:${inkOn(hex)}`, "aria-label": `${meeting ? "Собрание: " : ""}${e.title}, ${timeLabel(e)}${e.hall ? ", " + cap(e.hall) : ""}`, onclick: () => eventDetails(e)},
    h("span", {class: "pt"}, timeLabel(e)),
    h("span", {class: "pm"}, h("b", {}, meeting ? "📋 " + e.title : e.title), e.hall ? h("small", {}, cap(e.hall)) : h("small", {}, "без площадки")));
}

function venuesBody(canEdit) {
  const thisYM = state.today.slice(0, 7);
  const ym = state.calMonth && state.calMonth >= monthShift(thisYM, -2) && state.calMonth <= monthShift(thisYM, 12) ? state.calMonth : thisYM;
  const first = ym + "-01";
  const dow = (new Date(first + "T00:00:00Z").getUTCDay() + 6) % 7; // неделя с понедельника
  const daysInMonth = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
  const weeks = Math.ceil((dow + daysInMonth) / 7);
  const start = addDays(first, -dow);
  const end = addDays(start, weeks * 7 - 1);
  const day = state.day && state.day >= start && state.day <= end && state.day.slice(0, 7) === ym ? state.day : (ym === thisYM ? state.today : first);
  const byDay = eventsByDay(start, end);
  const go = (n) => { state.calMonth = monthShift(ym, n); state.day = ""; render(); };

  const head = h("div", {class: "calhead"},
    h("button", {class: "cal-nav", "aria-label": "Предыдущий месяц", disabled: ym <= monthShift(thisYM, -2), onclick: () => go(-1)}, "‹"),
    h("div", {class: "caltitle"}, h("b", {}, `${MONTH_NAMES[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`),
      ym !== thisYM ? h("button", {class: "link", onclick: () => { state.calMonth = thisYM; state.day = state.today; render(); }}, "Сегодня") : null),
    h("button", {class: "cal-nav", "aria-label": "Следующий месяц", disabled: ym >= monthShift(thisYM, 12), onclick: () => go(1)}, "›"));
  const wd = h("div", {class: "calwd"}, ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((x, i) => h("span", {class: i > 4 ? "we" : ""}, x)));
  const cells = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const list = byDay.get(d) || [];
    // кружок — обычное событие, квадратик — собрание (у каждой площадки свой цвет)
    const marks = [...new Map(list.map((e) => { const m = Boolean(e.meta && e.meta.kind === "meeting"); const c = e.hall ? hexOfHall(e.hall) : FALLBACK_HEX; return [c + (m ? "|m" : ""), {c, m}]; })).values()];
    const colors = marks;
    const out = d.slice(0, 7) !== ym;
    cells.push(h("button", {class: "calday" + (out ? " out" : "") + (d === state.today ? " today" : "") + (d === day ? " sel" : "") + (d < state.today ? " past" : ""), "aria-pressed": String(d === day),
      "aria-label": `${dayTitle(d)}${list.length ? ", событий: " + list.length : ""}`,
      onclick: () => { state.day = d; if (out) state.calMonth = d.slice(0, 7); render(); }},
      h("b", {}, String(dateParts(d).d)),
      h("span", {class: "dots"}, (colors.length > 3 ? colors.slice(0, 2) : colors).map((x) => h("i", {class: x.m ? "sq" : "", style: `background:${x.c}`})), colors.length > 3 ? h("em", {}, "+") : null))); // всегда одна строка (максимум три значка), чтобы ячейки не росли
  }
  const grid = h("div", {class: "calgrid"}, ...cells);

  const venues = state.venues.slice();
  const legend = h("div", {class: "vlegend"},
    ...venues.map((v) => h(canEdit ? "button" : "span", {class: "vchip", ...(canEdit ? {onclick: () => venueSheet(v), "aria-label": `Площадка «${v}»: цвет и удаление`} : {})},
      h("i", {style: `background:${hexOfHall(v)}`}), cap(v))),
    canEdit ? h("button", {class: "vchip add", onclick: () => addVenueSheet()}, icon("plus"), "Площадка") : null);

  const list = byDay.get(day) || [];
  const dayBox = h("section", {class: "dayevents", "aria-live": "polite"},
    h("h2", {class: "vday"}, dayTitle(day)),
    list.length ? h("div", {class: "plaques"}, ...list.map(plaque))
      : h("div", {class: "empty small"}, h("div", {}, "На этот день событий нет")));
  const body = h("div", {class: "venues"}, h("section", {class: "calendar"}, head, wd, grid), legend, dayBox);
  if (!venues.length && !canEdit) body.append(h("div", {class: "hint-line"}, "Площадки добавит администратор"));
  // листаем месяцы свайпом по календарю
  let x0 = null;
  grid.addEventListener("touchstart", (ev) => { x0 = ev.touches[0].clientX; }, {passive: true});
  grid.addEventListener("touchend", (ev) => { if (x0 === null) return; const dx = ev.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 60) { const n = dx < 0 ? 1 : -1; const to = monthShift(ym, n); if (to >= monthShift(thisYM, -2) && to <= monthShift(thisYM, 12)) go(n); } });
  return body;
}

function addVenueSheet(onAdded) {
  const err = h("div", {class: "error", role: "alert"});
  const palette = state.palette || [];
  const used = new Set(Object.values(state.venueColors || {}));
  let color = (palette.find((c) => !used.has(c.hex)) || palette[0] || {}).name || "";
  const input = h("input", {class: "input", placeholder: "Например, Фойе или Репетиционный зал", maxlength: "60", onkeydown: (e) => { if (e.key === "Enter") add.click(); }});
  const pick = h("div", {});
  const paint = () => pick.replaceChildren(swatches(color, (name) => { color = name; paint(); }));
  const add = h("button", {class: "btn", onclick: async () => {
    const name = input.value.trim().split(/\s+/).join(" ");
    if (!name) return shakeBad(input, err, "Введите название площадки");
    close();
    enqueue({t: "vAdd", name, color});
    render();
    if (onAdded) onAdded(name);
  }}, "Добавить");
  const {close} = overlay(sheet(h("h2", {}, "Новая площадка"), h("label", {class: "field"}, h("span", {}, "Название"), input),
    h("div", {class: "field"}, h("span", {}, "Цвет"), pick), err,
    h("div", {class: "actions"}, h("button", {class: "btn light", onclick: () => close()}, "Отмена"), add)));
  paint();
  setTimeout(() => input.focus(), 60);
}

/** Площадка: сменить цвет или убрать. */
function venueSheet(name) {
  const palette = state.palette || [];
  const current = (palette.find((c) => c.hex === hexOfHall(name)) || {}).name || "";
  const body = h("div", {});
  const paint = (sel) => body.replaceChildren(swatches(sel, (color) => {
    paint(color);
    enqueue({t: "vColor", name, color});
    render(); // календарь и плашки событий за панелью перекрашиваются сразу
  }));
  const {close} = overlay(sheet(h("h2", {}, cap(name)), h("div", {class: "field"}, h("span", {}, "Цвет"), body),
    h("div", {class: "actions"},
      h("button", {class: "btn light", onclick: () => { close(); confirmDialog("Убрать площадку?", `«${name}» пропадёт из списка. События останутся, но без площадки их не получится проверить на занятость.`, "Убрать", () => removeVenue(name)); }}, icon("trash"), "Убрать"),
      h("button", {class: "btn", onclick: () => close()}, "Готово"))));
  paint(current);
}

function removeVenue(name) {
  if (state.events.some((e) => hallKey(e.hall) === hallKey(name) && upcoming(e))) return toast("На этой площадке есть будущие события. Сначала перенесите их.", {bad: true});
  enqueue({t: "vDel", name});
  render();
}

/** Плашка «нет интернета»: показываем последнее, что удалось загрузить, и когда это было. */
function offlineBar() {
  if (!state.offline) return null;
  const d = state.savedAt ? new Date(state.savedAt) : null;
  const hhmm = d ? d.toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit"}) : "";
  const same = d && d.toDateString() === new Date().toDateString();
  const when = d ? (same ? "сегодня в " + hhmm : d.toLocaleDateString("ru-RU", {day: "numeric", month: "long"}) + " в " + hhmm) : "";
  return h("div", {class: "note offline", role: "status"}, icon("alert"), h("span", {}, "Нет интернета. Показано последнее сохранённое" + (when ? " (" + when + ")" : "") + ". Менять можно как обычно: правки видны сразу и отправятся, когда появится связь."));
}
function setOffline(on) { if (state.offline !== on) { state.offline = on; render(); } }

// ---------- профиль: соцсети и «когда я не могу работать» ----------
/** Нажали на аватар: кто я, какие соцсети подключены и календарь, где отмечаются дни, когда работать не получится. */
function profileSheet() {
  const me = state.me, cfg = window.KTK || {};
  const channels = me.channels || [];
  let off = new Set(me.off || []);
  const orig = new Set(me.off || []);
  const thisYM = state.today.slice(0, 7);
  let ym = thisYM;
  const social = (key, label, url) => {
    const on = channels.includes(key);
    return h("div", {class: "drow"}, h("span", {}, label),
      on ? h("b", {class: "okchip"}, icon("check"), "подключён")
        : (url && me.login ? h("a", {class: "link", href: url + encodeURIComponent(me.login), target: "_blank", rel: "noopener"}, "не подключён · подключить") : h("b", {class: "muted"}, "не подключён")));
  };
  const calBox = h("div", {class: "offcal"});
  const info = h("div", {class: "hint-line"});
  const save = h("button", {class: "btn"}, "Сохранить");
  const dirty = () => off.size !== orig.size || [...off].some((d) => !orig.has(d));
  const paint = () => {
    const first = ym + "-01";
    const dow = (new Date(first + "T00:00:00Z").getUTCDay() + 6) % 7;
    const dim = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
    const start = addDays(first, -dow), weeks = Math.ceil((dow + dim) / 7);
    const mine = state.events.filter((e) => e.mine && e.mine.length);
    const cells = [];
    for (let d = start; d <= addDays(start, weeks * 7 - 1); d = addDays(d, 1)) {
      const outM = d.slice(0, 7) !== ym, past = d < state.today;
      const shift = mine.some((e) => onDay(e, d));
      const locked = shift && !off.has(d); // смена уже назначена: «не могу» отметить нельзя
      cells.push(h("button", {class: "calday" + (outM ? " out" : "") + (past ? " dis" : "") + (off.has(d) ? " off" : "") + (locked ? " shiftday" : "") + (d === state.today ? " today" : ""), disabled: past || outM || locked, "aria-pressed": String(off.has(d)),
        "aria-label": `${dayTitle(d)}${off.has(d) ? ", не могу работать" : ""}${shift ? ", у вас смена" : ""}`,
        onclick: () => { if (off.has(d)) off.delete(d); else off.add(d); paint(); }},
        h("b", {}, String(dateParts(d).d)), h("span", {class: "dots"}, shift ? h("i", {style: "background:#0A96DC"}) : null)));
    }
    calBox.replaceChildren(
      h("div", {class: "calhead"},
        h("button", {class: "cal-nav", "aria-label": "Предыдущий месяц", disabled: ym <= thisYM, onclick: () => { ym = monthShift(ym, -1); paint(); }}, "‹"),
        h("div", {class: "caltitle"}, h("b", {}, `${MONTH_NAMES[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`)),
        h("button", {class: "cal-nav", "aria-label": "Следующий месяц", disabled: ym >= monthShift(thisYM, 12), onclick: () => { ym = monthShift(ym, 1); paint(); }}, "›")),
      h("div", {class: "calwd"}, ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((x, i) => h("span", {class: i > 4 ? "we" : ""}, x))),
      h("div", {class: "calgrid"}, ...cells));
    const n = [...off].filter((d) => d >= state.today).length;
    info.textContent = (n ? `Отмечено дней: ${n}. На эти дни вас нельзя будет назначить на событие.` : "Нажимайте на даты, когда не можете работать.") + " Синий кружок — день, когда вам уже назначена смена: его отметить нельзя, об отказе от смены напишите администратору.";
    save.disabled = !dirty();
  };
  save.addEventListener("click", () => {
    const add = [...off].filter((d) => !orig.has(d)), remove = [...orig].filter((d) => !off.has(d));
    state.me.off = [...off].sort();
    close();
    enqueue({t: "off", add, remove});
  });
  const {close} = overlay(sheet(
    h("div", {class: "profhead"}, (state.avatars[me.uid] ? avatarEl(me.uid, me.name, "avatar big") : h("img", {class: "avatar big", src: "avatar.webp", alt: ""})), h("div", {}, h("h2", {}, me.name), h("span", {class: "badge " + me.role}, me.roleLabel))),
    h("div", {class: "dmeta"},
      me.login ? h("div", {class: "drow"}, h("span", {}, "Ваш логин"), h("b", {class: "mono"}, me.login)) : null,
      social("telegram", "Telegram", cfg.BOT_URL ? cfg.BOT_URL + "?start=" : ""),
      social("vk", "ВКонтакте", cfg.VK_URL ? cfg.VK_URL + "?ref=" : "")),
    me.canEdit ? h("button", {class: "btn light report-btn", onclick: () => { close(); reportSheet(); }}, icon("chart"), "Сформировать отчёт") : null,
    h("div", {class: "field"}, h("span", {}, "Когда я не могу работать"), calBox, info),
    h("div", {class: "actions"}, h("button", {class: "btn light", onclick: () => close()}, "Закрыть"), save),
    h("div", {class: "ver"}, `Приложение ${window.KTK_VERSION || "?"} · сервер ${state.serverVersion || "?"}`)));
  paint();
}

// ---------- отчёт за период (администраторам) ----------
function reportSheet() {
  const first = state.today.slice(0, 7) + "-01";
  const f = {kind: "venue", value: "", from: first, to: state.today};
  let result = null, busy = false;
  const valueOptions = () => f.kind === "venue" ? state.venues : f.kind === "person" ? state.staff : (state.groups.length ? state.groups.map((g) => g.name) : state.roles);
  const allLabel = () => f.kind === "venue" ? "Все площадки" : f.kind === "person" ? "Все сотрудники (по каждому)" : "Все отделы";
  const body = h("div", {});
  const out = h("div", {class: "rep-out"});
  const quick = (label, from, to) => h("button", {class: "vchip", onclick: () => { f.from = from; f.to = to; result = null; paint(); }}, label);
  const monthEnd = (ym) => addDays(monthShift(ym, 1) + "-01", -1);
  const run = async (extra) => {
    if (busy) return null;
    if (offlineNow()) { toast("Нет интернета", {bad: true}); return null; }
    busy = true; paintOut();
    try { return await api("POST", "/api/report", {from: f.from, to: f.to, kind: f.kind, value: f.value, ...extra}); }
    catch (err) { toast(err.message, {bad: true}); return null; }
    finally { busy = false; }
  };
  const show = async () => { const r = await run({}); if (r) { result = r.report; } paintOut(); };
  const toSheet = async () => { const r = await run({save: true}); if (r) { result = r.report; toast(`Отчёт № ${r.saved.number} записан в лист «Отчёты»`, {plane: true}); if (r.saved.url) window.open(r.saved.url, "_blank", "noopener"); } paintOut(); };
  const download = async () => {
    const r = await run({csv: true}); if (!r) return paintOut();
    const url = URL.createObjectURL(new Blob([r.csv], {type: "text/csv;charset=utf-8"}));
    const a = h("a", {href: url, download: `Отчёт ${f.from} — ${f.to}.csv`}); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
    paintOut();
  };
  const paintOut = () => {
    if (busy) return out.replaceChildren(h("div", {class: "hint-line"}, "Готовим отчёт…"));
    if (!result) return out.replaceChildren();
    const r = result;
    out.replaceChildren(
      h("div", {class: "rep-sum"}, r.summary.map(([a, b]) => h("div", {}, h("b", {}, b), h("span", {}, a)))),
      r.rows.length ? h("div", {class: "rep-wrap"}, h("table", {class: "rep"}, h("thead", {}, h("tr", {}, r.columns.map((c) => h("th", {}, c)))),
        h("tbody", {}, r.rows.map((row) => h("tr", {}, row.map((c) => h("td", {}, c))))), h("tfoot", {}, h("tr", {}, r.total.map((c) => h("td", {}, c))))))
        : h("div", {class: "hint-line"}, "За этот период ничего не нашлось"),
      r.note ? h("div", {class: "hint-line"}, "Внимание: " + r.note) : null,
      r.rows.length ? h("div", {class: "actions"}, h("button", {class: "btn light", onclick: download}, "Скачать для Excel"), h("button", {class: "btn", onclick: toSheet}, "Записать в лист «Отчёты»")) : null);
  };
  const paint = () => {
    const sel = h("select", {class: "input", "aria-label": "Что показать", onchange: (e) => { f.value = e.target.value; result = null; paintOut(); }},
      h("option", {value: ""}, allLabel()), valueOptions().map((v) => h("option", {value: v, selected: v === f.value}, v)));
    body.replaceChildren(
      h("div", {class: "field"}, h("span", {}, "По чему отчёт"),
        h("div", {class: "seg2", role: "tablist"}, [["venue", "Площадка"], ["person", "Сотрудник"], ["role", "Отдел"]].map(([k, label]) => h("button", {class: "segb" + (f.kind === k ? " on" : ""), role: "tab", "aria-selected": String(f.kind === k), onclick: () => { f.kind = k; f.value = ""; result = null; paint(); }}, label))), sel),
      h("div", {class: "field"}, h("span", {}, "Период"),
        h("div", {class: "rep-dates"},
          h("input", {type: "date", class: "input", value: f.from, "aria-label": "С даты", onchange: (e) => { f.from = e.target.value; result = null; paintOut(); }}),
          h("input", {type: "date", class: "input", value: f.to, "aria-label": "По дату", onchange: (e) => { f.to = e.target.value; result = null; paintOut(); }})),
        h("div", {class: "vchips"},
          quick("Этот месяц", first, monthEnd(state.today.slice(0, 7))),
          quick("Прошлый месяц", monthShift(state.today.slice(0, 7), -1) + "-01", addDays(first, -1)),
          quick("30 дней", addDays(state.today, -29), state.today))));
  };
  const {close} = overlay(sheet(h("h2", {}, "Отчёт за период"), body, h("div", {class: "actions"}, h("button", {class: "btn", onclick: show}, "Показать")), out, h("div", {class: "actions"}, h("button", {class: "btn light", onclick: () => close()}, "Закрыть"))));
  paint();
}

function appView() {
  const canEdit = state.me.canEdit;
  const body = state.tab === "venues" ? venuesBody(canEdit) : scheduleBody(canEdit);
  const old = state.layout === 1 && state.me.role === "admin"
    ? h("div", {class: "note"}, icon("alert"), h("span", {}, "Таблица в старом формате: время окончания и площадки не сохраняются. Запустите styleSheets в Apps Script, и она перестроится сама (копия останется).")) : null;
  return h("main", {class: "app"},
    h("div", {class: "top"},
      h("div", {class: "bar"},
        h("button", {class: "whobtn", "aria-label": "Мой профиль", onclick: () => profileSheet()},
          (state.avatars[state.me.uid] ? avatarEl(state.me.uid, state.me.name, "avatar") : h("img", {class: "avatar", src: "avatar.webp", alt: ""})),
          h("div", {class: "who"}, h("b", {}, state.me.name), h("span", {class: "badge " + state.me.role}, state.me.roleLabel))),
        h("button", {class: "icon-btn", "aria-label": "Обновить", onclick: () => load(true)}, icon("refresh")),
        h("button", {class: "icon-btn", "aria-label": "Выйти", onclick: () => confirmDialog("Выйти?", "Чтобы войти снова, понадобится ваш логин.", "Выйти", logout)}, icon("exit"))),
      h("div", {class: "tabs", role: "tablist"},
        [["all", "Расписание"], ["mine", "Мои смены"], ["venues", "Площадки"]].map(([t, label]) => h("button", {class: "tab", role: "tab", "aria-selected": String(state.tab === t), onclick: () => { state.tab = t; render(); window.scrollTo(0, 0); }}, label)))),
    offlineBar(), old, body,
    canEdit && state.tab !== "venues" ? h("button", {class: "fab", "aria-label": "Добавить событие", onclick: () => editor(null)}, icon("plus")) : null);
}

function render() {
  const scroll = window.scrollY;
  if (!state.token) root.replaceChildren(loginView());
  else if (!state.ready) root.replaceChildren(h("div", {class: "loading"}, h("div", {class: "empty"}, cloud(), h("div", {}, "Загружаем расписание"))));
  else root.replaceChildren(appView());
  window.scrollTo(0, scroll);
}

let loading = false, loadAgain = false;
async function load(manual = false, force = false) {
  if (!state.token) return render();
  if (loading) { if (force) loadAgain = true; return; } // идёт загрузка: после неё сверимся ещё раз
  if (navigator.onLine === false && state.ready) { setOffline(true); if (manual) toast("Нет интернета: показано последнее сохранённое", {bad: true}); return; }
  loading = true;
  try {
    const d = await api("GET", "/api/schedule");
    if (!d || !d.me || !Array.isArray(d.events)) throw new Error("Сервер ответил неполно. Попробуйте ещё раз через минуту.");
    const next = {me: d.me, events: d.events, roles: d.roles, allRoles: d.allRoles || d.roles, staff: d.staff || [], venues: d.venues || [], venueColors: d.venueColors || {}, palette: d.palette || [], unavailable: d.unavailable || {}, groups: d.groups || [], layout: d.layout || 2, rev: d.rev || "", today: d.today};
    Object.assign(state, next, {ready: true, offline: false, savedAt: Date.now(), serverVersion: d.version || ""});
    const server = JSON.stringify({...next, savedAt: 0}); // кеш на телефоне — то, что на сервере; ещё не ушедшие правки накладываем поверх ниже
    applyQueue();
    if (d.avatarKey && d.avatarKey !== state.avatarKey) loadAvatars(d.avatarKey);
    setTimeout(prefetchChats, 1500); // после показа расписания фоном подгружаем переписки // аватарки меняются редко: грузим только при смене ключа
    try { localStorage.setItem("ktk_cache", JSON.stringify({...JSON.parse(server), savedAt: state.savedAt})); } catch (_) {}
    render();
    if (manual) toast("Обновлено");
  } catch (e) {
    if (!state.token) return; // 401: api() уже вернул на экран входа
    if (e.transient && state.ready) { if (manual) toast(e.message, {bad: true}); setTimeout(() => load(), 8000); return; } // сервер обновляется: показываем то, что есть, и тихо пробуем снова
    if (e.offline && state.ready) { setOffline(true); if (manual) toast(e.message, {bad: true}); return; } // нет сети: остаёмся на последних сохранённых данных
    toast(e.message, {bad: true});
    if (!state.ready) root.replaceChildren(h("div", {class: "loading"}, h("div", {class: "empty"}, cloud(), h("h3", {}, "Не удалось загрузить"), h("p", {}, e.message),
      h("div", {class: "stack"}, h("button", {class: "btn", onclick: () => { render(); load(); }}, "Повторить"), h("button", {class: "btn light", onclick: logout}, "Выйти")))));
  } finally { loading = false; if (loadAgain) { loadAgain = false; load(false, true); } }
}

// ---------- редактирование: администратор и редактор ----------
function actionSheet(e) {
  const {close} = overlay(sheet(h("h2", {}, e.title),
    h("button", {class: "option", onclick: () => { close(); editor(e); }}, h("span", {class: "ic"}, icon("pencil")), "Редактировать"),
    h("button", {class: "option danger", onclick: () => { close(); confirmDialog("Удалить событие?", `«${e.title}» пропадёт из расписания, а сотрудникам придёт сообщение об отмене.`, "Удалить", () => remove(e)); }}, h("span", {class: "ic"}, icon("trash")), "Удалить")));
}

function remove(e) {
  enqueue({t: "evDel", id: e.id || "", row: e.row, rev: e.rev});
  render();
}

/** Сохранение события: сразу показываем его в списке, на сервер отправляем в очереди (ID у нового события придумывает приложение). */
function saveEventOptimistic(orig, event, force, meta) {
  const op = orig
    ? {t: "evEdit", id: orig.id || "", row: orig.row, rev: orig.rev, event, meta: meta || undefined, force: force || undefined}
    : {t: "evNew", id: newEventId(), event, meta: meta || undefined, force: force || undefined};
  enqueue(op);
  render();
}

function editor(e) {
  const times = e && e.time ? e.time.split(/,\s*/) : [];
  const draft = e
    ? {row: e.row, rev: e.rev, kind: (e.meta && e.meta.kind) || "event", note: (e.meta && e.meta.note) || "", publish: false, title: e.title, date: e.date, dateEnd: e.dateEnd || "", time: times[0] || "", extra: times.slice(1), end: e.end || "", hall: e.hall || "", roles: JSON.parse(JSON.stringify(e.roles))}
    : {kind: "event", note: "", publish: true, title: "", date: state.today, dateEnd: "", time: "", extra: [], end: "", hall: "", roles: {}};
  const {ov, close} = overlay("");
  const paint = () => {
    const venues = [...new Set([...state.venues, draft.hall].filter(Boolean))];
    const err = h("div", {class: "error", role: "alert"});
    const title = h("input", {class: "input", value: draft.title, placeholder: "Например, Спектакль «Бука»", oninput: (ev) => { draft.title = ev.target.value; ev.target.classList.remove("bad"); err.textContent = ""; }});
    const date = h("input", {class: "input", type: "date", value: draft.date, onchange: (ev) => { draft.date = ev.target.value; paint(); }});
    const dateEnd = h("input", {class: "input", type: "date", value: draft.dateEnd, min: draft.date, onchange: (ev) => { draft.dateEnd = ev.target.value; paint(); }});
    // время меняем «на месте», без перерисовки окна: иначе системное колесо выбора времени закрывается при каждом движении и приложение «вылетает»
    const start = h("input", {class: "input", type: "time", value: draft.time, "aria-label": "Начало", onchange: (ev) => { draft.time = ev.target.value; if (!draft.time) { draft.end = ""; end.value = ""; } end.disabled = !draft.time; refreshClash(); }});
    const end = h("input", {class: "input", type: "time", value: draft.end, "aria-label": "Окончание", disabled: !draft.time, onchange: (ev) => { draft.end = ev.target.value; refreshClash(); }});
    const hallChips = h("div", {class: "chips"},
      ...venues.map((x) => h("button", {class: "chip withdot" + (hallKey(draft.hall) === hallKey(x) ? " on" : ""), onclick: () => { draft.hall = hallKey(draft.hall) === hallKey(x) ? "" : x; paint(); }}, h("i", {class: "cdot", style: `background:${hexOfHall(x)}`}), cap(x))),
      h("button", {class: "chip add", onclick: () => addVenueSheet((name) => { draft.hall = name; paint(); })}, "+ новая"));
    let clash = [];
    const warn = h("div", {});
    const refreshClash = () => {
      clash = conflictsFor({...draft, time: [draft.time, ...draft.extra].filter(Boolean).join(", ")});
      warn.replaceChildren(...(clash.length ? [h("div", {class: "warn"}, icon("alert"), h("span", {}, `Площадка занята: ${clash.map((c) => `${c.title} (${timeLabel(c)})`).join("; ")}`))] : []));
    };
    refreshClash();
    const origNames = new Set(e ? Object.values(e.roles || {}).flat() : []);
    const dDays = eventDays(draft);
    const badPeople = [...new Set(Object.values(draft.roles).flat())].filter((n) => !origNames.has(n) && blockedDays(n, dDays).length);
    const warnOff = badPeople.length ? h("div", {class: "warn"}, icon("alert"), h("span", {}, `Не могут работать в эти дни: ${badPeople.map((n) => `${n} (${blockedDays(n, dDays).map(shortDate).join(", ")})`).join("; ")}. Уберите их или смените дату.`)) : null;
    // должности — группы из «Сотрудников»; плюс те, где на этом событии уже кто-то стоит (чтобы старые записи не потерялись)
    const editRoles = [...state.roles, ...Object.keys(draft.roles).filter((r) => !state.roles.includes(r))];
    const roleBlocks = editRoles.map((role) => {
      const names = draft.roles[role] || [];
      return h("div", {class: "roleblock"}, tag(role),
        h("div", {class: "chips"},
          ...names.map((n) => h("button", {class: "chip person", "aria-label": `Убрать ${n}`, onclick: () => { draft.roles[role] = names.filter((x) => x !== n); if (!draft.roles[role].length) delete draft.roles[role]; paint(); }}, n + " ×")),
          h("button", {class: "chip add", onclick: () => picker(role, names, (sel) => { if (sel.length) draft.roles[role] = sel; else delete draft.roles[role]; paint(); }, {row: draft.row, date: draft.date, dateEnd: draft.dateEnd, time: [draft.time, ...draft.extra].filter(Boolean).join(", "), end: draft.end})}, "+ добавить")));
    });
    const meeting = draft.kind === "meeting";
    const kindSwitch = h("div", {class: "seg2", role: "tablist"},
      [["event", "Событие"], ["meeting", "📋 Собрание"]].map(([k, label]) => h("button", {class: "segb" + (draft.kind === k ? " on" : ""), role: "tab", "aria-selected": String(draft.kind === k), onclick: () => { draft.kind = k; paint(); }}, label)));
    const note = h("textarea", {class: "input", rows: "6", placeholder: "О чём собрание, повестка, что подготовить. Можно вставить текст или взять его из документа ниже.", oninput: (ev) => (draft.note = ev.target.value)}, draft.note);
    note.value = draft.note;
    const docBtn = h("button", {class: "btn light attach", disabled: Boolean(draft.reading), onclick: () => chooseFiles(false, async ([f]) => {
      draft.reading = true; paint();
      try {
        const text = await extractDocText(f);
        draft.note = draft.note.trim() ? draft.note.trim() + "\n\n" + text : text;
        toast(`Текст из «${f.name}» добавлен в описание`, {plane: true});
      } catch (er) { toast(er.message, {bad: true}); }
      draft.reading = false; paint();
    }, ".docx,.odt,.txt,.md,text/plain")}, draft.reading ? "Читаю документ…" : "📄 Взять текст из документа");
    const docHint = h("div", {class: "hint-line"}, draft.row ? "Можно заменить текст или добавить документ (например, итоги после собрания). Чтобы разослать новый текст прямо сейчас, нажмите кнопку «Разослать» ниже." : "Прикрепите документ Word (.docx), .odt или .txt: его текст попадёт в описание, а оттуда в группу ВК и в личные сообщения всем сотрудникам. Перед отправкой текст можно поправить." + (draft.note.length > 3500 ? " Текст длинный: он уйдёт несколькими сообщениями." : ""));
    const fileList = h("div", {class: "files"}, docBtn, docHint);
    const announceBox = !draft.row ? h("label", {class: "check"}, h("input", {type: "checkbox", checked: draft.publish, onchange: (ev) => (draft.publish = ev.target.checked)}), h("span", {}, "Когда рассылаете: выложить ещё и в группу ВК и канал")) : null;
    // «Разослать»: сотрудникам в личные сообщения и (по галочке) в группу ВК и канал. Обычное «Создать» / «Сохранить» ничего не рассылает.
    // Так можно создать собрание заранее, а разослать позже — или приложить документ с итогами и разослать уже после собрания.
    const resendBtn = h("button", {class: "btn light", onclick: () => {
      if (!draft.note.trim()) { toast("Сначала добавьте текст или документ", {bad: true}); return; }
      confirmDialog(draft.row ? "Разослать собрание?" : "Создать и разослать?", `Текст уйдёт всем сотрудникам в личные сообщения${draft.row || draft.publish ? " и будет выложен в группе ВК и канале" : ""}. ${draft.row ? "Изменения в собрании тоже сохранятся." : "Собрание будет создано."}`, "Разослать", () => { draft.resend = true; if (draft.row) draft.publish = true; doSave(false); });
    }}, draft.row ? "📣 Разослать сотрудникам и выложить в ВК" : "📣 Создать и разослать сотрудникам");
    const meetingBlock = meeting ? h("div", {class: "meetblock"}, h("label", {class: "field"}, h("span", {}, "Текст собрания"), note), h("div", {class: "field"}, h("span", {}, "Документ"), fileList), announceBox, resendBtn) : null;
    const save = h("button", {class: "btn", disabled: Boolean(draft.uploading)}, draft.row ? "Сохранить" : (meeting ? "Создать собрание" : "Создать"));
    const doSave = (force) => {
      err.textContent = "";
      const event = {title: draft.title.trim(), date: draft.date, dateEnd: draft.dateEnd || "", time: [draft.time, ...draft.extra].filter(Boolean).join(", "), end: draft.end, hall: draft.hall, roles: draft.roles};
      if (!event.title) { draft.resend = false; return shakeBad(title, err, "Введите название события"); }
      if (!event.date) { draft.resend = false; return shakeBad(date, err, "Укажите дату"); }
      if (badPeople.length) { draft.resend = false; err.textContent = "Не могут работать в эти дни: " + badPeople.join(", ") + ". Уберите их или смените дату."; return; }
      if (!force && clash.length) { confirmDialog("Площадка занята", `Площадка занята: ${clash.map((c) => `${c.title} (${timeLabel(c)})`).join("; ")}. Сохранить всё равно?`, "Сохранить", () => doSave(true)); return; }
      close();
      const meta = draft.kind === "meeting" || (e && e.meta && (e.meta.kind === "meeting" || e.meta.note))
        ? {kind: draft.kind, note: draft.note.trim(), publish: draft.publish, ...(draft.resend ? {resend: true} : {}), ...(!draft.row && !draft.resend ? {announce: false} : {})} : null;
      draft.resend = false;
      saveEventOptimistic(e, event, force || clash.length > 0, meta);
    };
    save.addEventListener("click", () => doSave(false));
    ov.replaceChildren(sheet(h("h2", {}, draft.row ? "Редактировать событие" : "Новое событие"),
      kindSwitch,
      h("label", {class: "field"}, h("span", {}, "Название"), title),
      meetingBlock,
      h("div", {class: "row2"}, h("label", {class: "field", style: "flex:1"}, h("span", {}, "Дата"), date),
        draft.dateEnd || draft.multi ? h("label", {class: "field", style: "flex:1"}, h("span", {}, "По"), dateEnd) : null),
      draft.dateEnd || draft.multi ? null : h("button", {class: "link", onclick: () => { draft.multi = true; paint(); }}, "Несколько дней"),
      h("div", {class: "row2"},
        h("label", {class: "field", style: "flex:1"}, h("span", {}, "Начало"), start),
        h("label", {class: "field", style: "flex:1"}, h("span", {}, "Окончание"), end)),
      draft.extra.length ? h("div", {class: "hint-line"}, "Ещё время в таблице: " + draft.extra.join(", ")) : null,
      h("div", {class: "field"}, h("span", {}, "Площадка"), hallChips, warn),
      h("div", {class: "field"}, h("span", {}, "Кто занят"), h("div", {class: "hint-line"}, "Необязательно: можно создать событие без сотрудников и назначить их позже."), ...roleBlocks, warnOff),
      err,
      h("div", {class: "actions"}, h("button", {class: "btn light", onclick: () => close()}, "Отмена"), save)));
  };
  paint();
}

/** Дни события (не больше двух месяцев подряд). */
const eventDays = (d) => { const out = []; if (!d.date) return out; for (let x = d.date, i = 0; x <= (d.dateEnd || d.date) && i < 62; x = addDays(x, 1), i++) out.push(x); return out; };
/** Дни, на которые человек отметил «не могу», в пределах события. */
const blockedDays = (name, days) => ((state.unavailable || {})[name] || []).filter((x) => days.includes(x));
/** В других событиях в то же время (если у обоих указано время). */
function busyWith(name, cand) {
  if (!cand.time) return [];
  return state.events.filter((e) => e.row !== cand.row && e.time && rangesMeet(e, cand) && slotsMeet(e, cand) && Object.values(e.roles || {}).some((names) => names.includes(name)));
}

function picker(role, selected, onDone, ctx = {}) {
  let sel = [...selected];
  const days = eventDays(ctx);
  const cand = {row: ctx.row, date: ctx.date, dateEnd: ctx.dateEnd, time: ctx.time, end: ctx.end};
  const list = h("div", {});
  const groups = h("div", {class: "chips groups"});
  const search = h("input", {class: "input search", placeholder: "Поиск сотрудника", oninput: () => fill()});
  const fill = () => {
    const q = search.value.toLowerCase();
    const names = state.staff.filter((n) => n.toLowerCase().includes(q));
    list.replaceChildren(...names.map((n) => {
      const off = blockedDays(n, days);
      const locked = Boolean(off.length) && !sel.includes(n); // отметил «не могу» — выбрать нельзя (а если уже стоял на событии, можно только снять)
      const busy = locked ? [] : busyWith(n, cand);
      const note = off.length ? "не может: " + off.map((d) => shortDate(d)).join(", ") : busy.length ? "уже занят(а): " + busy.map((e) => `${e.title}, ${timeLabel(e)}`).join("; ") : "";
      return h("button", {class: "pick" + (sel.includes(n) ? " on" : "") + (locked ? " off" : "") + (busy.length ? " warnp" : ""), disabled: locked, "aria-disabled": String(locked),
        onclick: () => { sel = sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n]; fill(); }},
        h("span", {class: "box"}, sel.includes(n) ? icon("check") : null), h("span", {class: "pn"}, n, note ? h("small", {}, note) : null));
    }), ...(names.length ? [] : [h("div", {class: "empty"}, "Никого не нашли")]));
    // группы из таблицы: одно нажатие добавляет всех, ещё одно — убирает
    groups.replaceChildren(...state.groups.filter((g) => g.members.length).map((g) => {
      const free = g.members.filter((n) => sel.includes(n) || !blockedDays(n, days).length);
      const all = free.length > 0 && free.every((n) => sel.includes(n));
      return h("button", {class: "chip group" + (all ? " on" : ""), onclick: () => { sel = all ? sel.filter((n) => !g.members.includes(n)) : [...new Set([...sel, ...g.members.filter((n) => sel.includes(n) || !blockedDays(n, days).length)])]; fill(); }}, icon("group"), `${g.name} · ${g.members.length}`);
    }));
  };
  const {close} = overlay(sheet(h("h2", {}, roleText(role)), state.groups.some((g) => g.members.length) ? h("div", {class: "field"}, h("span", {}, "Группы"), groups) : null, search, list,
    h("div", {class: "actions"}, h("button", {class: "btn", onclick: () => { close(); onDone(sel); }}, "Готово"))));
  fill();
}

// ---------- старт и быстрое обновление ----------
if (state.token) {
  // сначала показываем прошлое расписание, чтобы не ждать сервер, потом обновляем
  try { const c = JSON.parse(localStorage.getItem("ktk_cache") || "null"); if (c && c.events && c.me) Object.assign(state, c, {ready: true}); applyQueue(); } catch (_) {}
  try { const a = JSON.parse(localStorage.getItem("ktk_avatars") || "null"); if (a && a.items) Object.assign(state, {avatars: a.items, avatarKey: a.key || ""}); } catch (_) {}
  if (navigator.onLine === false && state.ready) state.offline = true;
}
render();
if (state.token && queue.length) pumpQueue(); // правки, не ушедшие в прошлый раз
if (state.token) load().then(() => {
  const m = /^#event=([0-9a-f]+)/.exec(location.hash || ""); // ссылка из уведомления о собрании
  if (m && state.ready) { const ev = state.events.find((x) => x.id === m[1]); if (ev) eventDetails(ev); history.replaceState(null, "", location.pathname + location.search); }
});

// Раз в несколько секунд спрашиваем сервер «версия данных изменилась?» (дёшево: таблицу он при этом не читает) и подгружаем новое.
async function poll() {
  if (!state.token || !state.ready || document.hidden || loading || queue.length > 0 || navigator.onLine === false) return;
  try { const r = await api("GET", "/api/ping", {rev: state.rev}); if (r.changed || state.offline) await load(); } catch (_) { /* нет связи — молча ждём следующий раз */ }
}
setInterval(poll, 8000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { if (queue.length) pumpQueue(); poll(); } });
window.addEventListener("focus", poll);
window.addEventListener("online", () => { if (state.token) { if (queue.length) pumpQueue(); else load(); } });
window.addEventListener("offline", () => { if (state.token && state.ready) setOffline(true); });
if ("serviceWorker" in navigator && !window.KTK_DEMO && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register("sw.js").catch(() => {}); // страница открывается и без интернета
// масштаб страницы отключён: щипок (на iOS — «жестовые» события) блокируем здесь, двойное касание — в стилях (touch-action: manipulation), чтобы быстрые нажатия по кнопкам не терялись
["gesturestart", "gesturechange", "gestureend"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
document.addEventListener("touchmove", (e) => { if (e.touches && e.touches.length > 1 && e.cancelable) e.preventDefault(); }, {passive: false});
