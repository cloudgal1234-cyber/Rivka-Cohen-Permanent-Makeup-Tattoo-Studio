const form = document.getElementById('health-form');
const err = document.getElementById('form-error');
const RIVKA_WA = '972559202184';

// שדה פירוט מופיע כשעונים "כן"
form.querySelectorAll('.q-detail').forEach(d => {
  const row = d.closest('.q-row');
  row.querySelectorAll('input[type=radio]').forEach(r =>
    r.addEventListener('change', () => { d.hidden = r.value !== 'כן'; }));
});

// ברירת מחדל: התאריך של היום
const dateInput = form.elements.date;
if (!dateInput.value) dateInput.valueAsDate = new Date();

// חתימה
const canvas = document.getElementById('sig');
const ctx = canvas.getContext('2d');
let drawing = false, signed = false;
ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.strokeStyle = '#2c2b28';
const pos = e => {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
};
canvas.addEventListener('pointerdown', e => { drawing = true; ctx.beginPath(); ctx.moveTo(...pos(e)); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', e => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); signed = true; });
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => canvas.addEventListener(t, () => { drawing = false; }));
document.getElementById('sig-clear').addEventListener('click', () => { ctx.clearRect(0, 0, canvas.width, canvas.height); signed = false; });

function validate() {
  let ok = form.checkValidity();
  form.querySelectorAll('.q-row').forEach(row => {
    const answered = row.querySelector('input[type=radio]:checked');
    row.classList.toggle('missing', !answered);
    if (!answered) ok = false;
  });
  err.hidden = ok;
  if (!ok) (form.querySelector('.q-row.missing') || form.querySelector(':invalid'))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return ok;
}

function summary() {
  const f = form.elements;
  const lines = [
    'הצהרת בריאות וטופס הסכמה – רבקה כהן, קעקועים בחומר של איפור קבוע',
    `שם: ${f.name.value}`, `ת.ז.: ${f.id.value}`, `טלפון: ${f.phone.value}`,
    `תאריך: ${f.date.value}`, `קעקוע: ${f.treatment.value}`, '', 'שאלון בריאות:'
  ];
  const yes = [];
  form.querySelectorAll('.q-row').forEach((row, i) => {
    const a = row.querySelector('input[type=radio]:checked').value;
    const detail = row.querySelector('.q-detail');
    const txt = `${i + 1}. ${row.querySelector('.q-text').textContent} – ${a}` + (detail && a === 'כן' && detail.value ? ` (${detail.value})` : '');
    if (a === 'כן') yes.push(txt);
  });
  lines.push(yes.length ? 'תשובות "כן":\n' + yes.join('\n') : 'כל התשובות: לא');
  lines.push('', '✔ מאשרת את הצהרת הבריאות', '✔ קראתי ואני מסכימה לטופס ההסכמה לטיפול');
  return lines.join('\n');
}

form.addEventListener('submit', e => {
  e.preventDefault();
  if (!validate()) return;
  window.open(`https://wa.me/${RIVKA_WA}?text=${encodeURIComponent(summary())}`, '_blank', 'noopener');
});
document.getElementById('print-btn').addEventListener('click', () => window.print());
