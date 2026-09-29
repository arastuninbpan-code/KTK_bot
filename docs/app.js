"use strict";
const CFG = window.KTK || {};
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const DEFAULT_HALLS = ["большая сцена", "малая сцена"];
// цвета меток разделов (Администратор, Гардероб, Касса…): по порядку колонок таблицы, из палитры
const TAG_COLORS = [["#0A96DC", "#fff"], ["#F2961E", "#fff"], ["#F04E4A", "#fff"], ["#F4C79A", "#1B3560"], ["#1B3560", "#fff"], ["#D4F1FC", "#1B3560"]];

const state = {token: localStorage.getItem("ktk_token") || "", me: null, events: [], roles: [], staff: [], today: "", tab: "all", ready: false};
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
    } catch (e) { throw new Error("Нет связи с сервером (" + e.message + "). Проверьте, что доступ веб-приложения «Все», а не «Только я»."); }
    try { data = JSON.parse(raw); } catch (e) { throw new Error("Сервер ответил не так, как ждали (код " + r.status + "): " + raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 160)); }
    status = data._status || (r.ok ? 200 : r.status);
  } else {
    const r = await fetch(path, {method, headers: {"Content-Type": "application/json", ...(state.token ? {Authorization: "Bearer " + state.token} : {})}, body: method === "GET" ? undefined : JSON.stringify(body || {})});
    data = await r.json().catch(() => ({}));
    status = r.status;
  }
  if (status === 401 && state.token) { logout(); throw new Error("Войдите заново"); }
  if (status >= 400) { const e = new Error(data.error || "Ошибка"); e.status = status; throw e; }
  return data;
}

function logout() {
  try { localStorage.removeItem("ktk_token"); localStorage.removeItem("ktk_cache"); } catch (_) {}
  Object.assign(state, {token: "", me: null, events: [], ready: false});
  render();
}

// ---------- панели как в DNA ----------
function overlay(content, {center = false} = {}) {
  const ov = h("div", {class: "overlay" + (center ? " center" : ""), onclick: (e) => { if (e.target === ov) close(); }}, content);
  const onKey = (e) => { if (e.key === "Escape") close(); };
  const close = () => { ov.remove(); document.removeEventListener("keydown", onKey); };
  document.addEventListener("keydown", onKey);
  document.body.append(ov);
  return {ov, close};
}
const sheet = (...kids) => h("div", {class: "sheet", role: "dialog", "aria-modal": "true"}, h("div", {class: "handle"}), ...kids);

function confirmDialog(title, text, okLabel, onOk) {
  const {close} = overlay(h("div", {class: "modal", role: "alertdialog"}, h("h2", {}, title), h("p", {}, text),
    h("div", {class: "actions"}, h("button", {class: "btn light", onclick: () => close()}, "Отмена"), h("button", {class: "btn coral", onclick: async () => { close(); await onOk(); }}, okLabel))), {center: true});
}

// ---------- вход ----------
function loginView() {
  let busy = false;
  const err = h("div", {class: "error", role: "alert"});
  const input = h("input", {class: "code-input", autocomplete: "username", autocapitalize: "characters", spellcheck: "false", maxlength: "32", placeholder: "ЛОГИН", "aria-label": "Ваш логин",
    oninput: () => { err.textContent = ""; }, onkeydown: (e) => { if (e.key === "Enter") go(); }});
  const btn = h("button", {class: "btn", onclick: () => go()}, "Войти");
  async function go() {
    if (busy) return;
    if (!input.value.trim()) { err.textContent = "Введите ваш логин"; return; }
    busy = true; btn.disabled = true; btn.textContent = "Входим…"; err.className = "hint"; err.textContent = "Идёт загрузка, подождите несколько секунд…"; input.disabled = true;
    try {
      const r = await api("POST", "/api/login", {login: input.value.trim()});
      state.token = r.token; localStorage.setItem("ktk_token", r.token);
      await load();
    } catch (e) { err.className = "error"; err.textContent = e.message; input.disabled = false; input.focus(); } finally { busy = false; btn.disabled = false; btn.textContent = "Войти"; }
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
  const time = e.time ? h("div", {class: "time"}, e.time.split(/,\s*/).map((t) => h("div", {}, t))) : h("div", {class: "time none"}, e.dateEnd ? "несколько дней" : "весь день");
  const range = e.dateEnd ? h("span", {class: "hall", style: "background:var(--cream)"}, `${shortDate(e.date)} — ${shortDate(e.dateEnd)}`) : null;
  const hall = e.hall ? h("span", {class: "hall" + (/малая/i.test(e.hall) ? " small" : "")}, icon("pin"), cap(e.hall)) : null;
  const roles = Object.entries(e.roles).filter(([r]) => state.tab !== "mine" || e.mine.includes(r));
  const list = h("ul", {class: "roles"}, roles.map(([role, names]) => h("li", {class: e.mine.includes(role) ? "me" : ""}, tag(role), h("div", {class: "n"}, names.join(", ")))));
  const urgent = isSoon(e);
  return h(canEdit ? "button" : "article", {class: "ev" + (e.mine.length ? " mine" : "") + (urgent ? " urgent" : ""), ...(canEdit ? {onclick: () => actionSheet(e), "aria-label": `Изменить: ${e.title}`} : {})},
    time,
    h("div", {}, h("h3", {}, e.title), range, hall, roles.length ? list : null),
    canEdit ? h("span", {class: "edit-hint"}, icon("pencil")) : (e.mine.length ? h("span", {class: "pill mine-tag"}, "вы") : null),
    urgent ? splash() : null);
}

function appView() {
  const canEdit = state.me.canEdit;
  const list = state.events.filter((e) => state.tab === "all" || e.mine.length);
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
  return h("main", {class: "app"},
    h("div", {class: "top"},
      h("div", {class: "bar"},
        h("img", {class: "avatar", src: "avatar.webp", alt: ""}),
        h("div", {class: "who"}, h("b", {}, state.me.name), h("span", {class: "badge " + state.me.role}, state.me.roleLabel)),
        h("button", {class: "icon-btn", "aria-label": "Обновить", onclick: () => load(true)}, icon("refresh")),
        h("button", {class: "icon-btn", "aria-label": "Выйти", onclick: () => confirmDialog("Выйти?", "Чтобы войти снова, понадобится новый код из бота.", "Выйти", logout)}, icon("exit"))),
      h("div", {class: "tabs", role: "tablist"},
        ["all", "mine"].map((t) => h("button", {class: "tab", role: "tab", "aria-selected": String(state.tab === t), onclick: () => { state.tab = t; render(); }}, t === "all" ? "Расписание" : "Мои смены")))),
    body,
    canEdit ? h("button", {class: "fab", "aria-label": "Добавить событие", onclick: () => editor(null)}, icon("plus")) : null);
}

function render() {
  const scroll = window.scrollY;
  if (!state.token) root.replaceChildren(loginView());
  else if (!state.ready) root.replaceChildren(h("div", {class: "loading"}, h("div", {class: "empty"}, cloud(), h("div", {}, "Загружаем расписание"))));
  else root.replaceChildren(appView());
  window.scrollTo(0, scroll);
}

async function load(manual = false) {
  if (!state.token) return render();
  try {
    const d = await api("GET", "/api/schedule");
    Object.assign(state, {me: d.me, events: d.events, roles: d.roles, staff: d.staff || [], today: d.today, ready: true});
    try { localStorage.setItem("ktk_cache", JSON.stringify({me: d.me, events: d.events, roles: d.roles, staff: d.staff || [], today: d.today})); } catch (_) {}
    render();
    if (manual) toast("Обновлено");
  } catch (e) {
    if (!state.token) return; // 401: api() уже вернул на экран входа
    toast(e.message, {bad: true});
    if (!state.ready) root.replaceChildren(h("div", {class: "loading"}, h("div", {class: "empty"}, cloud(), h("h3", {}, "Не удалось загрузить"), h("p", {}, e.message),
      h("div", {class: "stack"}, h("button", {class: "btn", onclick: () => { render(); load(); }}, "Повторить"), h("button", {class: "btn light", onclick: logout}, "Выйти")))));
  }
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
  const draft = e
    ? {row: e.row, rev: e.rev, title: e.title, date: e.date, dateEnd: e.dateEnd || "", times: e.time ? e.time.split(/,\s*/) : [], hall: e.hall || "", roles: JSON.parse(JSON.stringify(e.roles))}
    : {title: "", date: state.today, dateEnd: "", times: [], hall: "", roles: {}};
  const halls = [...new Set([...DEFAULT_HALLS, ...state.events.map((x) => x.hall).filter(Boolean), draft.hall].filter(Boolean))];
  const {ov, close} = overlay("");
  const paint = () => {
    const err = h("div", {class: "error", role: "alert"});
    const title = h("input", {class: "input", value: draft.title, placeholder: "Например, Спектакль «Бука»", oninput: (ev) => (draft.title = ev.target.value)});
    const date = h("input", {class: "input", type: "date", value: draft.date, onchange: (ev) => (draft.date = ev.target.value)});
    const dateEnd = h("input", {class: "input", type: "date", value: draft.dateEnd, min: draft.date, onchange: (ev) => (draft.dateEnd = ev.target.value)});
    const timeInputs = draft.times.map((t, i) => h("div", {class: "row2", style: "margin-bottom:8px"},
      h("input", {class: "input", type: "time", value: t, onchange: (ev) => (draft.times[i] = ev.target.value)}),
      h("button", {class: "icon-btn", "aria-label": "Убрать время", onclick: () => { draft.times.splice(i, 1); paint(); }}, icon("cross"))));
    const hallChips = h("div", {class: "chips"}, ...halls.map((x) => h("button", {class: "chip" + (draft.hall === x ? " on" : ""), onclick: () => { draft.hall = draft.hall === x ? "" : x; paint(); }}, cap(x))));
    const roleBlocks = state.roles.map((role) => {
      const names = draft.roles[role] || [];
      return h("div", {class: "roleblock"}, tag(role),
        h("div", {class: "chips"},
          ...names.map((n) => h("button", {class: "chip person", "aria-label": `Убрать ${n}`, onclick: () => { draft.roles[role] = names.filter((x) => x !== n); if (!draft.roles[role].length) delete draft.roles[role]; paint(); }}, n + " ×")),
          h("button", {class: "chip add", onclick: () => picker(role, names, (sel) => { if (sel.length) draft.roles[role] = sel; else delete draft.roles[role]; paint(); })}, "+ добавить")));
    });
    const save = h("button", {class: "btn", onclick: async () => {
      err.textContent = "";
      const event = {title: draft.title.trim(), date: draft.date, dateEnd: draft.dateEnd || "", time: draft.times.filter(Boolean).join(", "), hall: draft.hall, roles: draft.roles};
      save.disabled = true;
      try {
        await api(draft.row ? "PUT" : "POST", draft.row ? `/api/events/${draft.row}` : "/api/events", {event, rev: draft.rev});
        close(); toast(draft.row ? "Сохранено, сотрудникам ушло сообщение" : "Событие добавлено, сотрудникам ушло сообщение", {plane: true}); await load();
      } catch (er) { err.textContent = er.message; save.disabled = false; if (er.status === 409) load(); }
    }}, draft.row ? "Сохранить" : "Создать");
    ov.replaceChildren(sheet(h("h2", {}, draft.row ? "Редактировать событие" : "Новое событие"),
      h("label", {class: "field"}, h("span", {}, "Название"), title),
      h("div", {class: "row2"}, h("label", {class: "field", style: "flex:1"}, h("span", {}, "Дата"), date),
        draft.dateEnd || draft.multi ? h("label", {class: "field", style: "flex:1"}, h("span", {}, "По"), dateEnd) : null),
      draft.dateEnd || draft.multi ? null : h("button", {class: "link", onclick: () => { draft.multi = true; paint(); }}, "Несколько дней"),
      h("div", {class: "field"}, h("span", {}, "Время"), ...timeInputs,
        draft.times.length < 2 ? h("button", {class: "link", onclick: () => { draft.times.push(""); paint(); }}, draft.times.length ? "+ ещё одно время" : "+ указать время") : null),
      h("div", {class: "field"}, h("span", {}, "Зал"), hallChips),
      h("div", {class: "field"}, h("span", {}, "Кто занят"), ...roleBlocks),
      err,
      h("div", {class: "actions"}, h("button", {class: "btn light", onclick: () => close()}, "Отмена"), save)));
  };
  paint();
}

function picker(role, selected, onDone) {
  let sel = [...selected];
  const list = h("div", {});
  const search = h("input", {class: "input search", placeholder: "Поиск сотрудника", oninput: () => fill()});
  const fill = () => {
    const q = search.value.toLowerCase();
    const names = state.staff.filter((n) => n.toLowerCase().includes(q));
    list.replaceChildren(...names.map((n) => h("button", {class: "pick" + (sel.includes(n) ? " on" : ""), onclick: () => { sel = sel.includes(n) ? sel.filter((x) => x !== n) : [...sel, n]; fill(); }},
      h("span", {class: "box"}, sel.includes(n) ? icon("check") : null), n)), ...(names.length ? [] : [h("div", {class: "empty"}, "Никого не нашли")]));
  };
  const {close} = overlay(sheet(h("h2", {}, roleText(role)), search, list,
    h("div", {class: "actions"}, h("button", {class: "btn", onclick: () => { close(); onDone(sel); }}, "Готово"))));
  fill();
}

// ---------- старт ----------
render();
if (state.token) {
  // сначала показываем прошлое расписание, чтобы не ждать сервер, потом обновляем
  try { const c = JSON.parse(localStorage.getItem("ktk_cache") || "null"); if (c && c.events) Object.assign(state, c, {ready: true}); } catch (_) {}
  load();
}
setInterval(() => { if (state.token && state.ready && !document.querySelector(".overlay") && !document.hidden) load(); }, 60000);
