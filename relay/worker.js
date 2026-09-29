// Посредник между Telegram и Google Apps Script (Cloudflare Workers, бесплатно).
// Apps Script отвечает на POST перенаправлением (302), и Telegram считает это ошибкой и тормозит доставку.
// Посредник сразу отвечает Telegram «ok», а сообщение передаёт скрипту сам (с переходом по перенаправлению).
//
// Переменные (Settings → Variables and Secrets):
//   GAS_URL      — адрес веб-приложения (…/exec) + «?secret=» + значение WEBHOOK_SECRET из свойств скрипта
//   PATH_SECRET  — любое длинное слово из латинских букв и цифр: это «пароль» в адресе посредника
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
