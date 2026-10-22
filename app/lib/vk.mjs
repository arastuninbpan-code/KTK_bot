import {ACK_LABELS, MENU_LABELS, menuRows} from "./format.mjs";
// ВКонтакте: разбор входящих событий (Callback API) и подготовка сообщений. Сеть — в gas/shell.gs.
// Сообщения у нас написаны в HTML-разметке Telegram (<b>, <s>, <code>); у VK такой разметки нет, поэтому переводим в простой текст.

const UNESCAPE = {"&lt;": "<", "&gt;": ">", "&amp;": "&"};

/** HTML Telegram -> простой текст для ВК: <s>…</s> зачёркиваем значками, остальные теги убираем, &lt; &gt; &amp; возвращаем. */
export function htmlToPlain(html) {
  return String(html)
    .replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_, url, t) => `${t}: ${url}`) // во ВК нет «ссылок в тексте»: пишем адрес рядом
    .replace(/<s>([\s\S]*?)<\/s>/g, (_, t) => Array.from(t.replace(/<[^>]*>/g, "")).map((c) => (c === " " ? c : c + "̶")).join(""))
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:lt|gt|amp);/g, (m) => UNESCAPE[m]);
}

/** Клавиатура под сообщением: кнопка-ссылка «Открыть в приложении». Подпись в ВК — до 40 знаков. */
export function vkKeyboard(options) {
  if (options && options.menu) { // главное меню: постоянные кнопки под полем ввода; «Приложение» открывается ссылкой сразу
    const m = options.menu;
    const rows = menuRows(m).map((row) => row.map((label) => (label === MENU_LABELS.app && m.appUrl
      ? {action: {type: "open_link", link: m.appUrl, label: label.slice(0, 40)}}
      : {action: {type: "text", label: label.slice(0, 40)}})));
    return JSON.stringify({one_time: false, inline: false, buttons: rows});
  }
  if (options && options.ack) { // «Увидел(а)» и «Не могу»: кнопки с обратным вызовом (VK пришлёт событие message_event)
    const cb = (status, color) => ({action: {type: "callback", label: ACK_LABELS[status].slice(0, 40), payload: JSON.stringify({a: "ack", s: status, e: options.ack.eventId})}, color});
    const rows = [[cb("ok", "positive"), cb("no", "negative")]];
    if (options.button) rows.push([{action: {type: "open_link", link: options.button.url, label: String(options.button.text).slice(0, 40)}}]);
    return JSON.stringify({inline: true, buttons: rows});
  }
  if (!options || !options.button) return undefined;
  return JSON.stringify({inline: true, buttons: [[{action: {type: "open_link", link: options.button.url, label: String(options.button.text).slice(0, 40)}}]]});
}

/**
 * Callback API: {type, object: {message: {peer_id, from_id, text, out}}, event_id, secret, group_id}
 * -> {chatId, text, phone: null, eventId} для личных сообщений людей; всё остальное (беседы, эхо, другие события) -> null.
 */
export function vkEvent(update) {
  if (!update || update.type !== "message_new") return null;
  const m = (update.object || {}).message;
  if (!m || m.out || !(m.from_id > 0) || m.peer_id !== m.from_id) return null;
  // ref — значение из ссылки vk.me/club…?ref=…: так «Подключить ВК» в приложении передаёт логин
  return {chatId: String(m.peer_id), text: m.text || "", phone: null, eventId: update.event_id || "", date: m.date || 0, start: String(m.ref || ""), label: "ВК https://vk.com/id" + m.peer_id};
}

/** Коды ошибок messages.send, при которых человеку писать нельзя (запретил сообщения или не начинал диалог). */
export const VK_CANT_WRITE = [901, 902, 900];

/** Нажатие кнопки «Увидел(а)» / «Не могу» (событие message_event) -> {chatId, userId, eventId, status, eventKey, convId} или null. */
export function vkButtonEvent(update) {
  if (!update || update.type !== "message_event") return null;
  const o = update.object || {};
  let p = o.payload;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch (e) { p = null; } }
  if (!p || p.a !== "ack" || !/^[0-9a-f]{8}$/.test(String(p.e || "")) || (p.s !== "ok" && p.s !== "no")) return null;
  return {chatId: String(o.peer_id || o.user_id || ""), userId: String(o.user_id || o.peer_id || ""), eventId: String(p.e), status: p.s, eventKey: String(o.event_id || ""), convId: o.conversation_message_id || 0};
}
