import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

// Google Apps Script не понимает часть новых приёмов JavaScript (операторы ||= ??= &&=): публикация тогда падает с «Unexpected token =».
// Node их принимает, поэтому тесты этого сами не заметят — проверяем собранный файл отдельно.
test("собранный Code.gs не содержит синтаксиса, который Apps Script отвергает", () => {
  const code = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "apps_script_bot", "Code.gs"), "utf8");
  const stripped = code.replace(/\/\/[^\n]*/g, "").replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""'); // комментарии и строки не считаем
  const bad = [];
  stripped.split("\n").forEach((line, i) => { if (/\|\|=|\?\?=|&&=|\*\*=/.test(line)) bad.push(`строка ${i + 1}: ${line.trim().slice(0, 100)}`); });
  assert.deepEqual(bad, [], "недопустимый для Apps Script оператор");
});
