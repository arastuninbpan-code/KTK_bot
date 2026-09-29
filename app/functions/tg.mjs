import {handleMessage} from "../lib/bot.mjs";
import {runtime} from "../lib/runtime.mjs";
import {telegramEvent} from "../lib/telegram.mjs";

// Сюда Telegram присылает каждое сообщение. Всегда отвечаем 200, чтобы Telegram не повторял доставку.
export default async (req) => {
  try {
    const rt = runtime();
    if (req.method !== "POST" || req.headers.get("x-telegram-bot-api-secret-token") !== rt.tgSecret) return new Response("ok");
    const ev = telegramEvent(await req.json());
    if (ev && rt.telegram) await handleMessage({store: rt.store, channel: rt.telegram, ev, siteUrl: new URL(req.url).origin});
  } catch (e) {
    console.error(String(e?.message || e));
  }
  return new Response("ok");
};

export const config = {path: "/tg"};
