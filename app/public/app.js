"use strict";
const BOT_URL = "https://t.me/k_t_k_bot";
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const WD = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
const DEFAULT_HALLS = ["большая сцена", "малая сцена"];

const state = {token: localStorage.getItem("ktk_token") || "", me: null, events: [], roles: [], staff: [], today: "", tab: "all", loading: false};
const root = document.getElementById("root");

// ---------- мелочи ----------
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
const roleText = (r) => String(r || "").replace(/\s*\/\s*/g, " / ");
const dateParts = (iso) => { const [y, m, d] = iso.split("-").map(Number); return {d, m: MONTHS[m - 1], wd: WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}; };
const dayTitle = (iso) => { const p = dateParts(iso); return `${p.wd}, ${p.d} ${p.m}`; };
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const shortDate = (iso) => { const p = dateParts(iso); return `${p.d} ${p.m.slice(0, 3)}`; };

let toastTimer;
function toast(text, bad = false) {
  const t = document.getElementById("toast");
  t.textContent = text; t.className = "show" + (bad ? " bad" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 3200);
}

async function api(method, path, body) {
  const r = await fetch(path, {method, headers: {"Content-Type": "application/json", ...(state.token ? {Authorization: "Bearer " + state.token} : {})}, body: body ? JSON.stringify(body) : undefined});
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && state.token) { logout(); throw new Error("Войдите заново"); }
  if (!r.ok) { const e = new Error(data.error || "Ошибка"); e.status = r.status; throw e; }
  return data;
}

function logout() {
  localStorage.removeItem("ktk_token");
  state.token = ""; state.me = null; state.events = [];
  render();
}

// ---------- панели как в DNA ----------
function overlay(content, {center = false} = {}) {
  const ov = h("div", {class: "overlay" + (center ? " center" : ""), onclick: (e) => { if (e.target === ov) close(); }}, content);
  const close = () => ov.remove();
  const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
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
  const input = h("input", {class: "code-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", placeholder: "••••••", "aria-label": "Код из бота",
    oninput: () => { input.value = input.value.replace(/\D/g, "").slice(0, 6); err.textContent = ""; if (input.value.length === 6) go(); }});
  const btn = h("button", {class: "btn", onclick: () => go()}, "Войти");
  async function go() {
    if (busy || input.value.length < 6) { if (input.value.length < 6) err.textContent = "Введите 6 цифр из бота"; return; }
    busy = true; btn.disabled = true;
    try {
      const r = await api("POST", "/api/login", {code: input.value});
      state.token = r.token; localStorage.setItem("ktk_token", r.token);
      await load();
    } catch (e) { err.textContent = e.message; input.value = ""; input.focus(); } finally { busy = false; btn.disabled = false; }
  }
  return h("main", {class: "login"},
    h("img", {class: "hero", src: "/avatar.webp", alt: ""}),
    h("h1", {}, "Расписание театра"),
    h("p", {class: "sub"}, "Ваши смены и события в одном месте"),
    h("div", {class: "sticker"},
      h("ol", {class: "steps"},
        h("li", {}, h("span", {}, "Откройте бота в Telegram и подключитесь (кнопка «Поделиться номером»)")),
        h("li", {}, h("span", {}, ["Отправьте боту команду ", h("b", {}, "/login"), ": он пришлёт код"])),
        h("li", {}, h("span", {}, "Введите код здесь"))),
      input, err, h("div", {class: "stack"}, btn, h("a", {class: "btn light", href: BOT_URL, target: "_blank", rel: "noopener"}, "✈️ Открыть бота"))));
}

// ---------- расписание ----------
function eventCard(e) {
  const dir = state.me.role === "director";
  const time = e.time ? h("div", {class: "time"}, e.time.split(/,\s*/).map((t, i) => h("div", {}, t))) : h("div", {class: "time none"}, e.dateEnd ? "несколько дней" : "весь день");
  const range = e.dateEnd ? h("div", {class: "hall", style: "background:var(--cream)"}, `${shortDate(e.date)} — ${shortDate(e.dateEnd)}`) : null;
  const hall = e.hall ? h("div", {class: "hall" + (/малая/i.test(e.hall) ? " small" : "")}, "📍 " + e.hall) : null;
  const roles = Object.entries(e.roles).filter(([r]) => state.tab !== "mine" || e.mine.includes(r));
  const list = h("ul", {class: "roles"}, roles.map(([role, names]) => h("li", {class: e.mine.includes(role) ? "me" : ""}, [h("span", {class: "r"}, roleText(role)), h("span", {class: "n"}, names.join(", "))])));
  const card = h(dir ? "button" : "article", {class: "ev" + (e.mine.length ? " mine" : ""), ...(dir ? {onclick: () => actionSheet(e), "aria-label": `Изменить: ${e.title}`} : {})},
    time,
    h("div", {}, h("h3", {}, e.title), range, hall, roles.length ? list : null),
    dir ? h("span", {class: "edit-hint", "aria-hidden": "true"}, "✏️") : (e.mine.length ? h("span", {class: "mine-tag"}, "вы") : null));
  return card;
}

function appView() {
  const dir = state.me.role === "director";
  const list = state.events.filter((e) => state.tab === "all" || e.mine.length);
  const byDay = new Map();
  for (const e of list) {
    const key = e.date < state.today ? state.today : e.date; // многодневные события, которые уже идут, показываем под «Сегодня»
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }

  const body = h("div", {});
  if (!list.length) {
    body.append(h("div", {class: "empty"}, h("img", {src: "/avatar.webp", alt: ""}), h("div", {}, state.tab === "mine" ? "Пока нет ваших смен" : "Событий пока нет"),
      dir ? h("div", {}, "Нажмите «+», чтобы добавить первое") : null));
  }
  for (const [date, evs] of byDay) {
    const pill = date === state.today ? h("span", {class: "pill"}, "Сегодня") : date === addDays(state.today, 1) ? h("span", {class: "pill tom"}, "Завтра") : null;
    body.append(h("div", {class: "day"}, h("h2", {}, dayTitle(date)), pill), ...evs.map(eventCard));
  }
  return h("main", {class: "app"},
    h("div", {class: "top"},
      h("div", {class: "bar"},
        h("img", {class: "avatar", src: "/avatar.webp", alt: ""}),
        h("div", {class: "who"}, h("b", {}, state.me.name), h("span", {class: "badge" + (dir ? " dir" : "")}, dir ? "Директор" : "Сотрудник")),
        h("button", {class: "icon-btn", "aria-label": "Обновить", onclick: () => load(true)}, "🔄"),
        h("button", {class: "icon-btn", "aria-label": "Выйти", onclick: () => confirmDialog("Выйти?", "Чтобы войти снова, понадобится новый код из бота.", "Выйти", logout)}, "🚪")),
      h("div", {class: "tabs", role: "tablist"},
        ["all", "mine"].map((t) => h("button", {class: "tab", role: "tab", "aria-selected": String(state.tab === t), onclick: () => { state.tab = t; render(); }}, t === "all" ? "Расписание" : "Мои смены")))),
    body,
    dir ? h("button", {class: "fab", "aria-label": "Добавить событие", onclick: () => editor(null)}, "+") : null);
}

function render() {
  const scroll = window.scrollY;
  root.replaceChildren(state.token && state.me ? appView() : loginView());
  window.scrollTo(0, scroll);
}

async function load(manual = false) {
  if (!state.token) return render();
  try {
    const d = await api("GET", "/api/schedule");
    Object.assign(state, {me: d.me, events: d.events, roles: d.roles, staff: d.staff || [], today: d.today});
    render();
    if (manual) toast("Обновлено");
  } catch (e) { if (state.token) toast(e.message, true); }
}

// ---------- директор: действия и редактор ----------
function actionSheet(e) {
  const {close} = overlay(sheet(h("h2", {}, e.title),
    h("button", {class: "option", onclick: () => { close(); editor(e); }}, h("span", {class: "ico"}, "✏️"), "Редактировать"),
    h("button", {class: "option danger", onclick: () => { close(); confirmDialog("Удалить событие?", `«${e.title}» пропадёт из расписания, а сотрудникам придёт уведомление об отмене.`, "Удалить", () => remove(e)); }}, h("span", {class: "ico"}, "🗑"), "Удалить")));
}

async function remove(e) {
  try { await api("DELETE", `/api/events/${e.row}`, {rev: e.rev}); toast("Событие удалено"); await load(); } catch (err) { toast(err.message, true); if (err.status === 409) load(); }
}

function editor(e) {
  const draft = e
    ? {row: e.row, rev: e.rev, title: e.title === "Смена" && !e.hall ? "" : e.title, date: e.date, dateEnd: e.dateEnd || "", times: e.time ? e.time.split(/,\s*/) : [], hall: e.hall || "", roles: JSON.parse(JSON.stringify(e.roles))}
    : {title: "", date: state.today, dateEnd: "", times: [], hall: "", roles: {}};
  if (e && e.title === "Смена") draft.title = "Смена";
  const halls = [...new Set([...DEFAULT_HALLS, ...state.events.map((x) => x.hall).filter(Boolean), draft.hall].filter(Boolean))];
  const {ov, close} = overlay("");
  const paint = () => {
    const err = h("div", {class: "error", role: "alert"});
    const title = h("input", {class: "input", value: draft.title, placeholder: "Например, Спектакль «Бука»", oninput: (ev) => (draft.title = ev.target.value)});
    const date = h("input", {class: "input", type: "date", value: draft.date, onchange: (ev) => (draft.date = ev.target.value)});
    const dateEnd = h("input", {class: "input", type: "date", value: draft.dateEnd, min: draft.date, onchange: (ev) => (draft.dateEnd = ev.target.value)});
    const timeInputs = draft.times.map((t, i) => h("div", {class: "row2", style: "margin-bottom:8px"},
      h("input", {class: "input", type: "time", value: t, onchange: (ev) => (draft.times[i] = ev.target.value)}),
      h("button", {class: "icon-btn", "aria-label": "Убрать время", onclick: () => { draft.times.splice(i, 1); paint(); }}, "✕")));
    const hallChips = h("div", {class: "chips"}, ...halls.map((x) => h("button", {class: "chip" + (draft.hall === x ? " on" : ""), onclick: () => { draft.hall = draft.hall === x ? "" : x; paint(); }}, x)));
    const roleBlocks = state.roles.map((role) => {
      const names = draft.roles[role] || [];
      return h("div", {class: "roleblock"}, h("b", {}, roleText(role)),
        h("div", {class: "chips"},
          ...names.map((n) => h("button", {class: "chip person", "aria-label": `Убрать ${n}`, onclick: () => { draft.roles[role] = names.filter((x) => x !== n); if (!draft.roles[role].length) delete draft.roles[role]; paint(); }}, n + " ✕")),
          h("button", {class: "chip add", onclick: () => picker(role, names, (sel) => { if (sel.length) draft.roles[role] = sel; else delete draft.roles[role]; paint(); })}, "+ добавить")));
    });
    const save = h("button", {class: "btn", onclick: async () => {
      err.textContent = "";
      const event = {title: draft.title.trim(), date: draft.date, dateEnd: draft.dateEnd || "", time: draft.times.filter(Boolean).join(", "), hall: draft.hall, roles: draft.roles};
      save.disabled = true;
      try {
        await api(draft.row ? "PUT" : "POST", draft.row ? `/api/events/${draft.row}` : "/api/events", {event, rev: draft.rev});
        close(); toast(draft.row ? "Сохранено" : "Событие добавлено"); await load();
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
      h("span", {class: "box"}, sel.includes(n) ? "✓" : ""), n)), ...(names.length ? [] : [h("div", {class: "empty"}, "Никого не нашли")]));
  };
  const {close} = overlay(sheet(h("h2", {}, roleText(role)), search, list,
    h("div", {class: "actions"}, h("button", {class: "btn", onclick: () => { close(); onDone(sel); }}, "Готово"))));
  fill();
}

// ---------- старт ----------
render();
if (state.token) load();
setInterval(() => { if (state.token && !document.querySelector(".overlay") && !document.hidden) load(); }, 60000);
