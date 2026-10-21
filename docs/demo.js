"use strict";
// Демо-режим (?demo): приложение работает само по себе, на выдуманных данных, без сервера. Логин ADMIN — админ, READER — читатель.
(function () {
  if (!/[?&]demo\b/.test(location.search)) return;
  const now = new Date(Date.now() + 3 * 3600e3);
  const iso = (n) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n)).toISOString().slice(0, 10);
  const hh = (m) => { const t = new Date(now.getTime() + m * 60e3); return String(t.getUTCHours()).padStart(2, "0") + ":" + String(t.getUTCMinutes()).padStart(2, "0"); };
  const A = "Администратор/ Капельдинер", G = "Гардероб/ Уборщица", K = "Касса", M = "Монтировка", S = "Актеры, свет, звук";
  const STAFF = ["Иванова М.В.", "Кузнецова Е.Н.", "Морозова Н.М.", "Орлова А.В.", "Петрова Л.Н.", "Сидорова Л.Р."];
  const GROUPS = [{name: "Актёры", members: ["Иванова М.В.", "Петрова Л.Н."]}, {name: "Техника", members: ["Кузнецова Е.Н.", "Орлова А.В."]}, {name: "Зал", members: ["Морозова Н.М.", "Сидорова Л.Р."]}];
  let venues = ["Большая сцена", "Малая сцена", "Фойе"];
  const PALETTE = [{name: "Красный", hex: "#E5484D"}, {name: "Оранжевый", hex: "#F2961E"}, {name: "Жёлтый", hex: "#E8C21A"}, {name: "Зелёный", hex: "#3DB16B"}, {name: "Бирюзовый", hex: "#1BA8A0"}, {name: "Голубой", hex: "#0A96DC"}, {name: "Синий", hex: "#3B5BDB"}, {name: "Фиолетовый", hex: "#8E5BD0"}, {name: "Розовый", hex: "#E0509A"}, {name: "Серый", hex: "#7A8699"}];
  const offDates = {"Петрова Л.Н.": [iso(1), iso(2)]};
  const venueColors = {"Большая сцена": "#E5484D", "Малая сцена": "#0A96DC", "Фойе": "#3DB16B"};
  const hexByName = (n) => (PALETTE.find((c) => c.name === n) || {}).hex;
  let seq = 10, rev = 1;
  const events = [
    {row: 2, date: iso(0), dateEnd: "", time: hh(40), end: hh(160), title: "Спектакль «Игра в солдатики»", hall: "Большая сцена", roles: {[A]: ["Петрова Л.Н."], [G]: ["Сидорова Л.Р."], [K]: ["Орлова А.В."]}},
    {row: 3, date: iso(0), dateEnd: "", time: hh(100), end: hh(150), title: "Репетиция хора", hall: "Малая сцена", roles: {[S]: ["Иванова М.В."]}},
    {row: 4, date: iso(1), dateEnd: "", time: "11:00", end: "12:30", title: "Спектакль «Бука»", hall: "Малая сцена", roles: {[A]: ["Иванова М.В."], [G]: ["Морозова Н.М."]}},
    {row: 5, date: iso(1), dateEnd: "", time: "13:00", end: "14:30", title: "Спектакль «Бука»", hall: "Малая сцена", roles: {[A]: ["Иванова М.В."]}},
    {row: 6, date: iso(3), dateEnd: "", time: "15:00", end: "16:00", title: "Экскурсия по театру", hall: "Фойе", roles: {[A]: ["Кузнецова Е.Н."]}},
    {row: 7, date: iso(6), dateEnd: "", time: "11:00", end: "13:00", title: "Спектакль «Мери Поппинс»", hall: "Большая сцена", roles: {[A]: ["Иванова М.В.", "Сидорова Л.Р."], [G]: ["Морозова Н.М."], [K]: ["Орлова А.В."], [M]: ["Кузнецова Е.Н."]}},
    {row: 8, date: iso(8), dateEnd: iso(12), time: "", end: "", title: "Фестиваль в Барнауле", hall: "", roles: {}},
  ].map((e) => ({...e, rev: "d" + e.row}));
  const users = {"ADMIN": {name: "Иванова М.В.", role: "admin", roleLabel: "Админ", canEdit: true, login: "ADMIN", channels: ["telegram"]}, "READER": {name: "Петрова Л.Н.", role: "reader", roleLabel: "Читатель", canEdit: false, login: "READER", channels: []}};
  const key = (s) => String(s || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
  const slots = (e) => { const s = String(e.time || "").split(/,\s*/).map(toMin).filter((x) => x !== null); if (e.dateEnd || !s.length) return [[0, 1440]]; const en = s.length === 1 ? toMin(e.end) : null; return s.map((a) => [a, en !== null && en > a ? en : a + 120]); };
  const clashes = (c) => c.hall ? events.filter((e) => e.row !== c.row && key(e.hall) === key(c.hall) && e.date <= (c.dateEnd || c.date) && c.date <= (e.dateEnd || e.date) && slots(e).some(([a, b]) => slots(c).some(([x, y]) => a < y && x < b))) : [];
  const metas = {}, chat = {}, photos = {}; // демо: метаданные событий и переписка живут в памяти страницы
  const view = (u) => events.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((e) => ({...e, id: "d" + e.row, meta: metas["d" + e.row] || {kind: "event", note: ""}, comments: (chat["d" + e.row] || []).length, mine: Object.entries(e.roles).filter(([, n]) => n.includes(u.name)).map(([r]) => r)}));
  window.KTK_DEMO = {
    call(method, path, body, token) {
      if (method === "POST" && path === "/api/login") { const k = String(body.login).toUpperCase(); if (k === "NOACCESS") return {status: 403, data: {error: "Доступ закрыт. Обратитесь к администратору."}}; return users[k] ? {status: 200, data: {token: "demo:" + k, user: users[k]}} : {status: 401, data: {error: "В демо-режиме логины: ADMIN (админ), READER (читатель) и NOACCESS (без доступа)"}}; }
      const u = users[String(token).replace("demo:", "")];
      if (!u) return {status: 401, data: {error: "Нужно войти"}};
      if (path === "/api/ping") return {status: 200, data: {rev: String(rev), changed: (body || {}).rev !== String(rev)}};
      if (method === "GET" && path === "/api/schedule") return {status: 200, data: {today: iso(0), me: {...u, off: offDates[u.name] || []}, unavailable: u.canEdit ? offDates : undefined, roles: [A, G, K, M, S], layout: 2, rev: String(rev), avatarKey: "demo", events: view(u), venues, venueColors, palette: PALETTE, staff: u.canEdit ? STAFF : undefined, groups: u.canEdit ? GROUPS : undefined}};
      if (path === "/api/report" && method === "POST") {
        const list = events.filter((e) => e.date >= body.from && e.date <= body.to && (!body.value || body.kind !== "venue" || key(e.hall) === key(body.value)));
        const rows = list.map((e) => [e.date.split("-").reverse().join("."), e.time || "", e.hall || "", e.title, "Событие", "", Object.values(e.roles || {}).flat().join(", ")]);
        const report = {kind: body.kind, kindLabel: "Демо", value: body.value || "", from: body.from, to: body.to, columns: ["Дата", "Время", "Площадка", "Событие", "Тип", "Часы", "Состав"], rows, summary: [["Записей", String(rows.length)], ["", ""], ["", ""], ["", ""]], total: ["ИТОГО", "", "", String(rows.length), "", "", ""], note: "демо-режим"};
        return {status: 200, data: {report, saved: body.save ? {number: 1} : undefined, csv: body.csv ? rows.map((r) => r.join(";")).join("\n") : undefined}};
      }
      if (path === "/api/avatars") return {status: 200, data: {items: {}, key: "demo"}};
      if (path === "/api/photos") {
        if (method === "POST") { const id = Math.random().toString(16).slice(2, 14).padEnd(12, "0"); photos[id] = "data:image/jpeg;base64," + String(body.data).replace(/^data:image\/jpeg;base64,/, ""); return {status: 200, data: {ok: true, id}}; }
        return photos[body.id] ? {status: 200, data: {data: photos[body.id]}} : {status: 404, data: {error: "Фото не найдено"}};
      }
      if (path === "/api/comments") {
        const list = chat[body.event] || (chat[body.event] = []);
        if (method === "GET") return {status: 200, data: {items: list.filter((c) => c.ts > (Number(body.since) || 0)).map((c) => ({...c, mine: c.name === u.name, canDelete: c.name === u.name || u.canEdit}))}};
        if (method === "POST") { const c = {id: "c" + Math.random().toString(36).slice(2, 8), ts: Date.now(), uid: u.login || "x", name: u.name, text: body.text || "", photos: body.photos || []}; list.push(c); return {status: 200, data: {ok: true, item: {...c, mine: true, canDelete: true}}}; }
        const k = Object.keys(chat).find((x) => chat[x].some((c) => c.id === body.id)); if (k) chat[k] = chat[k].filter((c) => c.id !== body.id); return {status: 200, data: {ok: true}};
      }
      if (path === "/api/off" && method === "POST") {
        const cur = new Set(offDates[u.name] || []);
        (body.add || []).forEach((d) => cur.add(d)); (body.remove || []).forEach((d) => cur.delete(d));
        offDates[u.name] = [...cur].sort(); rev++;
        return {status: 200, data: {ok: true, off: offDates[u.name]}};
      }
      if (!u.canEdit) return {status: 403, data: {error: "Менять расписание могут только администратор и редактор."}};
      if (path === "/api/venues") {
        const name = String(body.name || "").trim();
        if (method === "PUT") { const hx = hexByName(body.color); if (!hx) return {status: 400, data: {error: "Выберите цвет из списка"}}; const v = venues.find((x) => key(x) === key(name)); if (v) venueColors[v] = hx; }
        else if (method === "POST") { if (!venues.some((v) => key(v) === key(name))) { venues.push(name); venueColors[name] = hexByName(body.color) || PALETTE[venues.length % PALETTE.length].hex; } }
        else { if (events.some((e) => key(e.hall) === key(name))) return {status: 409, data: {error: "На этой площадке есть будущие события. Сначала перенесите их."}}; venues = venues.filter((v) => key(v) !== key(name)); }
        rev++; return {status: 200, data: {ok: true, venues, venueColors}};
      }
      const row = Number(path.split("/")[3] || 0);
      if (method === "DELETE") { events.splice(events.findIndex((e) => e.row === row), 1); rev++; return {status: 200, data: {ok: true}}; }
      if (!body.event.title) return {status: 400, data: {error: "Укажите название"}};
      const clash = body.force ? [] : clashes({...body.event, row: method === "PUT" ? row : -1});
      if (clash.length) return {status: 409, data: {error: `Площадка «${body.event.hall}» занята: ${clash[0].title} (${clash[0].time}${clash[0].end ? "–" + clash[0].end : ""})`, conflicts: clash}};
      const ev = {...body.event, rev: "d" + Math.random()};
      if (method === "POST") { events.push({...ev, row: ++seq}); if (body.meta) metas["d" + seq] = {kind: body.meta.kind, note: body.meta.note || ""}; }
      else Object.assign(events.find((e) => e.row === row), ev);
      rev++;
      return {status: 200, data: {ok: true}};
    },
  };
  localStorage.removeItem("ktk_token");
  localStorage.removeItem("ktk_cache");
  document.title = "Расписание театра · демо";
})();
