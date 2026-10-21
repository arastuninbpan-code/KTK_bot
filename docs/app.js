"use strict";
const CFG = window.KTK || {};
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
// цвета меток разделов (Администратор, Гардероб, Касса…): по порядку колонок таблицы, из палитры
const TAG_COLORS = [["#0A96DC", "#fff"], ["#F2961E", "#fff"], ["#F04E4A", "#fff"], ["#F4C79A", "#1B3560"], ["#1B3560", "#fff"], ["#D4F1FC", "#1B3560"]];

const state = {token: localStorage.getItem("ktk_token") || "", me: null, events: [], roles: [], staff: [], venues: [], venueColors: {}, palette: [], groups: [], layout: 2, rev: "", today: "", day: "", calMonth: "", tab: "all", ready: false, offline: false, savedAt: 0, unavailable: {}};
const root = document.getElementById("root");

// ---------- разметка без innerHTML ----------
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
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
const tagStyle = (role) => { const i = Math.max(0, state.roles.indexOf(role)) % TAG_COLORS.length; return `background:${TAG_COLORS[i][0]};color:${TAG_COLORS[i][1]}`; };
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
  return h("button", {class: "ev" + (e.mine.length ? " mine" : "") + (urgent ? " urgent" : ""), style: outline, onclick: () => (canEdit ? actionSheet(e) : eventDetails(e)), "aria-label": `${canEdit ? "Изменить" : "Открыть"}: ${e.title}`},
    time,
    h("div", {}, h("h3", {}, e.title), range, hall, roles.length ? list : null),
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
    e.mine && e.mine.length ? h("div", {class: "note ok"}, icon("check"), h("span", {}, "Вы заняты: " + e.mine.map(roleText).join(", "))) : null,
    roles.length ? h("div", {class: "field"}, h("span", {}, "Кто занят"), h("ul", {class: "roles"}, roles.map(([role, names]) => h("li", {class: (e.mine || []).includes(role) ? "me" : ""}, tag(role), h("div", {class: "n"}, names.join(", ")))))) : h("div", {class: "hint-line"}, "Людей на событие пока не назначили"),
    h("div", {class: "actions"},
      canEdit ? h("button", {class: "btn light", onclick: () => { close(); confirmDialog("Удалить событие?", `«${e.title}» пропадёт из расписания, а сотрудникам придёт сообщение об отмене.`, "Удалить", () => remove(e)); }}, icon("trash"), "Удалить") : null,
      canEdit ? h("button", {class: "btn", onclick: () => { close(); editor(e); }}, icon("pencil"), "Редактировать") : h("button", {class: "btn", onclick: () => close()}, "Закрыть"))));
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
      h("span", {class: "dots"}, colors.slice(0, 4).map((c) => h("i", {style: `background:${c}`})), colors.length > 4 ? h("em", {}, "+") : null)));
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
    if (!name) { err.textContent = "Введите название"; return; }
    add.disabled = true;
    try { await api("POST", "/api/venues", {name, color}); close(); toast("Площадка добавлена", {plane: true}); await load(); if (onAdded) onAdded(name); }
    catch (e) { err.textContent = e.message; add.disabled = false; }
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
  const paint = (sel) => body.replaceChildren(swatches(sel, async (color) => {
    paint(color);
    try { await api("PUT", "/api/venues", {name, color}); toast("Цвет сохранён"); await load(); } catch (e) { toast(e.message, {bad: true}); paint(current); }
  }));
  const {close} = overlay(sheet(h("h2", {}, cap(name)), h("div", {class: "field"}, h("span", {}, "Цвет"), body),
    h("div", {class: "actions"},
      h("button", {class: "btn light", onclick: () => { close(); confirmDialog("Убрать площадку?", `«${name}» пропадёт из списка. События останутся, но без площадки их не получится проверить на занятость.`, "Убрать", () => removeVenue(name)); }}, icon("trash"), "Убрать"),
      h("button", {class: "btn", onclick: () => close()}, "Готово"))));
  paint(current);
}

async function removeVenue(name) {
  try { await api("DELETE", "/api/venues", {name}); toast("Площадка убрана"); await load(); } catch (e) { toast(e.message, {bad: true}); }
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
      cells.push(h("button", {class: "calday" + (outM ? " out" : "") + (past ? " dis" : "") + (off.has(d) ? " off" : "") + (d === state.today ? " today" : ""), disabled: past || outM, "aria-pressed": String(off.has(d)),
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
    info.textContent = n ? `Отмечено дней: ${n}. На эти дни вас нельзя будет назначить на событие.` : "Нажимайте на даты, когда не можете работать. Синий кружок — день, когда у вас уже есть смена.";
    save.disabled = !dirty();
  };
  save.addEventListener("click", async () => {
    save.disabled = true;
    try {
      const r = await api("POST", "/api/off", {add: [...off].filter((d) => !orig.has(d)), remove: [...orig].filter((d) => !off.has(d))});
      state.me.off = r.off;
      close(); toast("Сохранено: отмеченные дни учтутся при составлении расписания", {plane: true}); load();
    } catch (e) { toast(e.message, {bad: true}); save.disabled = false; }
  });
  const {close} = overlay(sheet(
    h("div", {class: "profhead"}, h("img", {class: "avatar big", src: "avatar.webp", alt: ""}), h("div", {}, h("h2", {}, me.name), h("span", {class: "badge " + me.role}, me.roleLabel))),
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
          h("img", {class: "avatar", src: "avatar.webp", alt: ""}),
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
async function load(manual = false) {
  if (!state.token) return render();
  if (loading) return;
  if (navigator.onLine === false && state.ready) { setOffline(true); if (manual) toast("Нет интернета: показано последнее сохранённое", {bad: true}); return; }
  loading = true;
  try {
    const d = await api("GET", "/api/schedule");
    const next = {me: d.me, events: d.events, roles: d.roles, staff: d.staff || [], venues: d.venues || [], venueColors: d.venueColors || {}, palette: d.palette || [], unavailable: d.unavailable || {}, groups: d.groups || [], layout: d.layout || 2, rev: d.rev || "", today: d.today};
    Object.assign(state, next, {ready: true, offline: false, savedAt: Date.now()});
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

async function remove(e) {
  try { await api("DELETE", `/api/events/${e.row}`, {rev: e.rev}); toast("Событие удалено, сотрудникам ушло сообщение", {plane: true}); await load(); } catch (err) { toast(err.message, {bad: true}); if (err.status === 409) load(); }
}

function editor(e) {
  const times = e && e.time ? e.time.split(/,\s*/) : [];
  const draft = e
    ? {row: e.row, rev: e.rev, title: e.title, date: e.date, dateEnd: e.dateEnd || "", time: times[0] || "", extra: times.slice(1), end: e.end || "", hall: e.hall || "", roles: JSON.parse(JSON.stringify(e.roles))}
    : {title: "", date: state.today, dateEnd: "", time: "", extra: [], end: "", hall: "", roles: {}};
  const {ov, close} = overlay("");
  const paint = () => {
    const venues = [...new Set([...state.venues, draft.hall].filter(Boolean))];
    const err = h("div", {class: "error", role: "alert"});
    const title = h("input", {class: "input", value: draft.title, placeholder: "Например, Спектакль «Бука»", oninput: (ev) => (draft.title = ev.target.value)});
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
    const roleBlocks = state.roles.map((role) => {
      const names = draft.roles[role] || [];
      return h("div", {class: "roleblock"}, tag(role),
        h("div", {class: "chips"},
          ...names.map((n) => h("button", {class: "chip person", "aria-label": `Убрать ${n}`, onclick: () => { draft.roles[role] = names.filter((x) => x !== n); if (!draft.roles[role].length) delete draft.roles[role]; paint(); }}, n + " ×")),
          h("button", {class: "chip add", onclick: () => picker(role, names, (sel) => { if (sel.length) draft.roles[role] = sel; else delete draft.roles[role]; paint(); }, {row: draft.row, date: draft.date, dateEnd: draft.dateEnd, time: [draft.time, ...draft.extra].filter(Boolean).join(", "), end: draft.end})}, "+ добавить")));
    });
    const save = h("button", {class: "btn"}, draft.row ? "Сохранить" : "Создать");
    const doSave = async (force) => {
      err.textContent = "";
      const event = {title: draft.title.trim(), date: draft.date, dateEnd: draft.dateEnd || "", time: [draft.time, ...draft.extra].filter(Boolean).join(", "), end: draft.end, hall: draft.hall, roles: draft.roles};
      save.disabled = true;
      try {
        await api(draft.row ? "PUT" : "POST", draft.row ? `/api/events/${draft.row}` : "/api/events", {event, rev: draft.rev, force: force || undefined});
        close(); toast(draft.row ? "Сохранено, сотрудникам ушло сообщение" : "Событие добавлено, сотрудникам ушло сообщение", {plane: true}); await load();
      } catch (er) {
        save.disabled = false;
        if (er.data && er.data.conflicts) confirmDialog("Площадка занята", er.message + ". Сохранить всё равно?", "Сохранить", () => doSave(true));
        else { err.textContent = er.message; if (er.status === 409) load(); }
      }
    };
    save.addEventListener("click", () => doSave(false));
    ov.replaceChildren(sheet(h("h2", {}, draft.row ? "Редактировать событие" : "Новое событие"),
      h("label", {class: "field"}, h("span", {}, "Название"), title),
      h("div", {class: "row2"}, h("label", {class: "field", style: "flex:1"}, h("span", {}, "Дата"), date),
        draft.dateEnd || draft.multi ? h("label", {class: "field", style: "flex:1"}, h("span", {}, "По"), dateEnd) : null),
      draft.dateEnd || draft.multi ? null : h("button", {class: "link", onclick: () => { draft.multi = true; paint(); }}, "Несколько дней"),
      h("div", {class: "row2"},
        h("label", {class: "field", style: "flex:1"}, h("span", {}, "Начало"), start),
        h("label", {class: "field", style: "flex:1"}, h("span", {}, "Окончание"), end)),
      draft.extra.length ? h("div", {class: "hint-line"}, "Ещё время в таблице: " + draft.extra.join(", ")) : null,
      h("div", {class: "field"}, h("span", {}, "Площадка"), hallChips, warn),
      h("div", {class: "field"}, h("span", {}, "Кто занят"), ...roleBlocks, warnOff),
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
      const locked = off.length && !sel.includes(n); // отметил «не могу» — выбрать нельзя (а если уже стоял на событии, можно только снять)
      const busy = locked ? [] : busyWith(n, cand);
      const note = off.length ? "не может: " + off.map((d) => shortDate(d)).join(", ") : busy.length ? "уже занят(а): " + busy.map((e) => `${e.title}, ${timeLabel(e)}`).join("; ") : "";
      return h("button", {class: "pick" + (sel.includes(n) ? " on" : "") + (locked ? " off" : "") + (busy.length ? " warnp" : ""), disabled: locked, "aria-disabled": String(Boolean(locked)),
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
  if (navigator.onLine === false && state.ready) state.offline = true;
}
render();
if (state.token) load();

// Раз в несколько секунд спрашиваем сервер «версия данных изменилась?» (дёшево: таблицу он при этом не читает) и подгружаем новое.
async function poll() {
  if (!state.token || !state.ready || document.hidden || loading || navigator.onLine === false) return;
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
