// Клиент Telegram Bot API. Сообщения в HTML-разметке; длинные режутся; заблокировавших бота отдаём как Gone.
import {chunkText} from "./format.mjs";

export class Gone extends Error {}

export function makeTelegram(token, fetchImpl = fetch) {
  const call = async (method, body) => {
    const r = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
    if (r.status === 403) throw new Gone();
    if (!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); // без адреса: в нём токен
    return r.json();
  };
  return {
    name: "telegram",
    async send(chatId, text, keyboard) {
      const pieces = chunkText(text);
      for (let i = 0; i < pieces.length; i++) {
        const body = {chat_id: chatId, text: pieces[i], parse_mode: "HTML", link_preview_options: {is_disabled: true}};
        if (i === pieces.length - 1) {
          if (keyboard === "contact") body.reply_markup = {keyboard: [[{text: "📱 Поделиться номером", request_contact: true}]], resize_keyboard: true, one_time_keyboard: true};
          else if (keyboard === "remove") body.reply_markup = {remove_keyboard: true};
        }
        await call("sendMessage", body);
      }
    },
    setWebhook: (url, secretToken) => call("setWebhook", {url, secret_token: secretToken, allowed_updates: ["message"]}),
    deleteWebhook: () => call("deleteWebhook", {}),
    info: () => call("getWebhookInfo", {}),
  };
}

/** Сообщение Telegram -> {chatId, text, phone}. Только личные чаты и только собственный контакт. */
export function telegramEvent(update) {
  const m = update.message;
  if (!m || !m.chat || m.chat.type !== "private") return null;
  const own = m.contact && m.from && m.contact.user_id === m.from.id;
  return {chatId: m.chat.id, text: m.text || "", phone: own ? m.contact.phone_number : null};
}
