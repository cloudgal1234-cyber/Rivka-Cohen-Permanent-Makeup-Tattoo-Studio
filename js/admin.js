// דף הניהול של רבקה
(() => {
  const { h, api, toast, DAYS, fmtDate, iso, addDays, minutes, endTime, waLink, modal } = UI;
  const root = document.getElementById('root');
  const SITE = location.origin;
  const STATUS = { pending: 'ממתין לאישור', confirmed: 'מאושר', cancelled: 'בוטל', completed: 'הגיעה', no_show: 'לא הגיעה' };
  const TIME_PREF = { any: 'כל שעה', morning: 'בוקר', noon: 'צהריים', evening: 'ערב' };
  const WL_STATUS = { waiting: 'ממתינה', contacted: 'פניתי אליה', booked: 'נקבע תור', removed: 'הוסרה' };
  const today = () => iso(new Date());

  const st = { tab: 'calendar', from: today(), showCancelled: false, services: [], summary: null };

  // ---------- התחברות ----------
  async function boot() {
    try {
      const me = await api('/api/admin/me');
      me.loggedIn ? shell() : login();
    } catch (e) { root.replaceChildren(h('div', { class: 'container' }, h('div', { class: 'alert' }, e.message))); }
  }

  function login() {
    const pw = h('input', { type: 'password', class: 'inp', autocomplete: 'current-password', placeholder: 'סיסמה', required: true });
    const err = h('div', { class: 'alert hidden', role: 'alert' });
    root.replaceChildren(h('div', { class: 'container' }, h('form', {
      class: 'panel login-box',
      onsubmit: async e => {
        e.preventDefault();
        try { await api('/api/admin/login', { method: 'POST', body: { password: pw.value } }); shell(); }
        catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); pw.select(); }
      }
    },
      h('img', { src: 'assets/logo.png', alt: 'רבקה כהן' }),
      h('h1', { style: 'font-size:1.6rem;margin-bottom:1.2rem' }, 'כניסה לניהול'),
      pw, err,
      h('button', { type: 'submit', class: 'btn', style: 'width:100%;justify-content:center;margin-top:1rem' }, 'כניסה'))));
    pw.focus();
  }

  // ---------- מסגרת ----------
  const TABS = [['calendar', 'יומן תורים'], ['pending', 'ממתינים לאישור'], ['clients', 'לקוחות'], ['waitlist', 'רשימת המתנה'], ['settings', 'הגדרות']];
  let view;
  async function shell() {
    view = h('div', { id: 'view' });
    root.replaceChildren(
      h('div', { class: 'admin-bar' }, h('div', { class: 'container inner' },
        h('img', { src: 'assets/logo.png', alt: '' }), h('strong', {}, 'ניהול הסטודיו'), h('span', { class: 'spacer' }),
        h('a', { href: '/', class: 'act', target: '_blank' }, 'לאתר'),
        h('button', { class: 'act', onclick: async () => { await api('/api/admin/logout', { method: 'POST', body: {} }); login(); } }, 'יציאה')),
        h('div', { class: 'container' }, h('nav', { class: 'tabs', id: 'tabs' }))),
      h('main', { class: 'admin-main' }, h('div', { class: 'container' }, view)));
    const cfg = await api('/api/admin/settings');
    st.services = cfg.services;
    go(st.tab);
  }

  async function refreshTabs() {
    st.summary = await api('/api/admin/summary');
    const tabs = document.getElementById('tabs');
    tabs.replaceChildren(...TABS.map(([id, label]) => h('button', {
      class: st.tab === id ? 'active' : '', onclick: () => go(id)
    }, label,
      id === 'pending' && st.summary.pending ? h('span', { class: 'badge' }, String(st.summary.pending)) : null,
      id === 'waitlist' && st.summary.waiting ? h('span', { class: 'badge' }, String(st.summary.waiting)) : null)));
  }

  async function go(tab) {
    st.tab = tab;
    view.replaceChildren(h('p', { class: 'muted' }, 'טוען…'));
    try {
      await refreshTabs();
      await ({ calendar: viewCalendar, pending: viewPending, clients: viewClients, waitlist: viewWaitlist, settings: viewSettings })[tab]();
    } catch (e) {
      if (e.status === 401) return login();
      view.replaceChildren(h('div', { class: 'alert' }, e.message));
    }
  }
  const reload = () => go(st.tab);

  // ---------- כרטיס תור ----------
  function apptCard(a, { showDate } = {}) {
    const acts = [];
    const act = (label, fn, cls = '') => acts.push(h('button', { class: 'act ' + cls, onclick: fn }, label));
    const active = a.status === 'pending' || a.status === 'confirmed';
    if (a.status === 'pending') act('✓ אישור', () => setStatus(a, 'confirmed'), 'primary');
    if (a.status === 'confirmed') { act('הגיעה ✓', () => setStatus(a, 'completed')); act('לא הגיעה', () => setStatus(a, 'no_show')); }
    if (active) { act('הזזה', () => moveModal(a)); act(a.status === 'pending' ? 'דחייה' : 'ביטול', () => cancelAppt(a), 'danger'); }
    if (!active) act('שחזור', () => setStatus(a, 'confirmed'));
    act('הערה', () => noteModal(a));
    act('וואטסאפ', () => window.open(waLink(a.client_phone, `היי ${a.client_name} 💕`), '_blank'), 'wa');
    act('כרטיס לקוחה', () => clientModal(a.client_id));
    return h('div', { class: 'appt ' + a.status },
      h('div', { class: 'time' }, a.time, h('small', {}, `עד ${endTime(a.time, a.duration)}`)),
      h('div', { class: 'who' },
        h('b', {}, a.client_name), ' · ', h('a', { href: 'tel:' + a.client_phone, dir: 'ltr' }, a.client_phone),
        h('div', { class: 'small muted' },
          showDate ? fmtDate(a.date) + ' · ' : '', a.service_name || 'טיפול', ` · ${minutes(a.duration)}`,
          h('span', { class: 'chip ' + a.status }, STATUS[a.status]),
          a.health_ok ? h('span', { class: 'chip ok' }, 'הצהרת בריאות ✓') : h('span', { class: 'chip warn' }, 'חסרה הצהרת בריאות'),
          a.source === 'online' ? h('span', { class: 'chip' }, 'מהאתר') : null),
        a.client_note ? h('div', { class: 'small' }, '💬 ', a.client_note) : null,
        a.admin_note ? h('div', { class: 'small muted' }, '📝 ', a.admin_note) : null),
      h('div', { class: 'acts' }, acts));
  }

  // ---------- הודעות וואטסאפ ----------
  const svcName = (a) => a.service_name || 'קעקוע';
  const MSG = {
    confirmed: a => `היי ${a.client_name}, התור שלך אצל רבקה כהן ל${svcName(a)} ב${fmtDate(a.date)} בשעה ${a.time} אושר 💕\nכתובת: ברקת 36, גבעת זאב.\nלפני הקעקוע מומלץ לא לשתות אלכוהול ולהגיע אחרי ארוחה. נתראה!`,
    moved: a => `היי ${a.client_name}, התור שלך אצל רבקה כהן הועבר ל${fmtDate(a.date)} בשעה ${a.time} 💕\nאם השעה לא מתאימה – תעדכני אותי.`,
    cancelled: a => `היי ${a.client_name}, התור שלך ב${fmtDate(a.date)} בשעה ${a.time} בוטל.\nלקביעת תור חדש: ${SITE}/book.html`,
    waitlist: (w, date, time) => `היי ${w.name}, כאן רבקה כהן 💕 התפנה תור ב${fmtDate(date)}${time ? ` בשעה ${time}` : ''}. רוצה אותו? תעני לי כאן ואשריין לך.`
  };

  function afterChange(title, a, msgKey, res) {
    const wl = res?.waitlist || [];
    const m = modal(title,
      h('p', { class: 'muted', style: 'margin-bottom:1rem' }, `לשלוח ל${a.client_name} עדכון בוואטסאפ?`),
      h('div', { class: 'row' },
        h('a', { class: 'btn btn-sm', href: waLink(a.client_phone, MSG[msgKey](a)), target: '_blank', rel: 'noopener', onclick: () => setTimeout(() => !wl.length && m.close(), 300) }, 'שליחת הודעה בוואטסאפ'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => m.close() }, 'לא עכשיו')),
      wl.length ? h('div', { style: 'margin-top:1.6rem' },
        h('h3', { style: 'margin-bottom:.4rem' }, `⏳ ${wl.length} ממתינות ברשימת ההמתנה מתאימות ל${fmtDate(res.freedDate)}`),
        h('p', { class: 'small muted', style: 'margin-bottom:.8rem' }, `התפנה מקום בשעה ${res.freedTime}. אפשר להציע אותו:`),
        wl.map(w => waitRow(w, { date: res.freedDate, time: res.freedTime }))) : null);
  }

  async function patch(a, body, quiet) {
    try {
      return await api(`/api/admin/appointments/${a.id}`, { method: 'PATCH', body });
    } catch (e) {
      if (e.status === 409 && !body.force && confirm(`${e.message}\nלשמור בכל זאת?`)) return patch(a, { ...body, force: true }, quiet);
      if (e.status !== 409) toast(e.message, true);
      return null;
    }
  }
  async function setStatus(a, status) {
    const res = await patch(a, { status });
    if (!res) return;
    toast(`הסטטוס עודכן: ${STATUS[status]}`);
    await reload();
    if (status === 'confirmed') afterChange('התור אושר ✓', res.appointment, 'confirmed', res);
    else if (res.waitlist?.length) afterChange('הסטטוס עודכן', res.appointment, 'cancelled', res);
  }
  async function cancelAppt(a) {
    if (!confirm(`לבטל את התור של ${a.client_name} ב${fmtDate(a.date)} בשעה ${a.time}?`)) return;
    const res = await patch(a, { status: 'cancelled' });
    if (!res) return;
    await reload();
    afterChange('התור בוטל', res.appointment, 'cancelled', res);
  }

  function noteModal(a) {
    const ta = h('textarea', { class: 'inp', rows: 4 }); ta.value = a.admin_note || '';
    const m = modal(`הערה פנימית – ${a.client_name}`, h('p', { class: 'small muted', style: 'margin-bottom:.6rem' }, 'רק את רואה את ההערה.'), ta,
      h('div', { class: 'step-nav' }, h('span'), h('button', { class: 'btn btn-sm', onclick: async () => {
        if (await patch(a, { adminNote: ta.value })) { m.close(); toast('ההערה נשמרה'); reload(); }
      } }, 'שמירה')));
  }

  // בורר שעה: שעות פנויות + שעה ידנית
  function timePicker({ date, duration, exclude, value }) {
    const custom = h('input', { type: 'time', class: 'inp', style: 'max-width:140px', value: value || '', step: 300 });
    const box = h('div', { class: 'slot-pick' });
    const wrap = h('div', {}, h('div', { class: 'small muted' }, 'שעות פנויות לפי שעות הפתיחה:'), box,
      h('label', { class: 'field', style: 'max-width:220px' }, 'או שעה אחרת', custom));
    async function load(d, dur) {
      box.replaceChildren(h('span', { class: 'small muted' }, 'טוען…'));
      if (!d) return box.replaceChildren(h('span', { class: 'small muted' }, 'בחרי תאריך'));
      const { slots } = await api(`/api/admin/slots?date=${d}&duration=${dur}&exclude=${exclude || 0}`);
      box.replaceChildren(...(slots.length ? slots.map(t => h('button', {
        type: 'button', class: t === custom.value ? 'sel' : '',
        onclick: e => { custom.value = t; box.querySelectorAll('button').forEach(b => b.classList.toggle('sel', b === e.currentTarget)); }
      }, t)) : [h('span', { class: 'small muted' }, 'אין שעות פנויות ביום הזה (אפשר לבחור שעה ידנית)')]));
    }
    load(date, duration);
    return { el: wrap, load, get value() { return custom.value; } };
  }

  function moveModal(a) {
    const date = h('input', { type: 'date', class: 'inp', value: a.date });
    const dur = h('input', { type: 'number', class: 'inp', min: 5, max: 600, step: 5, value: a.duration });
    const tp = timePicker({ date: a.date, duration: a.duration, exclude: a.id, value: a.time });
    const refresh = () => tp.load(date.value, +dur.value || a.duration);
    date.addEventListener('change', refresh); dur.addEventListener('change', refresh);
    const m = modal(`הזזת תור – ${a.client_name}`,
      h('p', { class: 'muted', style: 'margin-bottom:1rem' }, `כרגע: ${fmtDate(a.date)} בשעה ${a.time}`),
      h('div', { class: 'grid-2' }, h('label', { class: 'field' }, 'תאריך חדש', date), h('label', { class: 'field' }, 'משך (דקות)', dur)),
      h('div', { style: 'margin-top:1rem' }, tp.el),
      h('div', { class: 'step-nav' }, h('span'), h('button', { class: 'btn btn-sm', onclick: async () => {
        if (!date.value || !tp.value) return toast('נא לבחור תאריך ושעה', true);
        const res = await patch(a, { date: date.value, time: tp.value, duration: +dur.value });
        if (!res) return;
        m.close(); toast('התור הועבר'); await reload();
        afterChange('התור הועבר ✓', res.appointment, 'moved', res);
      } }, 'שמירה')));
  }

  function newApptModal(prefill = {}) {
    const name = h('input', { class: 'inp', value: prefill.name || '' });
    const phone = h('input', { class: 'inp', type: 'tel', dir: 'ltr', value: prefill.phone || '' });
    const svc = h('select', { class: 'inp' }, st.services.filter(s => s.active).map(s => h('option', { value: s.id }, `${s.name} (${minutes(s.duration)})`)));
    const date = h('input', { type: 'date', class: 'inp', value: prefill.date || st.from });
    const dur = h('input', { type: 'number', class: 'inp', min: 5, max: 600, step: 5 });
    const status = h('select', { class: 'inp' }, h('option', { value: 'confirmed' }, 'מאושר'), h('option', { value: 'pending' }, 'ממתין לאישור'));
    const note = h('textarea', { class: 'inp', rows: 2, placeholder: 'הערה פנימית' });
    const svcDur = () => st.services.find(s => String(s.id) === svc.value)?.duration || 60;
    dur.value = svcDur();
    const tp = timePicker({ date: date.value, duration: svcDur() });
    svc.addEventListener('change', () => { dur.value = svcDur(); tp.load(date.value, +dur.value); });
    date.addEventListener('change', () => tp.load(date.value, +dur.value));
    dur.addEventListener('change', () => tp.load(date.value, +dur.value));
    const err = h('div', { class: 'alert hidden' });
    const save = async (force) => {
      try {
        await api('/api/admin/appointments', { method: 'POST', body: {
          name: name.value, phone: phone.value, serviceId: +svc.value, date: date.value, time: tp.value,
          duration: +dur.value, status: status.value, adminNote: note.value, force
        } });
        m.close(); toast('התור נוסף'); reload();
      } catch (e) {
        if (e.status === 409 && !force && confirm(`${e.message}\nלשמור בכל זאת?`)) return save(true);
        err.textContent = e.message; err.classList.remove('hidden');
      }
    };
    const m = modal('תור חדש',
      h('div', { class: 'grid-2' },
        h('label', { class: 'field' }, 'שם הלקוחה', name), h('label', { class: 'field' }, 'טלפון', phone),
        h('label', { class: 'field' }, 'טיפול', svc), h('label', { class: 'field' }, 'סטטוס', status),
        h('label', { class: 'field' }, 'תאריך', date), h('label', { class: 'field' }, 'משך (דקות)', dur)),
      h('div', { style: 'margin-top:1rem' }, tp.el),
      h('label', { class: 'field', style: 'margin-top:1rem' }, 'הערה', note), err,
      h('div', { class: 'step-nav' }, h('span'), h('button', { class: 'btn btn-sm', onclick: () => save(false) }, 'הוספת תור')));
  }

  // ---------- יומן ----------
  async function viewCalendar() {
    const to = addDays(st.from, 6);
    const { appointments } = await api(`/api/admin/appointments?from=${st.from}&to=${to}`);
    const shown = appointments.filter(a => st.showCancelled || a.status !== 'cancelled');
    const s = st.summary;
    const stat = (n, label, tab) => h('div', { class: 'stat', style: tab ? 'cursor:pointer' : '', onclick: tab ? () => go(tab) : null }, h('b', {}, String(n)), h('span', {}, label));
    const days = Array.from({ length: 7 }, (_, i) => addDays(st.from, i));
    const shift = n => { st.from = addDays(st.from, n); reload(); };
    view.replaceChildren(
      h('div', { class: 'stats' },
        stat(s.todayCount, 'תורים היום'), stat(s.weekCount, 'תורים השבוע'),
        stat(s.pending, 'ממתינים לאישור', 'pending'), stat(s.waiting, 'ברשימת המתנה', 'waitlist'), stat(s.clients, 'לקוחות', 'clients')),
      h('div', { class: 'row', style: 'margin-bottom:1.4rem' },
        h('button', { class: 'act', onclick: () => shift(-7) }, '→ שבוע קודם'),
        h('button', { class: 'act', onclick: () => { st.from = today(); reload(); } }, 'היום'),
        h('button', { class: 'act', onclick: () => shift(7) }, 'שבוע הבא ←'),
        h('input', { type: 'date', class: 'inp', style: 'max-width:170px', value: st.from, onchange: e => { if (e.target.value) { st.from = e.target.value; reload(); } } }),
        h('label', { class: 'small row', style: 'gap:.3rem' }, h('input', { type: 'checkbox', checked: st.showCancelled, onchange: e => { st.showCancelled = e.target.checked; reload(); } }), 'הצגת מבוטלים'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', onclick: () => newApptModal() }, '+ תור חדש')),
      h('div', {}, days.map(d => {
        const list = shown.filter(a => a.date === d);
        return h('div', { class: 'day-group' },
          h('h3', {}, fmtDate(d, { weekday: 'long' }), h('small', {}, fmtDate(d, { day: 'numeric', month: 'long' }) + (d === today() ? ' · היום' : '') + (list.length ? ` · ${list.length} תורים` : ''))),
          list.length ? list.map(a => apptCard(a)) : h('p', { class: 'small muted' }, 'אין תורים'));
      })));
  }

  async function viewPending() {
    const { appointments } = await api(`/api/admin/appointments?status=pending&from=${today()}`);
    view.replaceChildren(
      h('h2', { class: 'section-title', style: 'margin-top:0' }, 'בקשות שממתינות לאישור'),
      h('div', {}, appointments.length ? appointments.map(a => apptCard(a, { showDate: true })) : h('p', { class: 'empty' }, 'אין בקשות חדשות 🎉')));
  }

  // ---------- לקוחות ----------
  async function viewClients() {
    const q = h('input', { type: 'search', class: 'inp', placeholder: 'חיפוש לפי שם או טלפון…', style: 'max-width:340px' });
    const list = h('div', {});
    let t;
    const load = async () => {
      const { clients } = await api('/api/admin/clients?q=' + encodeURIComponent(q.value));
      list.replaceChildren(...(clients.length ? clients.map(c => h('div', { class: 'list-item clickable', onclick: () => clientModal(c.id) },
        h('div', { class: 'grow' }, h('b', {}, c.name), ' · ', h('span', { dir: 'ltr' }, c.phone),
          h('div', { class: 'small muted' }, `${c.visits} תורים`, c.last_date ? ` · אחרון: ${fmtDate(c.last_date, { day: 'numeric', month: 'short', year: 'numeric' })}` : '')),
        c.health_ok ? h('span', { class: 'chip ok' }, 'הצהרת בריאות ✓') : h('span', { class: 'chip warn' }, 'חסרה הצהרת בריאות'))) : [h('p', { class: 'empty' }, 'לא נמצאו לקוחות')]));
    };
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 250); });
    view.replaceChildren(h('div', { class: 'row', style: 'margin-bottom:1.2rem' }, q), list);
    await load();
  }

  async function clientModal(id) {
    let data;
    try { data = await api('/api/admin/clients/' + id); } catch (e) { return toast(e.message, true); }
    const c = data.client;
    const notes = h('textarea', { class: 'inp', rows: 3, placeholder: 'הערות על הלקוחה (רגישויות, העדפות…)' }); notes.value = c.notes || '';
    const healthBlock = c.health
      ? h('div', {},
          h('p', { class: 'small', style: 'margin-bottom:.6rem' }, `נחתמה ב-${new Date(c.health_signed_at).toLocaleDateString('he-IL')} · ת.ז. ${c.id_number || '—'}`,
            c.health_ok ? '' : h('span', { class: 'chip warn' }, 'פג תוקף – יותר משנה')),
          h('ul', { class: 'health-list' }, data.questions.map((q, i) => h('li', { class: c.health.answers[i] === 'כן' ? 'yes' : '' },
            h('span', {}, `${i + 1}. ${q}`, c.health.details?.[i] ? h('div', { class: 'small' }, '↳ ', c.health.details[i]) : null),
            h('b', {}, c.health.answers[i])))),
          h('p', { class: 'small muted', style: 'margin:1rem 0 .4rem' }, 'אישרה את הצהרת הבריאות ואת טופס ההסכמה לטיפול. חתימה:'),
          c.signature ? h('img', { class: 'sig-img', src: c.signature, alt: 'חתימת הלקוחה' }) : null)
      : h('div', { class: 'alert' }, 'עדיין לא מולאה הצהרת בריאות. ',
          h('a', { href: waLink(c.phone, `היי ${c.name} 💕 לפני הקעקוע צריך למלא הצהרת בריאות קצרה: ${SITE}/book.html?health=1`), target: '_blank', rel: 'noopener', style: 'text-decoration:underline' }, 'שליחת קישור בוואטסאפ'));
    const m = modal(c.name,
      h('div', { class: 'row no-print', style: 'margin-bottom:1rem' },
        h('a', { class: 'act', href: 'tel:' + c.phone, dir: 'ltr' }, '📞 ' + c.phone),
        h('a', { class: 'act wa', href: waLink(c.phone, `היי ${c.name} 💕`), target: '_blank', rel: 'noopener' }, 'וואטסאפ'),
        h('button', { class: 'act', onclick: () => { m.close(); newApptModal({ name: c.name, phone: c.phone }); } }, '+ קביעת תור'),
        h('button', { class: 'act', onclick: () => window.print() }, 'הדפסה'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'act danger', onclick: async () => {
          if (!confirm(`למחוק את ${c.name} ואת כל התורים והצהרת הבריאות שלה? אי אפשר לבטל את זה.`)) return;
          await api('/api/admin/clients/' + c.id, { method: 'DELETE' }); m.close(); toast('הלקוחה נמחקה'); reload();
        } }, 'מחיקה')),
      h('p', { class: 'small muted' }, `לקוחה מ-${new Date(c.created_at).toLocaleDateString('he-IL')}`),
      h('h3', { class: 'section-title', style: 'margin-top:1rem' }, 'הערות'),
      notes,
      h('button', { class: 'btn btn-sm no-print', style: 'margin-top:.6rem', onclick: async () => {
        await api('/api/admin/clients/' + c.id, { method: 'PATCH', body: { notes: notes.value } }); toast('נשמר');
      } }, 'שמירת הערות'),
      h('h3', { class: 'section-title' }, 'הצהרת בריאות וטופס הסכמה'), healthBlock,
      h('h3', { class: 'section-title' }, `היסטוריית תורים (${data.appointments.length})`),
      data.appointments.length ? data.appointments.map(a => h('div', { class: 'list-item' },
        h('div', { class: 'grow' }, `${fmtDate(a.date, { day: 'numeric', month: 'short', year: 'numeric' })} · ${a.time} · ${a.service_name || ''}`),
        h('span', { class: 'chip ' + a.status }, STATUS[a.status]))) : h('p', { class: 'small muted' }, 'אין תורים'));
  }

  // ---------- רשימת המתנה ----------
  function waitRow(w, offer) {
    const sel = h('select', { class: 'inp', style: 'max-width:150px', onchange: async e => {
      await api(`/api/admin/waitlist/${w.id}`, { method: 'PATCH', body: { status: e.target.value } }); toast('עודכן'); refreshTabs();
    } }, Object.entries(WL_STATUS).map(([v, t]) => h('option', { value: v, selected: w.status === v }, t)));
    const range = w.date_from || w.date_to
      ? `${w.date_from ? fmtDate(w.date_from, { day: 'numeric', month: 'short' }) : 'מעכשיו'} – ${w.date_to ? fmtDate(w.date_to, { day: 'numeric', month: 'short' }) : 'בלי הגבלה'}`
      : 'כל תאריך';
    const msg = offer ? MSG.waitlist(w, offer.date, offer.time) : `היי ${w.name}, כאן רבקה כהן 💕 התפנה תור – רוצה שנקבע?`;
    return h('div', { class: 'list-item' },
      h('div', { class: 'grow' }, h('b', {}, w.name), ' · ', h('a', { href: 'tel:' + w.phone, dir: 'ltr' }, w.phone),
        h('div', { class: 'small muted' }, `${w.service_name || 'כל קעקוע'} · ${range} · ${TIME_PREF[w.time_pref] || ''}`),
        w.note ? h('div', { class: 'small' }, '💬 ', w.note) : null,
        h('div', { class: 'small muted' }, 'נרשמה ב-' + new Date(w.created_at).toLocaleDateString('he-IL'))),
      h('a', { class: 'act wa', href: waLink(w.phone, msg), target: '_blank', rel: 'noopener', onclick: () => {
        if (w.status === 'waiting') { sel.value = 'contacted'; sel.dispatchEvent(new Event('change')); }
      } }, 'הצעת תור בוואטסאפ'),
      sel,
      offer ? null : h('button', { class: 'act danger', onclick: async () => {
        if (!confirm(`למחוק את ${w.name} מרשימת ההמתנה?`)) return;
        await api(`/api/admin/waitlist/${w.id}`, { method: 'DELETE' }); reload();
      } }, 'מחיקה'));
  }
  async function viewWaitlist() {
    const { waitlist } = await api('/api/admin/waitlist');
    view.replaceChildren(
      h('h2', { class: 'section-title', style: 'margin-top:0' }, 'רשימת המתנה'),
      h('p', { class: 'muted', style: 'margin-bottom:1rem' }, 'כשתור מתבטל או זז, המערכת מציגה אוטומטית את הממתינות שמתאימות לאותו יום.'),
      h('div', {}, waitlist.length ? waitlist.map(w => waitRow(w)) : h('p', { class: 'empty' }, 'רשימת ההמתנה ריקה')));
  }

  // ---------- הגדרות ----------
  async function viewSettings() {
    const { settings: s, services } = await api('/api/admin/settings');
    const hours = JSON.parse(JSON.stringify(s.hours));
    const closures = [...s.closures];
    const svcs = services.map(x => ({ ...x }));

    const hoursBox = h('div', {});
    const drawHours = () => hoursBox.replaceChildren(...DAYS.map((d, i) => {
      const list = hours[i] || (hours[i] = []);
      return h('div', { class: 'hours-row' }, h('b', {}, d),
        h('div', { class: 'ranges' },
          list.length ? list.map((r, j) => h('span', { class: 'range' },
            h('input', { type: 'time', value: r.from, onchange: e => { r.from = e.target.value; } }), '–',
            h('input', { type: 'time', value: r.to, onchange: e => { r.to = e.target.value; } }),
            h('button', { type: 'button', 'aria-label': 'הסרה', onclick: () => { list.splice(j, 1); drawHours(); } }, '×'))) : h('span', { class: 'chip' }, 'סגור'),
          h('button', { type: 'button', class: 'act', onclick: () => { list.push(list.length ? { from: '16:00', to: '20:00' } : { from: '10:00', to: '19:00' }); drawHours(); } }, '+ טווח שעות')));
    }));
    drawHours();

    const num = (val, min, max) => h('input', { type: 'number', class: 'inp', value: val, min, max, style: 'max-width:120px' });
    const step = num(s.slotStep, 5, 240), notice = num(s.minNoticeHours, 0, 336), horizon = num(s.horizonDays, 1, 365);
    const auto = h('input', { type: 'checkbox', checked: s.autoConfirm });

    const clBox = h('div', {});
    const drawClosures = () => clBox.replaceChildren(
      ...closures.sort((a, b) => a.date.localeCompare(b.date)).map((c, i) => h('div', { class: 'list-item' },
        h('div', { class: 'grow' }, h('b', {}, fmtDate(c.date)), ' · ', c.from ? `${c.from}–${c.to}` : 'כל היום', c.reason ? ` · ${c.reason}` : ''),
        h('button', { class: 'act danger', onclick: () => { closures.splice(i, 1); drawClosures(); } }, 'הסרה'))),
      closures.length ? '' : h('p', { class: 'small muted' }, 'אין ימים חסומים'));
    drawClosures();
    const cDate = h('input', { type: 'date', class: 'inp', style: 'max-width:170px' });
    const cFrom = h('input', { type: 'time', class: 'inp', style: 'max-width:120px' });
    const cTo = h('input', { type: 'time', class: 'inp', style: 'max-width:120px' });
    const cReason = h('input', { class: 'inp', placeholder: 'סיבה (חופש, אירוע…)', style: 'max-width:220px' });

    const svcBox = h('div', {});
    const drawSvcs = () => svcBox.replaceChildren(
      h('div', { class: 'svc-row small muted' }, h('span', {}, 'שם'), h('span', {}, 'משך (דקות)'), h('span', {}, 'פעיל')),
      ...svcs.map(x => h('div', { class: 'svc-row' },
        h('input', { class: 'inp', value: x.name, oninput: e => { x.name = e.target.value; } }),
        h('input', { class: 'inp', type: 'number', min: 5, max: 600, step: 5, value: x.duration, oninput: e => { x.duration = +e.target.value; } }),
        h('label', {}, h('input', { type: 'checkbox', checked: !!x.active, onchange: e => { x.active = e.target.checked; } })))),
      h('button', { class: 'act', onclick: () => { svcs.push({ name: 'טיפול חדש', duration: 60, active: 1 }); drawSvcs(); } }, '+ הוספת טיפול'));
    drawSvcs();

    const save = async () => {
      try {
        await api('/api/admin/settings', { method: 'PUT', body: {
          settings: { hours, slotStep: +step.value, minNoticeHours: +notice.value, horizonDays: +horizon.value, autoConfirm: auto.checked, closures },
          services: svcs.map(x => ({ ...x, active: !!x.active }))
        } });
        st.services = (await api('/api/admin/settings')).services;
        toast('ההגדרות נשמרו ✓'); reload();
      } catch (e) { toast(e.message, true); }
    };

    const pwCur = h('input', { type: 'password', class: 'inp', autocomplete: 'current-password' });
    const pwNew = h('input', { type: 'password', class: 'inp', autocomplete: 'new-password', minlength: 8 });

    view.replaceChildren(h('div', { class: 'panel' },
      h('h2', { class: 'section-title', style: 'margin-top:0' }, 'שעות פתיחה'),
      h('p', { class: 'small muted' }, 'אפשר להוסיף כמה טווחים ביום (למשל בוקר וערב עם הפסקה באמצע).'),
      hoursBox,
      h('h2', { class: 'section-title' }, 'הגדרות תורים'),
      h('div', { class: 'grid-2' },
        h('label', { class: 'field' }, 'מרווח בין שעות התחלה (דקות)', step),
        h('label', { class: 'field' }, 'כמה שעות מראש אפשר לקבוע לפחות', notice),
        h('label', { class: 'field' }, 'כמה ימים קדימה אפשר לקבוע', horizon),
        h('label', { class: 'agree' }, auto, 'אישור אוטומטי של תורים מהאתר (בלי לחכות לאישור שלי)')),
      h('h2', { class: 'section-title' }, 'ימים ושעות חסומים'),
      h('p', { class: 'small muted', style: 'margin-bottom:.6rem' }, 'חופשה, חג או אירוע – בלי שעות = כל היום חסום.'),
      clBox,
      h('div', { class: 'row', style: 'margin-top:.6rem' }, cDate, cFrom, '–', cTo, cReason,
        h('button', { class: 'act', onclick: () => {
          if (!cDate.value) return toast('נא לבחור תאריך', true);
          if ((cFrom.value || cTo.value) && !(cFrom.value && cTo.value && cTo.value > cFrom.value)) return toast('טווח שעות לא תקין', true);
          closures.push({ date: cDate.value, from: cFrom.value || null, to: cTo.value || null, reason: cReason.value });
          cDate.value = cFrom.value = cTo.value = cReason.value = ''; drawClosures();
        } }, '+ חסימה')),
      h('h2', { class: 'section-title' }, 'סוגי טיפולים ומשך'),
      svcBox,
      h('div', { class: 'step-nav' }, h('span'), h('button', { class: 'btn', onclick: save }, 'שמירת כל ההגדרות'))),
      h('div', { class: 'panel', style: 'margin-top:1.6rem' },
        h('h2', { class: 'section-title', style: 'margin-top:0' }, 'החלפת סיסמה'),
        h('div', { class: 'grid-2' }, h('label', { class: 'field' }, 'סיסמה נוכחית', pwCur), h('label', { class: 'field' }, 'סיסמה חדשה (לפחות 8 תווים)', pwNew)),
        h('button', { class: 'btn btn-sm', style: 'margin-top:1rem', onclick: async () => {
          try { await api('/api/admin/password', { method: 'POST', body: { current: pwCur.value, next: pwNew.value } }); pwCur.value = pwNew.value = ''; toast('הסיסמה הוחלפה ✓'); }
          catch (e) { toast(e.message, true); }
        } }, 'החלפת סיסמה')));
  }

  boot();
})();
