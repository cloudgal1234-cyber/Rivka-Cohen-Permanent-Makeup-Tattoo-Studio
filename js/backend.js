// שכבת הנתונים של מערכת התורים – Firebase (Firestore + Authentication), בלי שרת.
// מקבלת את אותן "כתובות" שהאתר משתמש בהן (/api/...) ומבצעת אותן מול Firestore.
// האבטחה האמיתית נאכפת בקובץ firestore.rules.
import { initializeApp } from './vendor/firebase/firebase-app.js';
import {
  getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut, onAuthStateChanged,
  EmailAuthProvider, reauthenticateWithCredential, updatePassword
} from './vendor/firebase/firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, where, runTransaction, writeBatch, serverTimestamp, Timestamp
} from './vendor/firebase/firebase-firestore.js';
import { firebaseConfig, ADMIN_EMAIL_DOMAIN } from './firebase-config.js';

const useEmulator = ['localhost', '127.0.0.1'].includes(location.hostname) && (() => {
  try { return localStorage.getItem('useEmulator') === '1'; } catch { return false; }
})();
const app = initializeApp(useEmulator ? { apiKey: 'demo', projectId: 'demo-rivka', authDomain: 'localhost' } : firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
if (useEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
const authReady = new Promise(r => { const off = onAuthStateChanged(auth, u => { off(); r(u); }); });

// ---------- קבועים וברירות מחדל ----------
const UNIT = 15; // גודל "משבצת" לחסימת יומן, בדקות
const HEALTH_VALID_DAYS = 365;
const QUESTION_COUNT = 24;
const STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'];
const ACTIVE = ['pending', 'confirmed'];
const DEFAULTS = {
  hours: {
    0: [{ from: '10:00', to: '19:00' }], 1: [{ from: '10:00', to: '19:00' }], 2: [{ from: '10:00', to: '19:00' }],
    3: [{ from: '10:00', to: '19:00' }], 4: [{ from: '10:00', to: '19:00' }], 5: [{ from: '09:00', to: '13:00' }], 6: []
  },
  slotStep: 30, minNoticeHours: 12, horizonDays: 60, autoConfirm: false, closures: [],
  services: [
    ['s1', 'ייעוץ ועיצוב', 20], ['s2', 'קעקוע מינימליסטי קטן', 30], ['s3', 'כיתוב / משפט', 45],
    ['s4', 'פרחים ובוטניקה', 60], ['s5', 'פרפרים וחיות', 60], ['s6', 'עיצוב אישי', 90], ['s7', 'חידוש / חיזוק קעקוע', 45]
  ].map(([id, name, duration], sort) => ({ id, name, duration, active: true, sort }))
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

// ---------- זמן ותאריכים (שעון ישראל) ----------
const pad = n => String(n).padStart(2, '0');
const toMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const dayNum = d => Date.parse(d + 'T00:00:00Z') / 86400000;
const weekday = d => new Date(d + 'T00:00:00Z').getUTCDay();
const addDays = (d, n) => new Date((dayNum(d) + n) * 86400000).toISOString().slice(0, 10);
function nowIL() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, abs: dayNum(date) * 1440 + Number(p.hour) * 60 + Number(p.minute) };
}
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('972')) d = '0' + d.slice(3);
  if (!/^0\d{8,9}$/.test(d)) fail(400, 'מספר הטלפון לא תקין');
  return d;
}
async function phoneHash(phone) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('rivka:' + phone));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const tsIso = t => (t && t.toDate ? t.toDate().toISOString() : t || null);
const healthValid = signedAt => !!signedAt && (Date.now() - Date.parse(signedAt)) / 86400000 < HEALTH_VALID_DAYS;

// ---------- משבצות ביומן ----------
// כל תור פעיל "תופס" משבצות של 15 דק׳ במסמכי blocks/{date_HHMM}. מסמך שכבר קיים = שעה תפוסה.
function blockTimes(time, duration) {
  const out = [];
  for (let t = Math.floor(toMin(time) / UNIT) * UNIT; t < toMin(time) + duration; t += UNIT) out.push(fromMin(t));
  return out;
}
const blockId = (date, time) => `${date}_${time.replace(':', '')}`;

// ---------- הגדרות ----------
let cfgCache = null;
async function getConfig(fresh) {
  if (cfgCache && !fresh) return cfgCache;
  const snap = await getDoc(doc(db, 'config', 'public'));
  cfgCache = { ...DEFAULTS, ...(snap.exists() ? snap.data() : {}) };
  return cfgCache;
}

function availableSlots(date, duration, cfg, busyTimes, { ignoreNotice } = {}) {
  if (!isDate(date) || !(duration > 0)) return [];
  const now = nowIL();
  const day = dayNum(date);
  if (!ignoreNotice && (day < dayNum(now.date) || day > dayNum(now.date) + cfg.horizonDays)) return [];
  const busy = [...busyTimes].map(t => [toMin(t), toMin(t) + UNIT]);
  for (const c of cfg.closures || []) {
    if (c.date === date) busy.push(c.from && c.to ? [toMin(c.from), toMin(c.to)] : [0, 1440]);
  }
  const minAbs = now.abs + (ignoreNotice ? -1e9 : cfg.minNoticeHours * 60);
  const out = [];
  for (const r of cfg.hours[weekday(date)] || []) {
    for (let t = toMin(r.from); t + duration <= toMin(r.to); t += cfg.slotStep) {
      if (day * 1440 + t < minAbs) continue;
      if (!busy.some(([a, b]) => t < b && t + duration > a)) out.push(fromMin(t));
    }
  }
  return out;
}

async function busyByDate(from, to, excludeAppt) {
  const snap = await getDocs(query(collection(db, 'blocks'), where('date', '>=', from), where('date', '<=', to)));
  const map = {};
  snap.forEach(d => { const b = d.data(); if (b.appt !== excludeAppt) (map[b.date] ||= new Set()).add(b.time); });
  return map;
}

// ---------- בדיקת הצהרת בריאות ----------
function validateHealth(h) {
  if (!h || typeof h !== 'object') fail(400, 'חסרה הצהרת בריאות');
  if (!Array.isArray(h.answers) || h.answers.length !== QUESTION_COUNT || h.answers.some(a => a !== 'כן' && a !== 'לא'))
    fail(400, 'יש לענות על כל שאלות הצהרת הבריאות');
  if (h.declare !== true || h.consent !== true) fail(400, 'יש לאשר את הצהרת הבריאות ואת טופס ההסכמה');
  const idNumber = String(h.idNumber || '').replace(/\D/g, '');
  if (!/^\d{5,9}$/.test(idNumber)) fail(400, 'מספר תעודת הזהות לא תקין');
  if (typeof h.signature !== 'string' || !/^data:image\/png;base64,/.test(h.signature) || h.signature.length > 400000) fail(400, 'חסרה חתימה');
  const details = {};
  for (const [k, v] of Object.entries(h.details || {})) if (h.answers[k] === 'כן') details[k] = str(v, 300);
  return { answers: h.answers, details, idNumber, signature: h.signature };
}
// כותב הצהרת בריאות בתוך טרנזקציה / batch
async function writeHealth(w, name, phone, health) {
  const formRef = doc(collection(db, 'healthForms'));
  w.set(formRef, {
    name, phone, idNumber: health.idNumber, answers: health.answers, details: health.details,
    declare: true, consent: true, signedAt: serverTimestamp()
  });
  w.set(doc(db, 'healthSignatures', formRef.id), { image: health.signature, signedAt: serverTimestamp() });
  w.set(doc(db, 'healthStatus', await phoneHash(phone)), { form: formRef.id, signedAt: serverTimestamp() });
  return formRef.id;
}

// ---------- מנהלת ----------
const isAdmin = async () => !!(await authReady, auth.currentUser);
async function requireAdmin() { if (!(await isAdmin())) fail(401, 'נדרשת התחברות'); }

async function apptsBetween(from, to) {
  const snap = await getDocs(query(collection(db, 'appointments'), where('date', '>=', from), where('date', '<=', to)));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function allAppts() {
  const snap = await getDocs(collection(db, 'appointments'));
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
async function latestHealthByPhone() {
  const snap = await getDocs(collection(db, 'healthForms'));
  const map = {};
  snap.forEach(d => {
    const f = { id: d.id, ...d.data(), signedAt: tsIso(d.data().signedAt) };
    if (!map[f.phone] || f.signedAt > map[f.phone].signedAt) map[f.phone] = f;
  });
  return map;
}
// התאמת הפורמט לזה שדף הניהול מצפה לו
function shapeAppt(a, health) {
  const signed = health?.[a.phone]?.signedAt || null;
  return {
    id: a.id, client_id: a.phone, client_name: a.name, client_phone: a.phone, service_id: a.serviceId,
    service_name: a.serviceName, date: a.date, time: a.time, duration: a.duration, status: a.status,
    client_note: a.clientNote || '', admin_note: a.adminNote || '', source: a.source,
    created_at: tsIso(a.createdAt), health_signed_at: signed, health_ok: healthValid(signed)
  };
}

// בונה מחדש את המשבצות של יום מסוים לפי התורים הפעילים בו
async function rebuildBlocks(date) {
  const appts = (await apptsBetween(date, date)).filter(a => ACTIVE.includes(a.status))
    .sort((a, b) => tsIso(a.createdAt) < tsIso(b.createdAt) ? -1 : 1);
  const want = {};
  for (const a of appts) for (const t of blockTimes(a.time, a.duration)) want[blockId(date, t)] ||= { date, time: t, appt: a.id };
  const have = await getDocs(query(collection(db, 'blocks'), where('date', '==', date)));
  const batch = writeBatch(db);
  have.forEach(d => { if (!want[d.id]) batch.delete(d.ref); else if (d.data().appt === want[d.id].appt) delete want[d.id]; });
  for (const [id, data] of Object.entries(want)) batch.set(doc(db, 'blocks', id), data);
  await batch.commit();
}

function checkConflict(appts, date, time, duration, excludeId) {
  const s = toMin(time);
  const clash = appts.find(a => a.id !== excludeId && a.date === date && ACTIVE.includes(a.status) &&
    s < toMin(a.time) + a.duration && s + duration > toMin(a.time));
  if (clash) fail(409, `חפיפה עם התור של ${clash.name} ב-${clash.time}`);
}

async function waitlistMatches(date) {
  const cfg = await getConfig();
  const snap = await getDocs(query(collection(db, 'waitlist'), where('status', '==', 'waiting')));
  return snap.docs.map(d => shapeWait({ id: d.id, ...d.data() }, cfg))
    .filter(w => (!w.date_from || w.date_from <= date) && (!w.date_to || w.date_to >= date))
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
}
function shapeWait(w, cfg) {
  return {
    id: w.id, name: w.name, phone: w.phone, service_id: w.serviceId || null,
    service_name: cfg.services.find(s => s.id === w.serviceId)?.name || null,
    date_from: w.dateFrom || null, date_to: w.dateTo || null, time_pref: w.timePref, note: w.note || '',
    status: w.status, created_at: tsIso(w.createdAt)
  };
}

// ---------- נתיבים ----------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/public/config', async () => {
  const cfg = await getConfig(true);
  return {
    services: cfg.services.filter(s => s.active).sort((a, b) => a.sort - b.sort).map(({ id, name, duration }) => ({ id, name, duration })),
    hours: cfg.hours, horizonDays: cfg.horizonDays, minNoticeHours: cfg.minNoticeHours, today: nowIL().date
  };
});

route('GET', '/api/public/availability', async (q) => {
  const cfg = await getConfig();
  const svc = cfg.services.find(s => s.id === q.get('service') && s.active);
  if (!svc) fail(400, 'טיפול לא קיים');
  const from = isDate(q.get('from')) ? q.get('from') : nowIL().date;
  const days = Math.min(Number(q.get('days')) || 42, 62);
  const busy = await busyByDate(from, addDays(from, days - 1));
  const out = {};
  for (let i = 0; i < days; i++) { const d = addDays(from, i); out[d] = availableSlots(d, svc.duration, cfg, busy[d] || []).length; }
  return { days: out };
});

route('GET', '/api/public/slots', async (q) => {
  const cfg = await getConfig();
  const svc = cfg.services.find(s => s.id === q.get('service') && s.active);
  if (!svc) fail(400, 'טיפול לא קיים');
  const date = q.get('date');
  if (!isDate(date)) return { slots: [] };
  const busy = await busyByDate(date, date);
  return { slots: availableSlots(date, svc.duration, cfg, busy[date] || []) };
});

route('POST', '/api/public/check', async (q, body) => {
  const snap = await getDoc(doc(db, 'healthStatus', await phoneHash(normPhone(body.phone))));
  return { needsHealth: !(snap.exists() && healthValid(tsIso(snap.data().signedAt))) };
});

route('POST', '/api/public/book', async (q, body) => {
  const name = str(body.name, 80);
  if (name.length < 2) fail(400, 'נא למלא שם מלא');
  const phone = normPhone(body.phone);
  const cfg = await getConfig(true);
  const svc = cfg.services.find(s => s.id === body.serviceId && s.active);
  if (!svc) fail(400, 'נא לבחור סוג קעקוע');
  if (!isDate(body.date) || !isTime(body.time)) fail(400, 'נא לבחור תאריך ושעה');
  const busy = await busyByDate(body.date, body.date);
  if (!availableSlots(body.date, svc.duration, cfg, busy[body.date] || []).includes(body.time)) fail(409, 'התור הזה כבר נתפס, נא לבחור שעה אחרת');
  let health = null;
  if (body.health) health = validateHealth(body.health);
  else {
    const st = await getDoc(doc(db, 'healthStatus', await phoneHash(phone)));
    if (!(st.exists() && healthValid(tsIso(st.data().signedAt)))) fail(400, 'חסרה הצהרת בריאות');
  }
  const apptRef = doc(collection(db, 'appointments'));
  const times = blockTimes(body.time, svc.duration);
  const status = cfg.autoConfirm ? 'confirmed' : 'pending';
  try {
    await runTransaction(db, async tx => {
      // אם אחת המשבצות כבר קיימת – מישהי אחרת תפסה את השעה
      for (const t of times) if ((await tx.get(doc(db, 'blocks', blockId(body.date, t)))).exists()) fail(409, 'התור הזה כבר נתפס, נא לבחור שעה אחרת');
      const healthFormId = health ? await writeHealth(tx, name, phone, health) : null;
      tx.set(apptRef, {
        name, phone, serviceId: svc.id, serviceName: svc.name, date: body.date, time: body.time, duration: svc.duration,
        status, clientNote: str(body.note, 500), source: 'online', firstBlock: blockId(body.date, times[0]),
        healthFormId, createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
      for (const t of times) tx.set(doc(db, 'blocks', blockId(body.date, t)), { date: body.date, time: t, appt: apptRef.id });
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e.code === 'permission-denied') fail(409, 'התור הזה כבר נתפס, נא לבחור שעה אחרת');
    throw e;
  }
  return { id: apptRef.id, status };
});

route('POST', '/api/public/health', async (q, body) => {
  const name = str(body.name, 80);
  if (name.length < 2) fail(400, 'נא למלא שם מלא');
  const phone = normPhone(body.phone);
  const health = validateHealth(body.health);
  const batch = writeBatch(db);
  await writeHealth(batch, name, phone, health);
  await batch.commit();
  return { ok: true };
});

route('POST', '/api/public/waitlist', async (q, body) => {
  const name = str(body.name, 80);
  if (name.length < 2) fail(400, 'נא למלא שם מלא');
  const phone = normPhone(body.phone);
  const from = isDate(body.dateFrom) ? body.dateFrom : null;
  const to = isDate(body.dateTo) ? body.dateTo : null;
  if (from && to && to < from) fail(400, 'טווח התאריכים לא תקין');
  await addDoc(collection(db, 'waitlist'), {
    name, phone, serviceId: typeof body.serviceId === 'string' && body.serviceId ? body.serviceId : null,
    dateFrom: from, dateTo: to, timePref: ['any', 'morning', 'noon', 'evening'].includes(body.timePref) ? body.timePref : 'any',
    note: str(body.note, 500), status: 'waiting', createdAt: serverTimestamp()
  });
  return { ok: true };
});

// --- ניהול ---
route('POST', '/api/admin/login', async (q, body) => {
  const user = str(body.username, 80).toLowerCase();
  const email = user.includes('@') ? user : `${user}@${ADMIN_EMAIL_DOMAIN}`;
  try { await signInWithEmailAndPassword(auth, email, String(body.password || '')); }
  catch (e) {
    if (e.code === 'auth/too-many-requests') fail(429, 'יותר מדי ניסיונות, נסי שוב בעוד כמה דקות');
    fail(401, 'שם משתמש או סיסמה שגויים');
  }
  // יצירת מסמך ההגדרות בפעם הראשונה
  const ref = doc(db, 'config', 'public');
  if (!(await getDoc(ref)).exists()) await setDoc(ref, DEFAULTS);
  return { ok: true };
});
route('POST', '/api/admin/logout', async () => { await signOut(auth); return { ok: true }; });
route('GET', '/api/admin/me', async () => ({ loggedIn: await isAdmin() }));

route('GET', '/api/admin/summary', async () => {
  await requireAdmin();
  const today = nowIL().date;
  const [appts, wl] = await Promise.all([allAppts(), getDocs(query(collection(db, 'waitlist'), where('status', '==', 'waiting')))]);
  const health = await latestHealthByPhone();
  const act = a => ACTIVE.includes(a.status);
  return {
    today,
    pending: appts.filter(a => a.status === 'pending' && a.date >= today).length,
    todayCount: appts.filter(a => a.date === today && act(a)).length,
    weekCount: appts.filter(a => a.date >= today && a.date <= addDays(today, 6) && act(a)).length,
    waiting: wl.size,
    clients: new Set([...appts.map(a => a.phone), ...Object.keys(health)]).size
  };
});

route('GET', '/api/admin/appointments', async (q) => {
  await requireAdmin();
  const from = isDate(q.get('from')) ? q.get('from') : '2000-01-01';
  const to = isDate(q.get('to')) ? q.get('to') : '2999-12-31';
  const status = STATUSES.includes(q.get('status')) ? q.get('status') : null;
  const [appts, health] = await Promise.all([apptsBetween(from, to), latestHealthByPhone()]);
  return {
    appointments: appts.filter(a => !status || a.status === status)
      .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map(a => shapeAppt(a, health))
  };
});

route('GET', '/api/admin/slots', async (q) => {
  await requireAdmin();
  const date = q.get('date');
  if (!isDate(date)) return { slots: [] };
  const cfg = await getConfig(true);
  const busy = await busyByDate(date, date, q.get('exclude') || null);
  return { slots: availableSlots(date, Number(q.get('duration')) || 60, cfg, busy[date] || [], { ignoreNotice: true }) };
});

route('POST', '/api/admin/appointments', async (q, body) => {
  await requireAdmin();
  const name = str(body.name, 80);
  if (name.length < 2) fail(400, 'נא למלא שם');
  const phone = normPhone(body.phone);
  const cfg = await getConfig(true);
  const svc = cfg.services.find(s => s.id === body.serviceId);
  if (!svc) fail(400, 'נא לבחור טיפול');
  if (!isDate(body.date) || !isTime(body.time)) fail(400, 'נא לבחור תאריך ושעה');
  const duration = Math.max(5, Math.min(Number(body.duration) || svc.duration, 600));
  if (!body.force) checkConflict(await apptsBetween(body.date, body.date), body.date, body.time, duration);
  const ref = await addDoc(collection(db, 'appointments'), {
    name, phone, serviceId: svc.id, serviceName: svc.name, date: body.date, time: body.time, duration,
    status: STATUSES.includes(body.status) ? body.status : 'confirmed', adminNote: str(body.adminNote, 500),
    clientNote: '', source: 'admin', createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  await rebuildBlocks(body.date);
  return { id: ref.id };
});

route('PATCH', '/api/admin/appointments/:id', async (q, body, p) => {
  await requireAdmin();
  const ref = doc(db, 'appointments', p.id);
  const snap = await getDoc(ref);
  if (!snap.exists()) fail(404, 'התור לא נמצא');
  const a = { id: snap.id, ...snap.data() };
  const next = { ...a };
  const cfg = await getConfig(true);
  if (body.status !== undefined) { if (!STATUSES.includes(body.status)) fail(400, 'סטטוס לא תקין'); next.status = body.status; }
  if (body.date !== undefined) { if (!isDate(body.date)) fail(400, 'תאריך לא תקין'); next.date = body.date; }
  if (body.time !== undefined) { if (!isTime(body.time)) fail(400, 'שעה לא תקינה'); next.time = body.time; }
  if (body.serviceId !== undefined) {
    const s = cfg.services.find(x => x.id === body.serviceId); if (!s) fail(400, 'טיפול לא קיים');
    next.serviceId = s.id; next.serviceName = s.name;
  }
  if (body.duration !== undefined) next.duration = Math.max(5, Math.min(Number(body.duration) || a.duration, 600));
  if (body.adminNote !== undefined) next.adminNote = str(body.adminNote, 500);
  const moved = next.date !== a.date || next.time !== a.time || next.duration !== a.duration;
  if (ACTIVE.includes(next.status) && (moved || !ACTIVE.includes(a.status)) && !body.force)
    checkConflict(await apptsBetween(next.date, next.date), next.date, next.time, next.duration, a.id);
  await updateDoc(ref, {
    status: next.status, date: next.date, time: next.time, duration: next.duration, serviceId: next.serviceId,
    serviceName: next.serviceName, adminNote: next.adminNote || '', updatedAt: serverTimestamp()
  });
  await rebuildBlocks(a.date);
  if (next.date !== a.date) await rebuildBlocks(next.date);
  const freed = ACTIVE.includes(a.status) && (!ACTIVE.includes(next.status) || moved);
  return {
    appointment: shapeAppt(next, await latestHealthByPhone()),
    waitlist: freed ? await waitlistMatches(a.date) : [],
    freedDate: freed ? a.date : null, freedTime: freed ? a.time : null
  };
});

route('GET', '/api/admin/clients', async (q) => {
  await requireAdmin();
  const [appts, health, notes] = await Promise.all([allAppts(), latestHealthByPhone(), getDocs(collection(db, 'clientNotes'))]);
  const nameOverride = {};
  notes.forEach(d => { if (d.data().name) nameOverride[d.id] = d.data().name; });
  const map = {};
  const touch = (phone, name, at) => {
    const c = (map[phone] ||= { id: phone, phone, name, created_at: at, visits: 0, last_date: null });
    if (at && (!c.created_at || at < c.created_at)) c.created_at = at;
    return c;
  };
  for (const a of appts) {
    const c = touch(a.phone, a.name, tsIso(a.createdAt));
    c.name = a.name; c.visits++;
    if (a.status !== 'cancelled' && (!c.last_date || a.date > c.last_date)) c.last_date = a.date;
  }
  for (const f of Object.values(health)) touch(f.phone, f.name, f.signedAt);
  const term = str(q.get('q'), 60).toLowerCase();
  return {
    clients: Object.values(map).map(c => ({
      ...c, name: nameOverride[c.phone] || c.name, health_signed_at: health[c.phone]?.signedAt || null,
      health_ok: healthValid(health[c.phone]?.signedAt)
    })).filter(c => !term || c.name.toLowerCase().includes(term) || c.phone.includes(term.replace(/\D/g, '') || term))
      .sort((a, b) => a.name.localeCompare(b.name, 'he'))
  };
});

route('GET', '/api/admin/clients/:id', async (q, body, p) => {
  await requireAdmin();
  const phone = p.id;
  const [apptSnap, health, note] = await Promise.all([
    getDocs(query(collection(db, 'appointments'), where('phone', '==', phone))),
    latestHealthByPhone(), getDoc(doc(db, 'clientNotes', phone))
  ]);
  const appts = apptSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const f = health[phone];
  if (!appts.length && !f) fail(404, 'הלקוחה לא נמצאה');
  const sig = f ? await getDoc(doc(db, 'healthSignatures', f.id)) : null;
  const created = [...appts.map(a => tsIso(a.createdAt)), f?.signedAt].filter(Boolean).sort()[0];
  return {
    client: {
      id: phone, phone, name: note.data()?.name || appts[0]?.name || f?.name, notes: note.data()?.notes || '',
      created_at: created, id_number: f?.idNumber || null,
      health: f ? { answers: f.answers, details: f.details || {} } : null,
      health_signed_at: f?.signedAt || null, health_ok: healthValid(f?.signedAt),
      signature: sig?.exists() ? sig.data().image : null
    },
    appointments: appts.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).map(a => shapeAppt(a, health)),
    questions: window.HEALTH ? window.HEALTH.questions : []
  };
});

route('PATCH', '/api/admin/clients/:id', async (q, body, p) => {
  await requireAdmin();
  const data = {};
  if (body.notes !== undefined) data.notes = str(body.notes, 2000);
  if (body.name !== undefined && str(body.name, 80)) data.name = str(body.name, 80);
  await setDoc(doc(db, 'clientNotes', p.id), data, { merge: true });
  return { ok: true };
});

route('DELETE', '/api/admin/clients/:id', async (q, body, p) => {
  await requireAdmin();
  const phone = p.id;
  const [appts, forms] = await Promise.all([
    getDocs(query(collection(db, 'appointments'), where('phone', '==', phone))),
    getDocs(query(collection(db, 'healthForms'), where('phone', '==', phone)))
  ]);
  const batch = writeBatch(db);
  const dates = new Set();
  appts.forEach(d => { dates.add(d.data().date); batch.delete(d.ref); });
  forms.forEach(d => { batch.delete(d.ref); batch.delete(doc(db, 'healthSignatures', d.id)); });
  batch.delete(doc(db, 'healthStatus', await phoneHash(phone)));
  batch.delete(doc(db, 'clientNotes', phone));
  await batch.commit();
  for (const d of dates) await rebuildBlocks(d);
  return { ok: true };
});

route('GET', '/api/admin/waitlist', async () => {
  await requireAdmin();
  const cfg = await getConfig();
  const snap = await getDocs(collection(db, 'waitlist'));
  const order = { waiting: 0, contacted: 1 };
  return {
    waitlist: snap.docs.map(d => shapeWait({ id: d.id, ...d.data() }, cfg))
      .sort((a, b) => ((order[a.status] ?? 2) - (order[b.status] ?? 2)) || (a.created_at < b.created_at ? -1 : 1))
  };
});
route('PATCH', '/api/admin/waitlist/:id', async (q, body, p) => {
  await requireAdmin();
  if (!['waiting', 'contacted', 'booked', 'removed'].includes(body.status)) fail(400, 'סטטוס לא תקין');
  await updateDoc(doc(db, 'waitlist', p.id), { status: body.status });
  return { ok: true };
});
route('DELETE', '/api/admin/waitlist/:id', async (q, body, p) => {
  await requireAdmin();
  await deleteDoc(doc(db, 'waitlist', p.id));
  return { ok: true };
});

route('GET', '/api/admin/settings', async () => {
  await requireAdmin();
  const cfg = await getConfig(true);
  const { services, ...settings } = cfg;
  return { settings, services: [...services].sort((a, b) => a.sort - b.sort) };
});

route('PUT', '/api/admin/settings', async (q, body) => {
  await requireAdmin();
  const s = body.settings || {};
  const cur = await getConfig(true);
  const num = (v, lo, hi, def) => { const n = Math.round(Number(v)); return n >= lo && n <= hi ? n : def; };
  const hours = {};
  for (let d = 0; d < 7; d++) {
    hours[d] = (Array.isArray(s.hours?.[d]) ? s.hours[d] : [])
      .filter(r => isTime(r.from) && isTime(r.to) && toMin(r.to) > toMin(r.from))
      .map(r => ({ from: r.from, to: r.to })).sort((a, b) => toMin(a.from) - toMin(b.from)).slice(0, 4);
  }
  let services = cur.services;
  if (Array.isArray(body.services)) {
    services = body.services.slice(0, 50).map((sv, i) => ({
      id: typeof sv.id === 'string' && sv.id ? sv.id : 's' + Date.now().toString(36) + i,
      name: str(sv.name, 80), duration: num(sv.duration, 5, 600, 60), active: sv.active !== false, sort: i
    })).filter(sv => sv.name);
  }
  const next = {
    hours, services,
    slotStep: num(s.slotStep, 5, 240, cur.slotStep),
    minNoticeHours: num(s.minNoticeHours, 0, 336, cur.minNoticeHours),
    horizonDays: num(s.horizonDays, 1, 365, cur.horizonDays),
    autoConfirm: s.autoConfirm === true,
    closures: (Array.isArray(s.closures) ? s.closures : [])
      .filter(c => isDate(c.date) && (!c.from || (isTime(c.from) && isTime(c.to) && c.to > c.from)))
      .map(c => ({ date: c.date, from: c.from || null, to: c.from ? c.to : null, reason: str(c.reason, 120) })).slice(0, 300)
  };
  await setDoc(doc(db, 'config', 'public'), next);
  cfgCache = null;
  return { ok: true };
});

route('POST', '/api/admin/password', async (q, body) => {
  await requireAdmin();
  if (typeof body.next !== 'string' || body.next.length < 8) fail(400, 'הסיסמה החדשה חייבת להכיל לפחות 8 תווים');
  try { await reauthenticateWithCredential(auth.currentUser, EmailAuthProvider.credential(auth.currentUser.email, String(body.current || ''))); }
  catch { fail(400, 'הסיסמה הנוכחית שגויה'); }
  await updatePassword(auth.currentUser, body.next);
  return { ok: true };
});

// ---------- נקודת הכניסה ----------
async function request(method, path, body) {
  const url = new URL(path, location.href);
  const r = routes.find(x => x.method === method && x.re.test(url.pathname));
  try {
    if (!r) fail(404, 'לא נמצא');
    if (firebaseConfig.apiKey === 'REPLACE_ME' && !useEmulator) fail(503, 'מערכת התורים עדיין לא חוברה ל-Firebase');
    return await r.fn(url.searchParams, body || {}, url.pathname.match(r.re).groups || {});
  } catch (e) {
    if (e instanceof HttpError) throw e;
    console.error(e);
    if (e.code === 'permission-denied') throw new HttpError(403, 'אין הרשאה לפעולה הזו');
    if (e.code === 'unavailable') throw new HttpError(0, 'אין חיבור לאינטרנט. בדקי את החיבור ונסי שוב.');
    throw new HttpError(500, 'משהו השתבש, נסי שוב');
  }
}

window.__backendReady({ request, Timestamp });
