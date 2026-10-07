'use strict';
// בדיקות לכללי האבטחה (firestore.rules) מול האמולטור של Firebase: npm test
const { test, before, after, beforeEach } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, setDoc, collection, writeBatch, serverTimestamp, query, where } = require('firebase/firestore');

let env;
const ADMIN = 'rivka@rivka-cohen.studio';

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rivka',
    firestore: { rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'), host: '127.0.0.1', port: 8080 }
  });
});
after(() => env.cleanup());
beforeEach(() => env.clearFirestore());

const anon = () => env.unauthenticatedContext().firestore();
const admin = () => env.authenticatedContext('rivka', { email: ADMIN }).firestore();
const stranger = () => env.authenticatedContext('evil', { email: 'evil@example.com' }).firestore();

function booking(db, { apptId = 'a1', date = '2030-01-10', time = '11:00', status = 'pending', blocks = ['1100', '1115'], health = null } = {}) {
  const b = writeBatch(db);
  for (const t of blocks) b.set(doc(db, 'blocks', `${date}_${t}`), { date, time: `${t.slice(0, 2)}:${t.slice(2)}`, appt: apptId });
  b.set(doc(db, 'appointments', apptId), {
    name: 'דנה', phone: '0501234567', serviceId: 's3', serviceName: 'כיתוב', date, time, duration: 30, status,
    clientNote: '', source: 'online', firstBlock: `${date}_${blocks[0]}`, healthFormId: health,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  });
  return b;
}
const healthData = (over = {}) => ({
  name: 'דנה', phone: '0501234567', idNumber: '123456789', answers: Array(24).fill('לא'), details: {},
  declare: true, consent: true, signedAt: serverTimestamp(), ...over
});

test('client can book; the same slot cannot be booked twice', async () => {
  await assertSucceeds(booking(anon()).commit());
  await assertFails(booking(anon(), { apptId: 'a2' }).commit());
  await assertFails(booking(anon(), { apptId: 'a3', time: '11:15', blocks: ['1115'] }).commit());
});

test('client cannot fake a confirmed booking or skip blocking the calendar', async () => {
  await assertFails(booking(anon(), { status: 'confirmed' }).commit());
  const db = anon();
  await assertFails(setDoc(doc(db, 'appointments', 'x'), {
    name: 'דנה', phone: '0501234567', serviceId: 's3', serviceName: 'כיתוב', date: '2030-01-10', time: '11:00', duration: 30,
    status: 'pending', clientNote: '', source: 'online', firstBlock: '2030-01-10_1100', healthFormId: null,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp()
  }));
  await assertFails(setDoc(doc(db, 'blocks', '2030-01-10_1200'), { date: '2030-01-10', time: '12:00', appt: 'nope' }));
});

test('autoConfirm setting makes online bookings confirmed', async () => {
  await env.withSecurityRulesDisabled(c => setDoc(doc(c.firestore(), 'config', 'public'), { autoConfirm: true }));
  await assertFails(booking(anon()).commit());
  await assertSucceeds(booking(anon(), { status: 'confirmed' }).commit());
});

test('personal data is private: only Rivka can read it', async () => {
  await assertSucceeds(booking(anon()).commit());
  for (const db of [anon(), stranger()]) {
    await assertFails(getDoc(doc(db, 'appointments', 'a1')));
    await assertFails(getDocs(collection(db, 'appointments')));
    await assertFails(getDocs(collection(db, 'healthForms')));
    await assertFails(getDocs(collection(db, 'waitlist')));
    await assertFails(getDocs(collection(db, 'healthStatus')));
  }
  await assertSucceeds(getDoc(doc(admin(), 'appointments', 'a1')));
  // שעות תפוסות – גלויות לכולן, בלי פרטים
  await assertSucceeds(getDocs(query(collection(anon(), 'blocks'), where('date', '==', '2030-01-10'))));
});

test('clients cannot change or cancel appointments; Rivka can', async () => {
  await assertSucceeds(booking(anon()).commit());
  await assertFails(setDoc(doc(anon(), 'appointments', 'a1'), { status: 'cancelled' }, { merge: true }));
  await assertFails(setDoc(doc(stranger(), 'appointments', 'a1'), { status: 'cancelled' }, { merge: true }));
  await assertSucceeds(setDoc(doc(admin(), 'appointments', 'a1'), { status: 'confirmed' }, { merge: true }));
});

test('health declaration: client can submit, nobody but Rivka can read', async () => {
  const db = anon();
  const b = writeBatch(db);
  b.set(doc(db, 'healthForms', 'f1'), healthData());
  b.set(doc(db, 'healthSignatures', 'f1'), { image: 'data:image/png;base64,iVBORw0KGgo=', signedAt: serverTimestamp() });
  b.set(doc(db, 'healthStatus', 'hash1'), { form: 'f1', signedAt: serverTimestamp() });
  await assertSucceeds(b.commit());
  await assertFails(getDoc(doc(anon(), 'healthForms', 'f1')));
  await assertFails(getDoc(doc(anon(), 'healthSignatures', 'f1')));
  await assertSucceeds(getDoc(doc(anon(), 'healthStatus', 'hash1')));
  await assertSucceeds(getDoc(doc(admin(), 'healthForms', 'f1')));
  // הצהרה חלקית / בלי אישור – נדחית
  await assertFails(setDoc(doc(anon(), 'healthForms', 'f2'), healthData({ answers: ['לא'] })));
  await assertFails(setDoc(doc(anon(), 'healthForms', 'f3'), healthData({ consent: false })));
  // אי אפשר לסמן "יש הצהרה" בלי הצהרה אמיתית
  await assertFails(setDoc(doc(anon(), 'healthStatus', 'hash2'), { form: 'missing', signedAt: serverTimestamp() }));
});

test('settings: public read, only Rivka writes', async () => {
  await assertFails(setDoc(doc(anon(), 'config', 'public'), { slotStep: 5 }));
  await assertFails(setDoc(doc(stranger(), 'config', 'public'), { slotStep: 5 }));
  await assertSucceeds(setDoc(doc(admin(), 'config', 'public'), { slotStep: 30 }));
  await assertSucceeds(getDoc(doc(anon(), 'config', 'public')));
});

test('waitlist signup is validated', async () => {
  const w = { name: 'נועה', phone: '0541111111', serviceId: null, dateFrom: null, dateTo: null, timePref: 'any', note: '', status: 'waiting', createdAt: serverTimestamp() };
  await assertSucceeds(setDoc(doc(anon(), 'waitlist', 'w1'), w));
  await assertFails(setDoc(doc(anon(), 'waitlist', 'w2'), { ...w, phone: 'abc' }));
  await assertFails(setDoc(doc(anon(), 'waitlist', 'w3'), { ...w, status: 'booked' }));
});
