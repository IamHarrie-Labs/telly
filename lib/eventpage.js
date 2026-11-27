import crypto from 'node:crypto';
import { config } from './config.js';
import { cardFor } from './card.js';
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

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(f.title)} · Telly</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(status ? `${status.label}: ${f.title}` : f.title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
${card ? `<meta property="og:image" content="${esc(card.url)}">
<meta property="og:image:alt" content="${esc(card.altText)}">
<meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
<link rel="icon" href="/favicon.ico">
<style>
@font-face { font-family: Poppins; font-weight: 400; src: url(/fonts/poppins-400.woff2) format('woff2'); font-display: swap; }
@font-face { font-family: Poppins; font-weight: 500; src: url(/fonts/poppins-500.woff2) format('woff2'); font-display: swap; }
@font-face { font-family: Poppins; font-weight: 600; src: url(/fonts/poppins-600.woff2) format('woff2'); font-display: swap; }
:root { --paper: #f4f4f1; --card: #ffffff; --ink: #1a1915; --soft: #5d5b52; --line: #e6e5df; --accent: #1a1915; --lime: #d9f26b; --warn: #9a3412; --warn-bg: #fdecdf; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 400 17px/1.55 Poppins, system-ui, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 40px 16px 56px; }
.eyebrow { font-size: 15px; font-weight: 500; color: var(--soft); margin: 0 0 10px; }
h1 { font-size: clamp(34px, 7vw, 52px); line-height: 1.02; letter-spacing: -.045em; margin: 0 0 24px; font-weight: 500; }
.banner { border-radius: 14px; padding: 14px 16px; margin: 0 0 22px; background: var(--warn-bg); color: var(--warn); font-weight: 600; }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: 24px; padding: 6px 22px; }
.row { display: flex; gap: 14px; padding: 16px 0; border-bottom: 1px solid var(--line); }
.row:last-child { border-bottom: 0; }
.row dt { width: 70px; flex: none; color: var(--soft); font-size: 14px; padding-top: 2px; }
.row dd { margin: 0; font-weight: 500; }
.row dd small { display: block; font-weight: 400; color: var(--soft); font-size: 14px; }
a { color: var(--ink); }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 22px 0 0; }
.btn { display: inline-flex; align-items: center; min-height: 48px; padding: 0 22px; border-radius: 999px; border: 1px solid var(--line); background: var(--card); text-decoration: none; font-weight: 500; font-size: 15px; }
.btn.primary { background: var(--lime); border-color: var(--lime); color: var(--ink); }
.past { color: var(--soft); margin: 22px 0 0; }
h2 { font-size: 20px; letter-spacing: -.02em; color: var(--ink); margin: 40px 0 10px; font-weight: 500; }
ul.log { list-style: none; margin: 0; padding: 0; }
ul.log li { padding: 10px 0; border-bottom: 1px solid var(--line); }
ul.log time { display: block; color: var(--soft); font-size: 13px; }
footer { margin-top: 40px; color: var(--soft); font-size: 13px; }
</style>
</head>
<body>
<main>
<p class="eyebrow">Event</p>
<h1>${esc(f.title)}</h1>
${status ? `<p class="banner" role="status">${esc(status.note)}</p>` : ''}
<dl class="panel">
  <div class="row"><dt>When</dt><dd>${esc(day)} at ${esc(time)}<small>${esc(zoneName(f.timeZone))} time</small></dd></div>
  <div class="row"><dt>Where</dt><dd>${esc(f.venue)}${f.address && !f.venue.includes(f.address) ? `<small>${esc(f.address)}</small>` : ''}<small><a href="${esc(map)}" rel="noopener">Open in maps</a></small></dd></div>
  ${f.price ? `<div class="row"><dt>Entry</dt><dd>${esc(f.price)}</dd></div>` : ''}
</dl>
${past ? '<p class="past">This event has finished.</p>' : `<div class="actions">
  ${canBook ? `<a class="btn primary" href="${esc(f.bookingUrl)}" rel="noopener">Book or find out more</a>` : ''}
  ${f.status !== 'cancelled' ? `<a class="btn" href="/e/${esc(campaign.pageId)}.ics" download>Add to calendar</a>
  <a class="btn" href="${esc(url.replace(/^https?:/, 'webcal:'))}.ics">Subscribe for updates</a>` : ''}
</div>`}
${changes.length ? `<h2>What's changed</h2>
<ul class="log">${changes.map((c) => `<li><time datetime="${esc(c.at)}">${esc(fmtStamp(c.at))}</time>${esc(c.text)}</li>`).join('')}</ul>` : ''}
<footer>Checked and kept current by the organiser with Telly. Last updated ${esc(fmtStamp(updated))}.</footer>
</main>
</body>
</html>`;
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
