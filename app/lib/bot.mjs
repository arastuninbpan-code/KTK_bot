// Диалог с сотрудником (одинаков для любого мессенджера) и рассылка уведомлений.
import {looksLikePhone, matchPhones, normPhone, planCycle, todayIso} from "./core.mjs";
import {afishaText, msgAskPhone, msgChange, msgConnected, msgLogin, msgReminder, msgStopped, msgUnknownPhone, msgWelcome, shiftsText} from "./format.mjs";
import {Gone} from "./telegram.mjs";
import {TABS} from "./store.mjs";

/**
 * channel: {name, send(chatId, text, keyboard)}; ev: {chatId, text, phone}
 * Возвращает после отправки ответа.
 */
export async function handleMessage({store, channel, ev, siteUrl = "", now = Date.now()}) {
  const chat = ev.chatId;
  const text = String(ev.text || "").trim();
  let phone = ev.phone ? normPhone(ev.phone) : null;
  if (!phone && looksLikePhone(text)) phone = normPhone(text); // номер, введённый вручную
  const users = await store.users();

  if (phone) {
    const u = users.find((x) => x.phone === phone);
    if (!u) return channel.send(chat, msgUnknownPhone);
    await store.bind(channel.name, chat, phone, u.name);
    return channel.send(chat, msgWelcome(u.name), "remove");
  }

  const mine = (await store.chats()).find((c) => c.channel === channel.name && c.chatId === String(chat));
  const user = mine ? users.find((x) => x.phone === mine.phone) : null;
  if (!user) return channel.send(chat, msgAskPhone, "contact");

  const cmd = (text.split(/\s+/)[0] || "").toLowerCase().split("@")[0];
  const today = todayIso(now);
  if (cmd === "/shifts") {
    const schedule = ((await store.snapshot()).meta || {}).schedule || [];
    const rows = schedule.filter((r) => r.date >= today && r.person && matchPhones(r.person, users).includes(user.phone));
    return channel.send(chat, shiftsText(rows));
  }
  if (cmd === "/schedule") {
    const schedule = ((await store.snapshot()).meta || {}).schedule || [];
    return channel.send(chat, afishaText(schedule.filter((r) => r.date >= today)));
  }
  if (cmd === "/login") {
    const code = await store.issueCode(user.phone);
    return channel.send(chat, msgLogin(code, siteUrl));
  }
  if (cmd === "/stop") {
    await store.unbind(channel.name, chat);
    return channel.send(chat, msgStopped, "remove");
  }
  return channel.send(chat, msgConnected(user.name));
}

/** Сверяет расписание с прошлой версией, рассылает уведомления и напоминания. senders: {telegram: {send}, ...} */
export async function runCycle({store, senders, now = Date.now(), log = console}) {
  const users = await store.users();
  const table = await store.book.get(TABS.schedule);
  const snap = await store.snapshot();
  const plan = planCycle(table, users, snap, now);
  if (JSON.stringify(plan.snap) !== JSON.stringify({chats: [], ...snap})) await store.saveSnapshot(plan.snap);

  const messages = plan.changes.map((c) => ({phone: c.phone, text: msgChange(c.kind, c.row, c.old)}));
  const groups = new Map();
  for (const r of plan.reminders) {
    const k = r.phone + "\t" + r.kind;
    groups.set(k, {phone: r.phone, kind: r.kind, rows: [...(groups.get(k)?.rows || []), r.row]});
  }
  for (const g of groups.values()) messages.push({phone: g.phone, text: msgReminder(g.kind, g.rows)});

  if (!messages.length) return {sent: 0};
  const chats = await store.chats();
  let sent = 0;
  for (const m of messages) {
    for (const c of chats.filter((x) => x.phone === m.phone)) {
      try {
        await senders[c.channel]?.send(c.chatId, m.text);
        sent++;
      } catch (err) {
        if (err instanceof Gone) await store.unbind(c.channel, c.chatId);
        else log.error(String(err.message || err));
      }
    }
  }
  return {sent};
}
