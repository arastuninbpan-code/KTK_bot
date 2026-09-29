// Посредник между внешним миром и Google Apps Script (Cloudflare Workers, бесплатно).
// 1) Telegram: Apps Script отвечает на POST перенаправлением (302), Telegram считает это ошибкой.
//    Посредник сразу отвечает «ok», а сообщение передаёт скрипту сам (с переходом по перенаправлению).
// 2) Сайт (/api): браузеры ненадёжно проходят перенаправление Google, поэтому запрос сайта
//    тоже идёт через посредника: он ходит в Apps Script, а ответ отдаёт сайту с нужными заголовками.
//
// Переменные (Settings → Variables and Secrets):
//   GAS_URL      — адрес веб-приложения (…/exec) + «?secret=» + значение WEBHOOK_SECRET из свойств скрипта
//   PATH_SECRET  — любое длинное слово из латинских букв и цифр: это «пароль» в адресе для Telegram
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api") {
      if (request.method === "OPTIONS") return new Response(null, {status: 204, headers: CORS});
      if (request.method !== "POST") return new Response("ktk-api ok", {headers: CORS});
      const base = env.GAS_URL.split("?")[0]; // без секрета Telegram: это запрос сайта, а не бота
      const json = (obj) => new Response(JSON.stringify(obj), {status: 200, headers: {...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}});
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 25000);
        const r = await fetch(base, {method: "POST", headers: {"Content-Type": "text/plain;charset=utf-8"}, body: await request.text(), redirect: "follow", signal: ctl.signal});
        clearTimeout(timer);
        const text = await r.text();
        try { JSON.parse(text); } catch (e) { return json({error: "Google ответил не так, как ждали (код " + r.status + "): " + text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 150)}); }
        return new Response(text, {status: 200, headers: {...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}});
      } catch (e) {
        return json({error: "Воркер не дождался Google (" + e.message + ")"});
      }
    }

    if (request.method !== "POST" || url.pathname !== "/" + env.PATH_SECRET) return new Response("ok");
    const body = await request.text();
    ctx.waitUntil(fetch(env.GAS_URL, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body,
      redirect: "follow",
    }));
    return new Response("ok");
  },
};
