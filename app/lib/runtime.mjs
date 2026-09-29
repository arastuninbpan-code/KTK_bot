// Сборка «боевых» зависимостей из переменных окружения Netlify.
import {createHmac} from "node:crypto";
import {runCycle} from "./bot.mjs";
import {SheetsBook} from "./sheets.mjs";
import {Store} from "./store.mjs";
import {makeTelegram} from "./telegram.mjs";

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Не задана переменная окружения ${name}`);
  return v;
};

export const tgSecret = (secret) => createHmac("sha256", secret).update("telegram-webhook").digest("hex").slice(0, 32);

export function runtime() {
  const secret = need("SESSION_SECRET");
  const book = new SheetsBook({id: need("SHEET_ID"), credentials: need("GOOGLE_CREDENTIALS_JSON")});
  const store = new Store(book, {secret});
  const telegram = process.env.TELEGRAM_BOT_TOKEN ? makeTelegram(process.env.TELEGRAM_BOT_TOKEN) : null;
  const senders = telegram ? {telegram} : {};
  const cycle = async () => store.withLock(() => runCycle({store, senders}));
  return {secret, book, store, telegram, senders, cycle, tgSecret: tgSecret(secret)};
}
