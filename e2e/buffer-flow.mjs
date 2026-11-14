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
ok(applied.body.summary === '3 removed' && gone === null, `cancelled: posts removed (${applied.body.summary})`);
const final = await api(`/api/campaigns/${id}`);
ok(final.body.campaign.posts.length === 0 && final.body.campaign.facts.status === 'cancelled', 'campaign record reflects the cancellation');

// Isolation: another login must not see this campaign.
jar.clear();
const stranger = await api(`/api/campaigns/${id}`);
ok(stranger.status === 401 || stranger.status === 404, 'a signed-out visitor cannot read the campaign');
