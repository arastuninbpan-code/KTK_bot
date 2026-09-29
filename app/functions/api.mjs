import {handleApi} from "../lib/api.mjs";
import {runtime} from "../lib/runtime.mjs";

export default async (req) => {
  const url = new URL(req.url);
  const rt = runtime();
  let body = {};
  if (req.method !== "GET") { try { body = await req.json(); } catch { body = {}; } }
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const {status, body: out} = await handleApi({method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, token}, {
    store: rt.store,
    secret: rt.secret,
    // после правки директора сразу рассылаем уведомления (не ждём минутного таймера); ошибки рассылки не ломают сохранение
    afterChange: async () => { try { await rt.cycle(); } catch (e) { console.error(String(e?.message || e)); } },
    setup: async (key) => {
      if (!process.env.SETUP_KEY || key !== process.env.SETUP_KEY) return {ok: false, error: "Неверный ключ"};
      if (!rt.telegram) return {ok: false, error: "Не задан TELEGRAM_BOT_TOKEN"};
      const hook = `${url.origin}/tg`;
      const set = await rt.telegram.setWebhook(hook, rt.tgSecret);
      return {ok: true, webhook: hook, telegram: set};
    },
  });
  return Response.json(out, {status, headers: {"Cache-Control": "no-store"}});
};

export const config = {path: "/api/*"};
