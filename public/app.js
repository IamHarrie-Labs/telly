// Telly front end. Plain DOM, no framework. All text from Buffer or the user is set with
// textContent (via el()), never as HTML.

import { startLanding } from '/landing.js';

// Report unexpected errors in this page to the server (a few per visit at most), so problems
// people hit show up in Telly's alerts instead of going unnoticed.
let reported = 0;
function reportError(message, source, line) {
  if (reported++ >= 5) return;
  fetch('/api/client-error', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: String(message || 'Unknown error').slice(0, 300), source, line, page: location.pathname }),
  }).catch(() => {});
}
addEventListener('error', (event) => reportError(event.message, event.filename, event.lineno));
addEventListener('unhandledrejection', (event) => reportError(event.reason?.message || event.reason, 'promise'));

const $ = (id) => document.getElementById(id);
const VIEWS = ['view-campaigns', 'view-editor', 'view-campaign', 'view-review'];
const KIND = { announcement: 'Announcement', reminder: 'Reminder', dayOf: 'Day of', followUp: 'Follow-up' };
const FIELD = { title: 'Title', startsLocal: 'Date and time', timeZone: 'Timezone', venue: 'Venue', address: 'Address', price: 'Price', bookingUrl: 'Booking link', status: 'Status' };

const state = {
  orgId: null,
  channels: [],
  campaigns: [],
  campaign: null, // the campaign being viewed
  editor: null, // { mode: 'new' } or { mode: 'change' }
  pendingFacts: null, // facts waiting to be scheduled or applied
  overwrite: new Set(), // conflicts the user chose to overwrite
  followUps: new Set(), // published posts that get a correction post
  edits: {}, // wording, time and leave-out choices from the preview, by `${channelId}:${kind}`
  version: null, // the campaign version the review was built from
  back: null, // what the Back button does in the current view
  flyer: false, // whether the server can read flyers
  demo: false, // a demo visitor: posts go to a practice queue, not Buffer
};

// ---- Small helpers -------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function message(id, text) {
  const node = $(id);
  node.textContent = text || '';
  node.hidden = !text;
}
const showError = (text) => { message('error', text); if (text) message('notice', ''); };
const showNotice = (text) => { message('notice', text); if (text) message('error', ''); };

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.errors?.join(' ') || body.error || `Request failed (${response.status})`);
    error.reconnect = Boolean(body.reconnect);
    error.body = body;
    throw error;
  }
  return body;
}

async function busy(button, task) {
  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  try {
    return await task();
  } catch (error) {
    if (error.reconnect) return location.reload();
    showError(error.message);
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }
}

function show(view, back = null) {
  for (const id of VIEWS) $(id).hidden = id !== view;
  // Replay the entrance animation each time a view opens.
  const node = $(view);
  node.classList.remove('view-enter');
  void node.offsetWidth;
  node.classList.add('view-enter');
  state.back = back;
  window.scrollTo({ top: 0 });
}

// Landing page for visitors, app shell once connected.
function setMode(mode) {
  const landing = mode === 'landing';
  document.body.dataset.mode = mode;
  $('signed-out').hidden = !landing;
  $('landing-nav').hidden = !landing;
  $('app-shell').hidden = landing;
  if (landing) startLanding();
  document.body.classList.remove('is-loading');
}

// Banners close when clicked.
for (const id of ['error', 'notice']) $(id).addEventListener('click', () => message(id, ''));

function formatWhen(iso, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso));
}

function eventWhen(facts) {
  const [date, time] = facts.startsLocal.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  // Display only: show the wall-clock time the organiser entered, in words.
  const asUtc = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(asUtc);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hour12: true }).format(asUtc);
  return `${day} at ${clock} (${facts.timeZone})`;
}

const channelName = (id) => {
  const channel = state.channels.find((c) => c.id === id);
  return channel ? `${channel.displayName || channel.name} · ${channel.service}` : 'Channel';
};

// ---- Preview aloud ---------------------------------------------------------------
// Uses the browser's speech voice. It previews the words a listener would hear; it is not
// a screen reader and does not reproduce any particular one.

const canSpeak = 'speechSynthesis' in window;
let speakingButton = null;

function listenButton(getText) {
  if (!canSpeak) return null;
  const button = el('button', { type: 'button', class: 'small', 'aria-pressed': 'false' }, 'Listen');
  button.addEventListener('click', () => {
    const wasThis = speakingButton === button;
    speechSynthesis.cancel();
    if (speakingButton) { speakingButton.textContent = 'Listen'; speakingButton.setAttribute('aria-pressed', 'false'); }
    speakingButton = null;
    if (wasThis) return;
    const utterance = new SpeechSynthesisUtterance(getText());
    utterance.lang = 'en-GB';
    utterance.onend = utterance.onerror = () => {
      if (speakingButton === button) { button.textContent = 'Listen'; button.setAttribute('aria-pressed', 'false'); speakingButton = null; }
    };
    speakingButton = button;
    button.textContent = 'Stop';
    button.setAttribute('aria-pressed', 'true');
    speechSynthesis.speak(utterance);
  });
  return button;
}

function postCard({ meta, pill, text, note, extra, listen = true }) {
  return el('article', { class: 'post' },
    el('div', { class: 'meta' }, el('span', {}, meta), el('span', { class: 'row', style: 'margin:0' }, pill || null, listen && text ? listenButton(() => text) : null)),
    typeof text === 'string' ? el('p', { class: 'text' }, text) : text,
    note ? el('p', { class: 'note' }, note) : null,
    extra || null,
  );
}

const pill = (label, tone) => el('span', { class: `pill ${tone}` }, label);

// ---- Campaign list ---------------------------------------------------------------

async function loadCampaigns() {
  state.campaigns = (await api('/api/campaigns')).campaigns;
  renderCampaigns();
}

function renderCampaigns() {
  const list = $('campaign-list');
  list.replaceChildren();
  $('new-campaign').hidden = !state.campaigns.length;
  if (!state.campaigns.length) {
    list.append(el('li', { class: 'card empty' },
      el('p', { class: 'statement' }, 'Start your first campaign.'),
      el('p', {}, 'Enter the event details once, or upload the flyer. Telly writes the announcement, reminder and day-of posts.'),
      el('button', { type: 'button', class: 'primary', onclick: () => openEditor('new') }, 'New campaign')));
    return;
  }
  const checks = [];
  for (const campaign of state.campaigns) {
    const status = campaign.facts.status === 'cancelled' ? 'Cancelled' : `${campaign.posts.length} scheduled`;
    const drift = el('span', { class: 'drift' });
    list.append(el('li', {},
      el('button', { type: 'button', onclick: () => openCampaign(campaign) },
        el('span', { class: 'list-main' },
          el('span', {}, campaign.facts.title),
          el('span', { class: 'muted' }, `${eventWhen(campaign.facts)} · ${status}`)),
        drift)));
    if (campaign.facts.status !== 'cancelled' && campaign.posts.length) checks.push([campaign, drift]);
  }
  checkDrift(checks);
}

// Reads each live campaign back from Buffer and flags anything that drifted since Telly
// last wrote it: a hand edit, a removed post, or a post that no longer matches the details.
async function checkDrift(checks) {
  const run = ++checkDrift.run;
  for (const [campaign, node] of checks.slice(0, 8)) {
    if (run !== checkDrift.run) return; // the list was redrawn
    node.replaceChildren(pill('Checking Buffer', 'neutral checking'));
    let posts;
    try {
      ({ posts } = await api(`/api/campaigns/${campaign.id}/status`));
    } catch {
      node.replaceChildren();
      continue;
    }
    const count = (types) => posts.filter((p) => types.includes(p.type)).length;
    const edited = count(['conflict', 'edited']);
    const missing = count(['missing']);
    const stale = count(['update', 'review']);
    const flags = [
      edited && pill(`${edited} edited in Buffer`, 'warn'),
      missing && pill(`${missing} removed in Buffer`, 'bad'),
      stale && pill(`${stale} out of date`, 'warn'),
    ].filter(Boolean);
    node.replaceChildren(...(flags.length ? flags : [pill('In sync', 'ok')]));
    const title = flags.length ? 'Changed in Buffer since Telly last wrote it' : 'Matches what Buffer holds';
    node.title = title;
  }
}
checkDrift.run = 0;

// ---- Editor: confirm the details --------------------------------------------------

const FORM_FIELDS = ['title', 'startsLocal', 'timeZone', 'venue', 'address', 'price', 'bookingUrl'];

function fillForm(facts) {
  const form = $('facts-form');
  for (const name of FORM_FIELDS) {
    form.elements[name].value = facts?.[name] ?? '';
    form.elements[name].classList.remove('is-filled');
  }
  if (!form.elements.timeZone.value) form.elements.timeZone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function readForm() {
  const form = $('facts-form');
  const facts = Object.fromEntries(FORM_FIELDS.map((name) => [name, form.elements[name].value.trim()]));
  if (state.editor.mode === 'change') facts.status = state.campaign.facts.status;
  return facts;
}

function renderChannelOptions() {
  const box = $('channel-options');
  box.replaceChildren();
  const usable = state.channels.filter((c) => !c.isDisconnected);
  if (!usable.length) {
    box.append(el('p', { class: 'muted', style: 'margin:0' }, 'No connected channels in this organization. Connect one in Buffer, then reload this page.'));
    return;
  }
  for (const channel of usable) {
    box.append(el('label', {},
      el('input', { type: 'checkbox', name: 'channel', value: channel.id, checked: usable.length === 1 }),
      channelName(channel.id)));
  }
}

function openEditor(mode) {
  state.editor = { mode };
  showError('');
  showNotice('');
  $('preview').hidden = true;
  if (mode === 'new') {
    $('editor-title').textContent = 'Confirm the details';
    $('editor-help').textContent = 'Telly writes every post from these details, so they only need to be right once.';
    $('editor-submit').textContent = 'Preview campaign';
    $('channel-field').hidden = false;
    fillForm(null);
    renderChannelOptions();
    $('flyer-drop').hidden = !state.flyer;
    $('flyer-status').textContent = '';
    show('view-editor', () => show('view-campaigns'));
  } else {
    $('editor-title').textContent = 'Change a detail';
    $('editor-help').textContent = 'Edit what changed. Telly shows every affected post before anything in Buffer changes.';
    $('editor-submit').textContent = 'Review changes';
    $('channel-field').hidden = true;
    $('flyer-drop').hidden = true;
    fillForm(state.campaign.facts);
    show('view-editor', () => openCampaign(state.campaign));
  }
  $('f-title').focus();
}

// ---- Flyer reading -----------------------------------------------------------------

// Shrinks the image in the browser so uploads stay small and fast; Claude reads ~1568px well.
async function shrinkImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

function localToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

$('flyer-file').addEventListener('change', async (event) => {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const drop = $('flyer-drop');
  const status = $('flyer-status');
  showError('');
  drop.classList.add('is-reading');
  drop.setAttribute('aria-busy', 'true');
  status.textContent = 'Reading the flyer…';
  try {
    const image = await shrinkImage(file);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { facts } = await api('/api/flyer', { method: 'POST', body: JSON.stringify({ image, timeZone, today: localToday() }) });
    const form = $('facts-form');
    const filled = [];
    for (const name of FORM_FIELDS) {
      if (!facts[name]) continue;
      form.elements[name].value = facts[name];
      form.elements[name].classList.add('is-filled');
      filled.push(name);
    }
    const missing = FORM_FIELDS.filter((name) => !facts[name] && ['title', 'startsLocal', 'venue'].includes(name));
    status.textContent = missing.length
      ? `Filled ${filled.length} details. Add the ${missing.map((m) => FIELD[m].toLowerCase()).join(' and ')}, then check the rest.`
      : `Filled ${filled.length} details from the flyer. Check each one before you preview.`;
    $('f-title').focus();
  } catch (error) {
    if (error.reconnect) return location.reload();
    status.textContent = '';
    showError(error.message === 'Not found' ? 'Reading flyers is not switched on.' : error.message);
  } finally {
    drop.classList.remove('is-reading');
    drop.removeAttribute('aria-busy');
  }
});

$('facts-form').addEventListener('input', (event) => event.target.classList?.remove('is-filled'));

$('facts-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const button = $('editor-submit');
  const facts = readForm();
  busy(button, async () => {
    showError('');
    if (state.editor.mode === 'new') {
      const channelIds = [...$('facts-form').querySelectorAll('input[name=channel]:checked')].map((i) => i.value);
      const services = servicesFor(channelIds);
      const result = await api('/api/campaigns/preview', { method: 'POST', body: JSON.stringify({ facts, channelIds, services }) });
      state.pendingFacts = { facts: result.facts, channelIds, services };
      state.edits = {};
      renderPreview(result.items, result.facts, result.card);
    } else {
      await reviewChange(facts, button);
    }
  });
});

const servicesFor = (ids) => Object.fromEntries(ids.map((id) => [id, state.channels.find((c) => c.id === id)?.service || '']));

// Length as the networks count it: an emoji or accented letter counts once.
const segmenter = 'Segmenter' in Intl ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
const textLength = (text) => (segmenter ? [...segmenter.segment(text)].length : Array.from(text).length);

// The wall-clock time of an instant in the event's timezone, for a datetime-local input.
function zonedLocal(iso, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function renderPreview(items, facts, card) {
  const list = $('preview-list');
  list.replaceChildren();
  const where = state.demo ? 'the practice queue' : 'Buffer';
  const updateCount = () => {
    const count = items.filter((i) => !i.skip && !state.edits[`${i.channelId}:${i.kind}`]?.skip).length;
    $('schedule').textContent = count === 1 ? `Schedule 1 post in ${where}` : `Schedule ${count} posts in ${where}`;
    $('schedule').hidden = count === 0;
  };
  for (const item of items) list.append(item.skip && !item.dueAt ? postCard({ meta: KIND[item.kind], text: '', note: item.skip }) : editablePost(item, facts, updateCount));

  $('card-preview').hidden = !card;
  if (card) {
    $('card-image').src = card.url;
    $('card-image').alt = card.altText;
    $('card-alt').textContent = `Alt text: ${card.altText}`;
    $('with-card').checked = true;
  }
  updateCount();
  $('preview').hidden = false;
  $('preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function editablePost(item, facts, updateCount) {
  const key = `${item.channelId}:${item.kind}`;
  const edit = () => (state.edits[key] ??= {});
  const area = el('textarea', { rows: '5', 'aria-label': `${KIND[item.kind]} wording` });
  area.value = item.text;
  const counter = el('span', { class: 'counter', 'aria-live': 'polite' });
  const reset = el('button', { type: 'button', class: 'small ghost', hidden: true }, "Use Telly's wording");
  const when = el('input', { type: 'datetime-local', value: zonedLocal(item.dueAt, facts.timeZone), 'aria-label': `${KIND[item.kind]} time, ${facts.timeZone}` });
  const leave = el('button', { type: 'button', class: 'small', 'aria-pressed': 'false' }, 'Leave out');
  const notes = el('p', { class: 'note' }, [item.skip, ...item.warnings].filter(Boolean).join(' '));
  notes.hidden = !notes.textContent;

  const refresh = () => {
    const n = textLength(area.value.trim());
    counter.textContent = `${n} / ${item.limit}`;
    counter.classList.toggle('over', n > item.limit);
    reset.hidden = area.value.trim() === item.template.trim();
  };
  area.addEventListener('input', () => {
    if (area.value.trim() === item.template.trim()) delete edit().text; else edit().text = area.value;
    refresh();
  });
  reset.addEventListener('click', () => { area.value = item.template; delete edit().text; refresh(); area.focus(); });
  when.addEventListener('change', () => { if (when.value) edit().dueLocal = when.value; });
  const box = el('article', { class: 'post post-edit' });
  leave.addEventListener('click', () => {
    const off = leave.getAttribute('aria-pressed') !== 'true';
    leave.setAttribute('aria-pressed', String(off));
    leave.textContent = off ? 'Include' : 'Leave out';
    box.classList.toggle('is-off', off);
    edit().skip = off;
    updateCount();
  });
  if (item.skip) { leave.setAttribute('aria-pressed', 'true'); leave.textContent = 'Include'; box.classList.add('is-off'); edit().skip = true; }
  refresh();

  box.append(
    el('div', { class: 'meta' }, el('span', {}, `${KIND[item.kind]} · ${channelName(item.channelId)}`), el('span', { class: 'row', style: 'margin:0' }, listenButton(() => area.value), leave)),
    area,
    el('div', { class: 'edit-row' }, el('label', { class: 'when' }, 'Goes out', when), el('span', { class: 'row', style: 'margin:0' }, reset, counter)),
    notes,
  );
  return box;
}

$('schedule').addEventListener('click', () => {
  busy($('schedule'), async () => {
    const { facts, channelIds, services } = state.pendingFacts;
    const body = { facts, channelIds, services, edits: state.edits, withCard: $('with-card').checked && !$('card-preview').hidden, organizationId: state.orgId };
    let result;
    try {
      result = await api('/api/campaigns', { method: 'POST', body: JSON.stringify(body) });
    } catch (error) {
      if (error.body?.summary) throw new Error(`Nothing was scheduled: ${error.body.results.map((r) => r.note).filter(Boolean).join(' ')}`);
      throw error;
    }
    await loadCampaigns();
    openCampaign(result.campaign);
    const where = state.demo ? 'the practice queue' : 'Buffer';
    showNotice(`Done: ${result.summary} in ${where}.${result.imageRefused ? ` ${where === 'Buffer' ? 'Buffer' : 'It'} wouldn't take the event card, so the posts went out without it.` : ''}`);
  });
});

// ---- Campaign view -----------------------------------------------------------------

function openCampaign(campaign) {
  state.campaign = campaign;
  const { facts } = campaign;
  const cancelled = facts.status === 'cancelled';
  $('campaign-title').textContent = facts.title;
  const status = $('campaign-status');
  status.className = `pill ${cancelled ? 'bad' : 'ok'}`;
  status.textContent = cancelled ? 'Cancelled' : `${campaign.posts.length} scheduled`;
  $('campaign-when').textContent = `${eventWhen(facts)} · ${[facts.venue, facts.address].filter(Boolean).join(', ')}`;

  renderCampaignPosts(campaign, null);
  $('campaign-actions').hidden = cancelled;
  $('campaign-fix').hidden = true;
  $('campaign-checked').textContent = '';
  show('view-campaign', () => show('view-campaigns'));

  // Then check what Buffer actually holds, so hand edits and published posts are visible.
  refreshCampaign(campaign);
}

// Reads the campaign back from Buffer and redraws it. Runs on open, every few minutes while
// the page is open, and whenever you come back to the tab.
function refreshCampaign(campaign) {
  if (!campaign.posts.length) return Promise.resolve();
  return api(`/api/campaigns/${campaign.id}/status`)
    .then(({ posts, checkedAt }) => {
      if (state.campaign !== campaign) return;
      renderCampaignPosts(campaign, new Map(posts.map((p) => [p.postId, p])));
      const stale = posts.filter((p) => p.type === 'update' || p.type === 'conflict').length;
      $('campaign-fix').hidden = stale === 0 || campaign.facts.status === 'cancelled';
      $('campaign-fix').textContent = stale === 1 ? 'Fix 1 out-of-date post' : `Fix ${stale} out-of-date posts`;
      const at = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(checkedAt));
      $('campaign-checked').textContent = `Checked with ${state.demo ? 'the practice queue' : 'Buffer'} at ${at}.`;
    })
    .catch(() => { /* keep the stored view; the next action will surface any error */ });
}

$('campaign-fix').addEventListener('click', () => busy($('campaign-fix'), () => reviewChange({ ...state.campaign.facts })));

const RECHECK_MS = 5 * 60 * 1000;
function recheck() {
  if (document.hidden || !state.orgId) return;
  if (!$('view-campaign').hidden && state.campaign) refreshCampaign(state.campaign);
  else if (!$('view-campaigns').hidden && state.campaigns.length) renderCampaigns();
}
setInterval(recheck, RECHECK_MS);
document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });

const LIVE = {
  unchanged: ['Up to date', 'ok', null],
  edited: ['Edited in Buffer', 'info', 'You changed this in Buffer. Telly keeps your wording and only fixes details that change.'],
  conflict: ['Edited in Buffer', 'warn', "You changed this in Buffer and it mentions an old detail. Press Fix to review the correction."],
  update: ['Out of date', 'warn', "Doesn't match the current details. Press Fix to review the correction."],
  published: ['Published', 'neutral', null],
  missing: ['Not in Buffer', 'neutral', 'This post was removed in Buffer.'],
  review: ['Time passed', 'neutral', null],
};

function postImage(image) {
  return image?.url ? el('img', { class: 'post-image', src: image.url, alt: image.altText || '', width: '96', height: '96', loading: 'lazy' }) : null;
}

function renderCampaignPosts(campaign, live) {
  const { facts } = campaign;
  const list = $('campaign-posts');
  list.replaceChildren();
  const posts = [...campaign.posts].sort((a, b) => new Date(a.lastWrittenDueAt) - new Date(b.lastWrittenDueAt));
  for (const post of posts) {
    const now = live?.get(post.postId);
    const [label, tone, note] = now ? LIVE[now.type] || [] : [];
    list.append(postCard({
      meta: `${KIND[post.kind]} · ${formatWhen(now?.dueAt || post.lastWrittenDueAt, facts.timeZone)} · ${channelName(post.channelId)}`,
      pill: label ? pill(label, tone) : null,
      text: now?.text ?? post.lastWrittenText,
      note,
      extra: [postImage(now ? now.image : post.card), state.demo && now && now.status === 'scheduled' ? practiceRow(campaign, post, now.text) : null],
    }));
  }
  if (!posts.length) list.append(el('p', { class: 'muted' }, facts.status === 'cancelled' ? "This event was called off, so Telly took its posts out of Buffer." : 'No scheduled posts.'));
}

// Demo only: act on a post the way an organiser might directly in Buffer, then see Telly
// catch it. These change the practice queue, never Telly's own record of the campaign.
function practiceRow(campaign, post, liveText) {
  const row = el('div', { class: 'practice' }, el('span', { class: 'practice-label' }, 'Practice, as if in Buffer'));
  const refresh = async (message) => {
    const { posts } = await api(`/api/campaigns/${campaign.id}/status`);
    if (state.campaign === campaign) renderCampaignPosts(campaign, new Map(posts.map((p) => [p.postId, p])));
    showNotice(message);
  };
  const act = (button, action, text, message) => busy(button, async () => {
    await api(`/api/demo/posts/${encodeURIComponent(post.postId)}`, { method: 'POST', body: JSON.stringify({ action, text }) });
    await refresh(message);
  });

  const edit = el('button', { type: 'button', class: 'small' }, 'Edit by hand');
  edit.addEventListener('click', () => {
    const area = el('textarea', { rows: '4', 'aria-label': 'Post text, as edited in Buffer' });
    area.value = liveText;
    const save = el('button', { type: 'button', class: 'small primary' }, 'Save in practice queue');
    const cancel = el('button', { type: 'button', class: 'small ghost', onclick: () => editor.replaceWith(row) }, 'Cancel');
    save.addEventListener('click', () => act(save, 'edit', area.value, 'Saved your edit. Telly noticed and marked the post "Edited in Buffer".'));
    const editor = el('div', { class: 'practice practice-edit' }, area, el('div', { class: 'row', style: 'margin:0' }, save, cancel));
    row.replaceWith(editor);
    area.focus();
  });
  const publish = el('button', { type: 'button', class: 'small' }, 'Publish now');
  publish.addEventListener('click', () => act(publish, 'publish', undefined, "Published. Telly can't edit a post that's already out, so if details change it will suggest a follow-up post."));
  const remove = el('button', { type: 'button', class: 'small' }, 'Remove');
  remove.addEventListener('click', () => act(remove, 'remove', undefined, "Removed. Telly now lists the post as missing, so you know it's gone."));
  row.append(edit, publish, remove);
  return row;
}

$('change-detail').addEventListener('click', () => openEditor('change'));
$('cancel-event').addEventListener('click', () => {
  busy($('cancel-event'), () => reviewChange({ ...state.campaign.facts, status: 'cancelled' }));
});

// ---- Review the corrections -------------------------------------------------------

async function reviewChange(facts) {
  const plan = await api(`/api/campaigns/${state.campaign.id}/changes/preview`, { method: 'POST', body: JSON.stringify({ facts }) });
  state.pendingFacts = { facts };
  state.overwrite = new Set();
  state.version = plan.version;
  // A published post that is now wrong gets a short correction unless you say otherwise.
  state.followUps = new Set(plan.items.filter((i) => i.type === 'published' && i.needsFollowUp).map((i) => i.postId));
  renderReview(plan, facts);
  show('view-review', () => openCampaign(state.campaign));
}

const sameWords = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();

function diffText(before, after) {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  // Show each removed line just above the line that took its place.
  const removed = oldLines.map((line, index) => ({ line, index })).filter((r) => !newLines.includes(r.line));
  const removedAt = (index) => removed.filter((r) => r.index === index).map((r) => el('span', { class: 'line-old' }, r.line));
  return el('p', { class: 'text' },
    newLines.map((l, i) => [removedAt(i), oldLines.includes(l) ? el('span', { style: 'display:block' }, l) : el('span', { class: 'line-new' }, l)]),
    removed.filter((r) => r.index >= newLines.length).map((r) => el('span', { class: 'line-old' }, r.line)));
}

function describeValue(key, value) {
  if (!value) return 'none';
  if (key === 'startsLocal') return eventWhen({ startsLocal: value, timeZone: state.campaign.facts.timeZone }).replace(/ \(.*\)$/, '');
  if (key === 'status') return value === 'cancelled' ? 'Cancelled' : 'Going ahead';
  return value;
}

function renderReview(plan, facts) {
  const before = state.campaign.facts;
  const changes = $('review-changes');
  changes.replaceChildren();
  for (const key of plan.changedFields) {
    changes.append(el('li', {}, `${FIELD[key]}: `,
      el('span', { class: 'from' }, describeValue(key, before[key])), ' → ',
      el('span', { class: 'to' }, describeValue(key, facts[key]))));
  }
  if (!plan.changedFields.length) changes.append(el('li', { class: 'muted' }, 'No details changed. Telly checked your posts against the current details.'));

  const list = $('review-items');
  list.replaceChildren();
  for (const item of plan.items) list.append(reviewCard(item));
  updateApply(plan);
}

function reviewCard(item) {
  const meta = `${KIND[item.kind]} · ${channelName(item.channelId)}`;
  switch (item.type) {
    case 'update': {
      const textChanges = !sameWords(item.current, item.proposed);
      const notes = [
        item.dueAt && `New time: ${formatWhen(item.dueAt, state.pendingFacts.facts.timeZone)}.`,
        item.card && 'The event card is redrawn with the new details.',
        item.ownWords && textChanges && 'Your wording stays. Only the changed details are swapped.',
      ].filter(Boolean);
      return postCard({
        meta,
        pill: pill(item.dueAt ? 'Will update and move' : 'Will update', 'info'),
        text: textChanges ? diffText(item.current, item.proposed) : item.current,
        note: notes.join(' ') || null,
        listen: false,
        extra: [postImage(item.card), el('div', { class: 'row', style: 'margin-top:8px' }, listenButton(() => item.proposed))],
      });
    }
    case 'delete':
      return postCard({ meta, pill: pill('Will remove', 'bad'), text: item.current, note: item.reason, listen: false });
    case 'conflict': {
      const keep = el('button', { type: 'button', class: 'small', 'aria-pressed': 'true' }, 'Keep mine');
      const use = el('button', { type: 'button', class: 'small', 'aria-pressed': 'false' }, 'Use correction');
      const choose = (overwrite) => {
        keep.setAttribute('aria-pressed', String(!overwrite));
        use.setAttribute('aria-pressed', String(overwrite));
        if (overwrite) state.overwrite.add(item.postId); else state.overwrite.delete(item.postId);
        updateApply();
      };
      keep.addEventListener('click', () => choose(false));
      use.addEventListener('click', () => choose(true));
      return postCard({
        meta,
        pill: pill('You edited this', 'warn'),
        text: diffText(item.current, item.proposed),
        note: `${item.note} Keep mine leaves your post as it is${item.dueAt ? ' (it still moves to the new time)' : ''}.`,
        listen: false,
        extra: el('div', { class: 'choice' }, keep, use),
      });
    }
    case 'published': {
      if (!item.needsFollowUp) return postCard({ meta, pill: pill('Published', 'neutral'), text: item.current, note: 'Already out, and still correct.', listen: false });
      const post = el('button', { type: 'button', class: 'small', 'aria-pressed': 'true' }, 'Post this correction');
      const skip = el('button', { type: 'button', class: 'small', 'aria-pressed': 'false' }, "I'll handle it");
      const choose = (on) => {
        post.setAttribute('aria-pressed', String(on));
        skip.setAttribute('aria-pressed', String(!on));
        if (on) state.followUps.add(item.postId); else state.followUps.delete(item.postId);
        updateApply();
      };
      post.addEventListener('click', () => choose(true));
      skip.addEventListener('click', () => choose(false));
      return postCard({
        meta,
        pill: pill('Already published', 'warn'),
        text: item.current,
        note: `${item.note} Telly can post this correction on the same channel as soon as Buffer allows: "${item.suggested.replace(/\n/g, ' · ')}"`,
        listen: false,
        extra: el('div', { class: 'choice' }, post, skip),
      });
    }
    case 'review':
      return postCard({ meta, pill: pill('Needs review', 'warn'), text: item.proposed || item.current, note: `${item.note} Edit its time in Buffer, or remove it there.`, listen: false });
    case 'missing':
      return postCard({ meta, pill: pill('Not in Buffer', 'neutral'), text: '', note: `${item.note} Telly will stop tracking it.`, listen: false });
    case 'edited':
      return postCard({ meta, pill: pill('Your wording', 'neutral'), text: item.current || 'You changed this post in Buffer. It doesn\'t mention anything that changed, so it stays as it is.', listen: false });
    default:
      return postCard({ meta, pill: pill('No change', 'neutral'), text: 'This post already matches the details.', listen: false });
  }
}

let lastPlan = null;
function updateApply(plan = lastPlan) {
  lastPlan = plan;
  const where = state.demo ? 'the practice queue' : 'Buffer';
  const has = (type) => plan.items.filter((i) => i.type === type);
  const changing = has('update').length + has('conflict').filter((i) => state.overwrite.has(i.postId)).length;
  const keeping = has('conflict').filter((i) => !state.overwrite.has(i.postId)).length;
  const removing = has('delete').length;
  const following = new Set(has('published').filter((i) => state.followUps.has(i.postId)).map((i) => i.channelId)).size;
  const dropping = has('missing').length;
  const waiting = has('review').length + has('published').filter((i) => i.needsFollowUp && !state.followUps.has(i.postId)).length;
  const posts = (n) => `${n} post${n === 1 ? '' : 's'}`;
  const parts = [
    changing && `change ${posts(changing)}`,
    keeping && `keep ${keeping === 1 ? 'your wording on 1 post' : `your wording on ${keeping} posts`}`,
    removing && `remove ${posts(removing)}`,
    following && `post ${following === 1 ? 'a correction' : `${following} corrections`}`,
    dropping && `stop tracking ${posts(dropping)} deleted in Buffer`,
  ].filter(Boolean);
  const button = $('apply');
  button.hidden = parts.length === 0;
  button.textContent = removing && !changing ? `Remove ${posts(removing)}` : 'Apply';
  $('review-summary').textContent = parts.length === 0
    ? `Nothing to send to ${where}.`
    : `Telly will ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}${waiting ? `, and leave ${posts(waiting)} for you` : ''}.`;
}

$('apply').addEventListener('click', () => {
  busy($('apply'), async () => {
    const result = await api(`/api/campaigns/${state.campaign.id}/changes/apply`, {
      method: 'POST',
      body: JSON.stringify({ facts: state.pendingFacts.facts, approve: 'all', overwrite: [...state.overwrite], followUps: [...state.followUps], version: state.version }),
    });
    await loadCampaigns();
    openCampaign(result.campaign);
    const failed = result.results.filter((r) => r.status === 'failed');
    if (failed.length) showError(`${result.summary}. ${failed.map((f) => `${KIND[f.kind]}: ${f.note}`).join(' ')}`);
    else showNotice(`Checked in ${state.demo ? 'the practice queue' : 'Buffer'}: ${result.summary}.`);
  });
});

// ---- Navigation, session, org ------------------------------------------------------

for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => { showError(''); state.back?.(); });
}
$('new-campaign').addEventListener('click', () => openEditor('new'));

async function loadChannels() {
  state.channels = (await api(`/api/channels?organizationId=${encodeURIComponent(state.orgId)}`)).channels;
}

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) {
    showError(params.get('error') === 'access_denied' ? 'You declined access on Buffer.' : "Couldn't connect to Buffer. Try again.");
    history.replaceState(null, '', '/');
  }

  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  $('tz-list').append(...zones.map((z) => el('option', { value: z })));

  let session;
  try {
    session = await api('/api/session');
  } catch (error) {
    setMode('landing');
    if (!error.reconnect) showError(error.message);
    return;
  }
  if (!session.connected) {
    setMode('landing');
    return;
  }

  $('account-bar').hidden = false;
  $('lab').hidden = !session.lab;
  state.flyer = Boolean(session.flyer);
  state.demo = Boolean(session.demo);
  $('demo-badge').hidden = !state.demo;
  $('demo-connect').hidden = !state.demo;
  $('demo-note').hidden = !state.demo;
  $('account-line').hidden = state.demo;
  $('logout').textContent = state.demo ? 'Leave demo' : 'Disconnect';
  $('account-line').textContent = session.account.name || session.account.email;
  const select = $('org');
  select.append(...session.account.organizations.map((o) => el('option', { value: o.id }, o.name)));
  select.hidden = session.account.organizations.length < 2;
  state.orgId = select.value;
  select.addEventListener('change', async () => {
    state.orgId = select.value;
    await loadChannels().catch((e) => showError(e.message));
    show('view-campaigns');
  });

  $('delete-data').hidden = false;
  $('delete-data').addEventListener('click', () => {
    const ok = confirm('Delete every campaign Telly has saved for your account, and turn off watching? Posts already in Buffer stay in Buffer. This cannot be undone.');
    if (!ok) return;
    busy($('delete-data'), async () => {
      const { removed } = await api('/api/campaigns', { method: 'DELETE' });
      await loadCampaigns();
      loadWatch();
      show('view-campaigns');
      showNotice(`Deleted ${removed} saved campaign${removed === 1 ? '' : 's'} from Telly.`);
    });
  });

  $('logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    location.reload();
  });

  try {
    await Promise.all([loadChannels(), loadCampaigns()]);
  } catch (error) {
    showError(error.message);
  }
  setMode('app');
  show('view-campaigns');
  if (!state.demo) loadWatch();
}

// ---- Background watching -----------------------------------------------------------

async function loadWatch() {
  try {
    renderWatch(await api('/api/watch'));
  } catch {
    $('watch').hidden = true;
  }
}

function renderWatch(watch) {
  $('watch').hidden = !watch.available;
  if (!watch.available) return;
  const where = watch.emails ? (watch.enabled && watch.email ? `emails ${watch.email}` : 'emails you') : 'shows it here';
  $('watch-pill').replaceChildren(watch.enabled ? pill('On', 'ok') : pill('Off', 'neutral'));
  const every = watch.everyHours === 1 ? 'every hour' : `every ${watch.everyHours || 6} hours`;
  $('watch-explain').textContent = watch.enabled
    ? `Telly checks your upcoming posts in Buffer ${every}, even with this page closed, and ${where} if a post fails, a channel disconnects or pauses, or posts fall out of date. It keeps going after you disconnect. Turn it off here to stop.`
    : `Telly can check your upcoming posts in Buffer ${every}, even with this page closed, and ${where} if a post fails, a channel disconnects or pauses, or posts fall out of date. To do that, it keeps your Buffer connection in its database, encrypted. Turning watching off deletes it.`;

  const issues = watch.enabled ? watch.issues || [] : [];
  $('watch-issues').replaceChildren(...issues.map((issue) => el('li', {}, issue.text)));
  $('watch-issues').hidden = !issues.length;

  let status = '';
  if (watch.lastError === 'reconnect') status = 'Buffer stopped accepting Telly’s stored connection. Disconnect and connect again to restart watching.';
  else if (watch.enabled && watch.checkedAt) {
    const at = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(watch.checkedAt));
    status = issues.length ? `Last checked ${at}.` : `Last checked ${at}. Nothing needs you.`;
  } else if (watch.enabled) status = 'Turned on. The first check runs within the next half hour.';
  $('watch-status').textContent = status;

  $('watch-form').hidden = watch.enabled;
  $('watch-off').hidden = !watch.enabled;
  $('watch-email-field').hidden = !watch.emails;
  $('watch-email').required = watch.emails;
  if (watch.email) $('watch-email').value = watch.email;
}

$('watch-form').addEventListener('submit', (event) => {
  event.preventDefault();
  busy($('watch-on'), async () => {
    const watch = await api('/api/watch', { method: 'POST', body: JSON.stringify({ email: $('watch-email').value.trim() }) });
    renderWatch(watch);
    showNotice('Watching is on.');
  });
});

$('watch-off').addEventListener('click', () => {
  busy($('watch-off'), async () => {
    const watch = await api('/api/watch', { method: 'DELETE' });
    if (watch.reconnect) return location.reload();
    renderWatch(watch);
    showNotice('Watching is off, and Telly deleted the stored Buffer connection.');
  });
});

// ---- Developer lab -----------------------------------------------------------------

const labOutput = (value) => { $('lab-out').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };

$('lab-read').addEventListener('click', async () => {
  try {
    const id = $('post-id').value.trim();
    if (!id) throw new Error('Enter a post ID first.');
    labOutput(await api(`/api/lab/post?id=${encodeURIComponent(id)}`));
  } catch (error) {
    labOutput(error.message);
  }
});

$('lab-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = {
    postId: String(form.get('postId') || '').trim(),
    text: String(form.get('text') || '') || undefined,
    imageUrl: String(form.get('imageUrl') || '').trim() || undefined,
    altText: String(form.get('altText') || '').trim() || undefined,
  };
  try {
    labOutput('Working…');
    const result = await api('/api/lab/edit', { method: 'POST', body: JSON.stringify(payload) });
    labOutput(result.checks ? { checks: result.checks, after: result.after } : result);
  } catch (error) {
    labOutput(error.message);
  }
});

init();
