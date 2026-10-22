// Разбор сообщений Telegram (отправка делается в оболочке платформы).

/** Чат больше недоступен (человек заблокировал бота). */
export class Gone extends Error {}

/** Сообщение Telegram -> {chatId, text, phone}. Только личные чаты и только собственный контакт. */
export function telegramEvent(update) {
  const m = update.message;
  if (!m || !m.chat || m.chat.type !== "private") return null;
  const own = m.contact && m.from && m.contact.user_id === m.from.id;
  const f = m.from || {};
  const label = "Telegram " + ([f.first_name, f.last_name].filter(Boolean).join(" ") || "без имени") + (f.username ? " @" + f.username : " (tg://user?id=" + (f.id || m.chat.id) + ")");
  return {chatId: m.chat.id, text: m.text || "", phone: own ? m.contact.phone_number : null, date: m.date || 0, label, name: [f.first_name, f.last_name].filter(Boolean).join(" ")};
}

/** Нажатие кнопки под сообщением -> {id, chatId, messageId, data} (только личные чаты). */
export function telegramCallback(update) {
  const q = update.callback_query;
  if (!q || !q.message || !q.message.chat || q.message.chat.type !== "private") return null;
  return {id: q.id, chatId: q.message.chat.id, messageId: q.message.message_id, data: q.data || ""};
}
