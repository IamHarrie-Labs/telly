// End-to-end run of Telly against the FAKE Buffer. Local-only check; not part of the app.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const BASE = process.env.BASE || 'https://localhost:3100';
const jar = new Map();

async function request(url, options = {}, hops = 0) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(url, { redirect: 'manual', ...options, headers: { ...(options.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  if (res.status >= 300 && res.status < 400 && hops < 8) return request(new URL(res.headers.get('location'), url).toString(), {}, hops + 1);
  return res;
}
const api = async (path, body) => {
  const res = await request(BASE + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; };
const post = async (id) => (await api(`/api/lab/post?id=${id}`)).body.post;
const alt = (p) => p?.assets?.find((a) => a.image)?.image?.altText;

const facts = { title: 'Community Workshop', startsLocal: '2026-12-19T14:00', timeZone: 'Africa/Lagos', venue: 'City Library', address: '12 Marina Road', price: 'Free entry', bookingUrl: 'https://example.org/book' };

const health = await api('/api/health');
ok(health.status === 200 && health.body.database === 'ok', 'health check reports the store is up');

await request(BASE + '/auth/login');
const session = await api('/api/session');
ok(session.body.connected === true, 'signed in through OAuth');
const channels = (await api('/api/channels?organizationId=org_mock')).body.channels;
const channelIds = [channels[0].id];
const services = { [channels[0].id]: channels[0].service };

const preview = await api('/api/campaigns/preview', { facts, channelIds, services });
ok(preview.status === 200 && preview.body.items.length === 3, 'preview returns 3 posts and sends nothing');
ok(preview.body.items.every((i) => i.limit === 300), 'Bluesky posts are checked against 300 characters');
ok(preview.body.card?.url?.includes('/card/') && preview.body.card.altText.startsWith('Event card: Community Workshop.'), 'preview includes the event card and its alt text');

const img = await request(preview.body.card.url.replace(/^https?:\/\/[^/]+/, BASE));
const bytes = Buffer.from(await img.arrayBuffer());
ok(img.status === 200 && img.headers.get('content-type') === 'image/png' && bytes.subarray(1, 4).toString() === 'PNG', `event card renders as a PNG (${bytes.length} bytes)`);
const forged = await request(preview.body.card.url.replace(/^https?:\/\/[^/]+/, BASE).replace(/.\.png$/, 'A.png'));
ok(forged.status === 404, 'a card address with a bad signature is refused');

const bad = await api('/api/campaigns/preview', { facts: { ...facts, timeZone: 'Mars/Olympus' }, channelIds });
ok(bad.status === 400, 'invalid facts are rejected');

// The organiser rewrites the reminder and moves it to the evening before scheduling.
const myReminder = 'Two days to go! Community Workshop, City Library, 2pm. Bring a friend.';
const edits = { [`${channelIds[0]}:reminder`]: { text: myReminder, dueLocal: '2026-12-17T18:30' } };
const created = await api('/api/campaigns', { facts, channelIds, services, edits, organizationId: 'org_mock' });
ok(created.status === 201 && created.body.results.every((r) => r.status === 'created'), `campaign created (${created.body.summary})`);
const id = created.body.campaign.id;
const [announcement, reminder, dayOf] = created.body.campaign.posts;
let r = await post(reminder.postId);
ok(r.text === myReminder && r.dueAt === '2026-12-17T17:30:00.000Z', 'your wording and time went to Buffer');
ok(alt(r)?.startsWith('Event card: Community Workshop.'), 'the event card and alt text are attached');

let plan = await api(`/api/campaigns/${id}/changes/preview`, { facts: { ...facts, venue: 'Town Hall' } });
ok(plan.body.items.every((i) => i.type === 'update' && i.dueAt === null && i.card), 'venue change: 3 updates, same times, new card');
ok(plan.body.items.find((i) => i.postId === reminder.postId).proposed === myReminder.replace('City Library', 'Town Hall'), 'your wording is corrected in place');

let pending = await api(`/api/campaigns/${id}/changes/apply`, { facts: { ...facts, venue: 'Town Hall' } });
ok(pending.body.counts.updated === 0 && pending.body.counts.review === 3, 'nothing changes without approval');

const stale = await api(`/api/campaigns/${id}/changes/apply`, { facts: { ...facts, venue: 'Town Hall' }, approve: 'all', version: 99 });
ok(stale.status === 409, 'an apply built from an old version is refused');

let applied = await api(`/api/campaigns/${id}/changes/apply`, { facts: { ...facts, venue: 'Town Hall' }, approve: 'all', version: plan.body.version });
ok(applied.body.summary === '3 updated', `venue change applied and read back (${applied.body.summary})`);
r = await post(reminder.postId);
ok(r.text.includes('Town Hall') && r.text.includes('Bring a friend') && r.dueAt === '2026-12-17T17:30:00.000Z', 'Buffer holds your corrected wording at your time');
ok(alt(r).includes('Town Hall'), 'the card alt text now names the new venue');

// Someone edits the announcement by hand in Buffer.
const venue2 = { ...facts, venue: 'Riverside Hall' };
await api('/api/lab/edit', { postId: announcement.postId, text: 'Big one this year: Community Workshop at Town Hall. Tell everyone!' });
plan = await api(`/api/campaigns/${id}/changes/preview`, { facts: venue2 });
const conflict = plan.body.items.find((i) => i.postId === announcement.postId);
ok(conflict.type === 'conflict' && conflict.proposed === 'Big one this year: Community Workshop at Riverside Hall. Tell everyone!', 'hand edit flagged, with the correction made in your words');
applied = await api(`/api/campaigns/${id}/changes/apply`, { facts: venue2, approve: 'all' });
ok(applied.body.summary === '2 updated · 1 kept as you wrote it', `Keep mine: ${applied.body.summary}`);
const a = await post(announcement.postId);
ok(a.text.includes('Town Hall. Tell everyone!') && alt(a).includes('Riverside Hall'), 'kept wording untouched, card still updated');
const status = await api(`/api/campaigns/${id}/status`);
ok(status.body.posts.every((p) => p.type === 'unchanged'), 'after Keep mine, the status check shows everything in sync');

// Overwrite on request.
await api('/api/lab/edit', { postId: dayOf.postId, text: 'Today! Community Workshop at Riverside Hall. Doors 2pm.' });
const venue3 = { ...facts, venue: 'Old Mill' };
applied = await api(`/api/campaigns/${id}/changes/apply`, { facts: venue3, approve: 'all', overwrite: [dayOf.postId] });
ok((await post(dayOf.postId)).text === 'Today! Community Workshop at Old Mill. Doors 2pm.', `Use correction swaps the venue in your edit (${applied.body.summary})`);

// Move the date by a week.
const moved = { ...venue3, startsLocal: '2026-12-26T14:00' };
applied = await api(`/api/campaigns/${id}/changes/apply`, { facts: moved, approve: 'all' });
const d = await post(dayOf.postId);
const rm = await post(reminder.postId);
ok(applied.body.summary === '3 updated' && d.dueAt === '2026-12-26T07:00:00.000Z', `date moved: posts rescheduled (${applied.body.summary})`);
ok(rm.dueAt === '2026-12-24T17:30:00.000Z' && rm.text.includes('2pm'), 'your custom-time reminder moved by the same week');
ok(d.text.includes('Saturday') || d.text.includes('Today'), 'day-of wording still reads right');

// Cancel.
applied = await api(`/api/campaigns/${id}/changes/apply`, { facts: { ...moved, status: 'cancelled' }, approve: 'all' });
const gone = await post(announcement.postId);
ok(applied.body.summary === '3 on hold' && gone === null, `cancelled: posts out of Buffer and on hold (${applied.body.summary})`);
let final = await api(`/api/campaigns/${id}`);
ok(final.body.campaign.posts.every((p) => p.held) && final.body.campaign.facts.status === 'cancelled', 'campaign record reflects the cancellation');

// Undo the cancellation: the same posts go back into Buffer with their wording.
ok(Boolean(final.body.campaign.undo), 'the cancellation can be undone');
const undoPlan = await api(`/api/campaigns/${id}/history/${final.body.campaign.undo}/undo/preview`, {});
ok(undoPlan.status === 200 && undoPlan.body.items.every((i) => i.type === 'resume') && undoPlan.body.facts.status === 'upcoming', 'undo preview brings the 3 posts back');
applied = await api(`/api/campaigns/${id}/changes/apply`, { approve: 'all', undo: final.body.campaign.undo, version: undoPlan.body.version });
final = await api(`/api/campaigns/${id}`);
const back = final.body.campaign.posts;
const backPost = await post(back.find((p) => p.kind === 'announcement').postId);
ok(applied.body.summary === '3 back in the queue' && back.every((p) => !p.held) && backPost?.status === 'scheduled', `undo put the posts back in Buffer (${applied.body.summary})`);
ok(backPost.text === undoPlan.body.items.find((i) => i.kind === 'announcement').proposed, 'with the wording they had before');
const history = final.body.campaign.history;
ok(history.at(-1).type === 'undo' && history.at(-2).undoneBy === history.at(-1).id, 'history records the undo against the change it reversed');
const again = await api(`/api/campaigns/${id}/history/${history.at(-2).id}/undo/preview`, {});
ok(again.status === 409, 'a change can only be undone once');

// A new status with posts still waiting for approval is not saved and leaves no history line.
const historyBefore = (await api(`/api/campaigns/${id}`)).body.campaign.history.length;
applied = await api(`/api/campaigns/${id}/changes/apply`, { facts: { ...moved, status: 'soldOut' } });
const unapproved = (await api(`/api/campaigns/${id}`)).body.campaign;
ok(unapproved.facts.status === 'upcoming' && unapproved.history.length === historyBefore, `an unapproved status change is not saved (${applied.body.summary})`);

// Sold out: the scheduled posts say so.
applied = await api(`/api/campaigns/${id}/changes/apply`, { facts: { ...moved, status: 'soldOut' }, approve: 'all' });
const soldOut = await post(back.find((p) => p.kind === 'reminder').postId);
ok(/sold out/.test(soldOut.text) && !soldOut.text.includes('example.org/book'), `sold out: posts rewritten (${applied.body.summary})`);

// Buffer Snippets and Ideas.
const snip = await api(`/api/campaigns/${id}/snippet`, {});
ok(snip.status === 200 && snip.body.snippet.id && snip.body.snippet.text.startsWith('Sold out · Community Workshop'), 'event details saved as a Buffer snippet');
applied = await api(`/api/campaigns/${id}/changes/apply`, { facts: { ...moved, status: 'soldOut', price: 'Free, donations welcome' }, approve: 'all' });
const mockState = await (await fetch(`http://localhost:${process.env.MOCK_PORT || 4110}/_state`)).json().catch(() => null);
ok(applied.body.snippet === 'updated' && mockState?.snippets?.[0]?.text.includes('donations welcome'), 'the snippet follows a change of details');
const ideas = await api(`/api/campaigns/${id}/ideas`, {});
ok(ideas.status === 200 && ideas.body.saved === 3, 'the posts are saved as 3 Buffer ideas');

// Teams: someone else in the same Buffer organization sees and can work on the campaign.
const MOCK = `http://localhost:${process.env.MOCK_PORT || 4010}`;
const control = (body) => fetch(`${MOCK}/_control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
await control({ nextLogin: 'acct_teammate' });
jar.clear();
await request(BASE + '/auth/login');
const teamList = (await api('/api/campaigns?organizationId=org_mock')).body.campaigns || [];
const shared = teamList.find((c) => c.id === id);
ok(shared && shared.mine === false && shared.createdBy === 'Mock User', 'a teammate in the same Buffer organization sees the campaign, marked as added by its creator');
const teamPreview = await api(`/api/campaigns/${id}/changes/preview`, { facts: { ...moved, status: 'soldOut', price: 'Free, donations welcome', venue: 'Town Hall' } });
ok(teamPreview.status === 200 && teamPreview.body.items.some((i) => i.type === 'update'), 'and can review a change to it');
ok((await api(`/api/campaigns/${id}/changes/apply`, { facts: moved, approve: 'all', version: 1 })).status === 409, 'an out-of-date review from a teammate is refused');

await control({ nextLogin: 'acct_outsider' });
jar.clear();
await request(BASE + '/auth/login');
const outsiderList = (await api('/api/campaigns?organizationId=org_mock')).body.campaigns || [];
ok(!outsiderList.some((c) => c.id === id) && (await api(`/api/campaigns/${id}`)).status === 404, 'someone outside the organization sees nothing');
await control({ nextLogin: 'acct_mock' });

// Isolation: another login must not see this campaign.
jar.clear();
const stranger = await api(`/api/campaigns/${id}`);
ok(stranger.status === 401 || stranger.status === 404, 'a signed-out visitor cannot read the campaign');
