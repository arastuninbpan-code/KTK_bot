// REST-API сайта. Чистая функция: запрос -> {status, body}. Никакой привязки к Netlify: легко тестировать.
import {createHash} from "node:crypto";
import {makeToken, readToken} from "./auth.mjs";
import {buildRow, headerRoles, matchPhones, parseDate, parseEvents, todayIso, validateEvent} from "./core.mjs";
import {TABS} from "./store.mjs";

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const rev = (cells) => createHash("sha1").update((cells || []).map(String).join("\u0001")).digest("hex").slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Номер строки, куда вставить событие с датой `date`, чтобы лист оставался по порядку дат. */
export function insertPosition(table, date, today) {
  for (let i = table.length; i >= 2; i--) {
    const m = String(table[i - 1]?.[0] || "").match(/^\s*(\d{1,2}\.\d{2}(?:\.\d{2,4})?)/);
    const d = m ? parseDate(m[1], today) : null;
    if (d && d <= date) return i + 1;
  }
  return 2;
}

export async function handleApi(req, deps) {
  const {store, secret, now = () => Date.now(), afterChange = async () => {}, setup} = deps;
  const {method, path, query = {}, body = {}, token} = req;
  try {
    // --- без входа ---
    if (method === "POST" && path === "/api/login") {
      const phone = await store.consumeCode(body.code || "");
      if (!phone) { await sleep(400); throw new HttpError(401, "Код неверный или устарел. Отправьте боту /login и введите новый код."); }
      const user = (await store.users()).find((u) => u.phone === phone);
      if (!user) throw new HttpError(403, "Вас нет в списке сотрудников.");
      return {status: 200, body: {token: makeToken({sub: phone}, secret, undefined, now()), user: {name: user.name, role: user.role}}};
    }
    if (method === "GET" && path === "/api/setup") {
      if (!setup) throw new HttpError(404, "Нет");
      return {status: 200, body: await setup(query.key)};
    }

    // --- нужен вход ---
    const session = readToken(token, secret, now());
    if (!session) throw new HttpError(401, "Нужно войти");
    const users = await store.users();
    const me = users.find((u) => u.phone === session.sub);
    if (!me) throw new HttpError(401, "Нужно войти");
    const isDirector = me.role === "director";
    const today = todayIso(now());

    if (method === "GET" && path === "/api/schedule") {
      const table = await store.book.get(TABS.schedule);
      const events = parseEvents(table, today)
        .filter((e) => (e.dateEnd || e.date) >= today)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map((e) => ({...e, rev: rev(table[e.row - 1]),
          mine: Object.entries(e.roles).filter(([, names]) => names.some((n) => matchPhones(n, users).includes(me.phone))).map(([role]) => role)}));
      return {status: 200, body: {today, me: {name: me.name, role: me.role}, roles: headerRoles(table), events,
        staff: isDirector ? await store.staffNames() : undefined}};
    }

    if (["POST", "PUT", "DELETE"].includes(method) && path.startsWith("/api/events")) {
      if (!isDirector) throw new HttpError(403, "Менять расписание может только директор.");
      const table = await store.book.get(TABS.schedule);
      const roles = headerRoles(table);
      const rowNo = Number(path.split("/")[3] || 0);

      if (method !== "POST") {
        if (!(rowNo >= 2) || !table[rowNo - 1]) throw new HttpError(404, "Событие не найдено (возможно, его уже удалили).");
        if (body.rev !== undefined && body.rev !== rev(table[rowNo - 1])) throw new HttpError(409, "Событие уже изменили. Обновите страницу и повторите.");
      }
      if (method === "DELETE") {
        await store.book.remove(TABS.schedule, rowNo);
        await afterChange();
        return {status: 200, body: {ok: true}};
      }

      const event = body.event;
      const errors = validateEvent(event);
      const staff = new Set(await store.staffNames());
      for (const [role, names] of Object.entries(event?.roles || {})) {
        if (!roles.includes(role)) errors.push(`Нет такой роли: ${role}`);
        for (const n of names) if (!staff.has(n)) errors.push(`Нет такого сотрудника: ${n}`);
      }
      if (errors.length) throw new HttpError(400, errors.join(". "));
      const cells = buildRow(event, roles, today);

      if (method === "POST") {
        const at = insertPosition(table, event.date, today);
        if (at > table.length) await store.book.append(TABS.schedule, cells);
        else { await store.book.insert(TABS.schedule, at); await store.book.set(TABS.schedule, at, cells); }
      } else {
        const old = parseEvents(table, today).find((e) => e.row === rowNo);
        if (old && old.date !== event.date) { // дата изменилась: переносим строку, чтобы лист остался по порядку
          await store.book.remove(TABS.schedule, rowNo);
          const rest = await store.book.get(TABS.schedule);
          const at = insertPosition(rest, event.date, today);
          if (at > rest.length) await store.book.append(TABS.schedule, cells);
          else { await store.book.insert(TABS.schedule, at); await store.book.set(TABS.schedule, at, cells); }
        } else {
          await store.book.set(TABS.schedule, rowNo, cells);
        }
      }
      await afterChange();
      return {status: 200, body: {ok: true}};
    }
    throw new HttpError(404, "Не найдено");
  } catch (e) {
    if (e instanceof HttpError) return {status: e.status, body: {error: e.message}};
    console.error(String(e?.message || e));
    return {status: 500, body: {error: "Что-то пошло не так. Попробуйте ещё раз."}};
  }
}
