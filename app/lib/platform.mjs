// Платформенные мелочи (криптография, пауза), которые в Node и в Google Apps Script устроены по-разному.
// Node подставляет реализацию из platform-node.mjs (тесты, стенд), Apps Script — из своей оболочки.
export const platform = {
  sha256hex: null,        // (строка) -> hex
  hmacB64url: null,       // (данные, секрет) -> base64url без «=»
  b64urlEncode: null,     // (строка UTF-8) -> base64url
  b64urlDecode: null,     // (base64url) -> строка UTF-8
  randomInt: null,        // (max) -> целое от 0 до max-1
  sleep: () => {},        // (мс)
};
