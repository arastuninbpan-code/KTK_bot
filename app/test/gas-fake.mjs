// Имитация Google Apps Script для тестов собранного Code.gs. Класс Range/Sheet содержит только методы, которые есть в настоящем API:
// вызов несуществующего метода падает (в отличие от заглушки на Proxy).
import {createHash, createHmac, randomUUID} from "node:crypto";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const signed = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const unsigned = (arr) => Buffer.from(arr.map((b) => (b + 256) % 256));
const bytesOf = (v) => (typeof v === "string" ? Buffer.from(v) : unsigned(v));

class Range {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, {sheet, r, c, nr, nc}); }
  #grid() { return this.sheet.cells; }
  #each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r + i, this.c + j, i, j); }
  getDisplayValues() { this.sheet.reads = (this.sheet.reads || 0) + 1; const out = []; this.#each((r, c, i, j) => { (out[i] ||= [])[j] = String(this.#grid()[r - 1]?.[c - 1] ?? ""); }); return out; }
  getValues() { return this.getDisplayValues(); }
  getValue() { return this.getDisplayValues()[0][0]; }
  setValues(vals) { this.#each((r, c, i, j) => { this.sheet.put(r, c, vals[i][j]); }); this.sheet.styleLog.push(["setValues", this.r]); return this; }
  setValue(v) { this.sheet.put(this.r, this.c, v); return this; }
  clearContent() { this.#each((r, c) => { if (this.#grid()[r - 1]) this.#grid()[r - 1][c - 1] = ""; }); return this; }
  merge() { this.sheet.styleLog.push(["merge", this.r]); return this; }
  setDataValidation(rule) { this.sheet.styleLog.push(["validation", rule]); return this; }
  clearDataValidations() { return this; }
  breakApart() { this.sheet.styleLog.push(["breakApart"]); return this; }
}
for (const m of ["setNumberFormat", "setBackground", "setFontColor", "setFontWeight", "setHorizontalAlignment", "setVerticalAlignment", "setWrap", "setBorder", "setFontSize", "setFontFamily"]) {
  Range.prototype[m] = function (...a) { this.sheet.styleLog.push([m, this.r, ...a]); return this; };
}

class Sheet {
  constructor(name) { this.name = name; this.cells = []; this.maxRows = 1000; this.maxCols = 26; this.styleLog = []; this.rules = []; }
  put(r, c, v) { while (this.cells.length < r) this.cells.push([]); const row = this.cells[r - 1]; while (row.length < c) row.push(""); row[c - 1] = String(v); }
  getLastRow() { for (let i = this.cells.length; i > 0; i--) if (this.cells[i - 1].some((x) => x !== "")) return i; return 0; }
  getLastColumn() { let m = 0; for (const row of this.cells) for (let j = row.length; j > 0; j--) if (row[j - 1] !== "") { m = Math.max(m, j); break; } return m; }
  getMaxRows() { return Math.max(this.maxRows, this.cells.length); }
  getMaxColumns() { return this.maxCols; }
  getRange(r, c, nr = 1, nc = 1) { if (typeof r === "string") return {a1: r}; return new Range(this, r, c, nr, nc); }
  getParent() { return this.ss; }
  copyTo(ss) { const s = new Sheet("Копия " + this.name); s.cells = structuredClone(this.cells); s.ss = ss; ss.sheets.push(s); return s; }
  setName(n) { this.name = n; return this; }
  getDataRange() { return new Range(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1)); }
  insertRowBefore(r) { this.cells.splice(r - 1, 0, []); }
  insertRowsAfter(r, n) { for (let i = 0; i < n; i++) this.cells.splice(r, 0, []); }
  deleteRow(r) { this.cells.splice(r - 1, 1); }
  deleteRows(r, n) { this.cells.splice(r - 1, n); }
  clear() { this.cells = []; }
  setRowHeight(r, h) { this.styleLog.push(["rowHeight", r, h]); }
  setColumnWidth(c, w) { this.styleLog.push(["colWidth", c, w]); }
  setFrozenRows(n) { this.styleLog.push(["frozen", n]); }
  setConditionalFormatRules(rules) { this.rules = rules; }
  getConditionalFormatRules() { return this.rules; }
}

class Spreadsheet {
  constructor(tabs) { this.sheets = Object.entries(tabs).map(([name, rows]) => { const s = new Sheet(name); s.ss = this; rows.forEach((row, i) => row.forEach((v, j) => s.put(i + 1, j + 1, v))); return s; }); }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { const s = new Sheet(n); s.ss = this; this.sheets.push(s); return s; }
}

const builder = (kind) => {
  const o = {kind};
  for (const m of ["whenFormulaSatisfied", "whenTextEqualTo", "setBackground", "setFontColor", "setBold", "setRanges", "requireValueInList", "requireValueInRange", "requireCheckbox", "setAllowInvalid"]) o[m] = (...a) => { (o.calls ||= []).push([m, ...a]); return o; };
  o.build = () => o;
  return o;
};

/** Загружает собранный Code.gs в песочницу с имитацией Google. */
export function loadGas({tabs, props = {}, now = Date.now()}) {
  const ss = new Spreadsheet(tabs);
  const properties = {...props};
  const cache = new Map();
  const fetches = [];
  const triggers = [];
  let clock = now;
  const respond = (code = 200, text = "{}") => ({getResponseCode: () => code, getContentText: () => text});
  const ctx = {
    console, Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(clock); } static now() { return clock; } },
    SpreadsheetApp: {openById: () => ss, newConditionalFormatRule: () => builder("cf"), newDataValidation: () => builder("dv"), BorderStyle: {SOLID: "SOLID"}},
    PropertiesService: {getScriptProperties: () => ({getProperty: (k) => properties[k] ?? null, setProperty: (k, v) => { properties[k] = String(v); }, deleteProperty: (k) => { delete properties[k]; }, getProperties: () => ({...properties})})},
    CacheService: {getScriptCache: () => ({get: (k) => cache.get(k) ?? null, put: (k, v) => { cache.set(k, v); }, remove: (k) => { cache.delete(k); }, removeAll: (ks) => { ks.forEach((k) => cache.delete(k)); }, getAll: (ks) => Object.fromEntries(ks.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)])), putAll: (o) => { for (const [k, v] of Object.entries(o)) cache.set(k, v); }})},
    LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
    ContentService: {MimeType: {JSON: "json"}, createTextOutput: (t) => ({t, setMimeType() { return this; }, getContent() { return this.t; }})},
    UrlFetchApp: {fetch: (url, opts) => { fetches.push({url, ...opts, body: typeof opts?.payload === "string" ? JSON.parse(opts.payload) : opts?.payload}); const custom = ctx.__fetchReply && ctx.__fetchReply(url); return respond(ctx.__fetchStatus || 200, custom || "{\"ok\":true}"); }},
    ScriptApp: {getProjectTriggers: () => triggers.slice(), deleteTrigger: (...a) => { if (a.length !== 1) throw new Error("Параметры не соответствуют сигнатуре метода ScriptApp.deleteTrigger"); triggers.splice(triggers.indexOf(a[0]), 1); },
      newTrigger: (fn) => { const t = {fn}; const chain = {forSpreadsheet: () => chain, onChange: () => chain, onEdit: () => chain, timeBased: () => chain, everyMinutes: () => chain, create: () => { triggers.push(t); return t; }}; return chain; }},
    Utilities: {
      DigestAlgorithm: {SHA_256: "sha256"}, Charset: {UTF_8: "utf8"},
      computeDigest: (_a, v) => signed(createHash("sha256").update(bytesOf(v)).digest()),
      computeHmacSha256Signature: (v, key) => signed(createHmac("sha256", key).update(bytesOf(v)).digest()),
      base64EncodeWebSafe: (v) => bytesOf(v).toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
      base64DecodeWebSafe: (s) => { if (s.length % 4 === 1) throw new Error("Неверный base64"); return signed(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64")); },
      newBlob: (s) => ({getBytes: () => signed(Buffer.from(s)), getDataAsString: () => Buffer.from(s).toString()}),
      getUuid: randomUUID, sleep: () => {}, formatDate: () => "01.10 10:00",
    },
  };
  ctx.Utilities.newBlob = (v) => { const buf = typeof v === "string" ? Buffer.from(v) : unsigned(v); return {getBytes: () => signed(buf), getDataAsString: () => buf.toString()}; };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "apps_script_bot", "Code.gs"), "utf8"), ctx);
  return {ctx, ss, properties, fetches, triggers, advance: (ms) => { clock += ms; }, setFetchStatus: (s) => { ctx.__fetchStatus = s; }, setFetchReply: (fn) => { ctx.__fetchReply = fn; }, run: (code) => { vm.runInContext("if (typeof propsMemo_ !== 'undefined') propsMemo_ = null; if (typeof netMs_ !== 'undefined') netMs_ = 0;", ctx); return vm.runInContext(code, ctx); } /* как в Google: каждый запуск начинается с чистых переменных */};
}
