// Разбор сообщений Telegram (отправка делается в оболочке платформы).

/** Чат больше недоступен (человек заблокировал бота). */
export class Gone extends Error {}

/** Сообщение Telegram -> {chatId, text, phone}. Только личные чаты и только собственный контакт. */
export function telegramEvent(update) {
  const m = update.message;
  if (!m || !m.chat || m.chat.type !== "private") return null;
  const own = m.contact && m.from && m.contact.user_id === m.from.id;
  return {chatId: m.chat.id, text: m.text || "", phone: own ? m.contact.phone_number : null};
}
