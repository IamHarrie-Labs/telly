// End-to-end checks for the event page, calendar file, the organiser's own flyer, plain-words
// changes and repeating an event, against the FAKE Buffer. Local-only check; not part of the app.
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
const image = (p) => p?.assets?.find((a) => a.image);

const facts = { title: 'Harbour Lights Concert', startsLocal: '2026-12-20T19:00', timeZone: 'Europe/London', venue: 'Harbour Hall', address: '3 Quay Street', price: '£8', bookingUrl: 'https://example.org/tickets' };

await request(BASE + '/auth/login');
const { channels } = (await api('/api/channels?organizationId=org_mock')).body;
const channelIds = [channels[0].id];
const services = { [channels[0].id]: channels[0].service };

// ---- The event page ----
const preview = await api('/api/campaigns/preview', { facts, channelIds, services });
const pageId = preview.body.pageId;
ok(/^[A-Za-z0-9]{8,16}$/.test(pageId || '') && preview.body.items.every((i) => i.text.includes(`/e/${pageId}`)), 'the preview links every post to the event page');

// The organiser's own flyer, stored so Buffer can fetch it.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const upload = await api('/api/images', { image: `data:image/png;base64,${png}` });
ok(upload.status === 201 && /\/img\/[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.png$/.test(upload.body.url || ''), 'an own flyer uploads and gets a signed address');
const fetched = await request(upload.body.url);
ok(fetched.status === 200 && fetched.headers.get('content-type') === 'image/png', 'and Buffer can fetch it from there');
ok((await request(upload.body.url.replace(/\.([A-Za-z0-9_-]{22})\.png$/, '.AAAAAAAAAAAAAAAAAAAAAA.png'))).status === 404, 'a tampered image address is refused');

const altText = 'Concert poster: Harbour Lights Concert, 20 December, 7pm, Harbour Hall, £8.';
const created = await api('/api/campaigns', { facts, channelIds, services, pageId, image: { url: upload.body.url, altText }, organizationId: 'org_mock' });
const campaign = created.body.campaign;
ok(created.status === 201 && campaign.pageId === pageId && campaign.facts.pageUrl.endsWith(`/e/${pageId}`), 'scheduling keeps the page from the preview');
const first = await post(campaign.posts[0].postId);
ok(image(first)?.image?.altText === altText && image(first)?.source?.includes('/img/') !== false, 'the posts carry the own flyer with its description');

const page = await request(`${BASE}/e/${pageId}`);
const html = await page.text();
ok(page.status === 200 && html.includes('Harbour Hall') && html.includes('£8') && html.includes('https://example.org/tickets'), 'the event page shows the details and booking link');
ok(html.includes('og:image') && html.includes('/card/'), 'its link preview uses the event card');
ok(html.includes('noindex'), 'and asks search engines not to list it');
const ics = await request(`${BASE}/e/${pageId}.ics`);
const cal = await ics.text();
ok(ics.status === 200 && /text\/calendar/.test(ics.headers.get('content-type')) && cal.includes(`UID:${pageId}@`) && cal.includes('SEQUENCE:1') && cal.includes('DTSTART:20261220T190000Z'), 'the calendar file has a stable id and the right start');
ok((await request(`${BASE}/e/nosuchpage1`)).status === 404, 'an unknown event page is not found');

// A detail that isn't printed on the flyer leaves it in place; a printed one swaps in the card.
const id = campaign.id;
let plan = await api(`/api/campaigns/${id}/changes/preview`, { facts: { ...facts, bookingUrl: 'https://example.org/new-tickets' } });
ok(plan.status === 200 && plan.body.items.every((i) => i.type === 'unchanged'), 'a new booking link changes no post: they link to the page');
plan = await api(`/api/campaigns/${id}/changes/preview`, { facts: { ...facts, venue: 'Pier Pavilion', address: '' } });
ok(plan.body.items.every((i) => i.card?.url?.includes('/card/')), 'a new venue swaps the outdated flyer for the event card');
const applied = await api(`/api/campaigns/${id}/changes/apply`, { facts: { ...facts, venue: 'Pier Pavilion', address: '' }, approve: 'all', version: plan.body.version });
ok(applied.status === 200, `the venue change applies (${applied.body.summary})`);
const swapped = await post(campaign.posts[0].postId);
ok(image(swapped)?.image?.altText?.startsWith('Event card'), 'the post now shows the event card');

const page2 = await (await request(`${BASE}/e/${pageId}`)).text();
ok(page2.includes('Pier Pavilion') && !page2.includes('Harbour Hall') && page2.includes("What's changed") && page2.includes('Now at Pier Pavilion'), 'the page shows the new venue and what changed');
const cal2 = await (await request(`${BASE}/e/${pageId}.ics`)).text();
ok(cal2.includes('SEQUENCE:2') && cal2.includes('LOCATION:Pier Pavilion'), 'the calendar file updates in place');
const sneaky = await api(`/api/campaigns/${id}/changes/preview`, { facts: { ...facts, venue: 'Pier Pavilion', address: '', status: 'soldOut', pageUrl: 'https://evil.example/e/abcdefgh12' } });
ok(sneaky.status === 200 && !JSON.stringify(sneaky.body).includes('evil.example'), 'the browser cannot point posts at another page');

// ---- Tell Telly what changed (local stand-in for Claude) ----
const told = await api(`/api/campaigns/${id}/understand`, { text: 'Sold out now, thanks everyone!' });
ok(told.status === 200 && told.body.facts.status === 'soldOut' && told.body.facts.venue === 'Pier Pavilion', 'plain words become updated details, keeping the rest');
const nothing = await api(`/api/campaigns/${id}/understand`, { text: 'hello there' });
ok(nothing.status === 422, 'a message with no change is turned away');

// ---- Repeating an event: a new campaign gets its own page ----
const again = await api('/api/campaigns/preview', { facts: { ...facts, startsLocal: '2026-12-27T19:00' }, channelIds, services });
ok(again.body.pageId && again.body.pageId !== pageId, 'a repeated event gets its own page');
const none = await api('/api/campaigns/preview', { facts, channelIds, services, eventPage: false });
ok(!none.body.pageId && none.body.items.every((i) => i.text.includes('example.org/tickets')), 'with the page turned off, posts link to the booking page as before');
