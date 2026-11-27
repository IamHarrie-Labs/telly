// The signed-in app around the campaigns: the side menu and the Dashboard, Scheduled posts,
// Calendar, Watching and Feedback screens. Everything shown comes from the saved campaigns.

import { chosenName, greeting, greetingName, rememberProfile, renderProfile } from '/profile.js';

const $ = (id) => document.getElementById(id);
const DAY = 86400000;
const KIND = { announcement: 'Announcement', reminder: 'Reminder', dayOf: 'Day of', followUp: 'Follow-up' };
const TONE = { announcement: 'lime', reminder: 'sky', dayOf: 'amber' };
// Screens opened from a campaign keep "Campaigns" highlighted in the menu.
const SECTION = { 'view-editor': 'view-list', 'view-campaign': 'view-list', 'view-review': 'view-list' };

let data = { campaigns: [], open: () => {}, create: () => {}, channel: () => '' };
const health = new Map(); // what Buffer showed for each campaign, from the last check
let month = null; // the first day of the month the calendar shows, in UTC
let browsed = false; // true once you move through the calendar yourself

function node(tag, className, text) {
  const out = document.createElement(tag);
  if (className) out.className = className;
  if (text != null) out.textContent = text;
  return out;
}

function button(className, onClick) {
  const out = node('button', className);
  out.type = 'button';
  out.addEventListener('click', onClick);
  return out;
}

const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const eventDate = (campaign) => campaign.facts.startsLocal.slice(0, 10);
const isOff = (campaign) => ['cancelled', 'postponed'].includes(campaign.facts.status);
const plural = (count, one, many) => (count === 1 ? one : many);
const format = (date, options) => new Intl.DateTimeFormat('en-GB', options).format(date);
const clock = (date) => format(date, { hour: 'numeric', minute: '2-digit', hour12: true });
// The event's own wall-clock time, as the organiser entered it.
// "9am", "6:30pm": short enough to sit on a calendar day.
const shortClock = (date) => clock(date).replace(':00', '').replace(/\s/g, '').toLowerCase();
const eventTime = (campaign) => clock(new Date(`${campaign.facts.startsLocal}:00`));
const dayHeading = (iso) => format(new Date(`${iso}T12:00:00`), { weekday: 'long', day: 'numeric', month: 'long' });

// Posts still to come, soonest first. Posts on hold are not in Buffer.
function waiting(now) {
  return data.campaigns
    .flatMap((campaign) => campaign.posts.filter((p) => !p.held).map((post) => ({ campaign, post, due: new Date(post.lastWrittenDueAt) })))
    .filter((item) => item.due > now)
    .sort((a, b) => a.due - b.due);
}

// The same post going to several channels at once is one line.
function grouped(posts) {
  const groups = new Map();
  for (const item of posts) {
    const key = `${item.campaign.id} ${item.post.kind} ${item.due.getTime()}`;
    if (!groups.has(key)) groups.set(key, { ...item, channels: [] });
    groups.get(key).channels.push(item.post.channelId);
  }
  return [...groups.values()];
}

const upcomingEvents = (today) => data.campaigns
  .filter((c) => !isOff(c) && eventDate(c) >= today)
  .sort((a, b) => a.facts.startsLocal.localeCompare(b.facts.startsLocal));

// A line that opens a campaign: a tile, a few lines of text and anything on the right.
function row(campaign, tile, lines, end) {
  const item = node('li');
  const open = button('row-button', () => data.open(campaign));
  tile.setAttribute('aria-hidden', 'true');
  const text = node('span', 'row-text');
  lines.forEach((line, i) => text.append(node('span', i ? 'muted' : '', line)));
  open.append(tile, text);
  if (end) open.append(end);
  item.append(open);
  return item;
}

function postRow({ campaign, post, due, channels }, when) {
  const kind = KIND[post.kind] || 'Post';
  const where = channels.length === 1 ? data.channel(channels[0]) : `${channels.length} channels`;
  return row(campaign, node('span', `dash-icon tone-${TONE[post.kind] || 'sage'}`, kind[0]),
    [campaign.facts.title, `${kind} · ${when(due)}`, where]);
}

function dateTile(campaign) {
  const date = new Date(`${eventDate(campaign)}T12:00:00`);
  const tile = node('span', 'date-tile');
  tile.append(node('b', '', date.getDate()), node('span', '', format(date, { month: 'short' })));
  return tile;
}

const eventRow = (campaign) => row(campaign, dateTile(campaign), [campaign.facts.title, `${eventTime(campaign)} · ${campaign.facts.venue}`]);
const emptyLine = (text) => node('li', 'muted empty-line', text);

// ---- Dashboard ---------------------------------------------------------------------

function renderStats(posts, events) {
  $('stat-events').textContent = events.length;
  $('stat-events-label').textContent = plural(events.length, 'Upcoming event', 'Upcoming events');
  $('stat-posts').textContent = posts.length;
  $('stat-posts-label').textContent = plural(posts.length, 'Post waiting to go out', 'Posts waiting to go out');
}

// Filled in once each campaign has been read back from Buffer. null means still checking.
export function setAttention(count) {
  $('stat-attention').textContent = count == null ? '…' : count;
  $('stat-attention-label').textContent = count == null ? 'Checking your posts' : plural(count, 'Campaign needs a look', 'Campaigns need a look');
}

function renderWeek(posts, now) {
  const days = Array.from({ length: 7 }, (_, i) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
  const counts = days.map((day) => posts.filter((p) => localDate(p.due) === localDate(day)).length);
  const total = counts.reduce((sum, n) => sum + n, 0);
  const most = Math.max(...counts, 1);
  $('dash-week-total').textContent = total ? `${total} ${plural(total, 'post goes', 'posts go')} out this week.` : 'Nothing goes out this week.';
  $('dash-week').replaceChildren(...days.map((day, i) => {
    const item = node('li', !counts[i] ? 'is-none' : counts[i] === most ? 'is-peak' : '');
    const bar = node('span', 'dash-bar');
    const fill = node('i');
    fill.style.height = `${Math.round((counts[i] / most) * 100)}%`;
    bar.append(fill);
    const count = node('b', '', counts[i]);
    const label = node('span', '', format(day, { weekday: 'short' }));
    for (const part of [count, bar, label]) part.setAttribute('aria-hidden', 'true');
    item.append(count, bar, label, node('span', 'sr-only', `${format(day, { weekday: 'long' })}: ${counts[i]} ${plural(counts[i], 'post', 'posts')}`));
    return item;
  }));
}

function renderNext(posts) {
  const next = grouped(posts).slice(0, 4);
  const when = (due) => `${format(due, { weekday: 'short', day: 'numeric', month: 'short' })}, ${clock(due)}`;
  $('dash-next-list').replaceChildren(...(next.length ? next.map((g) => postRow(g, when)) : [emptyLine('No posts are waiting.')]));
}

function renderUpcoming(events) {
  $('dash-upcoming').replaceChildren(...(events.length ? events.slice(0, 4).map(eventRow) : [emptyLine('No events coming up.')]));
}

function renderHero(events) {
  const next = events[0];
  const action = $('dash-hero-action');
  $('dash-hero-text').textContent = next
    ? `Next up is ${next.facts.title}. Change a detail once and check every correction before anything changes.`
    : 'Start with an event. When its details change, Telly shows every correction before anything changes.';
  action.textContent = next ? 'Open the next event' : 'New campaign';
  action.onclick = () => (next ? data.open(next) : data.create());
}

// ---- Scheduled posts ----------------------------------------------------------------

function renderPosts(posts) {
  const box = $('posts-all');
  if (!posts.length) {
    box.replaceChildren(node('p', 'dash-card empty-line muted', 'No posts are waiting. Schedule a campaign and its posts show up here.'));
    return;
  }
  const days = new Map();
  for (const group of grouped(posts)) {
    const day = localDate(group.due);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(group);
  }
  box.replaceChildren(...[...days].map(([day, groups]) => {
    const section = node('section', 'dash-card');
    const list = node('ul', 'rows');
    list.append(...groups.map((g) => postRow(g, clock)));
    section.append(node('h3', 'dash-h', dayHeading(day)), list);
    return section;
  }));
}

// ---- Calendar -------------------------------------------------------------------

function renderCalendar() {
  const today = localDate(new Date());
  const year = month.getUTCFullYear();
  const m = month.getUTCMonth();
  const heading = format(month, { timeZone: 'UTC', month: 'long', year: 'numeric' });
  $('cal-month').textContent = heading;
  const cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => node('span', 'cal-weekday', d));
  const length = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
  // Whole weeks, Monday to Sunday: the first and last rows run into the months either side.
  const lead = (month.getUTCDay() + 6) % 7;
  const total = Math.ceil((lead + length) / 7) * 7;
  const inMonth = [];
  // Every post Telly scheduled, on the day it goes out on your own clock (as Scheduled posts shows).
  // Posts on hold are out of Buffer, so they don't appear. Ones already sent stay, faded.
  const now = new Date();
  const sends = new Map();
  for (const group of grouped(data.campaigns.flatMap((campaign) => campaign.posts
    .filter((p) => !p.held)
    .map((post) => ({ campaign, post, due: new Date(post.lastWrittenDueAt) }))))) {
    const day = localDate(group.due);
    if (!sends.has(day)) sends.set(day, []);
    sends.get(day).push(group);
  }
  for (const list of sends.values()) list.sort((a, b) => a.due - b.due);
  for (let i = 0; i < total; i++) {
    const at = new Date(month.getTime() + (i - lead) * DAY);
    const date = at.toISOString().slice(0, 10);
    const other = at.getUTCMonth() !== m;
    const label = format(at, { timeZone: 'UTC', day: 'numeric', month: 'long' });
    const events = data.campaigns.filter((c) => eventDate(c) === date).sort((a, b) => a.facts.startsLocal.localeCompare(b.facts.startsLocal));
    if (!other) inMonth.push(...events);
    const cell = node('div', `cal-cell${other ? ' is-other' : ''}${date === today ? ' is-today' : ''}`);
    // Days from the months either side show their month too, so "1" can't be misread.
    cell.append(node('span', 'cal-number', other && at.getUTCDate() === 1 ? format(at, { timeZone: 'UTC', day: 'numeric', month: 'short' }) : at.getUTCDate()));
    for (const campaign of events) {
      const chip = button(`cal-event${isOff(campaign) ? ' is-off' : ''}`, () => data.open(campaign));
      chip.textContent = campaign.facts.title;
      chip.title = `${campaign.facts.title}, ${eventTime(campaign)}`;
      chip.setAttribute('aria-label', `Open ${campaign.facts.title}, ${label}`);
      cell.append(chip);
    }
    for (const { campaign, post, due, channels } of sends.get(date) || []) {
      const kind = KIND[post.kind] || 'Post';
      const sent = due <= now;
      const where = channels.length === 1 ? data.channel(channels[0]) : `${channels.length} channels`;
      const marker = button(`cal-post${sent ? ' is-sent' : ''}`, () => data.open(campaign));
      marker.append(node('span', `cal-post-kind tone-${TONE[post.kind] || 'sage'}`, kind[0]), node('span', 'cal-post-time', shortClock(due)));
      marker.title = `${kind} for ${campaign.facts.title}, ${clock(due)}, ${where}${sent ? ' (sent)' : ''}`;
      marker.setAttribute('aria-label', `${kind} for ${campaign.facts.title}, ${label} at ${clock(due)}${sent ? ', sent' : ''}. Open the campaign`);
      cell.append(marker);
    }
    cells.push(cell);
  }
  $('cal-grid').replaceChildren(...cells);
  $('cal-agenda-title').textContent = `Events in ${heading}`;
  $('cal-agenda').replaceChildren(...(inMonth.length ? inMonth.map(eventRow) : [emptyLine('No events this month.')]));
}

// ---- Watching -----------------------------------------------------------------------

function renderChecked() {
  const live = data.campaigns.filter((c) => !isOff(c) && c.posts.some((p) => !p.held));
  $('watch-campaigns').replaceChildren(...(live.length ? live.map((c) => {
    const flags = node('span', 'drift');
    for (const [label, tone] of health.get(c.id) || [['Checking', 'neutral']]) flags.append(node('span', `pill ${tone}`, label));
    const count = c.posts.filter((p) => !p.held).length;
    return row(c, dateTile(c), [c.facts.title, `${count} ${plural(count, 'post', 'posts')} scheduled`], flags);
  }) : [emptyLine('No campaigns have scheduled posts yet.')]));
}

// flags: [label, tone] pairs for one campaign, from reading its posts back.
export function setHealth(id, flags) {
  health.set(id, flags);
  renderChecked();
}

// ---- Search, drawing and navigation ---------------------------------------------

function applySearch() {
  const wanted = $('dash-search').value.trim().toLowerCase();
  let shown = 0;
  for (const item of $('campaign-list').children) {
    const match = !wanted || item.textContent.toLowerCase().includes(wanted);
    item.hidden = !match;
    if (match) shown += 1;
  }
  $('dash-no-match').hidden = !wanted || shown > 0;
}

const monthOf = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
};

// Call after the campaign list has been drawn, so the search applies to it.
export function renderDashboard({ campaigns, open, create, channel }) {
  data = { campaigns, open, create, channel };
  const now = new Date();
  const posts = waiting(now);
  const events = upcomingEvents(localDate(now));
  // The calendar opens on the next event's month. Once you move through it, it stays put.
  if (!browsed) month = monthOf(events[0] ? eventDate(events[0]) : localDate(now));
  const none = !campaigns.length;
  $('dash-overview').hidden = none;
  $('dash-empty').hidden = !none;
  $('dash-search').hidden = none;
  for (const item of document.querySelectorAll('[data-new]')) item.hidden = none;
  if (none) $('dash-search').value = '';
  renderStats(posts, events);
  renderWeek(posts, now);
  renderNext(posts);
  renderUpcoming(events);
  renderHero(events);
  renderPosts(posts);
  renderCalendar();
  renderChecked();
  applySearch();
}

// A different organization starts the calendar and the checks afresh.
export function resetDashboard() {
  browsed = false;
  health.clear();
}

function setMenu(open) {
  $('app-shell').classList.toggle('nav-open', open);
  $('app-menu').setAttribute('aria-expanded', String(open));
  $('app-backdrop').hidden = !open;
}

// Highlights the screen you are on and closes the phone menu.
export function markScreen(view) {
  const section = SECTION[view] || view;
  for (const link of document.querySelectorAll('.side-link, .side-account')) {
    if (link.dataset.go === section) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  setMenu(false);
}

function setupFeedback() {
  $('app-feedback-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const send = $('app-feedback-send');
    const result = $('app-feedback-result');
    const message = $('app-feedback-message').value.trim();
    if (message.length < 3) {
      result.textContent = 'Write a few words first.';
      return;
    }
    send.disabled = true;
    send.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, page: '/app/feedback' }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'That didn’t send. Try again in a moment.');
      $('app-feedback-message').value = '';
      result.textContent = 'Sent. Thanks for letting us know.';
    } catch (error) {
      result.textContent = error.message;
    } finally {
      send.disabled = false;
      send.removeAttribute('aria-busy');
    }
  });
}

let me = { demo: false, account: {}, org: '', avatar: '' };

/** The greeting and the sidebar's account block, from the account and any name chosen in Settings. */
export function showProfile(changes = {}) {
  me = { ...me, ...changes };
  const { demo, account, org, avatar } = me;
  if (demo) {
    $('campaigns-title').textContent = 'Your dashboard';
    renderProfile({ name: 'Demo workspace', org: 'Practice queue' });
    return;
  }
  const chosen = chosenName(account.id);
  $('campaigns-title').textContent = greeting(greetingName(account.name, chosen));
  renderProfile({ name: chosen || account.name || account.email || 'Your account', org, avatar });
  if (account.id) rememberProfile({ accountId: account.id, org, avatar });
}

export function startDashboard({ demo, account, go }) {
  showProfile({ demo, account: account || {}, org: account?.organizations?.[0]?.name || '' });
  if (demo) {
    const link = $('dash-buffer');
    link.href = '/auth/login';
    link.removeAttribute('target');
    $('dash-buffer-label').textContent = 'Connect Buffer';
  }

  for (const link of document.querySelectorAll('[data-go]')) link.addEventListener('click', () => go(link.dataset.go));
  for (const item of document.querySelectorAll('[data-new]')) item.addEventListener('click', () => data.create());
  $('app-menu').addEventListener('click', () => setMenu(!$('app-shell').classList.contains('nav-open')));
  $('app-backdrop').addEventListener('click', () => setMenu(false));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false); });

  $('dash-search').addEventListener('input', applySearch);
  const step = (by) => { browsed = true; month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + by, 1)); renderCalendar(); };
  $('cal-prev').addEventListener('click', () => step(-1));
  $('cal-next').addEventListener('click', () => step(1));
  $('cal-today').addEventListener('click', () => { browsed = true; month = monthOf(localDate(new Date())); renderCalendar(); });
  setupFeedback();
}
