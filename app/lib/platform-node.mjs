// Реализация платформы для Node (тесты и локальный стенд). В сборку для Apps Script не входит.
import {createHash, createHmac, randomInt} from "node:crypto";
import {platform} from "./platform.mjs";

Object.assign(platform, {
  sha256hex: (s) => createHash("sha256").update(s).digest("hex"),
  hmacB64url: (data, secret) => createHmac("sha256", secret).update(data).digest("base64url"),
  b64urlEncode: (s) => Buffer.from(s).toString("base64url"),
  b64urlDecode: (s) => Buffer.from(s, "base64url").toString(),
  randomInt: (max) => randomInt(0, max),
  sleep: () => {}, // в тестах не ждём
});
export {platform};
