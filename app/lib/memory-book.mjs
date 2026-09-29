// Книга (таблица) в памяти с тем же интерфейсом, что у Google Таблицы в Apps Script. Для тестов и локального стенда.
//   get(tab) -> [[...]]   set(tab, row, values)   append(tab, values)   insert(tab, beforeRow)   remove(tab, row)
//   clearRow(tab, row)    replaceColumnA(tab, values)    ensure(tab, header?)
export class MemoryBook {
  constructor(tabs = {}) { this.tabs = structuredClone(tabs); }
  #t(tab) { return (this.tabs[tab] ||= []); }
  ensure(tab, header) { if (!this.tabs[tab]) this.tabs[tab] = header ? [[...header]] : []; }
  get(tab) { return structuredClone(this.#t(tab)); }
  set(tab, row, values) { const t = this.#t(tab); while (t.length < row - 1) t.push([]); t[row - 1] = values.map(String); }
  append(tab, values) { this.#t(tab).push(values.map(String)); }
  insert(tab, beforeRow) { const t = this.#t(tab); while (t.length < beforeRow - 1) t.push([]); t.splice(beforeRow - 1, 0, []); }
  remove(tab, row) { this.#t(tab).splice(row - 1, 1); }
  clearRow(tab, row) { const t = this.#t(tab); if (t[row - 1]) t[row - 1] = []; }
  replaceColumnA(tab, values) { this.tabs[tab] = values.map((v) => [String(v)]); }
}
