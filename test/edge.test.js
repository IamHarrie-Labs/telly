import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFacts, planChange, printedChanged, publishAt, renderPost } from '../lib/campaign.js';
import { changeLog, renderCalendar, renderEventPage, renderFeed } from '../lib/eventpage.js';
import { feedUrl, readFeedToken } from '../lib/feed.js';

const facts = normalizeFacts({
  title: 'Community Workshop', startsLocal: '2026-12-12T14:00', timeZone: 'Africa/Lagos',
  venue: 'City Library', address: '12 Marina Road', price: 'Free entry', bookingUrl: 'https://example.org/book',
  pageUrl: 'https://usetelly.xyz/e/abcDEF2345',
});
const NOW = new Date('2026-11-11T09:00:00Z');

test('posts link to the event page instead of the booking link', () => {
  const text = renderPost('announcement', facts);
  assert.match(text, /Latest details: https:\/\/usetelly\.xyz\/e\/abcDEF2345$/);
  assert.doesNotMatch(text, /example\.org\/book/);
  assert.match(renderPost('reminder', { ...facts, status: 'postponed' }), /Updates: https:\/\/usetelly\.xyz\/e\/abcDEF2345/);
});

test('only a well-formed event page address is kept', () => {
  assert.equal(normalizeFacts({ ...facts, pageUrl: 'javascript:alert(1)' }).pageUrl, undefined);
  assert.equal(normalizeFacts({ ...facts, pageUrl: 'https://x.test/e/short' }).pageUrl, undefined);
});

test('a flyer goes out of date only when a printed detail changes', () => {
  assert.equal(printedChanged(facts, { ...facts, bookingUrl: 'https://example.org/other' }), false);
  assert.equal(printedChanged(facts, { ...facts, status: 'soldOut' }), false);
  assert.equal(printedChanged(facts, { ...facts, venue: 'Town Hall' }), true);
});

function campaignWithFlyer() {
  const flyer = { url: 'https://usetelly.xyz/img/x.png', altText: 'Poster for the workshop', flyer: true };
  const posts = [];
  const current = new Map();
  for (const kind of ['announcement', 'reminder', 'dayOf']) {
    const due = publishAt(kind, facts);
    const text = renderPost(kind, facts, due);
    posts.push({ kind, channelId: 'ch1', postId: `p_${kind}`, lastWrittenText: text, lastWrittenDueAt: due.toISOString(), writtenFacts: facts, card: flyer });
    current.set(`p_${kind}`, { id: `p_${kind}`, text, status: 'scheduled', dueAt: due.toISOString(), assets: [{ image: { altText: flyer.altText } }] });
  }
  return { campaign: { facts, posts }, current };
}
const cardFor = (f) => ({ url: `https://usetelly.xyz/card/${f.venue}.png`, altText: `Event card: ${f.title}.` });

test('the own flyer stays for a new booking link, and gives way to the card for a new venue', () => {
  const { campaign, current } = campaignWithFlyer();
  const same = planChange(campaign, { ...facts, bookingUrl: 'https://example.org/new' }, current, NOW, { cardFor });
  assert.ok(same.items.every((i) => i.type === 'unchanged'));
  const moved = planChange(campaign, { ...facts, venue: 'Town Hall' }, current, NOW, { cardFor });
  assert.ok(moved.items.every((i) => i.card?.url.includes('Town Hall')));
});

const campaign = {
  pageId: 'abcDEF2345', version: 2, createdAt: '2026-11-01T10:00:00Z', facts: { ...facts, venue: 'Town Hall' },
  history: [
    { type: 'created', at: '2026-11-01T10:00:00Z' },
    { type: 'change', at: '2026-11-05T10:00:00Z', before: facts, after: { ...facts, venue: 'Town Hall' } },
  ],
};

test('the page lists what changed, newest first, and skips undone changes', () => {
  assert.deepEqual(changeLog(campaign).map((c) => c.text), ['Now at Town Hall, 12 Marina Road']);
  assert.deepEqual(changeLog({ ...campaign, history: [{ ...campaign.history[1], undoneBy: 'x' }] }), []);
});

test('the event page escapes what organisers type', () => {
  const html = renderEventPage({ ...campaign, facts: { ...campaign.facts, title: '<script>alert(1)</script>' } }, NOW);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('the event page hides booking once sold out, and says when the event has finished', () => {
  assert.doesNotMatch(renderEventPage({ ...campaign, facts: { ...campaign.facts, status: 'soldOut' } }, NOW), /Book or find out more/);
  assert.match(renderEventPage(campaign, new Date('2027-01-01T00:00:00Z')), /This event has finished/);
});

test('the event page works in every status, including cancelled, which has no event card', () => {
  for (const status of ['upcoming', 'soldOut', 'postponed', 'cancelled']) {
    const html = renderEventPage({ ...campaign, facts: { ...campaign.facts, status } }, NOW);
    assert.match(html, /<h1>/, status);
    assert.equal(html.includes('og:image'), status !== 'cancelled', status);
  }
  const cancelled = renderEventPage({ ...campaign, facts: { ...campaign.facts, status: 'cancelled' } }, NOW);
  assert.match(cancelled, /This event has been cancelled/);
  assert.doesNotMatch(cancelled, /Book or find out more|Add to calendar/);
});

test('the calendar file is valid, stable and folds long lines', () => {
  const ics = renderCalendar({ ...campaign, facts: { ...campaign.facts, title: 'A'.repeat(120) } }, NOW);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /UID:abcDEF2345@usetelly\.xyz|UID:abcDEF2345@/);
  assert.match(ics, /SEQUENCE:2/);
  assert.match(ics, /DTSTART:20261212T130000Z/);
  assert.ok(ics.split('\r\n').every((line) => Buffer.byteLength(line) <= 75), 'no line longer than 75 octets');
  assert.match(renderCalendar({ ...campaign, facts: { ...campaign.facts, status: 'cancelled' } }, NOW), /STATUS:CANCELLED/);
});

test('one feed holds every event, each with the same id as its own calendar file', () => {
  const other = { ...campaign, pageId: 'xyzXYZ6789', facts: { ...campaign.facts, status: 'cancelled' } };
  const ics = renderFeed([campaign, other, { ...campaign, pageId: undefined }], NOW);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /END:VCALENDAR\r\n$/);
  assert.equal(ics.split('BEGIN:VEVENT').length - 1, 2, 'events without a page are left out');
  assert.match(ics, /UID:abcDEF2345@/);
  assert.match(ics, /UID:xyzXYZ6789@[\s\S]*STATUS:CANCELLED/);
  assert.match(ics, /X-WR-CALNAME:Telly events/);
  assert.equal(renderFeed([], NOW).split('BEGIN:VEVENT').length - 1, 0);
});

test('a feed address reads back only when its signature is right', () => {
  const token = new URL(feedUrl('acct_123')).pathname.replace(/^\/cal\//, '').replace(/\.ics$/, '');
  assert.equal(readFeedToken(token), 'acct_123');
  const [data, sig] = token.split('.');
  assert.equal(readFeedToken(`${Buffer.from('acct_999').toString('base64url')}.${sig}`), null, 'another account with the same signature');
  assert.equal(readFeedToken(`${data}.${'A'.repeat(22)}`), null, 'a made-up signature');
  assert.equal(readFeedToken('not-a-token'), null);
});
