// Сессии: подписанный токен (HMAC-SHA256), без хранения на сервере.
import {createHmac, timingSafeEqual} from "node:crypto";

const sign = (data, secret) => createHmac("sha256", secret).update(data).digest("base64url");

export function makeToken(payload, secret, ttlMs = 30 * 24 * 3600e3, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({...payload, exp: now + ttlMs})).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function readToken(token, secret, now = Date.now()) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const good = sign(body, secret);
  if (sig.length !== good.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > now ? p : null;
  } catch {
    return null;
  }
}
