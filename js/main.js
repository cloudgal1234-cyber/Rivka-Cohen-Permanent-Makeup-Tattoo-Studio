const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// תפריט מובייל
const toggle = document.querySelector('.nav-toggle');
const nav = document.getElementById('main-nav');
toggle.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  toggle.setAttribute('aria-expanded', open);
});
nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
  nav.classList.remove('open');
  toggle.setAttribute('aria-expanded', 'false');
}));

// מסך טעינה → הפעלת אנימציות הפתיחה
const start = () => document.body.classList.add('loaded');
window.addEventListener('load', () => setTimeout(start, 900));
setTimeout(start, 3500); // גיבוי אם טעינה איטית

// פיצול כותרת ה-HERO למילים שעולות אחת אחרי השנייה
const h1 = document.querySelector('.hero h1');
if (h1) {
  let i = 0;
  const split = node => {
    [...node.childNodes].forEach(n => {
      if (n.nodeType === 3) {
        const frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach(part => {
          if (!part.trim()) { frag.append(part); return; }
          const w = document.createElement('span'); w.className = 'word';
          const inner = document.createElement('span'); inner.textContent = part;
          inner.style.transitionDelay = (0.35 + i++ * 0.12) + 's';
          w.append(inner); frag.append(w);
        });
        n.replaceWith(frag);
      } else if (n.nodeType === 1 && n.tagName !== 'BR') split(n);
    });
  };
  split(h1);
  h1.querySelector('.accent')?.classList.add('accent-shine');
}

// הכנת איורי הקו לציור עצמי
document.querySelectorAll('.lineart').forEach(svg =>
  svg.querySelectorAll('path, circle').forEach(p => p.setAttribute('pathLength', '1')));
document.querySelector('.hero-art')?.classList.add('draw');

// כיווני הופעה שונים ודירוג לפי סדר
const variants = [
  ['.about-media', 'from-right'], ['.about-text', 'from-left'],
  ['.hygiene-grid > div', 'from-right'], ['.hygiene-list', 'from-left'],
  ['.contact-info', 'from-right'], ['.map', 'zoom'],
  ['.cards .card', 'flip'], ['.cmp-card', 'zoom'], ['.g-item', 'zoom'], ['.tl-item', 'flip']
];
variants.forEach(([sel, cls]) => document.querySelectorAll(sel).forEach(el => el.classList.add('reveal', cls)));
document.querySelectorAll('.cards, .compare, .gallery-grid, .timeline, .steps, .rules, .tips, .hygiene-list').forEach(group =>
  [...group.children].forEach((el, i) => el.style.setProperty('--d', (i % 6) * 0.12 + 's')));

// הופעה בגלילה
const items = document.querySelectorAll('.reveal, .card-art, .g-art, .frame-art');
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      e.target.classList.add('visible');
      if (e.target.querySelector('.lineart') || e.target.classList.contains('card-art')) e.target.classList.add('draw');
      io.unobserve(e.target);
    });
  }, { threshold: 0.15 });
  items.forEach(el => io.observe(el));
} else {
  items.forEach(el => el.classList.add('visible', 'draw'));
}

// פס התקדמות, כותרת מוצללת ופרלקסה
const bar = document.querySelector('.scroll-progress');
const header = document.querySelector('.site-header');
const heroArt = document.querySelector('.hero-art');
const frame = document.querySelector('.about .frame');
let ticking = false;
const onScroll = () => {
  const y = window.scrollY;
  const max = document.documentElement.scrollHeight - innerHeight;
  bar.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
  header.classList.toggle('scrolled', y > 20);
  if (!reduceMotion) {
    if (heroArt && y < innerHeight) heroArt.style.translate = `0 ${y * 0.25}px`;
    if (frame) {
      const r = frame.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight) frame.style.translate = `0 ${(r.top - innerHeight / 2) * -0.06}px`;
    }
  }
  ticking = false;
};
addEventListener('scroll', () => { if (!ticking) { requestAnimationFrame(onScroll); ticking = true; } }, { passive: true });
onScroll();

if (finePointer && !reduceMotion) {
  // הטיה תלת-ממדית לכרטיסים
  document.querySelectorAll('.card, .cmp-card, .tl-item, .tip').forEach(el => {
    el.classList.add('tilt');
    el.addEventListener('mousemove', e => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      el.classList.add('tilting');
      el.style.transform = `perspective(900px) rotateY(${(x - .5) * 12}deg) rotateX(${(.5 - y) * 12}deg) translateY(-6px)`;
      el.style.setProperty('--mx', x * 100 + '%'); el.style.setProperty('--my', y * 100 + '%');
    });
    el.addEventListener('mouseleave', () => { el.classList.remove('tilting'); el.style.transform = ''; });
  });

  // כפתורים מגנטיים
  document.querySelectorAll('.hero-actions .btn, .contact .btn, .btn-insta').forEach(b => {
    b.classList.add('magnetic');
    b.addEventListener('mousemove', e => {
      const r = b.getBoundingClientRect();
      b.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * .25}px, ${(e.clientY - r.top - r.height / 2) * .35}px)`;
    });
    b.addEventListener('mouseleave', () => { b.style.transform = ''; });
  });

  // נצנצים שנשארים אחרי העכבר
  const shapes = ['✦', '♥', '✧', '·'];
  let last = 0;
  addEventListener('mousemove', e => {
    const now = performance.now();
    if (now - last < 45) return;
    last = now;
    const s = document.createElement('span');
    s.className = 'sparkle';
    s.textContent = shapes[Math.floor(Math.random() * shapes.length)];
    s.style.left = e.clientX + 'px'; s.style.top = e.clientY + 'px';
    s.style.setProperty('--sx', (Math.random() * 40 - 20) + 'px');
    s.style.setProperty('--sy', (Math.random() * 30 + 10) + 'px');
    s.style.fontSize = (10 + Math.random() * 8) + 'px';
    document.body.append(s);
    setTimeout(() => s.remove(), 900);
  }, { passive: true });
}

// הגדלת תמונות בגלריה
const lb = document.querySelector('.lightbox');
if (lb) {
  const lbImg = lb.querySelector('img'), lbCap = lb.querySelector('.lb-cap');
  const close = () => { lb.classList.remove('open'); setTimeout(() => { lb.hidden = true; }, 350); };
  document.querySelectorAll('.gallery-photos .g-item').forEach(fig => {
    fig.tabIndex = 0;
    const open = () => {
      const img = fig.querySelector('img');
      lbImg.src = img.src; lbImg.alt = img.alt; lbCap.textContent = fig.querySelector('figcaption')?.textContent || '';
      lb.hidden = false; requestAnimationFrame(() => lb.classList.add('open'));
      lb.querySelector('.lb-close').focus();
    };
    fig.addEventListener('click', open);
    fig.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  lb.addEventListener('click', e => { if (e.target !== lbImg) close(); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !lb.hidden) close(); });
}

document.getElementById('year').textContent = new Date().getFullYear();
