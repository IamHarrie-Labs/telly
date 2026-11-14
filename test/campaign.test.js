import test from 'node:test';
import assert from 'node:assert/strict';
import {
  zonedToUtc, normalizeFacts, validateFacts, publishAt, renderPost, describeCard, diffFacts,
  buildCampaignPlan, planChange, summarize, MAX_POST_LENGTH, planSchedule, correctText, renderFollowUp, textLength, limitFor,
} from '../lib/campaign.js';

const facts = normalizeFacts({
  title: 'Community Workshop',
  startsLocal: '2026-12-12T14:00',
  timeZone: 'Africa/Lagos',
  venue: 'City Library',
  address: '12 Marina Road',
  price: 'Free entry',
  bookingUrl: 'https://example.org/book',
});
const NOW = new Date('2026-11-11T09:00:00Z');

// ---- Time ------------------------------------------------------------------------

test('wall-clock times convert to the right instant across timezones', () => {
  assert.equal(zonedToUtc('2026-12-12T14:00', 'Africa/Lagos').toISOString(), '2026-12-12T13:00:00.000Z'); // UTC+1
  assert.equal(zonedToUtc('2026-12-12T14:00', 'America/New_York').toISOString(), '2026-12-12T19:00:00.000Z'); // winter, UTC-5
  assert.equal(zonedToUtc('2026-07-04T14:00', 'Europe/London').toISOString(), '2026-07-04T13:00:00.000Z'); // summer, UTC+1
  assert.equal(zonedToUtc('2026-07-04T14:00', 'America/New_York').toISOString(), '2026-07-04T18:00:00.000Z'); // summer, UTC-4
});

test('an event right after a daylight-saving change still lands on the right hour', () => {
  // US clocks go forward on 2027-03-14 at 02:00. 09:00 that morning is already UTC-4.
  assert.equal(zonedToUtc('2027-03-14T09:00', 'America/New_York').toISOString(), '2027-03-14T13:00:00.000Z');
  // The day before is still UTC-5.
  assert.equal(zonedToUtc('2027-03-13T09:00', 'America/New_York').toISOString(), '2027-03-13T14:00:00.000Z');
});

test('posts are scheduled relative to the event in the event timezone', () => {
  assert.equal(publishAt('announcement', facts).toISOString(), '2026-11-28T08:00:00.000Z'); // 14 days before, 09:00 WAT
  assert.equal(publishAt('reminder', facts).toISOString(), '2026-12-10T08:00:00.000Z');
  assert.equal(publishAt('dayOf', facts).toISOString(), '2026-12-12T07:00:00.000Z'); // 08:00 WAT
});

// ---- Facts -----------------------------------------------------------------------

test('facts are validated before anything is scheduled', () => {
  assert.deepEqual(validateFacts(facts), []);
  assert.ok(validateFacts({ ...facts, title: '' }).length > 0);
  assert.ok(validateFacts({ ...facts, startsLocal: 'next Saturday' }).length > 0);
  assert.ok(validateFacts({ ...facts, timeZone: 'Mars/Olympus' }).length > 0);
  assert.ok(validateFacts({ ...facts, timeZone: '' }).length > 0);
  assert.ok(validateFacts({ ...facts, bookingUrl: 'http://insecure.example' }).length > 0);
  assert.equal(validateFacts({ ...facts, bookingUrl: '' }).length, 0, 'the booking link is optional');
});

test('diffFacts reports only what changed', () => {
  assert.deepEqual(diffFacts(facts, { ...facts, venue: 'Town Hall' }), ['venue']);
  assert.deepEqual(diffFacts(facts, facts), []);
});

// ---- Wording ---------------------------------------------------------------------

test('every fact appears in the announcement, and nothing else is invented', () => {
  const text = renderPost('announcement', facts);
  for (const expected of ['Community Workshop', 'Saturday 12 December', '2:00 pm', 'City Library', '12 Marina Road', 'Free entry', 'https://example.org/book']) {
    assert.ok(text.includes(expected), `missing "${expected}" in:\n${text}`);
  }
});

test('"tomorrow" and "today" are used only when they are true', () => {
  assert.match(renderPost('reminder', { ...facts, startsLocal: '2026-12-12T14:00' }, new Date('2026-12-11T08:00:00Z')), /is tomorrow at 2:00 pm/);
  assert.match(renderPost('reminder', facts, new Date('2026-12-10T08:00:00Z')), /is on Saturday 12 December at 2:00 pm/);
  assert.match(renderPost('dayOf', facts, new Date('2026-12-12T07:00:00Z')), /^Today: Community Workshop at 2:00 pm\./);
  // The event moved a week: the day-of post must not claim it is today.
  const moved = { ...facts, startsLocal: '2026-12-19T14:00' };
  const text = renderPost('dayOf', moved, new Date('2026-12-12T07:00:00Z'));
  assert.ok(!text.includes('Today'), text);
  assert.match(text, /Saturday 19 December/);
});

test('a cancelled event never produces promotional wording', () => {
  const text = renderPost('reminder', { ...facts, status: 'cancelled' });
  assert.match(text, /^Cancelled:/);
  assert.ok(!text.includes('Details and booking'));
});

test('the card description is built from the facts', () => {
  const alt = describeCard(facts);
  assert.match(alt, /Community Workshop/);
  assert.match(alt, /City Library/);
  assert.match(alt, /Free entry/);
});

// ---- Creating --------------------------------------------------------------------

test('a plan covers every channel and kind', () => {
  const items = buildCampaignPlan(facts, ['ch1', 'ch2'], NOW);
  assert.equal(items.length, 6);
  assert.ok(items.every((i) => !i.skip && i.warnings.length === 0));
  assert.ok(items.every((i) => Array.from(i.text).length <= MAX_POST_LENGTH));
});

test('when the usual time has passed, the announcement moves up and the reminder is skipped', () => {
  // The day before the event, early afternoon: there is no room for a reminder.
  const late = buildCampaignPlan(facts, ['ch1'], new Date('2026-12-11T12:00:00Z'));
  assert.deepEqual(late.map((i) => !!i.skip), [false, true, false]);
  const announcement = late.find((i) => i.kind === 'announcement');
  assert.equal(announcement.dueAt, '2026-12-11T12:15:00.000Z', 'as soon as possible, on the quarter hour');
  assert.match(announcement.warnings[0], /usual time has passed/);
});

test('an event ten days away still gets all three posts', () => {
  const schedule = planSchedule(facts, new Date('2026-12-02T10:00:00Z'));
  assert.equal(schedule.announcement.dueAt.toISOString(), '2026-12-03T08:00:00.000Z', 'next morning at 09:00 local');
  assert.equal(schedule.announcement.moved, true);
  assert.equal(schedule.reminder.moved, false);
  assert.equal(schedule.dayOf.moved, false);
});

test('your own wording and time from the preview are used', () => {
  const edits = { 'ch1:reminder': { text: 'Two days to go! City Library, 2pm. Bring a friend.', dueLocal: '2026-12-10T18:30' } };
  const items = buildCampaignPlan(facts, ['ch1'], NOW, { edits });
  const reminder = items.find((i) => i.kind === 'reminder');
  assert.equal(reminder.custom, true);
  assert.equal(reminder.customTime, true);
  assert.equal(reminder.dueAt, '2026-12-10T17:30:00.000Z');
  assert.match(reminder.text, /Bring a friend/);
  const skipped = buildCampaignPlan(facts, ['ch1'], NOW, { edits: { 'ch1:dayOf': { skip: true } } });
  assert.ok(skipped.find((i) => i.kind === 'dayOf').skip);
});

test('length is checked against each network', () => {
  const long = 'x'.repeat(290);
  const edits = { 'a:announcement': { text: long }, 'b:announcement': { text: long } };
  const items = buildCampaignPlan(facts, ['a', 'b'], NOW, { services: { a: 'bluesky', b: 'twitter' }, edits });
  assert.equal(items.find((i) => i.channelId === 'a' && i.kind === 'announcement').warnings.length, 0, 'Bluesky allows 300');
  assert.match(items.find((i) => i.channelId === 'b' && i.kind === 'announcement').warnings[0], /allows 280/);
  assert.equal(textLength('👋🏽 café'), 6, 'an emoji with a skin tone counts once');
  assert.equal(limitFor('mastodon'), 500);
});

// ---- Correcting your own words ---------------------------------------------------

test('a change is made inside your own wording, and nothing else is touched', () => {
  const mine = 'Big news! Community Workshop lands at City Library on Saturday 12 December, doors 2pm. Free entry, all welcome 🎉';
  const moved = correctText(mine, facts, { ...facts, venue: 'Town Hall', startsLocal: '2026-12-19T15:30' });
  assert.equal(moved, 'Big news! Community Workshop lands at Town Hall on Saturday 19 December, doors 3:30pm. Free entry, all welcome 🎉');
  assert.equal(correctText('See you there!', facts, { ...facts, venue: 'Town Hall' }), 'See you there!', 'nothing to fix');
  assert.equal(correctText('Sat 12 Dec at 14:00', facts, { ...facts, startsLocal: '2026-12-13T14:00' }), 'Sun 13 Dec at 14:00');
});

test('a follow-up says what changed', () => {
  const text = renderFollowUp(facts, { ...facts, venue: 'Town Hall', price: '£5' });
  assert.match(text, /^Change of plans for Community Workshop: it's now at Town Hall, 12 Marina Road and entry is now £5\./);
  assert.match(renderFollowUp(facts, { ...facts, status: 'cancelled' }), /^Cancelled:/);
});

// ---- Changing --------------------------------------------------------------------

function managed(f = facts) {
  const posts = [];
  const current = new Map();
  for (const kind of ['announcement', 'reminder', 'dayOf']) {
    const due = publishAt(kind, f);
    const text = renderPost(kind, f, due);
    const postId = `p_${kind}`;
    posts.push({ kind, channelId: 'ch1', postId, lastWrittenText: text });
    current.set(postId, { id: postId, text, status: 'scheduled', dueAt: due.toISOString() });
  }
  return { campaign: { facts: f, posts }, current };
}

test('changing the venue proposes an update for every post and leaves the schedule alone', () => {
  const { campaign, current } = managed();
  const plan = planChange(campaign, { ...facts, venue: 'Town Hall' }, current, NOW);
  assert.deepEqual(plan.changedFields, ['venue']);
  assert.ok(plan.items.every((i) => i.type === 'update'));
  assert.ok(plan.items.every((i) => i.proposed.includes('Town Hall') && !i.proposed.includes('City Library')));
  assert.ok(plan.items.every((i) => i.dueAt === null), 'times are unchanged, so no new schedule is sent');
});

test('an unchanged fact set proposes nothing', () => {
  const { campaign, current } = managed();
  const plan = planChange(campaign, facts, current, NOW);
  assert.ok(plan.items.every((i) => i.type === 'unchanged'));
});

test('moving the date reschedules the posts and rewrites them', () => {
  const { campaign, current } = managed();
  const plan = planChange(campaign, { ...facts, startsLocal: '2026-12-19T14:00' }, current, NOW);
  assert.ok(plan.items.every((i) => i.type === 'update' && i.dueAt));
  assert.match(plan.items.find((i) => i.kind === 'announcement').proposed, /Saturday 19 December/);
  // The day-of post moves to the new day, so "Today" is true again on the day it goes out.
  const dayOf = plan.items.find((i) => i.kind === 'dayOf');
  assert.equal(dayOf.dueAt, '2026-12-19T07:00:00.000Z');
  assert.match(dayOf.proposed, /^Today:/);
});

test('a post you edited by hand is flagged, and the correction keeps your wording', () => {
  const { campaign, current } = managed();
  current.get('p_reminder').text = 'Hey all, workshop soon at City Library! Bring a friend.';
  const plan = planChange(campaign, { ...facts, venue: 'Town Hall' }, current, NOW);
  const reminder = plan.items.find((i) => i.kind === 'reminder');
  assert.equal(reminder.type, 'conflict');
  assert.match(reminder.current, /Bring a friend/);
  assert.equal(reminder.proposed, 'Hey all, workshop soon at Town Hall! Bring a friend.');
  assert.equal(plan.items.filter((i) => i.type === 'update').length, 2);
});

test('a hand edit that does not mention what changed is left alone', () => {
  const { campaign, current } = managed();
  current.get('p_reminder').text = 'Two days to go. See you there!';
  const plan = planChange(campaign, { ...facts, venue: 'Town Hall' }, current, NOW);
  assert.equal(plan.items.find((i) => i.kind === 'reminder').type, 'edited');
  const status = planChange(campaign, facts, current, NOW);
  assert.equal(status.items.find((i) => i.kind === 'reminder').type, 'edited', 'the status check flags it as edited');
});

test('a post with your own wording is corrected in place', () => {
  const { campaign, current } = managed();
  const mine = 'Workshop at City Library this Saturday, 2pm sharp.';
  campaign.posts[1] = { ...campaign.posts[1], lastWrittenText: mine, custom: true };
  current.get('p_reminder').text = mine;
  const plan = planChange(campaign, { ...facts, venue: 'Town Hall' }, current, NOW);
  const reminder = plan.items.find((i) => i.kind === 'reminder');
  assert.equal(reminder.type, 'update');
  assert.equal(reminder.proposed, 'Workshop at Town Hall this Saturday, 2pm sharp.');
});

test('a post on a time you picked moves by the same amount as the event', () => {
  const { campaign, current } = managed();
  campaign.posts[1] = { ...campaign.posts[1], customTime: true };
  current.get('p_reminder').dueAt = '2026-12-10T17:30:00.000Z';
  const plan = planChange(campaign, { ...facts, startsLocal: '2026-12-19T14:00' }, current, NOW);
  assert.equal(plan.items.find((i) => i.kind === 'reminder').dueAt, '2026-12-17T17:30:00.000Z');
});

test('the event card is replaced when a detail on it changes, unless you swapped the picture', () => {
  const cardFor = (f) => ({ url: `https://t/card/${f.venue}`, altText: `Card at ${f.venue}` });
  const { campaign, current } = managed();
  for (const post of campaign.posts) {
    post.card = cardFor(facts);
    current.get(post.postId).assets = [{ image: { altText: 'Card at City Library' } }];
  }
  current.get('p_dayOf').assets = [{ image: { altText: 'My own photo' } }];
  const plan = planChange(campaign, { ...facts, venue: 'Town Hall' }, current, NOW, { cardFor });
  assert.equal(plan.items.find((i) => i.kind === 'announcement').card.altText, 'Card at Town Hall');
  assert.equal(plan.items.find((i) => i.kind === 'dayOf').card, null);
  // A price change that no post text mentions still updates the picture.
  const priceOnly = planChange(campaign, { ...facts, venue: 'Hall B' }, current, NOW, { cardFor });
  assert.ok(priceOnly.items.filter((i) => i.type === 'update').every((i) => i.card || i.kind === 'dayOf'));
});

test('a published post offers a follow-up only when something changed', () => {
  const { campaign, current } = managed();
  current.get('p_announcement').status = 'sent';
  const same = planChange(campaign, facts, current, NOW);
  assert.equal(same.items.find((i) => i.kind === 'announcement').needsFollowUp, false);
  const moved = planChange(campaign, { ...facts, venue: 'Town Hall' }, current, NOW);
  assert.match(moved.items.find((i) => i.kind === 'announcement').suggested, /^Change of plans/);
});

test('cancelling removes scheduled posts and sends published ones to a manual checklist', () => {
  const { campaign, current } = managed();
  current.get('p_announcement').status = 'sent';
  const plan = planChange(campaign, { ...facts, status: 'cancelled' }, current, NOW);
  assert.equal(plan.items.find((i) => i.kind === 'announcement').type, 'published');
  assert.match(plan.items.find((i) => i.kind === 'announcement').suggested, /^Cancelled:/);
  assert.equal(plan.items.find((i) => i.kind === 'announcement').needsFollowUp, true);
  assert.equal(plan.items.filter((i) => i.type === 'delete').length, 2);
});

test('a new date that puts a post in the past asks for review instead of scheduling it', () => {
  const { campaign, current } = managed();
  const plan = planChange(campaign, { ...facts, startsLocal: '2026-11-12T14:00' }, current, NOW);
  assert.ok(plan.items.some((i) => i.type === 'review'));
});

test('a post deleted in Buffer is reported as missing', () => {
  const { campaign, current } = managed();
  current.delete('p_reminder');
  const plan = planChange(campaign, { ...facts, venue: 'Town Hall' }, current, NOW);
  assert.equal(plan.items.find((i) => i.kind === 'reminder').type, 'missing');
});

test('the result line lists only what happened', () => {
  assert.equal(summarize({ updated: 3, review: 1, failed: 1 }), '3 updated · 1 need review · 1 failed');
  assert.equal(summarize({ updated: 2, kept: 1 }), '2 updated · 1 kept as you wrote it');
  assert.equal(summarize({}), 'Nothing to change');
});
