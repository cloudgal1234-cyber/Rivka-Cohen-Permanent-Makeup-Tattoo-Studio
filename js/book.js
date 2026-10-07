// קביעת תור – אשף בשלבים
(() => {
  const { h, api, toast, fmtDate, iso, addDays, minutes, endTime } = UI;
  const app = document.getElementById('app');
  const bar = document.getElementById('steps-bar');
  const STUDIO_PHONE = '0559202184';

  const state = {
    config: null, service: null, date: null, time: null,
    month: null, availability: {}, name: '', phone: '', note: '',
    needsHealth: true, health: null,
    healthOnly: new URLSearchParams(location.search).get('health') === '1'
  };

  function setStep(step) {
    const order = ['service', 'date', 'details', 'health', 'confirm'];
    const idx = order.indexOf(step);
    bar.querySelectorAll('li').forEach(li => {
      const i = order.indexOf(li.dataset.step);
      li.classList.toggle('active', i === idx);
      li.classList.toggle('done', i < idx);
      li.classList.toggle('hidden', (li.dataset.step === 'health' && !state.needsHealth) ||
        (state.healthOnly && !['details', 'health'].includes(li.dataset.step)));
    });
  }
  function render(step, ...nodes) {
    setStep(step);
    app.replaceChildren(h('div', { class: 'step' }, ...nodes));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  const errorBox = () => h('div', { class: 'alert hidden', role: 'alert' });
  const showErr = (box, msg) => { box.textContent = msg; box.classList.remove('hidden'); box.scrollIntoView({ behavior: 'smooth', block: 'center' }); };

  // ---------- שלב 1: סוג קעקוע ----------
  function stepService() {
    const grid = h('div', { class: 'svc-grid' }, state.config.services.map(s =>
      h('button', {
        type: 'button', class: 'svc' + (state.service?.id === s.id ? ' selected' : ''),
        onclick: () => { state.service = s; state.date = state.time = null; stepDate(); }
      }, h('strong', {}, s.name), h('span', {}, `⏱ ${minutes(s.duration)}`))));
    render('service',
      h('h2', {}, 'איזה קעקוע עושים?'),
      h('p', { class: 'muted', style: 'margin-bottom:1.4rem' }, 'לא בטוחה? בחרי "ייעוץ ועיצוב" ונחליט יחד.'),
      grid, waitlistCta());
  }

  // ---------- שלב 2: תאריך ושעה ----------
  async function loadMonth() {
    const first = state.month + '-01';
    const from = first < state.config.today ? state.config.today : first;
    const d = new Date(first + 'T12:00:00');
    const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - (+from.slice(8) - 1);
    const res = await api(`/api/public/availability?service=${state.service.id}&from=${from}&days=${days}`);
    Object.assign(state.availability, res.days);
  }

  async function stepDate() {
    if (!state.month) state.month = state.config.today.slice(0, 7);
    render('date', h('p', { class: 'muted', style: 'text-align:center' }, 'בודקת תורים פנויים…'));
    try { await loadMonth(); } catch (e) { return render('date', h('div', { class: 'alert' }, e.message)); }

    const last = addDays(state.config.today, state.config.horizonDays);
    const [y, m] = state.month.split('-').map(Number);
    const firstDow = new Date(y, m - 1, 1).getDay();
    const daysIn = new Date(y, m, 0).getDate();
    const monthName = new Date(y, m - 1, 1).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
    const shift = (n) => { const d = new Date(y, m - 1 + n, 1); state.month = iso(d).slice(0, 7); stepDate(); };

    const cal = h('div', { class: 'cal', role: 'grid', 'aria-label': monthName },
      ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'].map(d => h('div', { class: 'dow' }, d)),
      Array.from({ length: firstDow }, () => h('div')),
      Array.from({ length: daysIn }, (_, i) => {
        const date = `${state.month}-${String(i + 1).padStart(2, '0')}`;
        const free = state.availability[date] || 0;
        return h('button', {
          type: 'button', disabled: !free, 'aria-label': `${fmtDate(date)}${free ? `, ${free} תורים פנויים` : ', אין תורים'}`,
          class: [date === state.date && 'sel', date === state.config.today && 'today'].filter(Boolean).join(' '),
          onclick: () => { state.date = date; state.time = null; stepDate(); }
        }, String(i + 1));
      }));

    const timesBox = h('div', {});
    const next = h('button', { type: 'button', class: 'btn', disabled: !state.time, onclick: stepDetails }, 'המשך ←');
    if (state.date) {
      timesBox.append(h('h3', { style: 'margin-bottom:.8rem' }, fmtDate(state.date)), h('p', { class: 'muted' }, 'טוען שעות…'));
      api(`/api/public/slots?service=${state.service.id}&date=${state.date}`).then(({ slots }) => {
        timesBox.lastChild.replaceWith(slots.length
          ? h('div', { class: 'times' }, slots.map((t, i) => h('button', {
              type: 'button', class: t === state.time ? 'sel' : '', style: `animation-delay:${i * 25}ms`,
              onclick: e => { state.time = t; timesBox.querySelectorAll('.times button').forEach(b => b.classList.toggle('sel', b === e.currentTarget)); next.disabled = false; }
            }, t)))
          : h('p', { class: 'empty' }, 'התורים ביום הזה כבר נתפסו. נסי יום אחר או הצטרפי לרשימת ההמתנה.'));
      }).catch(e => { timesBox.lastChild.replaceWith(h('div', { class: 'alert' }, e.message)); });
    } else {
      timesBox.append(h('p', { class: 'empty' }, 'בחרי יום בלוח כדי לראות שעות פנויות'));
    }

    render('date',
      h('h2', { style: 'margin-bottom:.4rem' }, 'מתי נוח לך?'),
      h('p', { class: 'muted', style: 'margin-bottom:1.4rem' }, `${state.service.name} · ${minutes(state.service.duration)}`),
      h('div', { class: 'cal-wrap' },
        h('div', {},
          h('div', { class: 'cal-head' },
            h('button', { type: 'button', class: 'cal-nav', 'aria-label': 'החודש הקודם', disabled: state.month <= state.config.today.slice(0, 7), onclick: () => shift(-1) }, '›'),
            h('strong', {}, monthName),
            h('button', { type: 'button', class: 'cal-nav', 'aria-label': 'החודש הבא', disabled: state.month >= last.slice(0, 7), onclick: () => shift(1) }, '‹')),
          cal),
        timesBox),
      waitlistCta(),
      h('div', { class: 'step-nav' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: stepService }, '→ חזרה'), next));
  }

  // ---------- שלב 3: פרטים ----------
  function stepDetails() {
    const err = errorBox();
    const name = h('input', { type: 'text', required: true, autocomplete: 'name', value: state.name });
    const phone = h('input', { type: 'tel', required: true, autocomplete: 'tel', dir: 'ltr', inputmode: 'tel', placeholder: '050-0000000', value: state.phone });
    const note = h('textarea', { placeholder: 'רעיון לקעקוע, מיקום בגוף, גודל… (לא חובה)' });
    note.value = state.note;
    const btn = h('button', { type: 'submit', class: 'btn' }, 'המשך ←');
    const form = h('form', {
      onsubmit: async e => {
        e.preventDefault();
        state.name = name.value.trim(); state.phone = phone.value.trim(); state.note = note.value.trim();
        if (state.name.length < 2) return showErr(err, 'נא למלא שם מלא');
        if (!/^0\d{8,9}$/.test(state.phone.replace(/\D/g, '').replace(/^972/, '0'))) return showErr(err, 'נא למלא מספר טלפון תקין');
        if (state.healthOnly) return stepHealth();
        btn.disabled = true;
        try {
          const r = await api('/api/public/check', { method: 'POST', body: { phone: state.phone } });
          state.needsHealth = r.needsHealth;
          state.needsHealth ? stepHealth() : stepConfirm();
        } catch (ex) { showErr(err, ex.message); btn.disabled = false; }
      }
    },
      h('h2', { style: 'margin-bottom:1.2rem' }, 'הפרטים שלך'),
      h('div', { class: 'grid-2' },
        h('label', { class: 'field' }, 'שם מלא', name),
        h('label', { class: 'field' }, 'טלפון', phone),
        h('label', { class: 'field full' }, 'הערות לרבקה', note)),
      err,
      h('div', { class: 'step-nav' }, state.healthOnly ? h('span') : h('button', { type: 'button', class: 'btn btn-ghost', onclick: stepDate }, '→ חזרה'), btn));
    render('details', form);
  }

  // ---------- שלב 4: הצהרת בריאות ----------
  function stepHealth() {
    const Q = window.HEALTH;
    const err = errorBox();
    const idInput = h('input', { type: 'text', inputmode: 'numeric', required: true, autocomplete: 'off' });
    const prev = state.health;
    let n = 0;
    const groups = Q.groups.map(size => h('div', { class: 'q-group' }, Array.from({ length: size }, () => {
      const i = n++;
      const detail = Q.detailQuestions.includes(i)
        ? h('input', { type: 'text', class: 'inp q-detail', placeholder: 'אם כן – נא לפרט', hidden: prev?.answers[i] !== 'כן' })
        : null;
      if (detail && prev?.details?.[i]) detail.value = prev.details[i];
      const radio = val => h('label', { class: 'yn' },
        h('input', { type: 'radio', name: 'q' + i, value: val, checked: prev?.answers[i] === val, onchange: () => { if (detail) detail.hidden = val !== 'כן'; row.classList.remove('missing'); } }),
        h('span', {}, val));
      const row = h('div', { class: 'q-row', 'data-i': i }, h('span', { class: 'q-text' }, `${i + 1}. ${Q.questions[i]}`), radio('כן'), radio('לא'), detail);
      return row;
    })));
    if (prev) idInput.value = prev.idNumber;
    const declare = h('input', { type: 'checkbox', checked: !!prev });
    const consent = h('input', { type: 'checkbox', checked: !!prev });
    const canvas = h('canvas', { width: 600, height: 160, 'aria-label': 'אזור חתימה' });
    const pad = UI.signaturePad(canvas);

    const form = h('form', {
      novalidate: true,
      onsubmit: e => {
        e.preventDefault();
        const answers = [], details = {};
        let missing = null;
        form.querySelectorAll('.q-row').forEach(row => {
          const i = +row.dataset.i;
          const v = row.querySelector('input[type=radio]:checked')?.value;
          row.classList.toggle('missing', !v);
          if (!v && !missing) missing = row;
          answers[i] = v;
          const d = row.querySelector('.q-detail');
          if (d && v === 'כן') details[i] = d.value.trim();
        });
        if (missing) { showErr(err, 'נא לענות על כל השאלות (השאלות החסרות מסומנות באדום)'); return missing.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        if (!/^\d{5,9}$/.test(idInput.value.replace(/\D/g, ''))) return showErr(err, 'נא למלא מספר תעודת זהות');
        if (!declare.checked || !consent.checked) return showErr(err, 'נא לאשר את הצהרת הבריאות ואת טופס ההסכמה');
        if (!pad.signed && !prev?.signature) return showErr(err, 'נא לחתום במסגרת החתימה');
        state.health = { answers, details, idNumber: idInput.value.replace(/\D/g, ''), declare: true, consent: true, signature: pad.signed ? pad.data() : prev.signature };
        if (state.healthOnly) return sendHealthOnly(err, e.submitter);
        stepConfirm();
      }
    },
      h('h2', {}, 'הצהרת בריאות'),
      h('p', { class: 'muted', style: 'margin-bottom:1.4rem' }, 'לקוחה חדשה? לפני הקעקוע הראשון ממלאים הצהרת בריאות וטופס הסכמה. המידע נשמר אצל רבקה בלבד.'),
      h('label', { class: 'field', style: 'max-width:280px;margin-bottom:1.6rem' }, 'מספר תעודת זהות', idInput),
      groups,
      h('div', { class: 'declaration' }, h('h3', {}, 'הצהרת המטופלת'), Q.declaration.map(p => h('p', {}, p)),
        h('label', { class: 'agree' }, declare, 'אני מאשרת את הצהרת הבריאות')),
      h('h3', { style: 'margin:2rem 0 1rem' }, 'טופס הסכמה לטיפול – קעקוע מאיפור קבוע'),
      h('ol', { class: 'consent' }, Q.consent.map(c => h('li', {}, c))),
      h('label', { class: 'agree' }, consent, 'קראתי, הבנתי ואני מסכימה לכל הסעיפים'),
      h('div', { class: 'sign' }, h('span', {}, 'חתימה'), canvas,
        h('button', { type: 'button', class: 'btn-plain', style: 'justify-self:start', onclick: () => pad.clear() }, 'ניקוי חתימה')),
      err,
      h('div', { class: 'step-nav' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: stepDetails }, '→ חזרה'),
        h('button', { type: 'submit', class: 'btn' }, 'המשך ←')));
    render('health', form);
  }

  // ---------- שלב 5: אישור ----------
  function stepConfirm() {
    const err = errorBox();
    const btn = h('button', { type: 'button', class: 'btn' }, 'שליחת בקשה לתור ✓');
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'שולחת…';
      try {
        const r = await api('/api/public/book', { method: 'POST', body: {
          name: state.name, phone: state.phone, note: state.note, serviceId: state.service.id,
          date: state.date, time: state.time, health: state.needsHealth ? state.health : undefined
        } });
        stepDone(r.status);
      } catch (e) {
        showErr(err, e.message);
        btn.disabled = false; btn.textContent = 'שליחת בקשה לתור ✓';
        if (e.status === 409) { state.time = null; setTimeout(stepDate, 2200); }
      }
    });
    const row = (k, v) => h('div', {}, h('dt', {}, k), h('dd', {}, v));
    render('confirm',
      h('h2', { style: 'margin-bottom:1.2rem' }, 'כמעט סיימנו!'),
      h('dl', { class: 'summary' },
        row('קעקוע', state.service.name),
        row('תאריך', fmtDate(state.date)),
        row('שעה', `${state.time}–${endTime(state.time, state.service.duration)}`),
        row('שם', state.name), row('טלפון', state.phone),
        state.note && row('הערות', state.note),
        row('הצהרת בריאות', state.needsHealth ? 'מולאה ✓' : 'כבר קיימת במערכת ✓')),
      h('p', { class: 'muted small', style: 'margin-top:1rem' }, 'אחרי השליחה רבקה תאשר את התור ותעדכן אותך בוואטסאפ. לביטול או שינוי – פשוט שולחים לה הודעה.'),
      err,
      h('div', { class: 'step-nav' },
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => (state.needsHealth ? stepHealth() : stepDetails()) }, '→ חזרה'), btn));
  }

  function icsFile() {
    const dt = (d, t) => d.replace(/-/g, '') + 'T' + t.replace(':', '') + '00';
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Rivka Cohen//Booking//HE', 'BEGIN:VEVENT',
      `UID:${Date.now()}@rivka-cohen`, `DTSTART;TZID=Asia/Jerusalem:${dt(state.date, state.time)}`,
      `DTEND;TZID=Asia/Jerusalem:${dt(state.date, endTime(state.time, state.service.duration))}`,
      `SUMMARY:קעקוע אצל רבקה כהן – ${state.service.name}`, 'LOCATION:ברקת 36\\, גבעת זאב', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    return URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  }

  function stepDone(status) {
    const confirmed = status === 'confirmed';
    setStep('confirm');
    bar.querySelectorAll('li').forEach(li => { li.classList.remove('active'); li.classList.add('done'); });
    const msg = `היי רבקה, קבעתי עכשיו תור באתר ל${state.service.name} ב${fmtDate(state.date)} בשעה ${state.time}. (${state.name})`;
    app.replaceChildren(h('div', { class: 'step success' },
      h('div', { class: 'check' }, '✓'),
      h('h2', {}, confirmed ? 'התור נקבע!' : 'הבקשה נשלחה!'),
      h('p', { class: 'muted', style: 'max-width:440px;margin:.6rem auto 1.6rem' }, confirmed
        ? `נתראה ב${fmtDate(state.date)} בשעה ${state.time} 💕`
        : `רבקה תאשר את התור ל${fmtDate(state.date)} בשעה ${state.time} ותעדכן אותך בוואטסאפ בהקדם 💕`),
      h('div', { class: 'row', style: 'justify-content:center' },
        h('a', { class: 'btn', href: UI.waLink(STUDIO_PHONE, msg), target: '_blank', rel: 'noopener' }, 'הודעה לרבקה בוואטסאפ'),
        h('a', { class: 'btn btn-ghost', href: icsFile(), download: 'tor-rivka-cohen.ics' }, 'הוספה ליומן')),
      h('p', { class: 'small muted', style: 'margin-top:1.6rem' }, '📍 ברקת 36, גבעת זאב · אל תשכחי לקרוא את ', h('a', { href: 'index.html#aftercare', style: 'text-decoration:underline' }, 'הוראות ההחלמה'))));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function sendHealthOnly(err, btn) {
    if (btn) btn.disabled = true;
    try {
      await api('/api/public/health', { method: 'POST', body: { name: state.name, phone: state.phone, health: state.health } });
      bar.querySelectorAll('li').forEach(li => { li.classList.remove('active'); li.classList.add('done'); });
      app.replaceChildren(h('div', { class: 'step success' }, h('div', { class: 'check' }, '✓'),
        h('h2', {}, 'הצהרת הבריאות נשלחה!'),
        h('p', { class: 'muted', style: 'margin:.6rem 0 1.6rem' }, 'תודה! רבקה קיבלה את ההצהרה. נתראה בסטודיו 💕'),
        h('a', { class: 'btn', href: 'index.html' }, 'לאתר')));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (ex) { showErr(err, ex.message); if (btn) btn.disabled = false; }
  }

  // ---------- רשימת המתנה ----------
  function waitlistCta() {
    return h('div', { class: 'waitlist-cta' },
      h('span', { class: 'grow', style: 'flex:1' }, '⏳ לא מצאת תור שמתאים לך?'),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: openWaitlist }, 'הצטרפות לרשימת המתנה'));
  }
  function openWaitlist() {
    const err = errorBox();
    const name = h('input', { type: 'text', required: true, autocomplete: 'name', value: state.name });
    const phone = h('input', { type: 'tel', required: true, dir: 'ltr', autocomplete: 'tel', value: state.phone });
    const svc = h('select', {}, h('option', { value: '' }, 'לא משנה / עוד לא יודעת'),
      state.config.services.map(s => h('option', { value: s.id, selected: state.service?.id === s.id }, s.name)));
    const from = h('input', { type: 'date', min: state.config.today, value: state.date || '' });
    const to = h('input', { type: 'date', min: state.config.today });
    const pref = h('select', {}, [['any', 'כל שעה'], ['morning', 'בוקר'], ['noon', 'צהריים'], ['evening', 'ערב']].map(([v, t]) => h('option', { value: v }, t)));
    const note = h('textarea', { placeholder: 'משהו שחשוב שרבקה תדע (לא חובה)' });
    const m = UI.modal('רשימת המתנה',
      h('p', { class: 'muted', style: 'margin-bottom:1.2rem' }, 'כשמתפנה תור שמתאים לך – רבקה תשלח לך הודעה.'),
      h('form', {
        onsubmit: async e => {
          e.preventDefault();
          try {
            await api('/api/public/waitlist', { method: 'POST', body: {
              name: name.value, phone: phone.value, serviceId: svc.value || null,
              dateFrom: from.value || null, dateTo: to.value || null, timePref: pref.value, note: note.value
            } });
            m.close(); toast('נרשמת לרשימת ההמתנה ✓ רבקה תעדכן אותך כשיתפנה תור');
          } catch (ex) { showErr(err, ex.message); }
        }
      },
        h('div', { class: 'grid-2' },
          h('label', { class: 'field' }, 'שם מלא', name), h('label', { class: 'field' }, 'טלפון', phone),
          h('label', { class: 'field full' }, 'סוג קעקוע', svc),
          h('label', { class: 'field' }, 'מתאריך', from), h('label', { class: 'field' }, 'עד תאריך', to),
          h('label', { class: 'field' }, 'שעה מועדפת', pref),
          h('label', { class: 'field full' }, 'הערות', note)),
        err,
        h('div', { class: 'step-nav' }, h('span'), h('button', { type: 'submit', class: 'btn' }, 'הרשמה לרשימת ההמתנה'))));
  }

  // ---------- התחלה ----------
  api('/api/public/config').then(cfg => {
    state.config = cfg;
    const pre = new URLSearchParams(location.search).get('service');
    if (pre) state.service = cfg.services.find(s => String(s.id) === pre) || null;
    if (state.healthOnly) {
      document.querySelector('.app-head h1').replaceChildren('הצהרת ', h('span', { class: 'accent' }, 'בריאות'));
      document.querySelector('.app-head p:last-child').textContent = 'ממלאות פעם אחת לפני הקעקוע הראשון – לוקח כמה דקות.';
      return stepDetails();
    }
    state.service ? stepDate() : stepService();
  }).catch(e => {
    app.replaceChildren(h('div', { class: 'alert' }, 'מערכת התורים לא זמינה כרגע. אפשר לקבוע תור בוואטסאפ: ',
      h('a', { href: UI.waLink(STUDIO_PHONE, 'היי רבקה, אשמח לקבוע תור לקעקוע'), style: 'text-decoration:underline' }, '055-920-2184')));
    console.error(e);
  });
})();
