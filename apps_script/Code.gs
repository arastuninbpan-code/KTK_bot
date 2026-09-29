/**
 * Будильник для бота. Вставить в Google Таблицу: Расширения → Apps Script.
 * Один раз запустить функцию setup() и выдать разрешения.
 *
 *  - при правке таблицы: ждёт 20 секунд тишины (чтобы не слать уведомления о половине правки) и запускает бота;
 *  - каждую минуту: запускает бота, чтобы он отвечал на сообщения и слал вечерние сводки.
 *
 * Токен GitHub (Settings → Developer settings → Fine-grained tokens, только репозиторий KTK_bot,
 * право Actions: Read and write) хранится в свойствах скрипта GH_TOKEN, а не в коде.
 */
// Если скрипт создан отдельным проектом (не из меню таблицы), укажите ID таблицы в свойствах скрипта: SHEET_ID.
function spreadsheet_() {
  return SpreadsheetApp.getActive() ||
    SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID"));
}

const OWNER = "arastuninbpan-code";
const REPO = "KTK_bot";
const WORKFLOW = "bot.yml";

function runBot_() {
  const token = PropertiesService.getScriptProperties().getProperty("GH_TOKEN");
  const r = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + OWNER + "/" + REPO + "/actions/workflows/" + WORKFLOW + "/dispatches",
    {
      method: "post",
      contentType: "application/json",
      headers: {Authorization: "Bearer " + token, Accept: "application/vnd.github+json"},
      payload: JSON.stringify({ref: "main"}),
      muteHttpExceptions: true,
    });
  if (r.getResponseCode() !== 204) console.error("GitHub: " + r.getResponseCode() + " " + r.getContentText());
}

function onSheetChange() {
  const props = PropertiesService.getScriptProperties();
  const stamp = String(Date.now());
  props.setProperty("last_change", stamp);
  Utilities.sleep(20000);
  if (props.getProperty("last_change") === stamp) runBot_();  // за 20 секунд новых правок не было
}

function everyMinute() {
  runBot_();
}

function setup() {
  ScriptApp.getProjectTriggers().forEach(ScriptApp.deleteTrigger);
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(spreadsheet_()).onChange().create();
  ScriptApp.newTrigger("onSheetChange").forSpreadsheet(spreadsheet_()).onEdit().create();
  ScriptApp.newTrigger("everyMinute").timeBased().everyMinutes(1).create();
}
