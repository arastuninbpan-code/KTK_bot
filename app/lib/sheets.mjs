// Доступ к Google Таблице через REST API (сервисный аккаунт, без внешних библиотек).
// Интерфейс "книги" одинаков у настоящей и тестовой (память) реализаций:
//   get(tab) -> [[...]]   set(tab, row, values)   append(tab, values)   insert(tab, beforeRow)   remove(tab, row)
//   clearRow(tab, row)    replaceColumnA(tab, values)    ensure(tab, header?)
import {createSign} from "node:crypto";

const b64url = (b) => Buffer.from(b).toString("base64url");

export class SheetsBook {
  constructor({id, credentials, fetchImpl = fetch}) {
    this.id = id;
    this.cred = typeof credentials === "string" ? JSON.parse(credentials) : credentials;
    this.fetch = fetchImpl;
    this.token = null;
    this.tokenExp = 0;
    this.sheetIds = null;
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExp - 60000) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const claim = {iss: this.cred.client_email, scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: this.cred.token_uri || "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600};
    const unsigned = b64url(JSON.stringify({alg: "RS256", typ: "JWT"})) + "." + b64url(JSON.stringify(claim));
    const sig = createSign("RSA-SHA256").update(unsigned).sign(this.cred.private_key, "base64url");
    const r = await this.fetch(claim.aud, {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams({grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + sig})});
    if (!r.ok) throw new Error("Google auth failed: " + r.status);
    const j = await r.json();
    this.token = j.access_token;
    this.tokenExp = Date.now() + (j.expires_in || 3600) * 1000;
    return this.token;
  }

  async api(path, opts = {}) {
    const r = await this.fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.id}${path}`, {
      ...opts,
      headers: {Authorization: "Bearer " + (await this.accessToken()), "Content-Type": "application/json", ...(opts.headers || {})},
    });
    if (!r.ok) throw new Error(`Sheets ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  async meta() {
    if (!this.sheetIds) {
      const j = await this.api("?fields=sheets.properties(sheetId,title)");
      this.sheetIds = Object.fromEntries(j.sheets.map((s) => [s.properties.title, s.properties.sheetId]));
    }
    return this.sheetIds;
  }

  async ensure(tab, header) {
    const ids = await this.meta();
    if (tab in ids) return;
    const j = await this.api(":batchUpdate", {method: "POST", body: JSON.stringify({requests: [{addSheet: {properties: {title: tab}}}]})});
    this.sheetIds[tab] = j.replies[0].addSheet.properties.sheetId;
    if (header) await this.set(tab, 1, header);
  }

  async get(tab) {
    const j = await this.api(`/values/${encodeURIComponent(`'${tab}'`)}?valueRenderOption=FORMATTED_VALUE`);
    return j.values || [];
  }

  async set(tab, row, values) {
    const range = encodeURIComponent(`'${tab}'!A${row}`);
    await this.api(`/values/${range}?valueInputOption=RAW`, {method: "PUT", body: JSON.stringify({values: [values.map(String)]})});
  }

  async append(tab, values) {
    const range = encodeURIComponent(`'${tab}'!A1`);
    await this.api(`/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {method: "POST", body: JSON.stringify({values: [values.map(String)]})});
  }

  async structural(tab, request) {
    const ids = await this.meta();
    await this.api(":batchUpdate", {method: "POST", body: JSON.stringify({requests: [request(ids[tab])]})});
  }

  /** Вставляет пустую строку перед строкой номер beforeRow (1 = самая первая). */
  insert(tab, beforeRow) {
    return this.structural(tab, (sheetId) => ({insertDimension: {range: {sheetId, dimension: "ROWS", startIndex: beforeRow - 1, endIndex: beforeRow}, inheritFromBefore: beforeRow > 2}}));
  }

  remove(tab, row) {
    return this.structural(tab, (sheetId) => ({deleteDimension: {range: {sheetId, dimension: "ROWS", startIndex: row - 1, endIndex: row}}}));
  }

  async clearRow(tab, row) {
    await this.api(`/values/${encodeURIComponent(`'${tab}'!A${row}:Z${row}`)}:clear`, {method: "POST", body: "{}"});
  }

  /** Записывает значения в столбец A (для служебных данных); остальное на листе очищает. */
  async replaceColumnA(tab, values) {
    await this.api(`/values/${encodeURIComponent(`'${tab}'`)}:clear`, {method: "POST", body: "{}"});
    if (!values.length) return;
    await this.api(`/values/${encodeURIComponent(`'${tab}'!A1`)}?valueInputOption=RAW`, {method: "PUT", body: JSON.stringify({values: values.map((v) => [String(v)])})});
  }
}

/** Книга в памяти: для тестов и локального просмотра. */
export class MemoryBook {
  constructor(tabs = {}) { this.tabs = structuredClone(tabs); this.calls = []; }
  #t(tab) { return (this.tabs[tab] ||= []); }
  async ensure(tab, header) { if (!this.tabs[tab]) this.tabs[tab] = header ? [[...header]] : []; }
  async get(tab) { return structuredClone(this.#t(tab)); }
  async set(tab, row, values) { const t = this.#t(tab); while (t.length < row - 1) t.push([]); t[row - 1] = values.map(String); this.calls.push(["set", tab, row]); }
  async append(tab, values) { this.#t(tab).push(values.map(String)); }
  async insert(tab, beforeRow) { const t = this.#t(tab); while (t.length < beforeRow - 1) t.push([]); t.splice(beforeRow - 1, 0, []); }
  async remove(tab, row) { this.#t(tab).splice(row - 1, 1); }
  async clearRow(tab, row) { const t = this.#t(tab); if (t[row - 1]) t[row - 1] = []; }
  async replaceColumnA(tab, values) { this.tabs[tab] = values.map((v) => [String(v)]); }
}
