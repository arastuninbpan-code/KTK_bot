// Собирает один файл для Google Apps Script: общий код из lib/ + оболочка gas/shell.gs -> ../apps_script_bot/Code.gs
// Запуск: node build-gas.mjs  (проверка, что файл не устарел: node build-gas.mjs --check)
import {readFileSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const here = fileURLToPath(new URL(".", import.meta.url));
const MODULES = ["platform", "core", "format", "telegram", "vk", "layout", "store", "auth", "api", "bot"];
const OUT = join(here, "..", "apps_script_bot", "Code.gs");

export function bundle() {
  const seen = new Map();
  const chunks = [`/**
 * Бот и приложение расписания театра на Google Apps Script (бесплатно, без сервера).
 * ФАЙЛ СОБИРАЕТСЯ АВТОМАТИЧЕСКИ из app/lib и app/gas/shell.gs — руками не править (node app/build-gas.mjs).
 *
 * Свойства скрипта: SHEET_ID, TELEGRAM_BOT_TOKEN, RELAY_URL (или WEBAPP_URL), APP_URL (адрес приложения для кнопки в боте).
 * ВКонтакте (необязательно): VK_TOKEN, VK_GROUP_ID, VK_SECRET, VK_CONFIRM. Публикация афиши: VK_TOKEN + VK_GROUP_ID и/или TG_CHANNEL.
 * Установка: setup() → «Начать развертывание → Веб-приложение» → setWebhook() → styleSheets().
 */
`];
  for (const name of MODULES) {
    const src = readFileSync(join(here, "lib", `${name}.mjs`), "utf8");
    const body = src.split("\n").filter((l) => !/^import .* from ".*";?\s*$/.test(l)).join("\n").replace(/^export (?=(async |function|const|let|class))/gm, "");
    for (const m of body.matchAll(/^(?:async )?(?:function|const|let|class) (\w+)/gm)) {
      if (seen.has(m[1])) throw new Error(`Имя «${m[1]}» объявлено дважды: ${seen.get(m[1])} и ${name}`);
      seen.set(m[1], name);
    }
    if (/^export /m.test(body) || /^import /m.test(body)) throw new Error(`В ${name}.mjs остался export/import, который сборка не поняла`);
    chunks.push(`// ===== lib/${name}.mjs =====\n${body.trim()}\n`);
  }
  chunks.push(readFileSync(join(here, "gas", "shell.gs"), "utf8"));
  const text = chunks.join("\n");
  // Apps Script не понимает «приватные» члены классов (#имя): Node их принимает, а Google падает с ParseError
  const priv = text.match(/this\.#\w+|^\s+#\w+\s*[(=;]/m);
  if (priv) throw new Error(`В коде для Apps Script нельзя использовать приватные члены классов (#): «${priv[0].trim()}»`);
  return text;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const text = bundle();
  if (process.argv.includes("--check")) {
    const cur = (() => { try { return readFileSync(OUT, "utf8"); } catch { return ""; } })();
    if (cur !== text) { console.error("apps_script_bot/Code.gs устарел: запустите node app/build-gas.mjs"); process.exit(1); }
    console.log("Code.gs актуален");
  } else {
    writeFileSync(OUT, text);
    console.log(`Собрано: ${OUT} (${text.split("\n").length} строк)`);
  }
}
