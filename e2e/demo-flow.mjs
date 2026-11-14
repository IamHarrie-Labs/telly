// End-to-end run of the public demo. Local-only check; not part of the app.
const BASE = process.env.BASE || 'http://localhost:3100';
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; };

function visitor() {
  const jar = new Map();
  const request = async (url, options = {}, hops = 0) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(url, { redirect: 'manual', ...options, headers: { ...(options.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
    for (const line of res.headers.getSetCookie?.() ?? []) { const [pair] = line.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    if (res.status >= 300 && res.status < 400 && hops < 8) return request(new URL(res.headers.get('location'), url).toString(), {}, hops + 1);
    return res;
  };
  const api = async (path, body) => {
    const res = await request(BASE + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { request, api };
}

const facts = { title: 'Open Mic Night', startsLocal: '2026-12-18T19:30', timeZone: 'Europe/London', venue: 'The Crown', address: '4 High Street', price: '£3 on the door', bookingUrl: '' };

const a = visitor();
const before = await a.api('/api/session');
ok(before.body.connected === false, 'a new visitor is signed out');
await a.request(BASE + '/demo');
const session = await a.api('/api/session');
ok(session.body.connected && session.body.demo === true, 'Try the demo signs in without Buffer');
ok(session.body.lab === false, 'developer lab stays off in the demo');
const channels = (await a.api('/api/channels?organizationId=org_demo')).body.channels;
ok(channels.length === 2, 'demo has two practice channels');

const created = await a.api('/api/campaigns', { facts, channelIds: channels.map((c) => c.id), organizationId: 'org_demo' });
ok(created.status === 201, `campaign scheduled in the practice queue (${created.body.summary})`);
const campaign = created.body.campaign;
const reminder = campaign.posts.find((p) => p.kind === 'reminder');

let status = await a.api(`/api/campaigns/${campaign.id}/status`);
ok(status.body.posts.every((p) => p.type === 'unchanged'), 'all posts in sync after scheduling');

ok(campaign.posts.every((p) => p.card?.altText?.startsWith('Event card: Open Mic Night.')), 'demo posts carry the event card');

const edit = await a.api(`/api/demo/posts/${reminder.postId}`, { action: 'edit', text: 'See you at The Crown! Bring a friend.' });
ok(edit.status === 200, 'practice: edit a post by hand');
status = await a.api(`/api/campaigns/${campaign.id}/status`);
ok(status.body.posts.find((p) => p.postId === reminder.postId).type === 'edited', 'Telly flags the hand edit');

const plan = await a.api(`/api/campaigns/${campaign.id}/changes/preview`, { facts: { ...facts, venue: 'The Swan' } });
const c = plan.body.items.find((i) => i.type === 'conflict');
ok(c?.proposed === 'See you at The Swan! Bring a friend.' && plan.body.items.some((i) => i.type === 'update'), 'venue change: updates plus one conflict, corrected in their words');
const applied = await a.api(`/api/campaigns/${campaign.id}/changes/apply`, { facts: { ...facts, venue: 'The Swan' }, approve: 'all', overwrite: [] });
ok(applied.status === 200 && applied.body.summary === '5 updated · 1 kept as you wrote it', `applied, hand edit kept (${applied.body.summary})`);

const dayOf = campaign.posts.find((p) => p.kind === 'dayOf');
await a.api(`/api/demo/posts/${dayOf.postId}`, { action: 'publish' });
status = await a.api(`/api/campaigns/${campaign.id}/status`);
ok(status.body.posts.find((p) => p.postId === dayOf.postId).type === 'published', 'practice: publish is reported as published');

// A detail changes after the day-of post went out: Telly offers a follow-up.
const pricier = { ...facts, venue: 'The Swan', price: '£5 on the door' };
const fplan = await a.api(`/api/campaigns/${campaign.id}/changes/preview`, { facts: pricier });
const pub = fplan.body.items.find((i) => i.postId === dayOf.postId);
ok(pub.needsFollowUp && pub.suggested.startsWith("Change of plans for Open Mic Night: entry is now £5 on the door."), 'published post gets suggested follow-up wording');
const fapplied = await a.api(`/api/campaigns/${campaign.id}/changes/apply`, { facts: pricier, approve: 'all', followUps: [dayOf.postId] });
ok(fapplied.body.counts.followUps === 1, `follow-up scheduled (${fapplied.body.summary})`);
const after = await a.api(`/api/campaigns/${campaign.id}`);
const follow = after.body.campaign.posts.find((p) => p.kind === 'followUp');
ok(follow && follow.channelId === dayOf.channelId && follow.lastWrittenText.includes('£5'), 'the follow-up is tracked on the same channel');
const again = await a.api(`/api/campaigns/${campaign.id}/changes/preview`, { facts: pricier });
ok(!again.body.items.find((i) => i.postId === dayOf.postId).needsFollowUp, 'the published post stops asking once it has a follow-up');

const b = visitor();
await b.request(BASE + '/demo');
const bList = await b.api('/api/campaigns');
ok(bList.body.campaigns.length === 0, "a second demo visitor can't see the first one's campaigns");
const bRead = await b.api(`/api/campaigns/${campaign.id}`);
ok(bRead.status === 404, "and can't open it by ID");
const bPractice = await b.api(`/api/demo/posts/${reminder.postId}`, { action: 'edit', text: 'hijack' });
ok(bPractice.status === 400, "and can't touch its practice posts");

const cancelled = await a.api(`/api/campaigns/${campaign.id}/changes/apply`, { facts: { ...facts, venue: 'The Swan', status: 'cancelled' }, approve: 'all', overwrite: [] });
ok(cancelled.status === 200 && cancelled.body.counts.removed >= 1, `cancel removes what hasn't gone out (${cancelled.body.summary})`);

const signedOut = visitor();
const practiceOut = await signedOut.api(`/api/demo/posts/${reminder.postId}`, { action: 'edit', text: 'x' });
ok(practiceOut.status === 404, 'practice actions need a demo session');
