// Сессии: подписанный токен (HMAC-SHA256), без хранения на сервере.
import {platform} from "./platform.mjs";

const sameString = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export function makeToken(payload, secret, ttlMs = 30 * 24 * 3600e3, now = Date.now()) {
  const body = platform.b64urlEncode(JSON.stringify({...payload, exp: now + ttlMs}));
  return `${body}.${platform.hmacB64url(body, secret)}`;
}

export function readToken(token, secret, now = Date.now()) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig || !sameString(sig, platform.hmacB64url(body, secret))) return null;
  try {
    const p = JSON.parse(platform.b64urlDecode(body));
    return p.exp > now ? p : null;
  } catch {
    return null;
  }
}
