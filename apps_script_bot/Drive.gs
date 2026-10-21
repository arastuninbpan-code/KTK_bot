/**
 * Загрузка файлов на Google Диск (собрания, вложения в переписке).
 * ЭТОТ ФАЙЛ ПУБЛИКУЕТСЯ ОТДЕЛЬНО (в .claspignore он сначала выключен): ему нужно разрешение на Google Диск, которое владелец даёт один раз
 * (в редакторе Apps Script выбрать функцию authorizeDrive → «Выполнить» → «Разрешить»). Остальные файлы проекта от него не зависят.
 * ФАЙЛ СОБИРАЕТСЯ из app/gas/drive.gs командой node app/build-gas.mjs — руками в apps_script_bot не править.
 */

/** Папка для файлов: создаётся один раз, её номер запоминается в свойствах скрипта (DRIVE_FOLDER_ID). */
function driveFolder_() {
  const p = PropertiesService.getScriptProperties();
  const known = p.getProperty("DRIVE_FOLDER_ID");
  if (known) { try { return DriveApp.getFolderById(known); } catch (e) { /* папку удалили — создадим новую */ } }
  const folder = DriveApp.createFolder("КТК: файлы приложения");
  p.setProperty("DRIVE_FOLDER_ID", folder.getId());
  return folder;
}

/** Сохраняет файл (содержимое — base64), открывает его «всем, у кого есть ссылка», возвращает описание для приложения. */
function driveSave_(name, mime, base64) {
  const blob = Utilities.newBlob(Utilities.base64Decode(base64), mime, name);
  const file = driveFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const id = file.getId();
  return {
    id, name, mime, size: blob.getBytes().length,
    url: "https://drive.google.com/file/d/" + id + "/view",
    thumb: /^image\//.test(mime) ? "https://drive.google.com/thumbnail?id=" + id + "&sz=w800" : "",
  };
}

/** Запустить один раз вручную: Google спросит разрешение на Диск. */
function authorizeDrive() {
  driveFolder_();
  console.log("Доступ к Google Диску разрешён: файлы будут сохраняться в папку «КТК: файлы приложения».");
}
