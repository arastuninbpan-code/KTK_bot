// API приложения. Чистая функция: запрос -> {status, body}. Синхронный код, никакой привязки к платформе.
import {makeToken, readToken} from "./auth.mjs";
import {buildRow, findConflicts, headerRoles, layoutOf, matchPhones, norm, parseDate, parseEvents, todayIso, validateEvent} from "./core.mjs";
import {platform} from "./platform.mjs";
import {canEdit, ROLE_LABELS, TABS} from "./store.mjs";

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

/** Версия строки: по ней ловим одновременные правки (если строку уже изменили, вернём 409). */
const rev = (cells) => platform.sha256hex((cells || []).map(String).join("\u0001")).slice(0, 12);

/** Номер строки, куда вставить событие с датой `date`, чтобы лист оставался по порядку дат. */
export function insertPosition(table, date, today) {
  for (let i = table.length; i >= 2; i--) {
    const m = String(table[i - 1]?.[0] || "").match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/);
    const d = m ? parseDate(m[1], today) : null;
    if (d && d <= date) return i + 1;
  }
  return 2;
}

function writeAt(store, table, date, cells, today) {
  const at = insertPosition(table, date, today);
  if (at > table.length) store.book.append(TABS.schedule, cells);
  else { store.book.insert(TABS.schedule, at); store.book.set(TABS.schedule, at, cells); }
}

const publicUser = (u) => ({name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role], canEdit: canEdit(u.role)});
/** Для кнопок «Подключить Telegram / ВК»: к каким каналам уже привязан человек и какой у него логин (он идёт в ссылку-подключение). */
const connections = (store, me) => ({login: me.login, channels: [...new Set(store.chats().filter((c) => c.phone === me.phone).map((c) => c.channel))]});

export function handleApi(req, deps) {
  const {store, secret, now = () => Date.now(), afterChange = () => {}, getRev = () => "", bumpRev = () => {}} = deps;
  const {method, path, body = {}, token} = req;
  try {
    // --- без входа ---
    if (method === "POST" && path === "/api/login") {
      store.ensureLogins();
      const user = store.findByLogin(body.login);
      if (!user) { platform.sleep(400); throw new HttpError(401, "Такого логина нет. Отправьте боту /login: он пришлёт ваш логин."); }
      if (user.role === "blocked") throw new HttpError(403, "Доступ закрыт. Обратитесь к администратору.");
      return {status: 200, body: {token: makeToken({sub: user.phone, l: store.loginMark(user.login)}, secret, undefined, now()), user: publicUser(user)}};
    }

    // --- нужен вход ---
    const session = readToken(token, secret, now());
    if (!session) throw new HttpError(401, "Нужно войти");
    // лёгкая проверка «есть ли новое»: без чтения таблицы (только подпись входа и счётчик версий)
    if (path === "/api/ping") { const rv = getRev(); return {status: 200, body: {rev: rv, changed: body.rev !== rv}}; }
    const users = store.users();
    const me = users.find((u) => u.phone === session.sub);
    if (!me || me.role === "blocked" || !me.login || session.l !== store.loginMark(me.login)) throw new HttpError(401, "Нужно войти");
    const today = todayIso(now());

    if (method === "GET" && path === "/api/schedule") {
      const table = store.book.get(TABS.schedule);
      const events = parseEvents(table, today)
        .filter((e) => (e.dateEnd || e.date) >= today)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map((e) => ({...e, rev: rev(table[e.row - 1]),
          mine: Object.entries(e.roles).filter(([, names]) => names.some((n) => matchPhones(n, users).includes(me.phone))).map(([role]) => role)}));
      // площадки: список из листа «Площадки» + все, что уже вписано в события
      const venues = [...store.venues()];
      for (const e of events) if (e.hall && !venues.some((v) => norm(v) === norm(e.hall))) venues.push(e.hall);
      const editor = canEdit(me.role);
      return {status: 200, body: {today, me: {...publicUser(me), ...connections(store, me)}, roles: headerRoles(table), layout: layoutOf(table).v, rev: getRev(), events, venues,
        staff: editor ? store.staffNames() : undefined, groups: editor ? store.groups() : undefined}};
    }

    if (path === "/api/venues" && ["POST", "DELETE"].includes(method)) {
      if (!canEdit(me.role)) throw new HttpError(403, "Площадки могут менять только администратор и редактор.");
      const name = String(body.name || "").split(/\s+/).filter(Boolean).join(" ");
      if (!name) throw new HttpError(400, "Укажите название площадки");
      if (name.length > 60) throw new HttpError(400, "Название слишком длинное");
      if (method === "POST") store.addVenue(name);
      else {
        const busy = parseEvents(store.book.get(TABS.schedule), today).some((e) => norm(e.hall) === norm(name) && (e.dateEnd || e.date) >= today);
        if (busy) throw new HttpError(409, "На этой площадке есть будущие события. Сначала перенесите их.");
        store.removeVenue(name);
      }
      bumpRev();
      return {status: 200, body: {ok: true, venues: store.venues()}};
    }

    if (["POST", "PUT", "DELETE"].includes(method) && path.startsWith("/api/events")) {
      if (!canEdit(me.role)) throw new HttpError(403, "Менять расписание могут только администратор и редактор.");
      const table = store.book.get(TABS.schedule);
      const roles = headerRoles(table);
      const layout = layoutOf(table);
      const rowNo = Number(path.split("/")[3] || 0);

      if (method !== "POST") {
        if (!(rowNo >= 2) || !table[rowNo - 1]) throw new HttpError(404, "Событие не найдено (возможно, его уже удалили).");
        if (body.rev !== undefined && body.rev !== rev(table[rowNo - 1])) throw new HttpError(409, "Событие уже изменили. Обновите страницу и повторите.");
      }
      if (method === "DELETE") {
        store.book.remove(TABS.schedule, rowNo);
        bumpRev();
        afterChange();
        return {status: 200, body: {ok: true}};
      }

      const event = body.event;
      const errors = validateEvent(event);
      const staff = new Set(store.staffNames());
      for (const [role, names] of Object.entries(event?.roles || {})) {
        if (!roles.includes(role)) errors.push(`Нет такой роли: ${role}`);
        for (const n of names) if (!staff.has(n)) errors.push(`Нет такого сотрудника: ${n}`);
      }
      if (errors.length) throw new HttpError(400, errors.join(". "));
      // площадка занята в это время? Предупреждаем; если человек подтвердил (force) — сохраняем
      if (!body.force && event.hall) {
        const clash = findConflicts(parseEvents(table, today), {...event, row: method === "PUT" ? rowNo : -1});
        if (clash.length) {
          const c = clash[0];
          throw new HttpError(409, `Площадка «${event.hall}» занята: ${c.title}${c.time ? ` (${c.time}${c.end ? "–" + c.end : ""})` : ""}`, {conflicts: clash});
        }
      }
      const cells = buildRow(event, roles, today, layout);

      if (method === "POST") {
        writeAt(store, table, event.date, cells, today);
      } else {
        const old = parseEvents(table, today).find((e) => e.row === rowNo);
        if (old && old.date !== event.date) { // дата изменилась: переносим строку, чтобы лист остался по порядку
          store.book.remove(TABS.schedule, rowNo);
          writeAt(store, store.book.get(TABS.schedule), event.date, cells, today);
        } else {
          store.book.set(TABS.schedule, rowNo, cells);
        }
      }
      bumpRev();
      afterChange();
      return {status: 200, body: {ok: true}};
    }
    throw new HttpError(404, "Не найдено");
  } catch (e) {
    if (e instanceof HttpError) return {status: e.status, body: {error: e.message, ...e.extra}};
    console.error(String(e?.message || e));
    return {status: 500, body: {error: "Что-то пошло не так. Попробуйте ещё раз."}};
  }
}
