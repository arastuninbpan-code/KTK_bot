// Оболочка приложения в памяти телефона: страница открывается и без интернета.
// Онлайн всегда берём свежее с сервера; если сети нет или она «висит» дольше 4 секунд — отдаём то, что сохранено в прошлый раз.
// Сами данные расписания (запросы к серверу — POST) сюда не попадают: их хранит само приложение.
const CACHE = "ktk-shell-v31";
const SHELL = ["./", "index.html", "style.css", "app.js", "config.js", "version.js", "demo.js", "avatar.webp", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const withTimeout = (promise, ms) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("timeout")), ms); promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // шрифты и прочее чужое не трогаем
  e.respondWith((async () => {
    try {
      const res = await withTimeout(fetch(req, {cache: "no-cache"}), 4000); // no-cache: всегда спрашиваем сервер, не берём устаревшее из кеша браузера
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    } catch (_) {
      const hit = await caches.match(req, {ignoreSearch: true});
      if (hit) return hit;
      if (req.mode === "navigate") { const home = await caches.match("index.html"); if (home) return home; }
      return Response.error();
    }
  })());
});
