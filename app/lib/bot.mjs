// Диалог с сотрудником (одинаков для любого мессенджера) и рассылка уведомлений. Синхронный код.
import {matchPhones, parseEvents, parseGrid, planCycle, todayIso} from "./core.mjs";
import {afishaText, appButton, MENU_COMMANDS, msgAlreadyLinked, msgApp, msgMenu, msgNoApp, msgChangesDigest, msgAskPhone, msgIntro, msgAuthLocked, msgBlocked, msgChange, msgAccessGranted, msgChoosePin, msgEnterPin, msgLogin, msgPinInvalid, msgPinSaved, msgPinUsed, msgPostEmpty, msgPostNoRights, msgPostNotConfigured, msgPostPreview, msgPostResult, msgReminder, msgStopped, msgWelcome, msgWrongCode, publicAfishaText, shiftsText} from "./format.mjs";
import {Gone} from "./telegram.mjs";
import {canEdit, normLogin, TABS, validPin} from "./store.mjs";

/**
 * channel: {name, send(chatId, text, options)}; options: "contact" | "remove" | {button: {text, url}}
 * ev: {chatId, text, phone}
 * publishers: {targets(): [названия мест], post(text): [строки-итоги]} — публикация афиши в группу ВК / канал Telegram (необязательно)
 */
export function handleMessage({store, channel, ev, appUrl = "", now = Date.now(), publishers = null, log = () => {}, lookupName = () => ""}) {
  const chat = ev.chatId;
  const text = String(ev.text || "").trim();
  store.ensureLogins();
  const users = store.users();
  const btn = appButton(appUrl);
  const menuFor = (u) => ({editor: canEdit(u.role) && Boolean(publishers && publishers.targets().length), appUrl});

  // Разовый шестизначный код выдаёт директор. Он только начинает активацию; постоянным кодом войти в новый чат нельзя.
  const startPayload = ev.start || (/^\/start(?:@\w+)?\s+(\S+)/i.exec(text) || [])[1] || "";
  const loginText = startPayload || (text && !text.startsWith("/") ? text : "");
  // Совместимость для уже заведённых сотрудников: собственный контакт Telegram безопасен,
  // но новая регистрация и обычный вход номера телефона не требуют.
  if (ev.phone) {
    const digits = String(ev.phone).replace(/\D/g, "").replace(/^8(?=\d{10}$)/, "7");
    const key = digits.length === 11 && digits.startsWith("7") ? digits.slice(1) : digits;
    const u = users.find((x) => x.phone === key);
    if (u && u.role !== "blocked") { store.bind(channel.name, chat, u.phone, u.name); return channel.send(chat, msgWelcome(u.name, u.login), {menu: menuFor(u)}); }
    if (u) return channel.send(chat, msgBlocked);
  }
  const mine = store.chats().find((c) => c.channel === channel.name && c.chatId === String(chat));
  const user = mine ? users.find((x) => x.phone === mine.phone) : null;
  if (!user) {
    const pending = store.activations().find((a) => a.channel === channel.name && a.chatId === String(chat));
    if (pending) {
      if (!validPin(text)) return channel.send(chat, msgPinInvalid);
      const current = store.users().find((x) => x.phone === pending.person);
      if (!current || current.role === "blocked") return channel.send(chat, msgBlocked);
      if (pending.mode === "login") {
        if (String(current.pin) !== text) {
          const failed = store.authFailed(channel.name, chat);
          return channel.send(chat, failed.blockedUntil ? msgAuthLocked : msgWrongCode(5 - failed.attempts));
        }
      } else if (!store.setPermanentLogin(pending.person, text)) return channel.send(chat, msgPinUsed);
      const fresh = store.users().find((x) => x.phone === pending.person);
      store.cancelActivation(channel.name, chat);
      store.authSucceeded(channel.name, chat);
      store.bind(channel.name, chat, fresh.phone, fresh.name);
      const credentials = `ID: ${fresh.login}\nPIN: ${fresh.pin}`;
      return channel.send(chat, msgPinSaved(fresh.name, fresh.login, fresh.pin), {menu: menuFor(fresh), copy: {text: "📋 Скопировать ID и PIN", value: credentials}});
    }
    const auth = store.authState(channel.name, chat);
    if (auth.blockedUntil > now) return channel.send(chat, msgAuthLocked);
    const byLogin = loginText && validPin(loginText) ? users.find((x) => normLogin(x.login) === normLogin(loginText)) : null;
    if (byLogin) {
      if (byLogin.role === "blocked") return channel.send(chat, msgBlocked);
      store.beginActivation(channel.name, chat, byLogin.phone, byLogin.temporary || !byLogin.pin ? "activate" : "login");
      return channel.send(chat, byLogin.temporary || !byLogin.pin ? msgChoosePin(byLogin.name) : msgEnterPin(byLogin.name));
    }
    if (loginText && validPin(loginText)) {
      const failed = store.authFailed(channel.name, chat);
      return channel.send(chat, failed.blockedUntil ? msgAuthLocked : msgWrongCode(5 - failed.attempts));
    }
    return channel.send(chat, /^\/start/i.test(text) || !text ? msgIntro : msgAskPhone);
  }
  if (user.role === "blocked") return channel.send(chat, msgBlocked);

  // /start в уже привязанном чате не должен запускать повторную авторизацию: иначе случайный код
  // мог бы переключить чат на другого сотрудника. Показываем это явно, а не маскируем главным меню.
  if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
    return channel.send(chat, msgAlreadyLinked(user.name, user.login), {menu: menuFor(user)});
  }

  const asked = MENU_COMMANDS[text] || MENU_COMMANDS[text.toLowerCase()] || text; // нажатие кнопки меню = команда
  const [first = "", ...rest] = asked.split(/\s+/);
  const cmd = first.toLowerCase().split("@")[0];
  const today = todayIso(now);
  if (cmd === "/shifts") {
    const rows = parseGrid(store.book.get(TABS.schedule), today).filter((r) => r.date >= today && r.person && matchPhones(r.person, users).includes(user.phone));
    return channel.send(chat, shiftsText(rows), btn);
  }
  if (cmd === "/schedule") {
    return channel.send(chat, afishaText(parseGrid(store.book.get(TABS.schedule), today).filter((r) => r.date >= today)), btn);
  }
  if (cmd === "/login") {
    const fresh = store.users().find((x) => x.phone === user.phone);
    const credentials = `ID: ${fresh.login}\nPIN: ${fresh.pin}`;
    return channel.send(chat, msgLogin(fresh.login, fresh.pin), {...btn, copy: {text: "📋 Скопировать ID и PIN", value: credentials}});
  }
  if (cmd === "/post") {
    if (!canEdit(user.role)) return channel.send(chat, msgPostNoRights);
    const targets = publishers ? publishers.targets() : [];
    if (!targets.length) return channel.send(chat, msgPostNotConfigured);
    const text = publicAfishaText(parseEvents(store.book.get(TABS.schedule), today), today);
    if (!text) return channel.send(chat, msgPostEmpty);
    if (!/^(да|yes|ok)$/i.test(text0(rest))) return channel.send(chat, msgPostPreview(text, targets), {menu: {...menuFor(user), confirm: true}}); // сначала показываем, что уйдёт; кнопка «Опубликовать» — внизу
    return channel.send(chat, msgPostResult(publishers.post(text)), {menu: menuFor(user)});
  }
  if (cmd === "/stop") {
    store.unbind(channel.name, chat);
    return channel.send(chat, msgStopped, "remove");
  }
  if (cmd === "/app") return appUrl ? channel.send(chat, msgApp, btn) : channel.send(chat, msgNoApp);
  return channel.send(chat, msgMenu, {menu: menuFor(user)}); // /start, /menu, /help и любое непонятное слово — главное меню
}

const text0 = (words) => String(words[0] || "").trim();

/** Сверяет расписание с прошлой версией, рассылает уведомления и напоминания. senders: {telegram: {send}, ...} */
export function runCycle({store, senders, now = Date.now(), appUrl = "", log = console}) {
  store.ensureOwner();
  store.ensureLogins();
  for (const c of store.chats().filter((x) => /^заявка/i.test(x.name || ""))) store.unbind(c.channel, c.chatId); // старый мусор: чаты, привязанные к «заявке»
  // администратор открыл доступ тем, кто оставил заявку: подключаем их чат и пишем «доступ открыт»
  const welcomed = new Set(); // кому «доступ открыт» уже отправили в этом проходе
  for (const rq of store.requests()) {
    const u = store.activeUsers().find((x) => x.phone === rq.phone);
    if (!u) continue;
    const cur = store.chats().find((c) => c.channel === rq.channel && c.chatId === rq.chatId);
    if (cur && cur.phone !== u.phone && store.activeUsers().some((x) => x.phone === cur.phone)) { store.removeRequest(rq.channel, rq.chatId); continue; } // чат уже у другого сотрудника — его подключение не трогаем
    welcomed.add(u.phone);
    store.bind(rq.channel, rq.chatId, u.phone, u.name);
    store.removeRequest(rq.channel, rq.chatId);
    try { senders[rq.channel]?.send(rq.chatId, msgAccessGranted(u.name, u.login), {menu: {editor: false, appUrl}}); } catch (err) { if (!(err instanceof Gone)) log.error(String(err.message || err)); }
  }
  const users = store.activeUsers();
  const table = store.book.get(TABS.schedule);
  const snap = store.snapshot();
  const plan = planCycle(table, users, snap, now);
  // каждый раз, когда человеку открывают доступ (в том числе повторно: закрыли и снова открыли), ему приходит уведомление
  const accessNow = [...new Set(users.map((u) => u.phone))].sort();
  const accessBefore = (snap.meta || {}).access;
  plan.snap.meta = {...plan.snap.meta, access: accessNow};
  if (Array.isArray(accessBefore)) {
    const chatsNow = store.chats();
    for (const u of users) {
      if (accessBefore.includes(u.phone) || welcomed.has(u.phone)) continue;
      welcomed.add(u.phone);
      for (const c of chatsNow.filter((x) => x.phone === u.phone)) {
        try { senders[c.channel]?.send(c.chatId, msgAccessGranted(u.name, u.login), appButton(appUrl)); }
        catch (err) { if (err instanceof Gone) store.unbind(c.channel, c.chatId); else log.error(String(err.message || err)); }
      }
    }
  }
  if (JSON.stringify(plan.snap) !== JSON.stringify({chats: [], ...snap})) store.saveSnapshot(plan.snap);

  // человек на одном событии может стоять на нескольких должностях: изменения по одному событию сводим в одно сообщение
  const changeGroups = new Map();
  for (const c of plan.changes) {
    const k = [c.phone, c.kind, c.row.date, c.row.event, c.row.time].join("|");
    const g = changeGroups.get(k);
    if (g) { if (c.row.role && !g.roles.includes(c.row.role)) g.roles.push(c.row.role); } else changeGroups.set(k, {c, roles: c.row.role ? [c.row.role] : []});
  }
  // всё, что изменилось у одного человека за этот проход (назначили на одно, перенесли другое, сняли с третьего), — одно сообщение
  const byPhone = new Map();
  for (const {c, roles} of changeGroups.values()) {
    const list = byPhone.get(c.phone) || [];
    list.push({kind: c.kind, row: {...c.row, role: roles.join(", ")}, old: c.old});
    byPhone.set(c.phone, list);
  }
  const messages = [...byPhone].map(([phone, items]) => ({phone, text: items.length === 1 ? msgChange(items[0].kind, items[0].row, items[0].old) : msgChangesDigest(items)}));
  const groups = new Map();
  for (const r of plan.reminders) {
    const k = r.phone + "\t" + r.kind;
    groups.set(k, {phone: r.phone, kind: r.kind, rows: [...(groups.get(k)?.rows || []), r.row]});
  }
  for (const g of groups.values()) messages.push({phone: g.phone, text: msgReminder(g.kind, g.rows)});

  if (!messages.length) return {sent: 0};
  const chats = store.chats();
  const btn = appButton(appUrl);
  let sent = 0;
  for (const m of messages) {
    for (const c of chats.filter((x) => x.phone === m.phone)) {
      try {
        senders[c.channel]?.send(c.chatId, m.text, btn);
        sent++;
      } catch (err) {
        if (err instanceof Gone) store.unbind(c.channel, c.chatId);
        else log.error(String(err.message || err));
      }
    }
  }
  return {sent};
}
