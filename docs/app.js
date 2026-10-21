"use strict";
const CFG = window.KTK || {};
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
// цвета меток разделов (Администратор, Гардероб, Касса…): по порядку колонок таблицы, из палитры
const TAG_COLORS = [["#0A96DC", "#fff"], ["#F2961E", "#fff"], ["#F04E4A", "#fff"], ["#F4C79A", "#1B3560"], ["#1B3560", "#fff"], ["#D4F1FC", "#1B3560"]];

const state = {token: localStorage.getItem("ktk_token") || "", me: null, events: [], roles: [], allRoles: [], staff: [], venues: [], venueColors: {}, palette: [], groups: [], layout: 2, rev: "", today: "", day: "", calMonth: "", tab: "all", ready: false, offline: false, savedAt: 0, unavailable: {}, avatars: {}, avatarKey: "", filesReady: false};
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
    try { data = JSON.parse(raw); } catch (e) { throw new Error("Сервер ответил не так, как ждали (код " + r.status + "): " + raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 160)); }
    status = data._status || (r.ok ? 200 : r.status);
  } else {
    const r = await fetch(method === "GET" && body ? path + "?" + new URLSearchParams(body) : path, {method, headers: {"Content-Type": "application/json", ...(state.token ? {Authorization: "Bearer " + state.token} : {})}, body: method === "GET" ? undefined : JSON.stringify(body || {})});
    data = await r.json().catch(() => ({}));
    status = r.status;
  }
  if (status === 401 && state.token) { logout(); throw new Error("Войдите заново"); }
  if (status >= 400) { const e = new Error(data.error || "Ошибка"); e.status = status; e.data = data; throw e; }
  return data;
}

// ---------- «сразу и красиво»: изменения показываем мгновенно, а на сервер они уходят следом по очереди ----------
// Ждать ответа Google не нужно: правка уже на экране. Если сервер отказал — покажем причину и вернём то, что у него на самом деле.
const opQueue = [];
let opRunning = false, opsRan = false, opsPending = 0;
function enqueue(run) {
  opsPending++;
  opQueue.push(run);
  pumpQueue();
}
async function pumpQueue() {
  if (opRunning) return;
  opRunning = true;
  opsRan = false;
  while (opQueue.length) {
    const run = opQueue.shift();
    try { await run(); } catch (e) { if (state.token) toast(e.message || "Не удалось сохранить", {bad: true}); }
    opsRan = true;
    opsPending--;
  }
  opRunning = false;
  if (state.token) await load(false, true); // сверяемся с сервером: строки получают настоящие номера, отклонённое откатывается
}
/** Событие, которое правим/удаляем, на сервере могло сменить номер строки (предыдущие правки из очереди): находим его заново по содержимому. */
async function resolveTarget(orig) {
  if (!orig) return null;
  if (orig.pending) throw new Error("Событие ещё сохранялось. Повторите через секунду.");
  if (!opsRan) return orig;
  const d = await api("GET", "/api/schedule");
  const found = d.events.find((x) => x.rev === orig.rev && x.title === orig.title);
  if (!found) throw new Error("Событие уже изменили. Обновите страницу и повторите.");
  return found;
}
const sortEvents = () => state.events.sort((a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || "")));
const offlineNow = () => state.offline || navigator.onLine === false;

/** Пустое обязательное поле: краснеет, трясётся, получает фокус; под ним — подсказка. */
function shakeBad(input, err, text) {
  err.textContent = text;
  input.classList.remove("bad"); void input.offsetWidth; input.classList.add("bad");
  try { input.scrollIntoView({block: "center", behavior: "smooth"}); input.focus({preventScroll: true}); } catch (_) {}
}

function logout() {
  try { localStorage.removeItem("ktk_token"); localStorage.removeItem("ktk_cache"); } catch (_) {}
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
  const urgent = isSoon(e);
  const hex = e.hall ? hexOfHall(e.hall) : "";
  const outline = hex && !urgent ? `border-color:${hex};box-shadow:3px 3px 0 ${hex}` : ""; // обводка цвета площадки
  return h("button", {class: "ev" + (e.mine.length ? " mine" : "") + (urgent ? " urgent" : ""), style: outline, onclick: () => (e.pending ? toast("Ещё сохраняется…") : eventDetails(e)), "aria-label": `Открыть: ${e.title}`},
    time,
    h("div", {}, h("h3", {}, e.meta && e.meta.kind === "meeting" ? h("span", {class: "mt"}, "📋 ") : null, e.title), range, hall, roles.length ? list : null, e.comments ? h("span", {class: "ccount"}, "💬 " + e.comments) : null),
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

// ---------- файлы: выбор, сжатие фото, загрузка ----------
const MAX_FILE = 12 * 1024 * 1024;
const fileIcon = (mime) => (/^image\//.test(mime) ? "🖼" : /pdf/.test(mime) ? "📕" : /word|document/.test(mime) ? "📄" : /sheet|excel/.test(mime) ? "📊" : /presentation|powerpoint/.test(mime) ? "📽" : "📎");
const sizeText = (n) => (n > 1048576 ? (n / 1048576).toFixed(1).replace(".", ",") + " МБ" : Math.max(1, Math.round(n / 1024)) + " КБ");
const toBase64 = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = () => rej(new Error("Не удалось прочитать файл")); r.readAsDataURL(blob); });

/** Фото уменьшаем до 1600 px и сжимаем: быстрее грузится и влезает в таблицу/Диск. Остальные файлы — как есть (до 12 МБ). */
async function prepareFile(file) {
  let blob = file, name = file.name || "файл", mime = file.type || "application/octet-stream";
  if (/^image\/(jpeg|png|webp)$/.test(mime) && file.size > 250 * 1024 && window.createImageBitmap) {
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const small = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.82));
      if (small && small.size < file.size) { blob = small; mime = "image/jpeg"; name = name.replace(/\.[^.]+$/, "") + ".jpg"; }
    } catch (_) { /* оставляем исходный файл */ }
  }
  if (blob.size > MAX_FILE) throw new Error(`«${name}» слишком большой (${sizeText(blob.size)}). Можно до 12 МБ.`);
  return {name, mime, blob, preview: /^image\//.test(mime) ? URL.createObjectURL(blob) : ""};
}
async function uploadFile(p) {
  const r = await api("POST", "/api/files", {name: p.name, mime: p.mime, data: await toBase64(p.blob)});
  return r.file;
}
/** Окно выбора файла телефона/компьютера. */
function chooseFiles(multiple, cb) {
  const input = h("input", {type: "file", multiple: multiple, style: "display:none"});
  input.addEventListener("change", () => { const list = [...input.files]; input.remove(); if (list.length) cb(list); });
  document.body.append(input); input.click();
}
const fileChip = (f, extra) => h("a", {class: "fchip", href: f.url, target: "_blank", rel: "noopener", download: f.local ? f.name : null},
  h("span", {class: "fi"}, fileIcon(f.mime)), h("span", {class: "fn"}, f.name, h("small", {}, sizeText(f.size))), extra || null);

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
  if (!e.id) return toast("Событие ещё готовится. Попробуйте через минуту.", {bad: true});
  let items = [], lastTs = 0, attach = [];
  const msgs = h("div", {class: "msgs", role: "log", "aria-live": "polite"});
  const chips = h("div", {class: "attach-row"});
  const ta = h("textarea", {class: "input chat-input", rows: "1", placeholder: "Сообщение", "aria-label": "Сообщение",
    oninput: () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; }});
  const sendBtn = h("button", {class: "send", "aria-label": "Отправить", onclick: () => send()}, icon("plane"));
  const attachBtn = h("button", {class: "clip", "aria-label": "Прикрепить фото или файл", onclick: () => {
    if (!state.filesReady) return toast("Файлы пока не подключены. Попросите администратора системы включить Google Диск.", {bad: true});
    chooseFiles(true, async (list) => { for (const f of list.slice(0, 5 - attach.length)) { try { attach.push(await prepareFile(f)); } catch (err) { toast(err.message, {bad: true}); } } paintChips(); });
  }}, "📎");
  const paintChips = () => chips.replaceChildren(...attach.map((a, i) => h("span", {class: "achip"}, a.preview ? h("img", {src: a.preview, alt: ""}) : fileIcon(a.mime), h("em", {}, a.name), h("button", {"aria-label": "Убрать", onclick: () => { attach.splice(i, 1); paintChips(); }}, "×"))));
  const stick = () => { msgs.scrollTop = msgs.scrollHeight; };
  const paint = (toBottom) => {
    const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
    let lastDay = "";
    const nodes = [];
    for (const m of items) {
      const day = dayLabel(m.ts);
      if (day !== lastDay) { nodes.push(h("div", {class: "dsep"}, h("span", {}, day))); lastDay = day; }
      const files = (m.files || []).map((f) => (/^image\//.test(f.mime) && (f.thumb || f.url)
        ? h("a", {class: "mimg", href: f.local ? f.url : f.url, target: "_blank", rel: "noopener"}, h("img", {src: f.thumb || f.url, alt: f.name, loading: "lazy", referrerpolicy: "no-referrer"}))
        : fileChip(f)));
      const status = m.pending ? " · отправляется…" : m.failed ? " · не отправлено, нажмите, чтобы повторить" : "";
      nodes.push(h("div", {class: "msg" + (m.mine ? " mine" : "") + (m.failed ? " failed" : "") + (m.pending ? " pending" : ""), onclick: m.failed ? () => retry(m) : null},
        m.mine ? null : avatarEl(m.uid, m.name, "sm"),
        h("div", {class: "bubble"},
          m.mine ? null : h("b", {class: "mname"}, m.name),
          m.text ? h("p", {}, m.text) : null,
          files.length ? h("div", {class: "mfiles"}, ...files) : null,
          h("small", {class: "mtime"}, clockOf(m.ts) + status, m.canDelete && !m.pending && !m.failed ? h("button", {class: "mdel", "aria-label": "Удалить сообщение", onclick: (ev) => { ev.stopPropagation(); confirmDialog("Удалить сообщение?", "Оно пропадёт у всех.", "Удалить", () => del(m)); }}, "удалить") : null))));
    }
    if (!items.length) nodes.push(h("div", {class: "empty small"}, h("div", {}, "Сообщений пока нет. Напишите первым: например, сможете ли вы быть на событии.")));
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
    if (!document.body.contains(ov) || offlineNow()) return;
    try { const r = await api("GET", "/api/comments", {event: e.id, since: lastTs}); if (merge(r.items)) paint(); } catch (_) { /* нет связи — следующий раз */ }
  };
  const push = (m) => {
    chatQueue.push(async () => {
      m.pending = true; m.failed = false; paint();
      try {
        const metas = [];
        for (const a of m._prep || []) metas.push(await uploadFile(a));
        const r = await api("POST", "/api/comments", {event: e.id, text: m.text, files: metas});
        items = items.filter((x) => x !== m);
        merge([r.item]); paint();
        e.comments = (e.comments || 0) + 1;
      } catch (err) { m.pending = false; m.failed = true; toast(err.message, {bad: true}); paint(); }
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
      files: prep.map((a) => ({name: a.name, mime: a.mime, size: a.blob.size, thumb: a.preview, url: a.preview, local: true})), _prep: prep};
    attach = []; ta.value = ""; ta.style.height = "auto"; paintChips();
    items.push(m); paint(true); push(m);
  };
  const del = async (m) => {
    items = items.filter((x) => x.id !== m.id); paint();
    try { await api("DELETE", "/api/comments", {id: m.id}); e.comments = Math.max(0, (e.comments || 1) - 1); } catch (err) { toast(err.message, {bad: true}); poll(); }
  };
  const title = h("div", {class: "chathead"}, h("b", {}, e.title), h("small", {}, `${shortDate(e.date)} · ${timeLabel(e)}`));
  const sh = sheet(title, msgs, chips, h("div", {class: "composer"}, attachBtn, ta, sendBtn));
  sh.classList.add("chat");
  const {ov} = overlay(sh);
  ta.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); send(); } });
  paint();
  api("GET", "/api/comments", {event: e.id}).then((r) => { merge(r.items); paint(true); }).catch((err) => { msgs.replaceChildren(h("div", {class: "empty small"}, err.message)); });
  const timer = setInterval(() => { if (!document.body.contains(ov)) clearInterval(timer); else poll(); }, 4000);
}

/** Подробная карточка события: открывается из календаря площадок и из списка расписания. */
function eventDetails(e) {
  const canEdit = state.me.canEdit;
  const hex = e.hall ? hexOfHall(e.hall) : null;
  const when = e.dateEnd ? `${dayTitle(e.date)} — ${dayTitle(e.dateEnd)}` : dayTitle(e.date);
  const roles = Object.entries(e.roles || {});
  const files = (e.meta && e.meta.files) || [];
  const filesBlock = files.length || (canEdit && state.filesReady) ? h("div", {class: "field"}, h("span", {}, "Файлы"),
    ...files.map((f) => fileChip(f, canEdit ? h("button", {class: "fdel", "aria-label": "Убрать файл", onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); removeEventFile(e, f); }}, "×") : null)),
    canEdit && state.filesReady && e.id ? h("button", {class: "link", onclick: () => attachToEvent(e)}, "+ Прикрепить файл") : null) : null;
  const {close} = overlay(sheet(
    h("h2", {}, e.title),
    h("div", {class: "dmeta"},
      h("div", {class: "drow"}, h("span", {}, "Когда"), h("b", {}, when)),
      h("div", {class: "drow"}, h("span", {}, "Время"), h("b", {}, timeLabel(e))),
      e.hall ? h("div", {class: "drow"}, h("span", {}, "Площадка"), h("b", {class: "vtag", style: `background:${hex};color:${inkOn(hex)}`}, cap(e.hall))) : null),
    e.meta && e.meta.kind === "meeting" ? h("div", {class: "meet-tag"}, "📋 Собрание") : null,
    e.meta && e.meta.note ? h("p", {class: "meet-note"}, e.meta.note) : null,
    filesBlock,
    e.mine && e.mine.length ? h("div", {class: "note ok"}, icon("check"), h("span", {}, "Вы заняты: " + e.mine.map(roleText).join(", "))) : null,
    roles.length ? h("div", {class: "field"}, h("span", {}, "Кто занят"), h("ul", {class: "roles"}, roles.map(([role, names]) => h("li", {class: (e.mine || []).includes(role) ? "me" : ""}, tag(role), h("div", {class: "n"}, names.join(", ")))))) : h("div", {class: "hint-line"}, "Людей на событие пока не назначили"),
    h("button", {class: "btn chat-open", onclick: () => { close(); chatSheet(e); }}, "💬 Обсуждение" + (e.comments ? ` · ${e.comments}` : "")),
    h("div", {class: "actions"},
      canEdit ? h("button", {class: "btn light", onclick: () => { close(); confirmDialog("Удалить событие?", `«${e.title}» пропадёт из расписания, а сотрудникам придёт сообщение об отмене.`, "Удалить", () => remove(e)); }}, icon("trash"), "Удалить") : null,
      canEdit ? h("button", {class: "btn", onclick: () => { close(); editor(e); }}, icon("pencil"), "Редактировать") : h("button", {class: "btn", onclick: () => close()}, "Закрыть"))));
}

/** Прикрепить файл к событию (администратор и редактор). Для собрания всем уходит уведомление «добавлен файл». */
function attachToEvent(e) {
  chooseFiles(true, async (list) => {
    if (offlineNow()) return toast("Нет интернета: прикрепить можно, когда появится сеть", {bad: true});
    toast("Загружаю файл…", {plane: true});
    try {
      const metas = [];
      for (const f of list.slice(0, 5)) metas.push(await uploadFile(await prepareFile(f)));
      await api("POST", "/api/event-files", {event: e.id, files: metas, notify: true});
      toast(e.meta && e.meta.kind === "meeting" ? "Файл прикреплён, всем ушло уведомление" : "Файл прикреплён", {plane: true});
      await load(false, true);
    } catch (err) { toast(err.message, {bad: true}); }
  });
}
function removeEventFile(e, f) {
  confirmDialog("Убрать файл?", `«${f.name}» пропадёт из события (сам файл на Google Диске останется).`, "Убрать", async () => {
    try { await api("DELETE", "/api/event-files", {event: e.id, fileId: f.id}); toast("Файл убран"); await load(false, true); } catch (err) { toast(err.message, {bad: true}); }
  });
}

function plaque(e) {
  const hex = e.hall ? hexOfHall(e.hall) : FALLBACK_HEX;
  return h("button", {class: "plaque", style: `background:${hex};color:${inkOn(hex)}`, "aria-label": `${e.title}, ${timeLabel(e)}${e.hall ? ", " + cap(e.hall) : ""}`, onclick: () => eventDetails(e)},
    h("span", {class: "pt"}, timeLabel(e)),
    h("span", {class: "pm"}, h("b", {}, e.title), e.hall ? h("small", {}, cap(e.hall)) : h("small", {}, "без площадки")));
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
    const colors = [...new Set(list.map((e) => (e.hall ? hexOfHall(e.hall) : FALLBACK_HEX)))];
    const out = d.slice(0, 7) !== ym;
    cells.push(h("button", {class: "calday" + (out ? " out" : "") + (d === state.today ? " today" : "") + (d === day ? " sel" : "") + (d < state.today ? " past" : ""), "aria-pressed": String(d === day),
      "aria-label": `${dayTitle(d)}${list.length ? ", событий: " + list.length : ""}`,
      onclick: () => { state.day = d; if (out) state.calMonth = d.slice(0, 7); render(); }},
      h("b", {}, String(dateParts(d).d)),
      h("span", {class: "dots"}, (colors.length > 3 ? colors.slice(0, 2) : colors).map((c) => h("i", {style: `background:${c}`})), colors.length > 3 ? h("em", {}, "+") : null))); // всегда одна строка (максимум три значка), чтобы ячейки не росли
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
    if (offlineNow()) { err.textContent = "Нет интернета: добавить можно, когда появится сеть."; return; }
    close();
    if (!state.venues.some((v) => hallKey(v) === hallKey(name))) state.venues.push(name);
    state.venueColors[name] = ((state.palette || []).find((c) => c.name === color) || {}).hex || FALLBACK_HEX;
    render(); toast("Добавляю площадку…", {plane: true});
    if (onAdded) onAdded(name);
    enqueue(async () => { await api("POST", "/api/venues", {name, color}); toast("Площадка добавлена", {plane: true}); });
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
    if (offlineNow()) return toast("Нет интернета: цвет можно сменить, когда появится сеть", {bad: true});
    paint(color);
    state.venueColors[name] = (palette.find((c) => c.name === color) || {}).hex || FALLBACK_HEX;
    render(); // календарь за панелью перекрашивается сразу
    enqueue(async () => { await api("PUT", "/api/venues", {name, color}); toast("Цвет сохранён"); });
  }));
  const {close} = overlay(sheet(h("h2", {}, cap(name)), h("div", {class: "field"}, h("span", {}, "Цвет"), body),
    h("div", {class: "actions"},
      h("button", {class: "btn light", onclick: () => { close(); confirmDialog("Убрать площадку?", `«${name}» пропадёт из списка. События останутся, но без площадки их не получится проверить на занятость.`, "Убрать", () => removeVenue(name)); }}, icon("trash"), "Убрать"),
      h("button", {class: "btn", onclick: () => close()}, "Готово"))));
  paint(current);
}

function removeVenue(name) {
  if (offlineNow()) return toast("Нет интернета: убрать площадку можно, когда появится сеть", {bad: true});
  if (state.events.some((e) => hallKey(e.hall) === hallKey(name) && upcoming(e))) return toast("На этой площадке есть будущие события. Сначала перенесите их.", {bad: true});
  state.venues = state.venues.filter((v) => hallKey(v) !== hallKey(name));
  delete state.venueColors[name];
  render(); toast("Убираю площадку…");
  enqueue(async () => { await api("DELETE", "/api/venues", {name}); toast("Площадка убрана"); });
}

/** Плашка «нет интернета»: показываем последнее, что удалось загрузить, и когда это было. */
function offlineBar() {
  if (!state.offline) return null;
  const d = state.savedAt ? new Date(state.savedAt) : null;
  const hhmm = d ? d.toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit"}) : "";
  const same = d && d.toDateString() === new Date().toDateString();
  const when = d ? (same ? "сегодня в " + hhmm : d.toLocaleDateString("ru-RU", {day: "numeric", month: "long"}) + " в " + hhmm) : "";
  return h("div", {class: "note offline", role: "status"}, icon("alert"), h("span", {}, "Нет интернета. Показано последнее сохранённое" + (when ? " (" + when + ")" : "") + ". Изменить расписание можно, когда появится сеть."));
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
    if (offlineNow()) return toast("Нет интернета: сохранить можно, когда появится сеть", {bad: true});
    const add = [...off].filter((d) => !orig.has(d)), remove = [...orig].filter((d) => !off.has(d));
    state.me.off = [...off].sort();
    close(); toast("Сохраняю…", {plane: true});
    enqueue(async () => { await api("POST", "/api/off", {add, remove}); toast("Сохранено: отмеченные дни учтутся при составлении расписания", {plane: true}); });
  });
  const {close} = overlay(sheet(
    h("div", {class: "profhead"}, (state.avatars[me.uid] ? avatarEl(me.uid, me.name, "avatar big") : h("img", {class: "avatar big", src: "avatar.webp", alt: ""})), h("div", {}, h("h2", {}, me.name), h("span", {class: "badge " + me.role}, me.roleLabel))),
    h("div", {class: "dmeta"},
      me.login ? h("div", {class: "drow"}, h("span", {}, "Ваш логин"), h("b", {class: "mono"}, me.login)) : null,
      social("telegram", "Telegram", cfg.BOT_URL ? cfg.BOT_URL + "?start=" : ""),
      social("vk", "ВКонтакте", cfg.VK_URL ? cfg.VK_URL + "?ref=" : "")),
    h("div", {class: "field"}, h("span", {}, "Когда я не могу работать"), calBox, info),
    h("div", {class: "actions"}, h("button", {class: "btn light", onclick: () => close()}, "Закрыть"), save)));
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

let loading = false;
async function load(manual = false, force = false) {
  if (!state.token) return render();
  if (loading) return;
  if (opsPending > 0 && !force) return; // идёт отправка правок: подгрузка стёрла бы то, что на экране
  if (navigator.onLine === false && state.ready) { setOffline(true); if (manual) toast("Нет интернета: показано последнее сохранённое", {bad: true}); return; }
  loading = true;
  try {
    const d = await api("GET", "/api/schedule");
    const next = {me: d.me, events: d.events, roles: d.roles, allRoles: d.allRoles || d.roles, staff: d.staff || [], venues: d.venues || [], venueColors: d.venueColors || {}, palette: d.palette || [], unavailable: d.unavailable || {}, filesReady: Boolean(d.filesReady), groups: d.groups || [], layout: d.layout || 2, rev: d.rev || "", today: d.today};
    Object.assign(state, next, {ready: true, offline: false, savedAt: Date.now()});
    if (d.avatarKey && d.avatarKey !== state.avatarKey) loadAvatars(d.avatarKey); // аватарки меняются редко: грузим только при смене ключа
    try { localStorage.setItem("ktk_cache", JSON.stringify({...next, savedAt: state.savedAt})); } catch (_) {}
    render();
    if (manual) toast("Обновлено");
  } catch (e) {
    if (!state.token) return; // 401: api() уже вернул на экран входа
    if (e.offline && state.ready) { setOffline(true); if (manual) toast(e.message, {bad: true}); return; } // нет сети: остаёмся на последних сохранённых данных
    toast(e.message, {bad: true});
    if (!state.ready) root.replaceChildren(h("div", {class: "loading"}, h("div", {class: "empty"}, cloud(), h("h3", {}, "Не удалось загрузить"), h("p", {}, e.message),
      h("div", {class: "stack"}, h("button", {class: "btn", onclick: () => { render(); load(); }}, "Повторить"), h("button", {class: "btn light", onclick: logout}, "Выйти")))));
  } finally { loading = false; }
}

// ---------- редактирование: администратор и редактор ----------
function actionSheet(e) {
  const {close} = overlay(sheet(h("h2", {}, e.title),
    h("button", {class: "option", onclick: () => { close(); editor(e); }}, h("span", {class: "ic"}, icon("pencil")), "Редактировать"),
    h("button", {class: "option danger", onclick: () => { close(); confirmDialog("Удалить событие?", `«${e.title}» пропадёт из расписания, а сотрудникам придёт сообщение об отмене.`, "Удалить", () => remove(e)); }}, h("span", {class: "ic"}, icon("trash")), "Удалить")));
}

function remove(e) {
  if (e.pending) return toast("Событие ещё сохраняется, подождите секунду", {bad: true});
  if (offlineNow()) return toast("Нет интернета: удалить можно, когда появится сеть", {bad: true});
  state.events = state.events.filter((x) => x.row !== e.row);
  render(); toast("Удаляю…", {plane: true});
  enqueue(async () => {
    const t = await resolveTarget(e);
    await api("DELETE", `/api/events/${t.row}`, {rev: t.rev});
    toast("Событие удалено, сотрудникам ушло сообщение", {plane: true});
  });
}

/** Сохранение события: сразу показываем его в списке, на сервер отправляем в очереди. */
function saveEventOptimistic(orig, event, force, meta) {
  const mine = Object.entries(event.roles).filter(([, names]) => names.includes(state.me.name)).map(([role]) => role);
  const local = {...event, mine, rev: "tmp", pending: true, row: orig ? orig.row : -Date.now(), id: orig ? orig.id : "", comments: orig ? orig.comments : 0, meta: meta || (orig && orig.meta) || {kind: "event", note: "", files: []}};
  if (orig) state.events = state.events.map((x) => (x.row === orig.row ? local : x)); else state.events.push(local);
  sortEvents(); render(); toast(orig ? "Сохраняю…" : "Добавляю…", {plane: true});
  enqueue(async () => {
    const t = await resolveTarget(orig);
    await api(orig ? "PUT" : "POST", orig ? `/api/events/${t.row}` : "/api/events", {event, rev: t && t.rev, force: force || undefined, meta: meta || undefined});
    toast(meta && meta.kind === "meeting" && !orig ? (meta.publish === false ? "Собрание создано, всем сотрудникам ушло уведомление" : "Собрание создано: уведомление всем и пост в группу отправлены") : orig ? "Сохранено, сотрудникам ушло сообщение" : "Событие добавлено, сотрудникам ушло сообщение", {plane: true});
  });
}

function editor(e) {
  if (e && e.pending) return toast("Событие ещё сохраняется, подождите секунду", {bad: true});
  const times = e && e.time ? e.time.split(/,\s*/) : [];
  const draft = e
    ? {row: e.row, rev: e.rev, kind: (e.meta && e.meta.kind) || "event", note: (e.meta && e.meta.note) || "", files: ((e.meta && e.meta.files) || []).slice(), publish: false, title: e.title, date: e.date, dateEnd: e.dateEnd || "", time: times[0] || "", extra: times.slice(1), end: e.end || "", hall: e.hall || "", roles: JSON.parse(JSON.stringify(e.roles))}
    : {kind: "event", note: "", files: [], publish: true, title: "", date: state.today, dateEnd: "", time: "", extra: [], end: "", hall: "", roles: {}};
  const {ov, close} = overlay("");
  const paint = () => {
    const venues = [...new Set([...state.venues, draft.hall].filter(Boolean))];
    const err = h("div", {class: "error", role: "alert"});
    const title = h("input", {class: "input", value: draft.title, placeholder: "Например, Спектакль «Бука»", oninput: (ev) => { draft.title = ev.target.value; ev.target.classList.remove("bad"); err.textContent = ""; }});
    const date = h("input", {class: "input", type: "date", value: draft.date, onchange: (ev) => { draft.date = ev.target.value; paint(); }});
    const dateEnd = h("input", {class: "input", type: "date", value: draft.dateEnd, min: draft.date, onchange: (ev) => { draft.dateEnd = ev.target.value; paint(); }});
    const start = h("input", {class: "input", type: "time", value: draft.time, "aria-label": "Начало", onchange: (ev) => { draft.time = ev.target.value; if (!draft.time) draft.end = ""; paint(); }});
    const end = h("input", {class: "input", type: "time", value: draft.end, "aria-label": "Окончание", disabled: !draft.time, onchange: (ev) => { draft.end = ev.target.value; paint(); }});
    const hallChips = h("div", {class: "chips"},
      ...venues.map((x) => h("button", {class: "chip withdot" + (hallKey(draft.hall) === hallKey(x) ? " on" : ""), onclick: () => { draft.hall = hallKey(draft.hall) === hallKey(x) ? "" : x; paint(); }}, h("i", {class: "cdot", style: `background:${hexOfHall(x)}`}), cap(x))),
      h("button", {class: "chip add", onclick: () => addVenueSheet((name) => { draft.hall = name; paint(); })}, "+ новая"));
    const clash = conflictsFor({...draft, time: [draft.time, ...draft.extra].filter(Boolean).join(", ")});
    const warn = clash.length ? h("div", {class: "warn"}, icon("alert"), h("span", {}, `Площадка занята: ${clash.map((c) => `${c.title} (${timeLabel(c)})`).join("; ")}`)) : null;
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
    const note = h("textarea", {class: "input", rows: "3", placeholder: "О чём собрание, повестка, что подготовить (необязательно)", oninput: (ev) => (draft.note = ev.target.value)}, draft.note);
    note.value = draft.note;
    const fileList = h("div", {class: "files"}, ...draft.files.map((f, i) => fileChip(f, h("button", {class: "fdel", "aria-label": "Убрать файл", onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); draft.files.splice(i, 1); paint(); }}, "×"))),
      draft.uploading ? h("div", {class: "hint-line"}, "Загружаю файл…") : null,
      h("button", {class: "btn light attach", disabled: !state.filesReady || draft.uploading, onclick: () => chooseFiles(true, async (list) => {
        if (offlineNow()) return toast("Нет интернета: файл можно приложить, когда появится сеть", {bad: true});
        draft.uploading = true; paint();
        try { for (const f of list.slice(0, 5)) draft.files.push(await uploadFile(await prepareFile(f))); } catch (er) { toast(er.message, {bad: true}); }
        draft.uploading = false; paint();
      })}, "📎 Прикрепить файл"),
      state.filesReady ? null : h("div", {class: "hint-line"}, "Файлы пока не подключены: попросите администратора системы включить Google Диск."));
    const announceBox = !draft.row ? h("label", {class: "check"}, h("input", {type: "checkbox", checked: draft.publish, onchange: (ev) => (draft.publish = ev.target.checked)}), h("span", {}, "Выложить в группу ВК и канал (всем сотрудникам уведомление в личные сообщения придёт в любом случае)")) : null;
    const meetingBlock = meeting ? h("div", {class: "meetblock"}, h("label", {class: "field"}, h("span", {}, "Описание"), note), h("div", {class: "field"}, h("span", {}, "Файлы"), fileList), announceBox) : null;
    const save = h("button", {class: "btn", disabled: Boolean(draft.uploading)}, draft.row ? "Сохранить" : (meeting ? "Создать собрание" : "Создать"));
    const doSave = (force) => {
      err.textContent = "";
      const event = {title: draft.title.trim(), date: draft.date, dateEnd: draft.dateEnd || "", time: [draft.time, ...draft.extra].filter(Boolean).join(", "), end: draft.end, hall: draft.hall, roles: draft.roles};
      if (!event.title) return shakeBad(title, err, "Введите название события");
      if (!event.date) return shakeBad(date, err, "Укажите дату");
      if (offlineNow()) { err.textContent = "Нет интернета: сохранить можно, когда появится сеть."; return; }
      if (badPeople.length) { err.textContent = "Не могут работать в эти дни: " + badPeople.join(", ") + ". Уберите их или смените дату."; return; }
      if (!force && clash.length) { confirmDialog("Площадка занята", `Площадка занята: ${clash.map((c) => `${c.title} (${timeLabel(c)})`).join("; ")}. Сохранить всё равно?`, "Сохранить", () => doSave(true)); return; }
      close();
      const meta = draft.kind === "meeting" || (e && e.meta && (e.meta.kind === "meeting" || e.meta.note || (e.meta.files || []).length))
        ? {kind: draft.kind, note: draft.note.trim(), files: draft.files, publish: draft.publish} : null;
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
  try { const c = JSON.parse(localStorage.getItem("ktk_cache") || "null"); if (c && c.events && c.me) Object.assign(state, c, {ready: true}); } catch (_) {}
  try { const a = JSON.parse(localStorage.getItem("ktk_avatars") || "null"); if (a && a.items) Object.assign(state, {avatars: a.items, avatarKey: a.key || ""}); } catch (_) {}
  if (navigator.onLine === false && state.ready) state.offline = true;
}
render();
if (state.token) load().then(() => {
  const m = /^#event=([0-9a-f]+)/.exec(location.hash || ""); // ссылка из уведомления о собрании
  if (m && state.ready) { const ev = state.events.find((x) => x.id === m[1]); if (ev) eventDetails(ev); history.replaceState(null, "", location.pathname + location.search); }
});

// Раз в несколько секунд спрашиваем сервер «версия данных изменилась?» (дёшево: таблицу он при этом не читает) и подгружаем новое.
async function poll() {
  if (!state.token || !state.ready || document.hidden || loading || opsPending > 0 || navigator.onLine === false) return;
  try { const r = await api("GET", "/api/ping", {rev: state.rev}); if (r.changed || state.offline) await load(); } catch (_) { /* нет связи — молча ждём следующий раз */ }
}
setInterval(poll, 8000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
window.addEventListener("focus", poll);
window.addEventListener("online", () => { if (state.token) load(); });
window.addEventListener("offline", () => { if (state.token && state.ready) setOffline(true); });
if ("serviceWorker" in navigator && !window.KTK_DEMO && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register("sw.js").catch(() => {}); // страница открывается и без интернета
// масштаб страницы отключён: щипок (на iOS — «жестовые» события) блокируем здесь, двойное касание — в стилях (touch-action: manipulation), чтобы быстрые нажатия по кнопкам не терялись
["gesturestart", "gesturechange", "gestureend"].forEach((t) => document.addEventListener(t, (e) => e.preventDefault()));
document.addEventListener("touchmove", (e) => { if (e.touches && e.touches.length > 1 && e.cancelable) e.preventDefault(); }, {passive: false});
