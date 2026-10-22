// Диалог с сотрудником (одинаков для любого мессенджера) и рассылка уведомлений. Синхронный код.
import {looksLikePhone, matchPhones, normPhone, parseEvents, parseGrid, planCycle, todayIso} from "./core.mjs";
import {afishaText, appButton, MENU_COMMANDS, msgApp, msgMenu, msgNoApp, msgAlreadyConnected, msgAskPhone, msgIntro, msgBlocked, msgChange, msgConnected, msgAccessGranted, msgCommentSaved, msgLogin, msgPostEmpty, msgPostNoRights, msgPostNotConfigured, msgPostPreview, msgPostResult, msgReminder, msgRequestSent, msgStopped, msgWelcome, publicAfishaText, shiftsText} from "./format.mjs";
import {Gone} from "./telegram.mjs";
import {canEdit, normLogin, TABS} from "./store.mjs";

/**
 * channel: {name, send(chatId, text, options)}; options: "contact" | "remove" | {button: {text, url}}
 * ev: {chatId, text, phone}
 * publishers: {targets(): [названия мест], post(text): [строки-итоги]} — публикация афиши в группу ВК / канал Telegram (необязательно)
 */
export function handleMessage({store, channel, ev, appUrl = "", now = Date.now(), publishers = null, log = () => {}, lookupName = () => ""}) {
  const chat = ev.chatId;
  const text = String(ev.text || "").trim();
  let phone = ev.phone ? normPhone(ev.phone) : null;
  if (!phone && looksLikePhone(text)) phone = normPhone(text); // номер, введённый вручную
  const users = store.users();
  const btn = appButton(appUrl);
  const menuFor = (u) => ({editor: canEdit(u.role) && Boolean(publishers && publishers.targets().length), appUrl});

  // логин, выданный администратором (или пришедший из ссылки «Подключить» в приложении: /start ЛОГИН): сразу узнаём человека
  const startPayload = ev.start || (/^\/start(?:@\w+)?\s+(\S+)/i.exec(text) || [])[1] || "";
  const loginText = startPayload || (text && !text.startsWith("/") ? text : "");
  const byLogin = !phone && loginText ? users.find((x) => x.login && normLogin(x.login) === normLogin(loginText)) : null;
  if (byLogin) phone = byLogin.phone;

  const label = ev.label || channel.name;
  const myRequest = () => store.requests().find((r) => r.channel === channel.name && r.chatId === String(chat));
  // человека нет в таблице: доступа нет, но заявка и его слова видны администратору прямо в листе «Сотрудники»
  const askAccess = (typed) => {
    const mine = myRequest();
    if (mine) log("Заявка: комментарий дописан в строку " + store.addAccessRequest(mine.phone, `${label}: пишет другой номер ${typed}`));
    else {
      let name = ev.name || "";
      if (!name) { try { name = lookupName(); } catch (e) { name = ""; } } // имя из профиля ВК: отдельный запрос, делаем только для заявки
      log("Заявка: записана в строку " + store.addAccessRequest(typed, `${label}: запросил доступ`, name));
      store.addRequest(channel.name, chat, typed);
    }
    return channel.send(chat, msgRequestSent);
  };

  if (phone) {
    const u = users.find((x) => x.phone === phone);
    // чат уже подключён к действующему сотруднику, а человек шлёт чужой номер: заявку не заводим (иначе она потом «переехала» бы на этот чат и сбила подключение)
    const bound = store.chats().find((c) => c.channel === channel.name && c.chatId === String(chat));
    const boundUser = bound ? users.find((x) => x.phone === bound.phone && x.role !== "blocked") : null;
    if (!u && boundUser) return channel.send(chat, msgAlreadyConnected(boundUser.name));
    if (!u) return askAccess(phone);
    if (u.role === "blocked") {
      if (!u.pending) return channel.send(chat, msgBlocked);
      store.addRequest(channel.name, chat, phone); // заявка уже есть в таблице, связываем с этим чатом
      return channel.send(chat, msgRequestSent);
    }
    store.bind(channel.name, chat, phone, u.name);
    store.ensureLogins(); // логин для входа в приложение показываем сразу
    const fresh = store.users().find((x) => x.phone === u.phone) || u;
    return channel.send(chat, msgWelcome(u.name, fresh.login), {menu: menuFor(u)});
  }

  const mine = store.chats().find((c) => c.channel === channel.name && c.chatId === String(chat));
  const user = mine ? users.find((x) => x.phone === mine.phone) : null;
  if (!user) {
    const req = myRequest();
    if (req && text && !text.startsWith("/")) { // сообщение от человека с открытой заявкой: пишем в комментарий администратору
      log("Заявка: комментарий записан в строку " + store.addAccessRequest(req.phone, `${label}: ${text}`));
      return channel.send(chat, msgCommentSaved);
    }
    return req ? channel.send(chat, msgRequestSent) : channel.send(chat, /^\/start/i.test(text) || !text ? msgIntro : msgAskPhone, "contact"); // первое знакомство — вступление, дальше короткая просьба
  }
  if (user.role === "blocked") return channel.send(chat, msgBlocked);

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
    store.ensureLogins();
    const fresh = store.users().find((x) => x.phone === user.phone);
    return channel.send(chat, msgLogin(fresh.login), {...btn, copy: {text: "📋 Скопировать логин", value: fresh.login}});
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
  const messages = [...changeGroups.values()].map(({c, roles}) => ({phone: c.phone, text: msgChange(c.kind, {...c.row, role: roles.join(", ")}, c.old)}));
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
