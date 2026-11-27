import crypto from 'node:crypto';
import { config } from './config.js';
import { cardFor } from './card.js';
import { shellPage } from './shell.js';
import { diffFacts, formatDay, formatTime, isOff, startsAt, whereLine } from './campaign.js';

// The always-current event page. Posts link here instead of straight to the booking link, so even
// a post that has already gone out (which no network lets anyone edit) leads people to the right
// date, venue and price. The page also offers a calendar file that updates itself, and its link
// preview uses the event card, so networks show the current details too.

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAGE_ID = /^[A-Za-z0-9]{8,16}$/;
const origin = () => new URL(config.redirectUri).origin;

export function newPageId() {
  const bytes = crypto.randomBytes(10);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

export const pageUrlFor = (pageId) => `${origin()}/e/${pageId}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const zoneName = (tz) => (tz.split('/').pop() || tz).replace(/_/g, ' ');

const STATUS = {
  soldOut: { label: 'Sold out', note: 'This event is sold out. Thank you to everyone who booked.' },
  postponed: { label: 'Postponed', note: "This event is postponed. The new date will appear here as soon as it's set." },
  cancelled: { label: 'Cancelled', note: 'This event has been cancelled. Sorry to everyone who was planning to come.' },
};

const TONE = { soldOut: 'info', postponed: 'warn', cancelled: 'bad' };

/** One line per change the organiser made, newest first, for the "What's changed" list. */
export function changeLog(campaign, max = 5) {
  const lines = [];
  for (const entry of [...(campaign.history || [])].reverse()) {
    if (entry.type !== 'change' || entry.undoneBy || !entry.before || !entry.after) continue;
    const { before, after } = entry;
    const start = startsAt(after);
    const parts = diffFacts(before, after).map((field) => {
      if (field === 'status') return { upcoming: 'back on', soldOut: 'sold out', postponed: 'postponed', cancelled: 'cancelled' }[after.status];
      if (field === 'title') return `renamed to ${after.title}`;
      if (field === 'startsLocal' || field === 'timeZone') return `moved to ${formatDay(start, after.timeZone)} at ${formatTime(start, after.timeZone)}`;
      if (field === 'venue' || field === 'address') return `now at ${whereLine(after)}`;
      if (field === 'price') return after.price ? `entry is now ${after.price}` : 'price removed';
      if (field === 'bookingUrl') return 'new booking link';
      return null;
    });
    const text = [...new Set(parts.filter(Boolean))].join(', ');
    if (text) lines.push({ at: entry.at, text: text[0].toUpperCase() + text.slice(1) });
    if (lines.length >= max) break;
  }
  return lines;
}

export function renderEventPage(campaign, now = new Date()) {
  const f = campaign.facts;
  const start = startsAt(f);
  const day = formatDay(start, f.timeZone);
  const time = formatTime(start, f.timeZone);
  const where = whereLine(f);
  const status = STATUS[f.status];
  const past = start.getTime() + 6 * 60 * 60 * 1000 < now.getTime();
  const card = cardFor(f); // none for a cancelled event
  const url = pageUrlFor(campaign.pageId);
  const map = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where)}`;
  const canBook = f.bookingUrl && !isOff(f.status) && f.status !== 'soldOut' && !past;
  const updated = new Date(campaign.updatedAt || campaign.history?.at(-1)?.at || campaign.createdAt);
  const changes = changeLog(campaign);
  const description = status ? `${status.label}: ${f.title}` : `${day} at ${time} · ${where}${f.price ? ` · ${f.price}` : ''}`;
  const fmtStamp = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: f.timeZone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(d));

  const head = `<title>${esc(f.title)} · Telly</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(status ? `${status.label}: ${f.title}` : f.title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
${card ? `<meta property="og:image" content="${esc(card.url)}">
<meta property="og:image:alt" content="${esc(card.altText)}">
<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}`;

  const main = `<header class="page-head">
  <div>
    <p class="page-sub">Event</p>
    <h1>${esc(f.title)}</h1>
  </div>
  <span class="pill ${status ? TONE[f.status] : 'ok'}">${esc(status ? status.label : past ? 'Finished' : 'Going ahead')}</span>
</header>
<div class="stack narrow-card">
${status ? `<p class="ev-banner" role="status">${esc(status.note)}</p>` : ''}
<dl class="dash-card ev-facts">
  <div><dt>When</dt><dd>${esc(day)} at ${esc(time)}<small>${esc(zoneName(f.timeZone))} time</small></dd></div>
  <div><dt>Where</dt><dd>${esc(f.venue)}${f.address && !f.venue.includes(f.address) ? `<small>${esc(f.address)}</small>` : ''}<small><a href="${esc(map)}" rel="noopener">Open in maps</a></small></dd></div>
  ${f.price ? `<div><dt>Entry</dt><dd>${esc(f.price)}</dd></div>` : ''}
</dl>
${past ? '<p class="muted">This event has finished.</p>' : `<div class="ev-actions">
  ${canBook ? `<a class="ev-button primary" href="${esc(f.bookingUrl)}" rel="noopener">Book or find out more</a>` : ''}
  ${f.status !== 'cancelled' ? `<a class="ev-button" href="/e/${esc(campaign.pageId)}.ics" download>Add to calendar</a>
  <a class="ev-button" href="${esc(url.replace(/^https?:/, 'webcal:'))}.ics">Subscribe for updates</a>` : ''}
</div>`}
${changes.length ? `<section class="dash-card">
  <h2 class="dash-h">What's changed</h2>
  <ul class="ev-log">${changes.map((c) => `<li><time datetime="${esc(c.at)}">${esc(fmtStamp(c.at))}</time>${esc(c.text)}</li>`).join('')}</ul>
</section>` : ''}
<p class="doc-note">Checked and kept current by the organiser with Telly. Last updated ${esc(fmtStamp(updated))}.</p>
</div>`;

  return shellPage({ head, main });
}

// ---- Calendar (RFC 5545) -------------------------------------------------------------

const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Lines longer than 75 octets are folded, continuing with a space.
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let chunk = '';
  for (const ch of line) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > (out.length ? 74 : 75)) {
      out.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  out.push(chunk);
  return out.join('\r\n ');
}

/**
 * A calendar with the one event. The UID stays the same and SEQUENCE goes up with each change,
 * so a calendar that subscribed (or re-imports the file) updates the event in place.
 */
export function renderCalendar(campaign, now = new Date()) {
  const f = campaign.facts;
  const start = startsAt(f);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000); // end time isn't known; two hours is a safe block
  const url = pageUrlFor(campaign.pageId);
  const title = STATUS[f.status] && f.status !== 'soldOut' ? `${STATUS[f.status].label}: ${f.title}` : f.title;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Telly//Event page//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(f.title)}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    'BEGIN:VEVENT',
    `UID:${campaign.pageId}@${new URL(url).host}`,
    `SEQUENCE:${campaign.version || 1}`,
    `DTSTAMP:${icsTime(now)}`,
    `LAST-MODIFIED:${icsTime(campaign.updatedAt || campaign.history?.at(-1)?.at || campaign.createdAt || now)}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsText(title)}`,
    `LOCATION:${icsText(whereLine(f))}`,
    `DESCRIPTION:${icsText([f.price, f.bookingUrl && `Booking: ${f.bookingUrl}`, `Latest details: ${url}`].filter(Boolean).join('\n'))}`,
    `URL:${url}`,
    `STATUS:${f.status === 'cancelled' ? 'CANCELLED' : f.status === 'postponed' ? 'TENTATIVE' : 'CONFIRMED'}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
