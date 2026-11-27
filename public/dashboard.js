// The dashboard around the campaign list: counts, the week ahead, the next posts, a calendar
// and the side navigation. Everything shown comes from the saved campaigns.

const $ = (id) => document.getElementById(id);
const DAY = 86400000;
const KIND = { announcement: 'Announcement', reminder: 'Reminder', dayOf: 'Day of', followUp: 'Follow-up' };
const TONE = { announcement: 'lime', reminder: 'sky', dayOf: 'amber' };

let data = { campaigns: [], open: () => {}, create: () => {}, channel: () => '' };
let month = null; // the first day of the month the calendar shows, in UTC

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

// Posts still to come, soonest first. Posts on hold are not in Buffer.
function waiting(now) {
  return data.campaigns
    .flatMap((campaign) => campaign.posts.filter((p) => !p.held).map((post) => ({ campaign, post, due: new Date(post.lastWrittenDueAt) })))
    .filter((item) => item.due > now)
    .sort((a, b) => a.due - b.due);
}

const upcomingEvents = (today) => data.campaigns
  .filter((c) => !isOff(c) && eventDate(c) >= today)
  .sort((a, b) => a.facts.startsLocal.localeCompare(b.facts.startsLocal));

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
    const label = node('span', '', new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(day));
    for (const part of [count, bar, label]) part.setAttribute('aria-hidden', 'true');
    const long = new Intl.DateTimeFormat('en-GB', { weekday: 'long' }).format(day);
    item.append(count, bar, label, node('span', 'sr-only', `${long}: ${counts[i]} ${plural(counts[i], 'post', 'posts')}`));
    return item;
  }));
}

function renderNext(posts) {
  const list = $('dash-next-list');
  if (!posts.length) {
    list.replaceChildren(node('li', 'muted small-text', 'No posts are waiting.'));
    return;
  }
  // The same post going to several channels at once is one line.
  const groups = new Map();
  for (const item of posts) {
    const key = `${item.campaign.id} ${item.post.kind} ${item.due.getTime()}`;
    if (!groups.has(key)) groups.set(key, { ...item, channels: [] });
    groups.get(key).channels.push(item.post.channelId);
  }
  list.replaceChildren(...[...groups.values()].slice(0, 4).map(({ campaign, post, due, channels }) => {
    const item = node('li');
    const open = button('dash-row', () => data.open(campaign));
    const kind = KIND[post.kind] || 'Post';
    const tile = node('span', `dash-icon tone-${TONE[post.kind] || 'sage'}`, kind[0]);
    tile.setAttribute('aria-hidden', 'true');
    const text = node('span', 'dash-row-text');
    const when = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(due);
    const where = channels.length === 1 ? data.channel(channels[0]) : `${channels.length} channels`;
    text.append(node('span', '', campaign.facts.title), node('span', 'muted', `${kind} · ${when}`), node('span', 'muted', where));
    open.append(tile, text);
    item.append(open);
    return item;
  }));
}

function renderCalendar() {
  const today = localDate(new Date());
  const year = month.getUTCFullYear();
  const m = month.getUTCMonth();
  const heading = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(month);
  $('dash-month').textContent = heading;
  const cells = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => node('span', 'dash-weekday', d));
  for (let i = 0; i < (month.getUTCDay() + 6) % 7; i++) cells.push(node('span'));
  const length = new Date(Date.UTC(year, m + 1, 0)).getUTCDate();
  for (let day = 1; day <= length; day++) {
    const date = new Date(month.getTime() + (day - 1) * DAY).toISOString().slice(0, 10);
    const events = data.campaigns.filter((c) => eventDate(c) === date);
    const classes = `dash-date${date === today ? ' is-today' : ''}`;
    if (!events.length) {
      cells.push(node('span', classes, day));
      continue;
    }
    // With more than one event that day, the press opens the first; the others are in the list.
    const cell = button(`${classes} has-event`, () => data.open(events[0]));
    cell.textContent = day;
    const names = events.map((c) => c.facts.title).join(', ');
    cell.title = names;
    cell.setAttribute('aria-label', `${day} ${heading}: open ${names}`);
    cells.push(cell);
  }
  $('dash-days').replaceChildren(...cells);
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

// Call after the campaign list has been drawn, so the search applies to it.
export function renderDashboard({ campaigns, open, create, channel }) {
  data = { campaigns, open, create, channel };
  const now = new Date();
  const posts = waiting(now);
  const events = upcomingEvents(localDate(now));
  // The calendar opens on the next event's month, and then stays where you leave it.
  if (!month) {
    const [y, m] = (events[0] ? eventDate(events[0]) : localDate(now)).split('-').map(Number);
    month = new Date(Date.UTC(y, m - 1, 1));
  }
  $('dash-overview').hidden = !campaigns.length;
  $('dash-next-link').hidden = !campaigns.length;
  $('dash-search').hidden = !campaigns.length;
  if (!campaigns.length) $('dash-search').value = '';
  renderStats(posts, events);
  renderWeek(posts, now);
  renderNext(posts);
  renderCalendar();
  renderHero(events);
  applySearch();
}

// A different organization starts the calendar afresh.
export function resetCalendar() { month = null; }

// On a wide screen the account controls live in the side panel instead of the top bar.
const wide = window.matchMedia('(min-width: 900px)');
export function placeAccount() {
  const onDashboard = !$('view-campaigns').hidden;
  const inSide = onDashboard && wide.matches;
  const bar = $('account-bar');
  const target = inSide ? $('dash-account') : document.querySelector('.header-bar');
  if (bar.parentElement !== target) target.append(bar);
  document.body.classList.toggle('dash-wide', inSide);
  $('app-shell').classList.toggle('is-dash', onDashboard);
}

export function startDashboard({ demo, name }) {
  const full = String(name || '').trim();
  const first = full.includes('@') ? '' : full.split(/\s+/)[0];
  $('campaigns-title').textContent = demo ? 'Your dashboard' : first ? `Welcome back, ${first}` : 'Welcome back';
  if (demo) {
    const link = $('dash-buffer');
    link.href = '/auth/login';
    link.removeAttribute('target');
    $('dash-buffer-label').textContent = 'Connect Buffer to schedule for real';
  }
  wide.addEventListener('change', placeAccount);
  $('dash-search').addEventListener('input', applySearch);
  const step = (by) => { month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + by, 1)); renderCalendar(); };
  $('dash-prev').addEventListener('click', () => step(-1));
  $('dash-next-month').addEventListener('click', () => step(1));
  const links = [...document.querySelectorAll('[data-jump]')];
  for (const link of links) {
    link.addEventListener('click', () => {
      for (const other of links) other.removeAttribute('aria-current');
      link.setAttribute('aria-current', 'page');
      const target = $(link.dataset.jump);
      // The overview panels are hidden until there is a campaign: go to the list instead.
      const shown = target.offsetParent ? target : $('dash-campaigns');
      shown.scrollIntoView({ behavior: 'smooth', block: 'start' });
      shown.focus({ preventScroll: true });
    });
  }
}
