// Telly landing page motion. Plain DOM, no libraries.
// Everything here sits on top of readable HTML: with scripts off or reduced motion on,
// the page still reads top to bottom.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp01 = (value) => Math.min(1, Math.max(0, value));

let started = false;
const scrollHandlers = [];

export function startLanding() {
  if (started) return;
  started = true;

  setupHeader();
  setupHero();
  setupHeroVideo();
  setupHow();

  // One scroll loop for everything tied to the scroll position.
  let queued = false;
  const run = () => { queued = false; for (const handler of scrollHandlers) handler(); };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
  window.addEventListener('scroll', queue, { passive: true });
  window.addEventListener('resize', queue);
  run();

  // Play the entrance once the starting state has been painted.
  requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.add('is-ready')));
}

// ---- Header and sticky card: they move once the page has been scrolled ---------------

function setupHeader() {
  scrollHandlers.push(() => document.body.classList.toggle('is-scrolled', window.scrollY > 40));
}

// ---- Hero: pinned while scrolling. The shade deepens, copy steps back, words light up ----

function setupHero() {
  const hero = document.querySelector('[data-hero]');
  if (!hero) return;
  const pin = hero.querySelector('.hero-pin');
  const words = splitWords(hero.querySelector('[data-reveal]'));
  let lit = -1;

  scrollHandlers.push(() => {
    const rect = hero.getBoundingClientRect();
    const travel = hero.offsetHeight - window.innerHeight;
    const p = travel > 0 ? clamp01(-rect.top / travel) : 0;

    const frost = clamp01(p / 0.2); // the shade over the video deepens
    const copy = clamp01((p - 0.06) / 0.16); // the headline, line and facts step back
    const reveal = clamp01((p - 0.22) / 0.1); // the "Why Telly" statement arrives
    const read = clamp01((p - 0.3) / 0.58); // its words light up one by one

    pin.style.setProperty('--f', frost.toFixed(3));
    pin.style.setProperty('--c', copy.toFixed(3));
    pin.style.setProperty('--r', reveal.toFixed(3));
    pin.classList.toggle('is-revealing', reveal > 0);

    const count = reduceMotion.matches ? words.length : Math.round(read * words.length);
    if (count !== lit) {
      lit = count;
      words.forEach((word, i) => word.classList.toggle('is-lit', i < count));
    }
  });
}

function splitWords(block) {
  if (!block) return [];
  const words = [];
  for (const node of [...block.childNodes]) {
    if (node.nodeType !== Node.TEXT_NODE) continue;
    const fragment = document.createDocumentFragment();
    for (const part of node.textContent.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { fragment.append(part); continue; }
      const span = document.createElement('span');
      span.className = 'w';
      span.textContent = part;
      words.push(span);
      fragment.append(span);
    }
    node.replaceWith(fragment);
  }
  return words;
}

// ---- Hero video: plays only while in view, and stays on its still frame for reduced motion ----

function setupHeroVideo() {
  const video = document.querySelector('[data-hero-video]');
  if (!video) return;
  let visible = true;
  const sync = () => {
    // Browsers already pause muted video in background tabs, so only scrolling and reduced motion matter here.
    if (reduceMotion.matches || !visible) video.pause();
    else video.play().catch(() => {}); // autoplay blocked: the poster stays, which is fine
  };
  pauseOffscreen(video, (v) => { visible = v; sync(); });
  reduceMotion.addEventListener('change', sync);
  if (reduceMotion.matches) video.removeAttribute('autoplay');
  sync();
}

// ---- How it works: the pinned picture follows the step being read -----------------------

function setupHow() {
  const root = document.querySelector('[data-how]');
  if (!root) return;
  const steps = $$('[data-step]', root);
  const slides = $$('[data-slide]', root.querySelector('[data-how-media]'));
  const badge = root.querySelector('[data-how-badge]');
  const primary = badge.querySelector('[data-badge-primary]');
  const secondary = badge.querySelector('[data-badge-secondary]');
  const fills = steps.map((s) => s.querySelector('[data-rail-fill]'));

  // On phones each step shows its own copy of the matching picture.
  steps.forEach((stepNode, i) => {
    const holder = stepNode.querySelector('[data-step-media]');
    const copy = slides[i]?.cloneNode(true);
    if (!holder || !copy) return;
    copy.removeAttribute('data-slide');
    copy.classList.add('is-active');
    holder.append(copy);
  });

  let active = -1;
  let swapTimer = null;
  const setActive = (index) => {
    if (index === active) return;
    active = index;
    steps.forEach((s, i) => s.classList.toggle('is-active', i === index));
    slides.forEach((s, i) => s.classList.toggle('is-active', i === index));
    const slide = slides[index];
    badge.classList.add('is-swapping');
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => {
      primary.textContent = slide.dataset.primary;
      secondary.textContent = slide.dataset.secondary;
      badge.classList.remove('is-swapping');
    }, reduceMotion.matches ? 0 : 250);
  };
  setActive(0);

  scrollHandlers.push(() => {
    const line = window.innerHeight * 0.55;
    let current = 0;
    steps.forEach((stepNode, i) => {
      const rect = stepNode.getBoundingClientRect();
      if (rect.top < line) current = i;
      const progress = clamp01((line - rect.top) / rect.height);
      fills[i]?.style.setProperty('--p', reduceMotion.matches ? 1 : progress.toFixed(3));
    });
    setActive(current);
  });
}

// ---- Helpers -------------------------------------------------------------------------

function pauseOffscreen(node, callback) {
  if (!('IntersectionObserver' in window)) return;
  new IntersectionObserver(([entry]) => callback(entry.isIntersecting), { rootMargin: '100px' }).observe(node);
}
