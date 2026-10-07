// כלים משותפים למערכת התורים ולדף הניהול
const UI = (() => {
  // יצירת אלמנט: h('div', {class: 'x', onclick: fn}, 'טקסט', child)
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'html') throw new Error('html אסור');
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  }

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method, credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined
      });
    } catch {
      throw Object.assign(new Error('אין חיבור לשרת. בדקי את האינטרנט ונסי שוב.'), { status: 0 });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'משהו השתבש, נסי שוב'), { status: res.status });
    return data;
  }

  let toastTimer;
  function toast(msg, isErr) {
    document.querySelector('.toast')?.remove();
    const t = h('div', { class: 'toast' + (isErr ? ' err' : ''), role: 'status' }, msg);
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 3800);
  }

  const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  const parse = (d) => new Date(d + 'T12:00:00');
  const fmtDate = (d, opts = { weekday: 'long', day: 'numeric', month: 'long' }) => parse(d).toLocaleDateString('he-IL', opts);
  const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const addDays = (d, n) => { const x = parse(d); x.setDate(x.getDate() + n); return iso(x); };
  const minutes = (n) => n >= 60 ? `${Math.floor(n / 60)} ש׳${n % 60 ? ` ${n % 60} ד׳` : ''}` : `${n} דק׳`;
  const endTime = (t, dur) => { const m = +t.slice(0, 2) * 60 + +t.slice(3) + dur; return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

  const intlPhone = (p) => '972' + String(p).replace(/\D/g, '').replace(/^0/, '');
  const waLink = (phone, text) => `https://wa.me/${intlPhone(phone)}?text=${encodeURIComponent(text)}`;

  // משטח חתימה
  function signaturePad(canvas) {
    const ctx = canvas.getContext('2d');
    let drawing = false, signed = false;
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1c1c1c';
    const pos = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height]; };
    canvas.addEventListener('pointerdown', e => { drawing = true; ctx.beginPath(); ctx.moveTo(...pos(e)); canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', e => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); signed = true; });
    ['pointerup', 'pointercancel'].forEach(t => canvas.addEventListener(t, () => { drawing = false; }));
    return {
      clear() { ctx.clearRect(0, 0, canvas.width, canvas.height); signed = false; },
      get signed() { return signed; },
      data() { return canvas.toDataURL('image/png'); }
    };
  }

  function modal(title, ...content) {
    const close = () => { bg.remove(); document.removeEventListener('keydown', esc); };
    const esc = e => { if (e.key === 'Escape') close(); };
    const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('button', { class: 'modal-close no-print', 'aria-label': 'סגירה', onclick: () => close() }, '×'),
      h('h2', {}, title), ...content);
    const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) close(); } }, box);
    document.addEventListener('keydown', esc);
    document.body.append(bg);
    box.querySelector('input, select, textarea, button:not(.modal-close)')?.focus();
    return { close, box };
  }

  return { h, api, toast, DAYS, fmtDate, iso, addDays, minutes, endTime, waLink, signaturePad, modal };
})();
