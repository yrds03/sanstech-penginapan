// In-memory implementation of the Apps Script services used by Code.gs.
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

function createBackend(options = {}) {
    const sheets = new Map(), properties = new Map(), cache = new Map(), triggers = [], faults = new Map();
    const copy = value => structuredClone(value);
    class Range {
        constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
        getValues() { return Array.from({ length: this.rows }, (_, i) => Array.from({ length: this.cols }, (_, j) => this.sheet.cells[this.row - 1 + i]?.[this.col - 1 + j] ?? '')); }
        getDisplayValues() { return this.getValues().map((row, i) => row.map((v, j) => this.sheet.displays.get(`${this.row - 1 + i}:${this.col - 1 + j}`) ?? (v instanceof Date ? v.toISOString() : String(v)))); }
        getFormulas() { return this.getValues().map((row, i) => row.map((v, j) => typeof v === 'string' && v.startsWith('=') && !this.sheet.literals.has(`${this.row - 1 + i}:${this.col - 1 + j}`) ? v : '')); }
        setValues(values) {
            if (faults.get(this.sheet.name) > 0) { faults.set(this.sheet.name, faults.get(this.sheet.name) - 1); throw new Error('Injected write failure'); }
            if (values.length !== this.rows || values.some(row => row.length !== this.cols)) throw new Error('Invalid range shape');
            values.forEach((row, i) => row.forEach((v, j) => {
                const index = this.row - 1 + i; this.sheet.cells[index] ||= [];
                const key = `${index}:${this.col - 1 + j}`;
                this.sheet.displays.delete(key);
                if (typeof v === 'string' && v.startsWith("'")) this.sheet.literals.add(key); else this.sheet.literals.delete(key);
                this.sheet.cells[index][this.col - 1 + j] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : copy(v);
            })); return this;
        }
        clearContent() { for (let i = 0; i < this.rows; i++) for (let j = 0; j < this.cols; j++) if (this.sheet.cells[this.row - 1 + i]) this.sheet.cells[this.row - 1 + i][this.col - 1 + j] = ''; return this; }
        getSheet() { return this.sheet; }
        getRow() { return this.row; }
        setBackground() { return this; } setFontColor() { return this; } setFontWeight() { return this; } setHorizontalAlignment() { return this; }
        setNumberFormat(format) { this.sheet.formats.push({ col: this.col, format }); for (let i = 0; i < this.rows; i++) for (let j = 0; j < this.cols; j++) this.sheet.displays.delete(`${this.row - 1 + i}:${this.col - 1 + j}`); return this; }
    }
    class Sheet {
        constructor(name, cells = []) { this.name = name; this.cells = copy(cells); this.formats = []; this.literals = new Set(); this.displays = new Map(); }
        getName() { return this.name; }
        getLastRow() { let n = this.cells.length; while (n && !this.cells[n - 1].some(v => v !== '' && v !== undefined)) n--; return n; }
        getLastColumn() { return Math.max(0, ...this.cells.map(row => row.reduce((end, v, i) => v !== '' && v !== undefined ? i + 1 : end, 0))); }
        getMaxRows() { return Math.max(1000, this.getLastRow()); }
        insertRowsAfter() {}
        getRange(row, col, rows = 1, cols = 1) { return new Range(this, row, col, rows, cols); }
        getDataRange() { return this.getRange(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
        setFrozenRows(n) { this.frozen = n; } autoResizeColumns() {}
        copyTo() { const target = new Sheet('Copy of ' + this.name, this.cells); sheets.set(target.name, target); return target; }
        setName(name) { sheets.delete(this.name); this.name = name; sheets.set(name, this); return this; }
    }
    const ss = {
        getSheetByName: name => sheets.get(name) || null,
        insertSheet(name) { const sheet = new Sheet(name); sheets.set(name, sheet); return sheet; },
        setSpreadsheetTimeZone(value) { this.timeZone = value; },
        getId: () => '1Z2iCSjdW2oi5dEucNR34mD-U2TEHi779OfbKgm11vwA'
    };
    let locked = false, blocked = false;
    const propStore = { getProperty: k => properties.get(k) ?? null, setProperty(k, v) { properties.set(k, String(v)); return this; }, deleteProperty(k) { properties.delete(k); return this; } };
    const context = vm.createContext({
        Date, Set, Map, console,
        SpreadsheetApp: { openById(id) { if (id !== ss.getId()) throw new Error('Wrong spreadsheet'); return ss; }, flush() {} },
        PropertiesService: { getScriptProperties: () => propStore },
        CacheService: { getScriptCache: () => ({ get: k => cache.get(k) ?? null, put: (k, v) => cache.set(k, v), remove: k => cache.delete(k) }) },
        LockService: { getScriptLock: () => ({ tryLock() { if (blocked || locked) return false; locked = true; return true; }, releaseLock() { locked = false; } }) },
        Utilities: {
            getUuid: () => crypto.randomUUID(),
            computeHmacSha256Signature: (value, key) => [...crypto.createHmac('sha256', key).update(value).digest()],
            formatDate(date, timeZone, pattern) {
                const fields = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(date)).map(p => [p.type, p.value]));
                if (pattern === 'yyyy-MM-dd') return `${fields.year}-${fields.month}-${fields.day}`;
                return `${fields.year}${fields.month}${fields.day}-${fields.hour}${fields.minute}${fields.second}`;
            }
        },
        ScriptApp: {
            getProjectTriggers: () => triggers,
            deleteTrigger(t) { triggers.splice(triggers.indexOf(t), 1); },
            newTrigger(handler) { const t = { handler, getHandlerFunction() { return this.handler; }, forSpreadsheet(id) { this.source = id; return this; }, onEdit() { this.type = 'edit'; return this; }, timeBased() { this.type = 'time'; return this; }, everyMinutes(n) { this.minutes = n; return this; }, create() { triggers.push(this); return this; } }; return t; }
        },
        ContentService: { MimeType: { JSON: 'json' }, createTextOutput(text) { return { text, setMimeType() { return this; } }; } }
    });
    const source = fs.readFileSync(path.join(__dirname, '../backend/Code.gs'), 'utf8');
    new vm.Script(source, { filename: 'Code.gs' }).runInContext(context);
    const schema = vm.runInContext('SHEET_SCHEMA', context);
    const seed = (name, rows, headers = schema[name]) => { sheets.set(name, new Sheet(name, [copy(headers), ...rows.map(row => Array.isArray(row) ? row : headers.map(h => row[h] ?? ''))])); };
    seed('Data User', options.users || [{ Username: 'Admin', Password: '654321', Role: 'Super Admin', 'Hak Akses': 'Semua Akses', Status: 'Aktif' }, { Username: 'Staff', Password: '112233', Role: 'Resepsionis', 'Hak Akses': 'Check In, Check Out', Status: 'Aktif' }]);
    seed('Data Kamar', [
        { 'No Kamar': '101', Tipe: 'Standard', Harga: 200000, Lantai: 'Lantai 1', Fasilitas: 'Wifi', Keterangan: '', Status: 'Kosong' },
        { 'No Kamar': '102', Tipe: 'Deluxe', Harga: 350000, Lantai: 'Lantai 1', Fasilitas: 'Wifi, AC', Keterangan: '', Status: 'Cleaning' }
    ]);
    const api = (action, data, token, requestId) => JSON.parse(context.doPost({ postData: { contents: JSON.stringify({ action, data, token, requestId }) } }).text);
    return {
        context, sheets, properties, cache, triggers, ss, seed, schema: copy(schema), faults,
        setup: () => copy(context.setupSistemPenginapan()),
        api,
        get: action => JSON.parse(context.doGet({ parameter: { action } }).text),
        rows: name => copy(context.readRows_(name)),
        today: () => context.today_(),
        login: (pin = '654321') => api('login', { pin }),
        blockLock(value) { blocked = value; },
        objectRow: (name, object) => schema[name].map(h => object[h] ?? ''),
        id: () => crypto.randomUUID()
    };
}
module.exports = { createBackend };
