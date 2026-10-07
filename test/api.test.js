'use strict';
// בדיקות לשרת מערכת התורים: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rivka-test-'));
process.env.ADMIN_PASSWORD = 'secret-pass-1';
const { server } = require('../server.js');
const HEALTH = require('../js/health-data.js');

let base, cookie = '';
const call = async (method, url, body, opts = {}) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': opts.type || 'application/json' } : {}), ...(opts.auth ? { Cookie: cookie } : {}) },
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });
  return { status: res.status, headers: res.headers, data: await res.json().catch(() => null) };
};
const health = () => ({
  answers: HEALTH.questions.map(() => 'לא'), idNumber: '123456789', declare: true, consent: true,
  signature: 'data:image/png;base64,iVBORw0KGgo='
});

before(() => new Promise(r => server.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); })));
after(() => { server.close(); fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }); });

let svc, date, slots;
test('config + availability', async () => {
  const cfg = await call('GET', '/api/public/config');
  assert.equal(cfg.status, 200);
  svc = cfg.data.services.find(s => s.duration === 60);
  const av = await call('GET', `/api/public/availability?service=${svc.id}&days=30`);
  date = Object.keys(av.data.days).find(d => av.data.days[d] > 2);
  assert.ok(date, 'expected an open day');
  slots = (await call('GET', `/api/public/slots?service=${svc.id}&date=${date}`)).data.slots;
  assert.ok(slots.length > 2);
});

test('new client must sign health declaration', async () => {
  const r = await call('POST', '/api/public/book', { name: 'דנה', phone: '050-1234567', serviceId: svc.id, date, time: slots[0] });
  assert.equal(r.status, 400);
  const bad = await call('POST', '/api/public/book', { name: 'דנה', phone: '050-1234567', serviceId: svc.id, date, time: slots[0], health: { ...health(), answers: ['לא'] } });
  assert.equal(bad.status, 400);
});

let apptId;
test('booking with health declaration → pending, slot is taken', async () => {
  const r = await call('POST', '/api/public/book', { name: 'דנה כהן', phone: '050-1234567', serviceId: svc.id, date, time: slots[0], health: health(), note: 'פרפר' });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'pending');
  apptId = r.data.id;
  const dup = await call('POST', '/api/public/book', { name: 'מישהי', phone: '052-7654321', serviceId: svc.id, date, time: slots[0], health: health() });
  assert.equal(dup.status, 409);
  const after = (await call('GET', `/api/public/slots?service=${svc.id}&date=${date}`)).data.slots;
  assert.ok(!after.includes(slots[0]));
});

test('returning client does not need health form again', async () => {
  const c = await call('POST', '/api/public/check', { phone: '+972 50 123 4567' });
  assert.equal(c.data.needsHealth, false);
  const n = await call('POST', '/api/public/check', { phone: '0529999999' });
  assert.equal(n.data.needsHealth, true);
  const free = (await call('GET', `/api/public/slots?service=${svc.id}&date=${date}`)).data.slots;
  const r = await call('POST', '/api/public/book', { name: 'דנה כהן', phone: '0501234567', serviceId: svc.id, date, time: free[free.length - 1] });
  assert.equal(r.status, 200);
});

test('waitlist signup', async () => {
  const r = await call('POST', '/api/public/waitlist', { name: 'נועה', phone: '0541111111', dateFrom: date, timePref: 'morning' });
  assert.equal(r.status, 200);
});

test('admin requires login; JSON-only writes', async () => {
  assert.equal((await call('GET', '/api/admin/appointments')).status, 401);
  assert.equal((await call('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
  assert.equal((await call('POST', '/api/admin/login', 'password=secret-pass-1', { type: 'application/x-www-form-urlencoded' })).status, 415);
  const ok = await call('POST', '/api/admin/login', { password: 'secret-pass-1' });
  assert.equal(ok.status, 200);
  const sc = ok.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];
});

test('admin sees appointment with health, approves, moves, detects conflicts', async () => {
  const list = await call('GET', `/api/admin/appointments?from=${date}&to=${date}`, null, { auth: true });
  const a = list.data.appointments.find(x => x.id === apptId);
  assert.equal(a.client_name, 'דנה כהן'); assert.equal(a.health_ok, true); assert.equal(a.status, 'pending');

  const conf = await call('PATCH', `/api/admin/appointments/${apptId}`, { status: 'confirmed' }, { auth: true });
  assert.equal(conf.data.appointment.status, 'confirmed');

  const other = list.data.appointments.find(x => x.id !== apptId);
  const clash = await call('PATCH', `/api/admin/appointments/${apptId}`, { time: other.time }, { auth: true });
  assert.equal(clash.status, 409);

  const moved = await call('PATCH', `/api/admin/appointments/${apptId}`, { time: slots[1] }, { auth: true });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.appointment.time, slots[1]);
  assert.equal(moved.data.freedDate, date);
});

test('cancel frees the slot and suggests waitlist matches', async () => {
  const r = await call('PATCH', `/api/admin/appointments/${apptId}`, { status: 'cancelled' }, { auth: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.waitlist.length, 1);
  assert.equal(r.data.waitlist[0].name, 'נועה');
  const free = (await call('GET', `/api/public/slots?service=${svc.id}&date=${date}`)).data.slots;
  assert.ok(free.includes(slots[1]));
});

test('client card includes health declaration', async () => {
  const cl = await call('GET', '/api/admin/clients?q=דנה', null, { auth: true });
  const c = await call('GET', `/api/admin/clients/${cl.data.clients[0].id}`, null, { auth: true });
  assert.equal(c.data.client.id_number, '123456789');
  assert.equal(c.data.client.health.answers.length, HEALTH.questions.length);
  assert.equal(c.data.client.phone, '0501234567');
});

test('opening hours and closures control availability', async () => {
  const cur = (await call('GET', '/api/admin/settings', null, { auth: true })).data.settings;
  const closed = await call('PUT', '/api/admin/settings', { settings: { ...cur, closures: [{ date }] } }, { auth: true });
  assert.equal(closed.status, 200);
  assert.deepEqual((await call('GET', `/api/public/slots?service=${svc.id}&date=${date}`)).data.slots, []);
  const wd = new Date(date + 'T00:00:00Z').getUTCDay();
  const hours = { ...cur.hours, [wd]: [{ from: '12:00', to: '14:00' }] };
  await call('PUT', '/api/admin/settings', { settings: { ...cur, hours, slotStep: 60, closures: [] } }, { auth: true });
  const s = (await call('GET', `/api/public/slots?service=${svc.id}&date=${date}`)).data.slots;
  assert.ok(s.every(t => t >= '12:00' && t <= '13:00'), JSON.stringify(s));
});

test('static files: private files are not served', async () => {
  for (const p of ['/server.js', '/data/studio.db', '/package.json', '/test/api.test.js', '/.gitignore', '/%2e%2e/etc/passwd'])
    assert.equal((await fetch(base + p)).status, 404, p);
  assert.equal((await fetch(base + '/admin')).status, 200);
  assert.equal((await fetch(base + '/js/book.js')).status, 200);
});

test('password change', async () => {
  assert.equal((await call('POST', '/api/admin/password', { current: 'x', next: 'abcdefgh1' }, { auth: true })).status, 400);
  assert.equal((await call('POST', '/api/admin/password', { current: 'secret-pass-1', next: 'abcdefgh1' }, { auth: true })).status, 200);
  assert.equal((await call('POST', '/api/admin/login', { password: 'abcdefgh1' })).status, 200);
});
