'use strict';
// שרת האתר ומערכת התורים של רבקה כהן.
// ללא תלויות חיצוניות: Node.js 22.13 ומעלה (node:sqlite מובנה).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const HEALTH = require('./js/health-data.js');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const TZ = 'Asia/Jerusalem';
const HEALTH_VALID_DAYS = 365;
const SESSION_DAYS = 14;
const STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'];
const ACTIVE = ['pending', 'confirmed'];

// ---------- מסד נתונים ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'studio.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, duration INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, id_number TEXT,
    health TEXT, health_signed_at TEXT, signature TEXT, notes TEXT, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS appointments (
    id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    service_id INTEGER REFERENCES services(id), date TEXT NOT NULL, time TEXT NOT NULL,
    duration INTEGER NOT NULL, status TEXT NOT NULL, client_note TEXT, admin_note TEXT,
    source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS appointments_date ON appointments(date);
  CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL, service_id INTEGER REFERENCES services(id),
    date_from TEXT, date_to TEXT, time_pref TEXT, note TEXT,
    status TEXT NOT NULL DEFAULT 'waiting', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
`);

const DEFAULT_SETTINGS = {
  // 0 = ראשון ... 6 = שבת. כל יום: רשימת טווחי שעות.
  hours: {
    0: [{ from: '10:00', to: '19:00' }], 1: [{ from: '10:00', to: '19:00' }],
    2: [{ from: '10:00', to: '19:00' }], 3: [{ from: '10:00', to: '19:00' }],
    4: [{ from: '10:00', to: '19:00' }], 5: [{ from: '09:00', to: '13:00' }], 6: []
  },
  slotStep: 30,
  minNoticeHours: 12,
  horizonDays: 60,
  autoConfirm: false,
  closures: [] // [{ date, from?, to?, reason? }]
};
const DEFAULT_SERVICES = [
  ['ייעוץ ועיצוב', 20], ['קעקוע מינימליסטי קטן', 30], ['כיתוב / משפט', 45],
  ['פרחים ובוטניקה', 60], ['פרפרים וחיות', 60], ['עיצוב אישי', 90], ['חידוש / חיזוק קעקוע', 45]
];

const getSetting = (key) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : DEFAULT_SETTINGS[key];
};
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
const settings = () => Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, getSetting(k)]));

if (!db.prepare('SELECT COUNT(*) AS n FROM services').get().n) {
  const ins = db.prepare('INSERT INTO services (name, duration, sort) VALUES (?, ?, ?)');
  DEFAULT_SERVICES.forEach(([n, d], i) => ins.run(n, d, i));
}

// ---------- סיסמת ניהול ----------
const hashPassword = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
};
const checkPassword = (pw, stored) => {
  if (!stored || typeof pw !== 'string') return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(test, Buffer.from(hash, 'hex'));
};
if (!getSetting('adminHash')) {
  const initial = process.env.ADMIN_PASSWORD || crypto.randomBytes(6).toString('base64url');
  setSetting('adminHash', hashPassword(initial));
  if (!process.env.ADMIN_PASSWORD) console.log(`\n*** סיסמת ניהול ראשונית: ${initial}  (מומלץ להחליף בדף הניהול) ***\n`);
}

// ---------- זמן ותאריכים (שעון ישראל) ----------
const pad = (n) => String(n).padStart(2, '0');
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const dayNum = (date) => Date.parse(date + 'T00:00:00Z') / 86400000;
const weekday = (date) => new Date(date + 'T00:00:00Z').getUTCDay();
const addDays = (date, n) => new Date((dayNum(date) + n) * 86400000).toISOString().slice(0, 10);
function nowIL() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, abs: dayNum(date) * 1440 + Number(p.hour) * 60 + Number(p.minute) };
}
const stamp = () => new Date().toISOString();

// ---------- חישוב תורים פנויים ----------
function busyIntervals(date, excludeId) {
  const rows = db.prepare(`SELECT time, duration FROM appointments
    WHERE date = ? AND status IN ('pending','confirmed') AND id != ?`).all(date, excludeId || 0);
  const list = rows.map(r => [toMin(r.time), toMin(r.time) + r.duration]);
  for (const c of getSetting('closures')) {
    if (c.date !== date) continue;
    list.push(c.from && c.to ? [toMin(c.from), toMin(c.to)] : [0, 24 * 60]);
  }
  return list;
}
const overlaps = (s, e, list) => list.some(([a, b]) => s < b && e > a);

function availableSlots(date, duration, { excludeId, ignoreNotice } = {}) {
  if (!isDate(date) || !(duration > 0)) return [];
  const s = settings();
  const now = nowIL();
  const day = dayNum(date);
  if (day < dayNum(now.date) || day > dayNum(now.date) + s.horizonDays) return [];
  const ranges = s.hours[weekday(date)] || [];
  const busy = busyIntervals(date, excludeId);
  const minAbs = now.abs + (ignoreNotice ? 0 : s.minNoticeHours * 60);
  const out = [];
  for (const r of ranges) {
    for (let t = toMin(r.from); t + duration <= toMin(r.to); t += s.slotStep) {
      if (day * 1440 + t < minAbs) continue;
      if (!overlaps(t, t + duration, busy)) out.push(fromMin(t));
    }
  }
  return out;
}

// ---------- עזרי אימות ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  if (!/^0\d{8,9}$/.test(d)) fail(400, 'מספר הטלפון לא תקין');
  return d;
}
const service = (id) => db.prepare('SELECT * FROM services WHERE id = ?').get(Number(id));
const healthValid = (c) => !!(c && c.health && c.health_signed_at &&
  (Date.now() - Date.parse(c.health_signed_at)) / 86400000 < HEALTH_VALID_DAYS);

function validateHealth(h) {
  if (!h || typeof h !== 'object') fail(400, 'חסרה הצהרת בריאות');
  const answers = h.answers;
  if (!Array.isArray(answers) || answers.length !== HEALTH.questions.length || answers.some(a => a !== 'כן' && a !== 'לא'))
    fail(400, 'יש לענות על כל שאלות הצהרת הבריאות');
  if (h.declare !== true || h.consent !== true) fail(400, 'יש לאשר את הצהרת הבריאות ואת טופס ההסכמה');
  const idNumber = String(h.idNumber || '').replace(/\D/g, '');
  if (!/^\d{5,9}$/.test(idNumber)) fail(400, 'מספר תעודת הזהות לא תקין');
  const sig = typeof h.signature === 'string' ? h.signature : '';
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length > 400000) fail(400, 'חסרה חתימה');
  const details = {};
  for (const i of HEALTH.detailQuestions) if (answers[i] === 'כן') details[i] = str(h.details?.[i], 300);
  return { answers, details, idNumber, signature: sig };
}

function upsertClient(name, phone) {
  const c = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
  if (c) {
    if (name && name !== c.name) db.prepare('UPDATE clients SET name = ? WHERE id = ?').run(name, c.id);
    return db.prepare('SELECT * FROM clients WHERE id = ?').get(c.id);
  }
  const r = db.prepare('INSERT INTO clients (name, phone, created_at) VALUES (?, ?, ?)').run(name, phone, stamp());
  return db.prepare('SELECT * FROM clients WHERE id = ?').get(r.lastInsertRowid);
}
function saveHealth(clientId, h) {
  db.prepare('UPDATE clients SET id_number = ?, health = ?, health_signed_at = ?, signature = ? WHERE id = ?')
    .run(h.idNumber, JSON.stringify({ answers: h.answers, details: h.details }), stamp(), h.signature, clientId);
}

function waitlistMatches(date) {
  return db.prepare(`SELECT w.*, s.name AS service_name FROM waitlist w LEFT JOIN services s ON s.id = w.service_id
    WHERE w.status = 'waiting' AND (w.date_from IS NULL OR w.date_from <= ?) AND (w.date_to IS NULL OR w.date_to >= ?)
    ORDER BY w.created_at`).all(date, date);
}

// ---------- הגבלת קצב ----------
const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) fail(429, 'יותר מדי ניסיונות, נסי שוב בעוד כמה דקות');
  arr.push(now); hits.set(key, arr);
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (a.every(t => now - t > 3600e3)) hits.delete(k); }, 600e3).unref();

// ---------- התחברות ----------
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');
function sessionOk(req) {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const row = db.prepare('SELECT expires FROM sessions WHERE token_hash = ?').get(tokenHash(m[1]));
  return !!row && row.expires > Date.now();
}
function cookie(req, value, maxAge) {
  const secure = (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https') || process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`;
}

// ---------- ניתוב API ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) =>
  routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

// --- ציבורי ---
route('GET', '/api/public/config', () => {
  const s = settings();
  return {
    services: db.prepare('SELECT id, name, duration FROM services WHERE active = 1 ORDER BY sort, id').all(),
    hours: s.hours, horizonDays: s.horizonDays, minNoticeHours: s.minNoticeHours, today: nowIL().date
  };
});

route('GET', '/api/public/availability', (req, q) => {
  const svc = service(q.get('service'));
  if (!svc || !svc.active) fail(400, 'טיפול לא קיים');
  const from = isDate(q.get('from')) ? q.get('from') : nowIL().date;
  const days = Math.min(Number(q.get('days')) || 42, 62);
  const out = {};
  for (let i = 0; i < days; i++) { const d = addDays(from, i); out[d] = availableSlots(d, svc.duration).length; }
  return { days: out };
});

route('GET', '/api/public/slots', (req, q) => {
  const svc = service(q.get('service'));
  if (!svc || !svc.active) fail(400, 'טיפול לא קיים');
  return { slots: availableSlots(q.get('date'), svc.duration) };
});

route('POST', '/api/public/check', (req, q, body, ip) => {
  rateLimit('check:' + ip, 30, 600e3);
  const c = db.prepare('SELECT * FROM clients WHERE phone = ?').get(normPhone(body.phone));
  return { needsHealth: !healthValid(c) };
});

route('POST', '/api/public/book', (req, q, body, ip) => {
  rateLimit('book:' + ip, 10, 600e3);
  const name = str(body.name, 80);
  if (name.length < 2) fail(400, 'נא למלא שם מלא');
  const phone = normPhone(body.phone);
  const svc = service(body.serviceId);
  if (!svc || !svc.active) fail(400, 'נא לבחור סוג קעקוע');
  if (!isDate(body.date) || !isTime(body.time)) fail(400, 'נא לבחור תאריך ושעה');
  // בדיקה והכנסה באותה פעולה סינכרונית – אין מצב ששתי מטופלות יתפסו אותו תור
  if (!availableSlots(body.date, svc.duration).includes(body.time)) fail(409, 'התור הזה כבר נתפס, נא לבחור שעה אחרת');
  const existing = db.prepare('SELECT * FROM clients WHERE phone = ?').get(phone);
  const health = healthValid(existing) && !body.health ? null : validateHealth(body.health);
  const status = getSetting('autoConfirm') ? 'confirmed' : 'pending';
  db.exec('BEGIN');
  try {
    const client = upsertClient(name, phone);
    if (health) saveHealth(client.id, health);
    const r = db.prepare(`INSERT INTO appointments (client_id, service_id, date, time, duration, status, client_note, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'online', ?, ?)`)
      .run(client.id, svc.id, body.date, body.time, svc.duration, status, str(body.note, 500), stamp(), stamp());
    db.exec('COMMIT');
    return { id: Number(r.lastInsertRowid), status };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
});

route('POST', '/api/public/health', (req, q, body, ip) => {
  rateLimit('health:' + ip, 10, 600e3);
  const name = str(body.name, 80);
  if (name.length < 2) fail(400, 'נא למלא שם מלא');
  const phone = normPhone(body.phone);
  const health = validateHealth(body.health);
  saveHealth(upsertClient(name, phone).id, health);
  return { ok: true };
});

route('POST', '/api/public/waitlist', (req, q, body, ip) => {
  rateLimit('wait:' + ip, 10, 600e3);
  const name = str(body.name, 80);
  if (name.length < 2) fail(400, 'נא למלא שם מלא');
  const phone = normPhone(body.phone);
  const svc = body.serviceId ? service(body.serviceId) : null;
  const from = isDate(body.dateFrom) ? body.dateFrom : null;
  const to = isDate(body.dateTo) ? body.dateTo : null;
  if (from && to && to < from) fail(400, 'טווח התאריכים לא תקין');
  const pref = ['any', 'morning', 'noon', 'evening'].includes(body.timePref) ? body.timePref : 'any';
  db.prepare(`INSERT INTO waitlist (name, phone, service_id, date_from, date_to, time_pref, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(name, phone, svc ? svc.id : null, from, to, pref, str(body.note, 500), stamp());
  return { ok: true };
});

// --- ניהול ---
route('POST', '/api/admin/login', (req, q, body, ip, res) => {
  rateLimit('login:' + ip, 8, 900e3);
  if (!checkPassword(body.password, getSetting('adminHash'))) fail(401, 'סיסמה שגויה');
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, expires) VALUES (?, ?)').run(tokenHash(token), Date.now() + SESSION_DAYS * 86400e3);
  res.setHeader('Set-Cookie', cookie(req, token, SESSION_DAYS * 86400));
  return { ok: true };
}, { public: true });

route('POST', '/api/admin/logout', (req, q, body, ip, res) => {
  const m = /(?:^|;\s*)sid=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '');
  if (m) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(m[1]));
  res.setHeader('Set-Cookie', cookie(req, '', 0));
  return { ok: true };
}, { public: true });

route('GET', '/api/admin/me', (req) => ({ loggedIn: sessionOk(req) }), { public: true });

route('GET', '/api/admin/summary', () => {
  const today = nowIL().date;
  return {
    today,
    pending: db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE status = 'pending' AND date >= ?").get(today).n,
    todayCount: db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE date = ? AND status IN ('pending','confirmed')").get(today).n,
    weekCount: db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE date BETWEEN ? AND ? AND status IN ('pending','confirmed')").get(today, addDays(today, 6)).n,
    waiting: db.prepare("SELECT COUNT(*) AS n FROM waitlist WHERE status = 'waiting'").get().n,
    clients: db.prepare('SELECT COUNT(*) AS n FROM clients').get().n
  };
});

const APPT_SELECT = `SELECT a.*, c.name AS client_name, c.phone AS client_phone, c.health_signed_at, s.name AS service_name
  FROM appointments a JOIN clients c ON c.id = a.client_id LEFT JOIN services s ON s.id = a.service_id`;

route('GET', '/api/admin/appointments', (req, q) => {
  const where = [], args = [];
  if (isDate(q.get('from'))) { where.push('a.date >= ?'); args.push(q.get('from')); }
  if (isDate(q.get('to'))) { where.push('a.date <= ?'); args.push(q.get('to')); }
  if (STATUSES.includes(q.get('status'))) { where.push('a.status = ?'); args.push(q.get('status')); }
  const rows = db.prepare(`${APPT_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.date, a.time LIMIT 500`).all(...args);
  return { appointments: rows.map(r => ({ ...r, health_ok: healthValid({ health: 1, health_signed_at: r.health_signed_at }) })) };
});

route('GET', '/api/admin/slots', (req, q) => {
  const duration = Number(q.get('duration')) || 60;
  return { slots: availableSlots(q.get('date'), duration, { excludeId: Number(q.get('exclude')) || 0, ignoreNotice: true }) };
});

function checkConflict(date, time, duration, excludeId, force) {
  if (force) return;
  const s = toMin(time);
  const clash = db.prepare(`${APPT_SELECT} WHERE a.date = ? AND a.status IN ('pending','confirmed') AND a.id != ?`).all(date, excludeId || 0)
    .find(r => s < toMin(r.time) + r.duration && s + duration > toMin(r.time));
  if (clash) fail(409, `חפיפה עם התור של ${clash.client_name} ב-${clash.time}`);
}

route('POST', '/api/admin/appointments', (req, q, body) => {
  const name = str(body.name, 80);
  if (name.length < 2) fail(400, 'נא למלא שם');
  const phone = normPhone(body.phone);
  const svc = service(body.serviceId);
  if (!svc) fail(400, 'נא לבחור טיפול');
  if (!isDate(body.date) || !isTime(body.time)) fail(400, 'נא לבחור תאריך ושעה');
  const duration = Math.max(5, Math.min(Number(body.duration) || svc.duration, 600));
  checkConflict(body.date, body.time, duration, 0, body.force);
  const client = upsertClient(name, phone);
  const status = STATUSES.includes(body.status) ? body.status : 'confirmed';
  const r = db.prepare(`INSERT INTO appointments (client_id, service_id, date, time, duration, status, admin_note, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?)`).run(client.id, svc.id, body.date, body.time, duration, status, str(body.adminNote, 500), stamp(), stamp());
  return { id: Number(r.lastInsertRowid) };
});

route('PATCH', '/api/admin/appointments/:id', (req, q, body, ip, res, p) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(Number(p.id));
  if (!a) fail(404, 'התור לא נמצא');
  const next = { ...a };
  if (body.status !== undefined) { if (!STATUSES.includes(body.status)) fail(400, 'סטטוס לא תקין'); next.status = body.status; }
  if (body.date !== undefined) { if (!isDate(body.date)) fail(400, 'תאריך לא תקין'); next.date = body.date; }
  if (body.time !== undefined) { if (!isTime(body.time)) fail(400, 'שעה לא תקינה'); next.time = body.time; }
  if (body.serviceId !== undefined) { const s = service(body.serviceId); if (!s) fail(400, 'טיפול לא קיים'); next.service_id = s.id; }
  if (body.duration !== undefined) next.duration = Math.max(5, Math.min(Number(body.duration) || a.duration, 600));
  if (body.adminNote !== undefined) next.admin_note = str(body.adminNote, 500);
  const moved = next.date !== a.date || next.time !== a.time || next.duration !== a.duration;
  if (ACTIVE.includes(next.status) && (moved || !ACTIVE.includes(a.status))) checkConflict(next.date, next.time, next.duration, a.id, body.force);
  db.prepare(`UPDATE appointments SET status = ?, date = ?, time = ?, service_id = ?, duration = ?, admin_note = ?, updated_at = ? WHERE id = ?`)
    .run(next.status, next.date, next.time, next.service_id, next.duration, next.admin_note, stamp(), a.id);
  const freed = (ACTIVE.includes(a.status) && !ACTIVE.includes(next.status)) || (ACTIVE.includes(a.status) && moved);
  return {
    appointment: db.prepare(`${APPT_SELECT} WHERE a.id = ?`).get(a.id),
    waitlist: freed ? waitlistMatches(a.date) : [],
    freedDate: freed ? a.date : null, freedTime: freed ? a.time : null
  };
});

route('GET', '/api/admin/clients', (req, q) => {
  const term = '%' + str(q.get('q'), 60).replace(/[%_]/g, '') + '%';
  const rows = db.prepare(`SELECT c.id, c.name, c.phone, c.health_signed_at, c.created_at,
      (SELECT COUNT(*) FROM appointments a WHERE a.client_id = c.id) AS visits,
      (SELECT MAX(date) FROM appointments a WHERE a.client_id = c.id AND a.status != 'cancelled') AS last_date
    FROM clients c WHERE c.name LIKE ? OR c.phone LIKE ? ORDER BY c.name LIMIT 300`).all(term, term);
  return { clients: rows.map(r => ({ ...r, health_ok: healthValid({ health: 1, health_signed_at: r.health_signed_at }) })) };
});

route('GET', '/api/admin/clients/:id', (req, q, body, ip, res, p) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(p.id));
  if (!c) fail(404, 'הלקוחה לא נמצאה');
  return {
    client: { ...c, health: c.health ? JSON.parse(c.health) : null, health_ok: healthValid(c) },
    appointments: db.prepare(`${APPT_SELECT} WHERE a.client_id = ? ORDER BY a.date DESC, a.time DESC`).all(c.id),
    questions: HEALTH.questions
  };
});

route('PATCH', '/api/admin/clients/:id', (req, q, body, ip, res, p) => {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(p.id));
  if (!c) fail(404, 'הלקוחה לא נמצאה');
  const name = body.name !== undefined ? str(body.name, 80) || c.name : c.name;
  const notes = body.notes !== undefined ? str(body.notes, 2000) : c.notes;
  db.prepare('UPDATE clients SET name = ?, notes = ? WHERE id = ?').run(name, notes, c.id);
  return { ok: true };
});

route('DELETE', '/api/admin/clients/:id', (req, q, body, ip, res, p) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(Number(p.id));
  return { ok: true };
});

route('GET', '/api/admin/waitlist', () => ({
  waitlist: db.prepare(`SELECT w.*, s.name AS service_name FROM waitlist w LEFT JOIN services s ON s.id = w.service_id
    ORDER BY CASE w.status WHEN 'waiting' THEN 0 WHEN 'contacted' THEN 1 ELSE 2 END, w.created_at`).all()
}));

route('PATCH', '/api/admin/waitlist/:id', (req, q, body, ip, res, p) => {
  if (!['waiting', 'contacted', 'booked', 'removed'].includes(body.status)) fail(400, 'סטטוס לא תקין');
  db.prepare('UPDATE waitlist SET status = ? WHERE id = ?').run(body.status, Number(p.id));
  return { ok: true };
});

route('DELETE', '/api/admin/waitlist/:id', (req, q, body, ip, res, p) => {
  db.prepare('DELETE FROM waitlist WHERE id = ?').run(Number(p.id));
  return { ok: true };
});

route('GET', '/api/admin/settings', () => {
  const { adminHash, ...s } = settings();
  return { settings: s, services: db.prepare('SELECT * FROM services ORDER BY sort, id').all() };
});

route('PUT', '/api/admin/settings', (req, q, body) => {
  const s = body.settings || {};
  const hours = {};
  for (let d = 0; d < 7; d++) {
    const list = Array.isArray(s.hours?.[d]) ? s.hours[d] : [];
    hours[d] = list.filter(r => isTime(r.from) && isTime(r.to) && toMin(r.to) > toMin(r.from))
      .map(r => ({ from: r.from, to: r.to })).sort((a, b) => toMin(a.from) - toMin(b.from)).slice(0, 4);
  }
  const num = (v, lo, hi, def) => { const n = Math.round(Number(v)); return n >= lo && n <= hi ? n : def; };
  const cur = settings();
  setSetting('hours', hours);
  setSetting('slotStep', num(s.slotStep, 5, 240, cur.slotStep));
  setSetting('minNoticeHours', num(s.minNoticeHours, 0, 336, cur.minNoticeHours));
  setSetting('horizonDays', num(s.horizonDays, 1, 365, cur.horizonDays));
  setSetting('autoConfirm', s.autoConfirm === true);
  setSetting('closures', (Array.isArray(s.closures) ? s.closures : [])
    .filter(c => isDate(c.date) && (!c.from || (isTime(c.from) && isTime(c.to) && c.to > c.from)))
    .map(c => ({ date: c.date, from: c.from || null, to: c.from ? c.to : null, reason: str(c.reason, 120) })).slice(0, 300));
  if (Array.isArray(body.services)) {
    const upd = db.prepare('UPDATE services SET name = ?, duration = ?, active = ?, sort = ? WHERE id = ?');
    const ins = db.prepare('INSERT INTO services (name, duration, active, sort) VALUES (?, ?, ?, ?)');
    body.services.slice(0, 50).forEach((sv, i) => {
      const name = str(sv.name, 80), duration = num(sv.duration, 5, 600, 60), active = sv.active === false ? 0 : 1;
      if (!name) return;
      if (sv.id && service(sv.id)) upd.run(name, duration, active, i, Number(sv.id));
      else ins.run(name, duration, active, i);
    });
  }
  return { ok: true };
});

route('POST', '/api/admin/password', (req, q, body) => {
  if (!checkPassword(body.current, getSetting('adminHash'))) fail(400, 'הסיסמה הנוכחית שגויה');
  if (typeof body.next !== 'string' || body.next.length < 8) fail(400, 'הסיסמה החדשה חייבת להכיל לפחות 8 תווים');
  setSetting('adminHash', hashPassword(body.next));
  return { ok: true };
});

// ---------- קבצים סטטיים ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon'
};
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  if (rel === 'admin') rel = 'admin.html';
  if (rel === 'book') rel = 'book.html';
  const file = path.normalize(path.join(ROOT, rel));
  const ext = path.extname(file).toLowerCase();
  const top = path.relative(ROOT, file).split(path.sep)[0];
  const allowed = file.startsWith(ROOT + path.sep) && TYPES[ext] &&
    (ext === '.html' ? !rel.includes('/') : ['css', 'js', 'assets'].includes(top));
  if (!allowed || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('לא נמצא');
  }
  const headers = { 'Content-Type': TYPES[ext], 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' };
  if (rel === 'admin.html') {
    Object.assign(headers, {
      'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    });
  }
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

// ---------- שרת ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 600000) { reject(new HttpError(413, 'הבקשה גדולה מדי')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'בקשה לא תקינה')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  const url = new URL(req.url, 'http://local');
  if (!url.pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url.pathname);
  }
  const send = (status, obj) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
    if (!r) fail(404, 'לא נמצא');
    if (url.pathname.startsWith('/api/admin/') && !r.public && !sessionOk(req)) fail(401, 'נדרשת התחברות');
    let body = {};
    if (req.method !== 'GET') {
      // הגנה מ-CSRF: רק JSON, יחד עם עוגיית SameSite=Strict
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'בקשה לא תקינה');
      body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'בקשה לא תקינה');
    }
    // מאחורי שרת פרוקסי (Render / Railway וכו') מגדירים TRUST_PROXY=1 כדי לזהות את כתובת המבקרת האמיתית
    const fwd = process.env.TRUST_PROXY === '1' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
    const ip = fwd || req.socket.remoteAddress || '';
    const params = url.pathname.match(r.re).groups || {};
    send(200, await r.handler(req, url.searchParams, body, ip, res, params));
  } catch (e) {
    if (e instanceof HttpError) send(e.status, { error: e.message });
    else { console.error(e); send(500, { error: 'שגיאה בשרת, נסי שוב' }); }
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`האתר פועל: http://localhost:${PORT}  ·  ניהול: http://localhost:${PORT}/admin`));
}
module.exports = { server, availableSlots, db };
