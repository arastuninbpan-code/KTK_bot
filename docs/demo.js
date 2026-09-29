"use strict";
// Демо-режим (?demo): приложение работает само по себе, на выдуманных данных, без сервера. Код входа: 000000 — админ, 111111 — читатель.
(function () {
  if (!/[?&]demo\b/.test(location.search)) return;
  const now = new Date(Date.now() + 3 * 3600e3);
  const iso = (n) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + n)).toISOString().slice(0, 10);
  const hh = (m) => { const t = new Date(now.getTime() + m * 60e3); return String(t.getUTCHours()).padStart(2, "0") + ":" + String(t.getUTCMinutes()).padStart(2, "0"); };
  const A = "Администратор/ Капельдинер", G = "Гардероб/ Уборщица", K = "Касса", M = "Монтировка", S = "Актеры, свет, звук";
  const STAFF = ["Иванова М.В.", "Кузнецова Е.Н.", "Морозова Н.М.", "Орлова А.В.", "Петрова Л.Н.", "Сидорова Л.Р."];
  let seq = 10;
  const events = [
    {row: 2, date: iso(0), dateEnd: "", time: hh(40), title: "Спектакль «Игра в солдатики»", hall: "большая сцена", roles: {[A]: ["Петрова Л.Н."], [G]: ["Сидорова Л.Р."], [K]: ["Орлова А.В."]}},
    {row: 3, date: iso(1), dateEnd: "", time: "11:00, 13:00", title: "Спектакль «Бука»", hall: "малая сцена", roles: {[A]: ["Иванова М.В."], [G]: ["Морозова Н.М."]}},
    {row: 4, date: iso(3), dateEnd: "", time: "15:00", title: "Экскурсия по театру", hall: "", roles: {[A]: ["Кузнецова Е.Н."]}},
    {row: 5, date: iso(6), dateEnd: "", time: "11:00", title: "Спектакль «Мери Поппинс»", hall: "большая сцена", roles: {[A]: ["Иванова М.В.", "Сидорова Л.Р."], [G]: ["Морозова Н.М."], [K]: ["Орлова А.В."], [M]: ["Кузнецова Е.Н."]}},
    {row: 6, date: iso(8), dateEnd: iso(12), time: "", title: "Фестиваль в Барнауле", hall: "", roles: {}},
  ].map((e) => ({...e, rev: "d" + e.row}));
  const users = {"000000": {name: "Иванова М.В.", role: "admin", roleLabel: "Админ", canEdit: true}, "111111": {name: "Петрова Л.Н.", role: "reader", roleLabel: "Читатель", canEdit: false}};
  const view = (u) => events.slice().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((e) => ({...e, mine: Object.entries(e.roles).filter(([, n]) => n.includes(u.name)).map(([r]) => r)}));
  window.KTK_DEMO = {
    call(method, path, body, token) {
      if (method === "POST" && path === "/api/login") return users[body.code] ? {status: 200, data: {token: "demo:" + body.code, user: users[body.code]}} : {status: 401, data: {error: "В демо-режиме коды: 000000 (админ) и 111111 (читатель)"}};
      const u = users[String(token).replace("demo:", "")];
      if (!u) return {status: 401, data: {error: "Нужно войти"}};
      if (method === "GET") return {status: 200, data: {today: iso(0), me: u, roles: [A, G, K, M, S], events: view(u), staff: u.canEdit ? STAFF : undefined}};
      if (!u.canEdit) return {status: 403, data: {error: "Менять расписание могут только администратор и редактор."}};
      const row = Number(path.split("/")[3] || 0);
      if (method === "DELETE") { events.splice(events.findIndex((e) => e.row === row), 1); return {status: 200, data: {ok: true}}; }
      if (!body.event.title) return {status: 400, data: {error: "Укажите название"}};
      const ev = {...body.event, rev: "d" + Math.random()};
      if (method === "POST") events.push({...ev, row: ++seq});
      else Object.assign(events.find((e) => e.row === row), ev);
      return {status: 200, data: {ok: true}};
    },
  };
  localStorage.removeItem("ktk_token");
  document.title = "Расписание театра · демо";
})();
