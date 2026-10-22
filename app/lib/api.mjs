// API приложения. Чистая функция: запрос -> {status, body}. Синхронный код, никакой привязки к платформе.
import {makeToken, readToken} from "./auth.mjs";
import {addDays, buildRow, daysOf, findConflicts, headerRoles, isIdColumn, layoutOf, rowColumns, matchPhones, norm, parseDate, parseEvents, todayIso, validateEvent} from "./core.mjs";
import {platform} from "./platform.mjs";
import {buildReport, checkParams, reportCsv} from "./report.mjs";
import {canEdit, cleanPhotoIds, colorName, ROLE_LABELS, TABS, VENUE_COLORS} from "./store.mjs";

export const SERVER_VERSION = "2026.10.22-5"; // меняется при каждом выпуске; приложение показывает её в профиле

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

/** {ФИО: [даты]}: кто и когда не может работать (только будущие даты) — для выбора людей на событие. */
const unavailableMap = (store, today) => {
  const out = {};
  for (const [name, dates] of store.offByName()) { const list = [...dates].filter((d) => d >= today).sort(); if (list.length) out[name] = list; }
  return out;
};

/** {название площадки: #цвет} — по ним приложение красит плашки событий. */
const venueColorMap = (store) => Object.fromEntries(store.venueList().map((v) => [v.name, v.hex]));
/**
 * Должности для выбора людей на событие: колонки-группы из листа «Сотрудники» (их добавляет администратор), в том виде, как они названы в «Расписании».
 * Если групп нет или в «Расписании» нет таких колонок — все колонки с людьми.
 */
function editableRoles(store, table) {
  const all = headerRoles(table);
  const picked = store.groups().map((g) => all.find((r) => norm(r) === norm(g.name))).filter(Boolean);
  return picked.length ? picked : all;
}
const avatarKey = (store) => platform.sha256hex(JSON.stringify(store.avatarsByUid())).slice(0, 10);
const newId = () => platform.sha256hex(`${platform.randomInt(1e9)}:${platform.randomInt(1e9)}`).slice(0, 8);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const publicUser = (u) => ({name: u.name, role: u.role, roleLabel: ROLE_LABELS[u.role], canEdit: canEdit(u.role)});
/** Для кнопок «Подключить Telegram / ВК»: к каким каналам уже привязан человек и какой у него логин (он идёт в ссылку-подключение). */
const connections = (store, me) => ({login: me.login, channels: [...new Set(store.chats().filter((c) => c.phone === me.phone).map((c) => c.channel))]});

export function handleApi(req, deps) {
  const {store, secret, now = () => Date.now(), afterChange = () => {}, getRev = () => "", bumpRev = () => {}, announce = () => {}, saveReport = () => ({number: 0})} = deps;
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
      const metaMap = store.metaMap();
      const counts = store.commentCounts();
      const events = parseEvents(table, today)
        .filter((e) => (e.dateEnd || e.date) >= addDays(today, -62)) // два месяца назад: для календаря на вкладке «Площадки»
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map((e) => ({...e, rev: rev(table[e.row - 1]),
          meta: e.id && metaMap[e.id] ? {kind: metaMap[e.id].kind, note: metaMap[e.id].note} : {kind: "event", note: ""},
          comments: (e.id && counts[e.id] && counts[e.id].n) || 0,
          mine: Object.entries(e.roles).filter(([, names]) => names.some((n) => matchPhones(n, users).includes(me.phone))).map(([role]) => role)}));
      // площадки: список из листа «Площадки» + все, что уже вписано в события
      const venues = [...store.venues()];
      for (const e of events) if (e.hall && !venues.some((v) => norm(v) === norm(e.hall))) venues.push(e.hall);
      const editor = canEdit(me.role);
      return {status: 200, body: {version: SERVER_VERSION, today, me: {...publicUser(me), ...connections(store, me), uid: store.uid(me.phone), off: store.offDates(me.phone).filter((d) => d >= today)}, roles: editableRoles(store, table), allRoles: headerRoles(table), layout: layoutOf(table).v, rev: getRev(), events, venues, venueColors: venueColorMap(store), palette: VENUE_COLORS,
        staff: editor ? store.staffNames() : undefined, groups: editor ? store.groups() : undefined,
        unavailable: editor ? unavailableMap(store, today) : undefined, avatarKey: avatarKey(store)}};
    }

    // --- отчёт за период (только для редакторов): показать или записать в лист «Отчёты» ---
    if (path === "/api/report" && method === "POST") {
      if (!canEdit(me.role)) throw new HttpError(403, "Отчёты доступны только администраторам");
      const bad = checkParams(body);
      if (bad) throw new HttpError(400, bad);
      const metaMap = store.metaMap();
      const events = parseEvents(store.book.get(TABS.schedule), today);
      const report = buildReport(events, {from: body.from, to: body.to, kind: body.kind, value: body.value, isMeeting: (e) => Boolean(e.id && metaMap[e.id] && metaMap[e.id].kind === "meeting")});
      const out = {report};
      if (body.save) out.saved = saveReport(report, me.name);
      if (body.csv) out.csv = reportCsv(report);
      return {status: 200, body: out};
    }

    // --- аватарки (из профилей ВК и Telegram): {uid: ссылка или маленькая картинка} ---
    if (path === "/api/avatars" && method === "GET") return {status: 200, body: {items: store.avatarsByUid(), key: avatarKey(store)}};

    // --- переписка по событию ---
    const eventById = (id) => parseEvents(store.book.get(TABS.schedule), today).find((e) => id && e.id === id);
    const shape = (c) => ({id: c.id, ts: c.ts, uid: store.uid(c.phone), name: c.name, text: c.text, photos: c.photos, mine: c.phone === me.phone, canDelete: c.phone === me.phone || canEdit(me.role)});
    if (path === "/api/comments" && method === "GET") {
      const id = String(body.event || "");
      if (!eventById(id)) throw new HttpError(404, "Событие не найдено (возможно, его уже удалили).");
      const since = Number(body.since) || 0;
      return {status: 200, body: {items: store.comments(id).filter((c) => c.ts > since).map(shape)}};
    }
    if (path === "/api/comments" && method === "POST") {
      const id = String(body.event || "");
      if (!eventById(id)) throw new HttpError(404, "Событие не найдено (возможно, его уже удалили).");
      const text = String(body.text || "").trim();
      const photos = cleanPhotoIds(body.photos);
      if (!text && !photos.length) throw new HttpError(400, "Напишите сообщение или приложите фото");
      if (text.length > 2000) throw new HttpError(400, "Сообщение слишком длинное");
      return {status: 200, body: {ok: true, item: shape(store.addComment(id, me, text, photos))}};
    }
    if (path === "/api/comments" && method === "DELETE") {
      const r = store.deleteComment(String(body.id || ""), me);
      if (r === null) throw new HttpError(403, "Чужие сообщения удалять может только администратор или редактор.");
      if (!r) throw new HttpError(404, "Сообщение уже удалено.");
      return {status: 200, body: {ok: true}};
    }

    // --- фото в переписке: уже сжатая в приложении картинка (JPEG, base64) хранится в скрытом листе; наружу (боты, группа) не уходит ---
    if (path === "/api/photos" && method === "POST") {
      const data = String(body.data || "").replace(/^data:image\/jpeg;base64,/, "");
      if (!/^[A-Za-z0-9+/=]+$/.test(data) || data.length < 100) throw new HttpError(400, "Это не похоже на фото");
      if (data.length > 160000) throw new HttpError(413, "Фото слишком большое. Попробуйте ещё раз: приложение само уменьшит его.");
      return {status: 200, body: {ok: true, id: store.addPhoto(data)}};
    }
    if (path === "/api/photos" && method === "GET") {
      const id = String(body.id || "");
      const data = /^[0-9a-f]{12}$/.test(id) ? store.photo(id) : "";
      if (!data) throw new HttpError(404, "Фото не найдено");
      return {status: 200, body: {data}};
    }

    // --- «Не могу работать»: каждый отмечает свои даты ---
    if (path === "/api/off" && method === "POST") {
      const clean = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((d) => ISO_RE.test(d)))];
      const add = clean(body.add).filter((d) => d >= today);
      const remove = clean(body.remove);
      if (add.length > 400 || remove.length > 400) throw new HttpError(400, "Слишком много дат за раз");
      // если директор уже поставил человека на работу в этот день, отметить «не могу» нельзя: отказ от смены — через администратора
      if (add.length) {
        const busyDays = new Set();
        for (const e of parseEvents(store.book.get(TABS.schedule), today)) {
          const mineHere = Object.values(e.roles).some((names) => names.some((n) => matchPhones(n, users).includes(me.phone)));
          if (mineHere) for (const d of daysOf(e)) busyDays.add(d);
        }
        const clash = add.filter((d) => busyDays.has(d));
        if (clash.length) throw new HttpError(409, `На ${clash.map((d) => d.slice(8, 10) + "." + d.slice(5, 7)).join(", ")} вам уже назначена смена, отметить «не могу» нельзя. Если не получится выйти, напишите администратору: он снимет вас со смены.`, {busy: clash});
      }
      store.setOff(me.phone, me.name, add, remove);
      bumpRev();
      return {status: 200, body: {ok: true, off: store.offDates(me.phone).filter((d) => d >= today)}};
    }

    if (path === "/api/venues" && ["POST", "PUT", "DELETE"].includes(method)) {
      if (!canEdit(me.role)) throw new HttpError(403, "Площадки могут менять только администратор и редактор.");
      const name = String(body.name || "").split(/\s+/).filter(Boolean).join(" ");
      if (!name) throw new HttpError(400, "Укажите название площадки");
      if (name.length > 60) throw new HttpError(400, "Название слишком длинное");
      if (method === "PUT") {
        if (!colorName(body.color)) throw new HttpError(400, "Выберите цвет из списка");
        if (!store.setVenueColor(name, body.color)) throw new HttpError(404, "Такой площадки нет");
      } else if (method === "POST") {
        if (body.color && !colorName(body.color)) throw new HttpError(400, "Выберите цвет из списка");
        store.addVenue(name, body.color);
      } else {
        const busy = parseEvents(store.book.get(TABS.schedule), today).some((e) => norm(e.hall) === norm(name) && (e.dateEnd || e.date) >= today);
        if (busy) throw new HttpError(409, "На этой площадке есть будущие события. Сначала перенесите их.");
        store.removeVenue(name);
      }
      bumpRev();
      return {status: 200, body: {ok: true, venues: store.venues(), venueColors: venueColorMap(store)}};
    }

    if (["POST", "PUT", "DELETE"].includes(method) && path.startsWith("/api/events")) {
      if (!canEdit(me.role)) throw new HttpError(403, "Менять расписание могут только администратор и редактор.");
      const table = store.book.get(TABS.schedule);
      const roles = headerRoles(table);
      const layout = layoutOf(table);
      // событие можно назвать номером строки (/api/events/5) или своим ID (/api/events/id-1a2b3c4d): по ID приложение
      // правит и то, что отправляло из очереди с задержкой (строки за это время могли сдвинуться)
      const seg = path.split("/")[3] || "";
      const byId = /^id-[0-9a-f]{8}$/.test(seg) ? seg.slice(3) : "";
      const rowNo = byId ? ((parseEvents(table, today).find((e) => e.id === byId) || {}).row || 0) : Number(seg || 0);
      // ID для нового события может прийти от приложения: повторная отправка (связь оборвалась на ответе) ничего не задваивает
      const wantId = /^[0-9a-f]{8}$/.test(String(body.id || "")) ? String(body.id) : "";
      if (method === "POST" && wantId && parseEvents(table, today).some((e) => e.id === wantId)) return {status: 200, body: {ok: true, id: wantId, duplicate: true}};

      if (method !== "POST") {
        if (!(rowNo >= 2) || !table[rowNo - 1]) {
          if (byId && method === "DELETE") return {status: 200, body: {ok: true, gone: true}}; // уже удалено: цель достигнута
          throw new HttpError(404, "Событие не найдено (возможно, его уже удалили).");
        }
        if (!byId && body.rev !== undefined && body.rev !== rev(table[rowNo - 1])) throw new HttpError(409, "Событие уже изменили. Обновите страницу и повторите.");
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
      // сотрудник отметил, что в эти дни не может: выбрать его нельзя (кроме тех, кто уже стоит на этом событии)
      if (!errors.length) {
        const old = method === "PUT" ? parseEvents(table, today).find((x) => x.row === rowNo) : null;
        const already = new Set(Object.values(old?.roles || {}).flat());
        const days = daysOf(event);
        const off = store.offByName();
        const names = [...new Set(Object.values(event.roles || {}).flat())].filter((n) => !already.has(n));
        for (const n of names) {
          const hit = days.filter((d) => off.get(n)?.has(d));
          if (hit.length) errors.push(`${n} отметил(а), что не может работать ${hit.map((d) => d.slice(8, 10) + "." + d.slice(5, 7)).join(", ")}`);
        }
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
      const columns = rowColumns(table);
      const hasId = columns.some(isIdColumn);
      const meta = body.meta && typeof body.meta === "object" ? body.meta : null;
      if (meta && !hasId) throw new HttpError(409, "Таблица ещё готовится (появляется служебная колонка). Повторите через минуту.");
      const old = method === "PUT" ? parseEvents(table, today).find((e) => e.row === rowNo) : null;
      const id = hasId ? ((old && old.id) || wantId || newId()) : "";
      const cells = buildRow(event, columns, today, layout, id);

      if (method === "POST") {
        writeAt(store, table, event.date, cells, today);
      } else {
        if (old && old.date !== event.date) { // дата изменилась: переносим строку, чтобы лист остался по порядку
          store.book.remove(TABS.schedule, rowNo);
          writeAt(store, store.book.get(TABS.schedule), event.date, cells, today);
        } else {
          store.book.set(TABS.schedule, rowNo, cells);
        }
      }
      if (meta && id) {
        const kind = meta.kind === "meeting" ? "meeting" : "event";
        const patch = {kind, note: String(meta.note || ""), author: store.uid(me.phone)};
        store.setMeta(id, patch);
      }
      bumpRev();
      afterChange();
      if (method === "POST" && meta && id && meta.kind === "meeting" && meta.announce !== false) {
        try { announce({kind: "meeting", event: {...event, id}, note: String(meta.note || ""), publish: meta.publish !== false}); } catch (e) { console.error(String(e.message || e)); }
      }
      return {status: 200, body: {ok: true, id}};
    }
    throw new HttpError(404, "Не найдено");
  } catch (e) {
    if (e instanceof HttpError) return {status: e.status, body: {error: e.message, ...e.extra}};
    console.error(String(e?.message || e));
    return {status: 500, body: {error: "Что-то пошло не так. Попробуйте ещё раз."}};
  }
}
