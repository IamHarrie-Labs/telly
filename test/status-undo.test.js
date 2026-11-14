import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFacts, planChange, publishAt, renderFollowUp, renderPost, snippetText, summarize } from '../lib/campaign.js';

const facts = normalizeFacts({
  title: 'Community Workshop', startsLocal: '2026-12-12T14:00', timeZone: 'Africa/Lagos',
  venue: 'City Library', address: '12 Marina Road', price: 'Free entry', bookingUrl: 'https://example.org/book',
});
const NOW = new Date('2026-11-11T09:00:00Z');

function managed(f = facts, { custom = false } = {}) {
  const posts = [];
  const current = new Map();
  for (const kind of ['announcement', 'reminder', 'dayOf']) {
    const due = publishAt(kind, f);
    const text = custom ? `Come along to ${f.title} at ${f.venue}!` : renderPost(kind, f, due);
    const postId = `p_${kind}`;
    posts.push({ kind, channelId: 'ch1', postId, lastWrittenText: text, lastWrittenDueAt: due.toISOString(), writtenFacts: f, custom });
    current.set(postId, { id: postId, text, status: 'scheduled', dueAt: due.toISOString() });
  }
  return { campaign: { facts: f, posts }, current };
}

test('the new statuses survive normalising, and anything unknown means going ahead', () => {
  for (const status of ['upcoming', 'soldOut', 'postponed', 'cancelled']) assert.equal(normalizeFacts({ status }).status, status);
  assert.equal(normalizeFacts({ status: 'exploded' }).status, 'upcoming');
});

test('sold-out posts say so and drop the booking link', () => {
  const text = renderPost('announcement', { ...facts, status: 'soldOut' });
  assert.match(text, /sold out/);
  assert.doesNotMatch(text, /example\.org\/book/);
  assert.match(renderPost('dayOf', { ...facts, status: 'soldOut' }), /^Today: Community Workshop at 2:00 pm\. It's sold out\./);
});

test('postponed posts say the date is off and a new one is coming', () => {
  assert.match(renderPost('reminder', { ...facts, status: 'postponed' }), /^Postponed: Community Workshop.*\nWe'll share the new date/);
});

test('marking sold out rewrites every post from the template, even your own wording', () => {
  const { campaign, current } = managed(facts, { custom: true });
  const plan = planChange(campaign, { ...facts, status: 'soldOut' }, current, NOW);
  assert.ok(plan.items.every((i) => i.type === 'update' && /sold out/.test(i.proposed)));
  assert.ok(plan.items.every((i) => i.custom === false), 'the posts become Telly wording again');
});

test('postponing takes posts out of Buffer but keeps them on hold', () => {
  const { campaign, current } = managed();
  const plan = planChange(campaign, { ...facts, status: 'postponed' }, current, NOW);
  assert.ok(plan.items.every((i) => i.type === 'delete' && i.hold === true));
  assert.match(plan.items[0].reason, /postponed/);
});

test('held posts come back with the new date when the event goes ahead', () => {
  const { campaign } = managed({ ...facts, status: 'postponed' });
  for (const post of campaign.posts) post.held = true;
  const newFacts = { ...facts, status: 'upcoming', startsLocal: '2027-01-16T14:00' };
  const plan = planChange(campaign, newFacts, new Map(), NOW);
  assert.ok(plan.items.every((i) => i.type === 'resume'));
  const ann = plan.items.find((i) => i.kind === 'announcement');
  assert.match(ann.proposed, /Saturday 16 January/);
  assert.equal(ann.dueAt, publishAt('announcement', newFacts).toISOString());
  // While the event is still off, held posts stay where they are.
  assert.ok(planChange(campaign, { ...facts, status: 'cancelled' }, new Map(), NOW).items.every((i) => i.type === 'held'));
});

test('a held post whose time has passed stays out', () => {
  const { campaign } = managed({ ...facts, status: 'cancelled' });
  for (const post of campaign.posts) post.held = true;
  const late = new Date('2026-12-12T12:00:00Z'); // an hour before the event
  const plan = planChange(campaign, facts, new Map(), late);
  assert.ok(plan.items.every((i) => i.type === 'expired'));
});

test('follow-up posts are removed for good, not held', () => {
  const { campaign, current } = managed();
  campaign.posts.push({ kind: 'followUp', channelId: 'ch1', postId: 'p_fu', lastWrittenText: 'Change of plans', custom: true });
  current.set('p_fu', { id: 'p_fu', text: 'Change of plans', status: 'scheduled', dueAt: '2026-11-20T09:00:00.000Z' });
  const plan = planChange(campaign, { ...facts, status: 'cancelled' }, current, NOW);
  assert.equal(plan.items.find((i) => i.postId === 'p_fu').hold, false);
});

test('undo puts back the exact earlier wording and time', () => {
  // The organiser's own wording was corrected for a venue change; undo restores it word for word.
  const moved = { ...facts, venue: 'Town Hall' };
  const { campaign, current } = managed(moved, { custom: true });
  const restore = new Map([['p_reminder', { text: 'My own words about City Library', dueAt: '2026-12-10T10:00:00.000Z', custom: true }]]);
  const plan = planChange(campaign, facts, current, NOW, { restore });
  const reminder = plan.items.find((i) => i.kind === 'reminder');
  assert.equal(reminder.proposed, 'My own words about City Library');
  assert.equal(reminder.dueAt, '2026-12-10T10:00:00.000Z');
  // Posts without a saved version fall back to swapping the detail back.
  assert.match(plan.items.find((i) => i.kind === 'announcement').proposed, /City Library/);
});

test('undo leaves a post for review if it was edited in Buffer since', () => {
  const moved = { ...facts, venue: 'Town Hall' };
  const { campaign, current } = managed(moved);
  current.get('p_reminder').text = 'Edited by hand: see you at Town Hall';
  const restore = new Map([['p_reminder', { text: 'Original reminder', dueAt: null }]]);
  const reminder = planChange(campaign, facts, current, NOW, { restore }).items.find((i) => i.kind === 'reminder');
  assert.equal(reminder.type, 'conflict');
  assert.equal(reminder.proposed, 'Edited by hand: see you at City Library');
});

test('undo withdraws a correction that has not gone out yet', () => {
  const { campaign, current } = managed();
  campaign.posts.push({ kind: 'followUp', channelId: 'ch1', postId: 'p_fu', lastWrittenText: 'Change of plans', custom: true });
  current.set('p_fu', { id: 'p_fu', text: 'Change of plans', status: 'scheduled', dueAt: '2026-11-20T09:00:00.000Z' });
  const item = planChange(campaign, facts, current, NOW, { withdraw: new Set(['p_fu']) }).items.find((i) => i.postId === 'p_fu');
  assert.equal(item.type, 'delete');
  assert.equal(item.hold, false);
});

test('follow-ups explain a status change', () => {
  assert.match(renderFollowUp(facts, { ...facts, status: 'soldOut' }), /sold out/);
  assert.match(renderFollowUp({ ...facts, status: 'postponed' }, { ...facts, startsLocal: '2027-01-16T14:00' }), /going ahead after all.*moved to Saturday 16 January/);
  assert.match(renderFollowUp({ ...facts, status: 'soldOut' }, facts), /tickets are available again/);
});

test('the snippet holds every confirmed detail on one line', () => {
  assert.equal(snippetText(facts), 'Community Workshop · Saturday 12 December at 2:00 pm · City Library, 12 Marina Road · Free entry · https://example.org/book');
  assert.match(snippetText({ ...facts, status: 'soldOut' }), /^Sold out · /);
});

test('the summary names posts put on hold and brought back', () => {
  assert.equal(summarize({ held: 3 }), '3 on hold');
  assert.equal(summarize({ updated: 1, restored: 2 }), '1 updated · 2 back in the queue');
});
