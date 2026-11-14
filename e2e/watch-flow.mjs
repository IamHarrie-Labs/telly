// End-to-end checks for background watching, security headers, feedback and error reports,
// run against the fake Buffer by e2e/run.mjs.
const BASE = process.env.BASE || 'http://localhost:3100';
const MOCK = `http://localhost:${process.env.MOCK_PORT || 4010}`;
const CRON = process.env.CRON_SECRET;
const ok = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const call = async (method, path, body) => {
  const res = await request(BASE + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => ({})) };
};
const cron = async (secret = CRON) => {
  const res = await fetch(`${BASE}/api/cron/watch`, { method: 'POST', headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const control = (body) => fetch(`${MOCK}/_control`, { method: 'POST', body: JSON.stringify(body) });

// ---- Headers ---------------------------------------------------------------------------
const home = await request(`${BASE}/`);
const csp = home.headers.get('content-security-policy') || '';
ok(csp.includes("script-src 'self'") && csp.includes("frame-ancestors 'none'"), 'pages carry a Content-Security-Policy');
ok(home.headers.get('permissions-policy')?.includes('camera=()'), 'pages carry a Permissions-Policy');

// ---- Sign in and set up a campaign --------------------------------------------------------
await request(`${BASE}/auth/login`);
ok((await call('GET', '/api/session')).body.connected === true, 'signed in through OAuth');

let watch = await call('GET', '/api/watch');
ok(watch.body.available === true && watch.body.enabled === false, 'watching is offered and starts off');

const channelId = (await call('GET', '/api/channels?organizationId=org_mock')).body.channels[0].id;
const facts = { title: 'Watch Night', startsLocal: '2027-02-10T19:00', timeZone: 'Africa/Lagos', venue: 'Town Hall', price: 'Free' };
const created = await call('POST', '/api/campaigns', { facts, channelIds: [channelId], organizationId: 'org_mock', services: { [channelId]: 'bluesky' } });
ok(created.status === 201, `campaign created (${created.body.summary})`);
const [first] = created.body.campaign.posts;

// ---- Turn watching on ---------------------------------------------------------------------
watch = await call('POST', '/api/watch', {});
ok(watch.body.enabled === true, 'watching turned on');

ok((await cron(null)).status === 401, 'the scheduler endpoint refuses calls without the secret');
ok((await cron('wrong-secret-wrong-secret-wrong')).status === 401, 'and with the wrong secret');

let run = await cron();
ok(run.status === 200 && run.body.checked === 1 && run.body.failed === 0, `scheduler checked the account (${JSON.stringify(run.body)})`);
watch = await call('GET', '/api/watch');
ok(watch.body.issues.length === 0 && watch.body.checkedAt, 'nothing needs attention yet');
const nextCheck = Date.parse(watch.body.nextCheckAt);
ok(nextCheck > Date.now(), `the next check is set for just after the next post is due (${watch.body.nextCheckAt})`);

// ---- Something goes wrong in Buffer -------------------------------------------------------
await control({ postId: first.postId, set: { status: 'error' } });
await control({ channelId, set: { isQueuePaused: true } });
run = await cron();
watch = await call('GET', '/api/watch');
const texts = watch.body.issues.map((i) => i.text).join(' | ');
ok(watch.body.issues.length === 2 && /failed to publish/.test(texts) && /paused/.test(texts), `watching found the failed post and paused queue (${texts})`);
await control({ postId: first.postId, set: { status: 'scheduled' } });
await control({ channelId, set: { isQueuePaused: false } });

// ---- Single-use refresh tokens under load -------------------------------------------------
// Access tokens last about a second here, so these all need a refresh at the same moment.
await sleep(1200);
const parallel = await Promise.all([
  cron(),
  call('GET', `/api/campaigns/${created.body.campaign.id}/status`),
  call('GET', `/api/campaigns/${created.body.campaign.id}/status`),
  call('GET', '/api/session'),
]);
ok(parallel.every((r) => r.status === 200), `four requests needing a refresh at once all succeed (${parallel.map((r) => r.status).join(',')})`);
await sleep(1200);
ok((await call('GET', '/api/session')).body.connected === true, 'still connected after the stored tokens rotated');

// ---- Disconnect: watching carries on --------------------------------------------------------
await call('POST', '/auth/logout');
jar.clear();
ok((await call('GET', '/api/session')).body.connected === false, 'signed out in the browser');
await sleep(1200);
run = await cron();
ok(run.body.checked === 1 && run.body.failed === 0, 'watching keeps checking after sign-out');

// Signing back in picks the watched connection back up.
await request(`${BASE}/auth/login`);
watch = await call('GET', '/api/watch');
ok(watch.body.enabled === true, 'signing in again shows watching still on');
await sleep(1200);
run = await cron();
ok(run.body.checked === 1 && run.body.failed === 0, 'the new sign-in replaced the stored connection');

// ---- Turn it off --------------------------------------------------------------------------
watch = await call('DELETE', '/api/watch');
ok(watch.body.enabled === false, 'watching turned off');
ok((await call('GET', `/api/campaigns/${created.body.campaign.id}/status`)).status === 200, 'the browser has its own Buffer connection back');
run = await cron();
ok(run.body.due === 0, 'nothing left for the scheduler');

// Delete my data also removes a watcher.
await call('POST', '/api/watch', {});
const removed = await call('DELETE', '/api/campaigns');
ok(removed.status === 200 && removed.body.removed >= 1, 'Delete my Telly data works with watching on');
ok((await call('GET', '/api/session')).body.connected === true, 'and leaves the browser connected');
ok((await cron()).body.due === 0, 'and removes the stored connection');

// ---- Feedback and browser error reports ---------------------------------------------------
ok((await call('POST', '/api/feedback', { message: 'Love the card.', page: '/' })).status === 200, 'feedback is accepted');
ok((await call('POST', '/api/feedback', { message: '' })).status === 400, 'empty feedback is refused');
ok((await call('POST', '/api/client-error', { message: 'TypeError: x is undefined', source: '/app.js', line: 3 })).status === 204, 'browser errors are reported');
