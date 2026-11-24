import test from "node:test";
import assert from "node:assert/strict";
import {loadGas} from "./gas-fake.mjs";
import {STAFF} from "./helpers.mjs";

test("несколько сотрудников: проверка сохраняет содержимое ячеек и указывает неизвестное имя", () => {
  const rows = [["Дата","Начало","Конец","Событие","Площадка","Актёры","Техника","ID"],
    ["05.12","11:00","","Пример","Зал","Иванова М.В./\nПетрова Л.Н.","Иванова М.В./\nНеизвестный А.А.","keep-id"]];
  const g = loadGas({tabs: {"Сотрудники": STAFF,"Расписание": rows,"_люди": [["Сотрудники"],["Иванова М.В."],["Петрова Л.Н."]]}, props: {SHEET_ID:"test"}});
  const sh = g.ss.getSheetByName("Расписание");
  const before = sh.getDataRange().getDisplayValues();
  const cleared = [];
  const range = sh.getRange.bind(sh);
  sh.getRange = (...args) => {
    const r = range(...args);
    r.clearDataValidations = () => { cleared.push(args); return r; };
    return r;
  };
  g.run('applyPeopleValidation_(tabSheet_(SpreadsheetApp.openById("test"), TABS.schedule))');
  assert.deepEqual(sh.getDataRange().getDisplayValues(), before);
  assert.deepEqual(cleared, [[2,6]]);
  assert.ok(sh.styleLog.some(([kind, rule]) => kind === "validation" &&
    rule.calls.some(([method, text]) => method === "setHelpText" && text.includes("Неизвестный А.А."))));
});
