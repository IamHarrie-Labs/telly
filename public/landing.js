// Telly landing page motion. Plain DOM, no libraries.
// Everything here sits on top of readable HTML: with scripts off or reduced motion on,
// the page still reads top to bottom.

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const desktop = window.matchMedia('(min-width: 900px)');
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp01 = (value) => Math.min(1, Math.max(0, value));

let started = false;
const scrollHandlers = [];

export function startLanding() {
  if (started) return;
  started = true;

  setupHeader();
  setupDropdown();
  $$('[data-timeline]').forEach(setupTimeline);
  setupHero();
  setupFlyer();
  setupCards();
  setupHow();
  setupBuilt();
  setupStickyCard();

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

// ---- Learn dropdown: click, Escape, outside click and arrow keys ----------------------

function setupDropdown() {
  for (const dropdown of $$('[data-dropdown]')) {
    const button = dropdown.querySelector('[data-dropdown-button]');
    const panel = dropdown.querySelector('[data-dropdown-panel]');
    const links = () => $$('a', panel);

    const open = (focusFirst = false) => {
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      if (focusFirst) links()[0]?.focus();
    };
    const close = (returnFocus = false) => {
      if (panel.hidden) return;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (returnFocus) button.focus();
    };

    button.addEventListener('click', () => (panel.hidden ? open() : close()));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); open(true); }
    });
    panel.addEventListener('keydown', (event) => {
      const items = links();
      const index = items.indexOf(document.activeElement);
      if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length].focus(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length].focus(); }
      if (event.key === 'Home') { event.preventDefault(); items[0].focus(); }
      if (event.key === 'End') { event.preventDefault(); items[items.length - 1].focus(); }
    });
    panel.addEventListener('click', (event) => { if (event.target.closest('a')) close(); });
    dropdown.addEventListener('focusout', (event) => { if (!dropdown.contains(event.relatedTarget)) close(); });
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(!panel.hidden); });
    document.addEventListener('pointerdown', (event) => { if (!dropdown.contains(event.target)) close(); });
  }
}

// ---- Timeline: drifting dashes along a line, and a pill that cycles its label ----------

// Dash widths and gaps in px: a fixed, irregular rhythm so the loop never looks mechanical.
const DASHES = [[122, 66], [40, 162], [58, 98], [126, 26], [104, 218], [128, 28], [64, 82], [48, 190], [12, 120], [86, 140]];

function dashGroup() {
  const group = document.createDocumentFragment();
  for (const [width, gap] of DASHES) {
    const dash = document.createElement('span');
    dash.className = 'dash';
    dash.style.width = `${width}px`;
    dash.style.marginRight = `${gap}px`;
    group.append(dash);
  }
  return group;
}

function setupTimeline(root) {
  const strip = root.querySelector('[data-dashes]');
  const track = document.createElement('span');
  track.className = 'dash-track';
  // Enough copies to cover wide screens twice, so sliding by half loops seamlessly.
  const half = Math.max(2, Math.ceil(window.innerWidth / 1600) + 1);
  for (let i = 0; i < half * 2; i += 1) track.append(dashGroup());
  track.style.setProperty('--dur', `${half * 32}s`);
  strip.append(track);
  pauseOffscreen(root, (visible) => { track.style.animationPlayState = visible ? 'running' : 'paused'; });

  const size = root.querySelector('[data-pill-size]');
  const text = root.querySelector('[data-pill-text]');
  const dot = root.querySelector('[data-pill-dot]');
  const labels = (root.dataset.labels || '').split(';').map((pair) => pair.split('|')).filter(([label]) => label);
  if (labels.length < 2) return;

  let index = 0;
  let visible = true;
  pauseOffscreen(root, (v) => { visible = v; });
  dot.style.background = labels[0][1];

  const naturalWidth = () => {
    const previous = size.style.width;
    size.style.width = 'auto';
    const width = size.getBoundingClientRect().width;
    size.style.width = previous;
    return width;
  };

  (async () => {
    size.style.width = `${naturalWidth()}px`;
    for (;;) {
      await sleep(3400);
      if (!visible || document.hidden) continue;
      index = (index + 1) % labels.length;
      const [label, color] = labels[index];
      root.dispatchEvent(new CustomEvent('timeline:label', { detail: { index, label } }));
      if (reduceMotion.matches) {
        text.textContent = label;
        dot.style.background = color;
        size.style.width = `${naturalWidth()}px`;
        continue;
      }
      text.classList.add('is-out');
      await sleep(300);
      text.classList.remove('is-out');
      text.classList.add('is-in');
      text.textContent = label;
      dot.style.background = color;
      size.style.width = `${naturalWidth()}px`;
      void text.offsetWidth; // apply the hidden starting state before animating in
      text.classList.remove('is-in');
    }
  })();
}

// ---- Hero: pinned while scrolling. Frost spreads, copy steps back, words light up ------

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

    const frost = clamp01(p / 0.2); // the frosted half spreads to full width
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

// ---- Flyer: the venue changes, a note goes up, the phone checks Buffer -------------------

function setupFlyer() {
  const flyer = document.querySelector('.flyer');
  const status = document.querySelector('[data-phone-status]');
  if (!flyer || !status) return;
  let visible = true;
  pauseOffscreen(flyer, (v) => { visible = v; });
  const wait = async (ms) => {
    await sleep(ms);
    while (!visible || document.hidden) await sleep(400);
  };
  const setStatus = (text, busy) => { status.textContent = text; status.classList.toggle('is-busy', busy); };

  (async () => {
    for (;;) {
      await wait(2400);
      flyer.classList.add('is-changed');
      setStatus('Venue changed', true);
      await wait(1500);
      setStatus('Updating 3 posts', true);
      await wait(1400);
      setStatus('Checked: 3 updated', false);
      await wait(3600);
      flyer.classList.remove('is-changed');
      setStatus('3 scheduled', false);
    }
  })();
}

// ---- The difference: expanding cards, with previous / next -----------------------------

function setupCards() {
  const root = document.querySelector('[data-cards]');
  if (!root) return;
  const track = root.querySelector('[data-cards-track]');
  const cards = $$('[data-card]', root);
  const prev = root.querySelector('[data-cards-prev]');
  const next = root.querySelector('[data-cards-next]');
  let active = 0;

  const activate = (index) => {
    active = Math.max(0, Math.min(cards.length - 1, index));
    cards.forEach((c, i) => c.classList.toggle('is-active', i === active));
    if (desktop.matches) {
      prev.disabled = active === 0;
      next.disabled = active === cards.length - 1;
    }
  };

  cards.forEach((card, i) => {
    card.addEventListener('mouseenter', () => { if (desktop.matches) activate(i); });
    card.addEventListener('focus', () => activate(i));
    card.addEventListener('click', () => activate(i));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') { event.preventDefault(); cards[Math.min(i + 1, cards.length - 1)].focus(); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); cards[Math.max(i - 1, 0)].focus(); }
    });
  });

  // Desktop: the buttons move the expanded card. Phone: they scroll the row one card.
  const step = (direction) => {
    if (desktop.matches) return activate(active + direction);
    const width = cards[0].getBoundingClientRect().width + 12;
    track.scrollBy({ left: direction * width, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  };
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));

  const sync = () => {
    if (desktop.matches) return;
    const max = track.scrollWidth - track.clientWidth;
    prev.disabled = track.scrollLeft <= 4;
    next.disabled = track.scrollLeft >= max - 4;
    const left = track.getBoundingClientRect().left;
    let nearest = 0;
    let best = Infinity;
    cards.forEach((card, i) => {
      const distance = Math.abs(card.getBoundingClientRect().left - left - 16);
      if (distance < best) { best = distance; nearest = i; }
    });
    cards.forEach((c, i) => c.classList.toggle('is-active', i === nearest));
  };
  track.addEventListener('scroll', () => requestAnimationFrame(sync), { passive: true });
  desktop.addEventListener('change', () => (desktop.matches ? activate(0) : sync()));
  if (desktop.matches) activate(0); else sync();
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

// ---- Built on Buffer: the signature draws itself when it comes into view -----------------

function setupBuilt() {
  const built = document.getElementById('built');
  if (!built || !('IntersectionObserver' in window)) { built?.classList.add('is-in'); return; }
  const observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) { built.classList.add('is-in'); observer.disconnect(); }
  }, { threshold: 0.3 });
  observer.observe(built);
}

// ---- Sticky card: always there, but steps aside for the closing call to action -----------

function setupStickyCard() {
  const card = document.getElementById('sticky-cta');
  const closing = document.querySelector('.closing-copy');
  if (!card || !closing) return;
  card.hidden = false;
  scrollHandlers.push(() => {
    const rect = closing.getBoundingClientRect();
    const away = rect.top < window.innerHeight && rect.bottom > 0;
    card.classList.toggle('is-away', away);
    card.toggleAttribute('inert', away);
  });
}

// ---- Helpers -------------------------------------------------------------------------

function pauseOffscreen(node, callback) {
  if (!('IntersectionObserver' in window)) return;
  new IntersectionObserver(([entry]) => callback(entry.isIntersecting), { rootMargin: '100px' }).observe(node);
}
