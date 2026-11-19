import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { config, root } from './config.js';
import { getSession } from './session.js';
import { BufferError, authorizeUrl, createPkce, exchangeCode, gql, safeEqual } from './buffer.js';
import { ACCOUNT_ID, CHANNELS, EDIT_POST, GET_POST } from './queries.js';
import { accountId, campaignRoutes, ideasAvailable } from './routes-campaigns.js';
import { FlyerError, flyerEnabled, parseImage, readFlyer } from './flyer.js';
import { practice, startDemo } from './demo.js';
import { readCardToken, renderCard } from './card.js';
import { PAGE_ID, renderCalendar, renderEventPage } from './eventpage.js';
import { extFor, imageUrl, newImageId, readImageToken } from './images.js';
import { store } from './store.js';
import { alert, log } from './alert.js';
import { adoptLogin, startWatching, stopWatching, watchAvailable } from './vault.js';

export { log };

// Shared with vercel.json, which sets the same headers on the static files.
export const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // a few decorative inline style attributes on the landing page
    "img-src 'self' data: blob: https:", // channel avatars come from the networks' own image hosts
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export const app = express();
app.disable('x-powered-by');
// Vercel's proxy puts the visitor's address in X-Forwarded-For; trust its first hop only.
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({ ...SECURITY_HEADERS, 'Cache-Control': 'no-store' });
  next();
});

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// A per-address limit on API calls, counted in the database so every server instance shares
// one count. Addresses are stored only as a keyed hash. If the database can't be reached the
// request goes through: a rate limit should never be the thing that takes the app down.
const WINDOW_MS = 60_000;
const ipKey = (ip) => crypto.createHmac('sha256', config.sessionSecret).update(`rl:${ip}`).digest('base64url').slice(0, 22);
app.use(['/api', '/auth', '/card'], async (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/cron/')) return next();
  let count = 0;
  try {
    count = await store.hit(ipKey(req.ip || 'unknown'), WINDOW_MS);
  } catch (error) {
    log('rate_limit_unavailable', { message: error.message });
    return next();
  }
  if (count > config.rateLimit) {
    res.set('Retry-After', String(Math.ceil((WINDOW_MS - (Date.now() % WINDOW_MS)) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Wait a minute and try again.' });
  }
  next();
});

// ---- Event card images -------------------------------------------------------------
// Public on purpose: Buffer and the social networks fetch these. The address is signed.

app.get(
  '/card/:token',
  wrap(async (req, res) => {
    const fields = readCardToken(req.params.token);
    if (!fields) return res.status(404).send('Not found');
    const png = await renderCard(fields);
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.send(png);
  }),
);

// ---- Always-current event pages --------------------------------------------------------
// Public on purpose: posts link here. Each page shows the event's details as they are now,
// with a calendar file that updates itself when they change.

const PAGE_HEADERS = { 'Cache-Control': 'public, max-age=60, s-maxage=60' };

app.get(
  '/e/:pageId.ics',
  wrap(async (req, res) => {
    const campaign = PAGE_ID.test(req.params.pageId) ? await store.getByPage(req.params.pageId) : null;
    if (!campaign) return res.status(404).send('Not found');
    res.set({ ...PAGE_HEADERS, 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `inline; filename="${req.params.pageId}.ics"` });
    res.send(renderCalendar(campaign));
  }),
);

app.get(
  '/e/:pageId',
  wrap(async (req, res) => {
    const campaign = PAGE_ID.test(req.params.pageId) ? await store.getByPage(req.params.pageId) : null;
    if (!campaign) return res.status(404).type('text').send('This event page does not exist.');
    res.set({ ...PAGE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
    res.send(renderEventPage(campaign));
  }),
);

// ---- The organiser's own flyer, for Buffer to attach -----------------------------------

app.get(
  '/img/:token',
  wrap(async (req, res) => {
    const id = readImageToken(req.params.token);
    const image = id ? await store.getImage(id) : null;
    if (!image) return res.status(404).send('Not found');
    res.set({ 'Content-Type': image.mediaType, 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.send(image.data);
  }),
);

app.post(
  '/api/images',
  express.json({ limit: '4mb' }),
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    if (!session.tokens && !session.demo) return res.status(401).json({ error: 'Connect Buffer first.', reconnect: true });
    const uploads = Number(session.uploads) || 0;
    if (uploads >= 20) return res.status(429).json({ error: "You've uploaded a lot of images this session. Use the event card instead." });
    let image;
    try {
      image = parseImage(req.body?.image);
    } catch (error) {
      if (error instanceof FlyerError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    const owner = await accountId(session);
    const id = newImageId();
    await store.putImage({ id, accountId: owner, mediaType: image.mediaType, data: Buffer.from(image.data, 'base64') });
    session.uploads = uploads + 1;
    await session.save();
    res.status(201).json({ url: imageUrl(id, image.mediaType), ext: extFor(image.mediaType) });
  }),
);

// ---- Health: lets an uptime monitor see the app and its database are up ----------------

app.get(
  '/api/health',
  wrap(async (req, res) => {
    const started = Date.now();
    let database = 'ok';
    try {
      await store.ping();
    } catch (error) {
      database = 'down';
      await alert('health_db_failed', { message: error.message });
    }
    res.status(database === 'ok' ? 200 : 503).json({ ok: database === 'ok', database, store: store.kind, ms: Date.now() - started });
  }),
);

// ---- Read an event flyer (optional: needs ANTHROPIC_API_KEY) -----------------------
// Registered before the general JSON parser because images need a larger body limit.

app.post(
  '/api/flyer',
  express.json({ limit: '4mb' }),
  wrap(async (req, res) => {
    if (!flyerEnabled()) return res.status(404).json({ error: 'Not found' });
    const session = await getSession(req, res);
    if (!session.tokens && !session.demo) return res.status(401).json({ error: 'Connect Buffer first.', reconnect: true });
    // A simple per-session cap, since every read is a paid API call.
    const reads = Number(session.flyerReads) || 0;
    if (reads >= (session.demo ? 5 : 30)) {
      return res.status(429).json({ error: "You've used all the flyer reads for this session. Type the details in instead." });
    }
    session.flyerReads = reads + 1;
    await session.save();
    try {
      const image = parseImage(req.body?.image);
      const { altText, ...facts } = await readFlyer({ image, timeZone: req.body?.timeZone, today: req.body?.today });
      res.json({ facts, altText });
    } catch (error) {
      if (error instanceof FlyerError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  }),
);

app.use(express.json({ limit: '100kb' }));

// ---- Connect with Buffer (OAuth 2.0 Authorization Code + PKCE) --------------------

app.get(
  '/auth/login',
  wrap(async (req, res) => {
    if (!config.clientId) {
      return res.status(500).send('BUFFER_CLIENT_ID is not set. Copy .env.example to .env and fill it in.');
    }
    // Cookies are per host, so start the flow on the same host the callback will return to.
    if (req.hostname !== new URL(config.redirectUri).hostname) {
      return res.redirect(new URL('/auth/login', config.redirectUri).toString());
    }
    const session = await getSession(req, res);
    const pkce = createPkce();
    session.pkce = { verifier: pkce.verifier, state: pkce.state };
    await session.save();
    res.redirect(authorizeUrl(pkce));
  }),
);

app.get(
  '/callback',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const pkce = session.pkce;
    session.pkce = undefined; // one use only
    if (!pkce) {
      await session.save();
      return res.status(403).send('Session lost. Open the app and press Connect again.');
    }
    const { code, state, error } = req.query;
    if (!safeEqual(state, pkce.state)) {
      await session.save();
      return res.status(403).send('Invalid state parameter.');
    }
    if (error || !code) {
      await session.save();
      return res.redirect(`/?error=${encodeURIComponent(String(error || 'no_code'))}`);
    }
    try {
      session.tokens = await exchangeCode(String(code), pkce.verifier);
      session.demo = undefined; // a real connection replaces any demo
      session.accountId = undefined;
      await session.save();
    } catch (e) {
      await session.save();
      return res.redirect(`/?error=${encodeURIComponent(e.code || 'token_exchange_failed')}`);
    }
    // If this account has watching on, the fresh sign-in also repairs the stored connection.
    if (watchAvailable()) {
      try {
        session.accountId = (await gql(session, ACCOUNT_ID)).account.id;
        await session.save();
        await adoptLogin(session, session.accountId);
      } catch (error) {
        log('watch_adopt_failed', { message: error.message });
      }
    }
    res.redirect('/');
  }),
);

// ---- Background watching: opt in, opt out, and the scheduler's entry point ------------

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

async function watchState(session) {
  const owner = await accountId(session);
  const watcher = await store.getWatcher(owner);
  return {
    available: true,
    emails: Boolean(config.resendKey),
    everyHours: Math.max(1, Math.round(config.watchEveryMs / 3600_000)),
    enabled: Boolean(watcher && watcher.enabled !== false),
    email: watcher?.email ?? null,
    checkedAt: watcher?.checkedAt ?? null,
    nextCheckAt: watcher?.nextCheckAt ?? null,
    lastError: watcher?.lastError ?? null,
    issues: watcher?.issues ?? [],
  };
}

const watchGuard = async (req, res) => {
  const session = await getSession(req, res);
  if (!watchAvailable() || session.demo) {
    res.status(404).json({ error: 'Watching is not available here.', available: false });
    return null;
  }
  if (!session.tokens) {
    res.status(401).json({ error: 'Connect Buffer first.', reconnect: true });
    return null;
  }
  return session;
};

app.get(
  '/api/watch',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    if (!watchAvailable() || session.demo || !session.tokens) return res.json({ available: false });
    res.json(await watchState(session));
  }),
);

app.post(
  '/api/watch',
  express.json({ limit: '10kb' }),
  wrap(async (req, res) => {
    const session = await watchGuard(req, res);
    if (!session) return;
    const email = String(req.body?.email || '').trim().slice(0, 320);
    if (config.resendKey && !EMAIL.test(email)) return res.status(400).json({ error: 'Enter the email address Telly should write to.' });
    const owner = await accountId(session);
    await startWatching(session, owner, { email: config.resendKey ? email : null });
    res.json(await watchState(session));
  }),
);

app.delete(
  '/api/watch',
  wrap(async (req, res) => {
    const session = await watchGuard(req, res);
    if (!session) return;
    await stopWatching(session, await accountId(session));
    res.json(session.tokens ? await watchState(session) : { available: true, enabled: false, reconnect: true });
  }),
);

// Called by the scheduler (GitHub Actions every half hour, Vercel Cron daily as a backstop).
app.all(
  '/api/cron/watch',
  wrap(async (req, res) => {
    const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (!config.cronSecret || !safeEqual(given, config.cronSecret)) return res.status(401).json({ error: 'Unauthorized' });
    if (!watchAvailable()) return res.json({ due: 0, checked: 0, note: 'TOKEN_KEY is not set' });
    const { runDueWatchers } = await import('./watch.js');
    res.json(await runDueWatchers());
  }),
);

// ---- Feedback and browser errors ----------------------------------------------------

app.post(
  '/api/feedback',
  express.json({ limit: '20kb' }),
  wrap(async (req, res) => {
    const message = String(req.body?.message || '').trim().slice(0, 4000);
    if (message.length < 3) return res.status(400).json({ error: 'Write a few words first.' });
    const session = await getSession(req, res);
    const page = String(req.body?.page || '').slice(0, 200);
    await store.addFeedback({ accountId: session.accountId || (session.demo ? 'demo' : null), page, message });
    await alert('feedback', { page, message: message.slice(0, 280) });
    res.json({ ok: true });
  }),
);

app.post(
  '/api/client-error',
  express.json({ limit: '10kb' }),
  (req, res) => {
    const b = req.body || {};
    alert('client_error', {
      message: String(b.message || '').slice(0, 300),
      source: String(b.source || '').slice(0, 200),
      line: Number(b.line) || undefined,
      page: String(b.page || '').slice(0, 200),
    }).catch(() => {});
    res.status(204).end();
  },
);

// ---- Demo: the full app on a practice queue, for anyone without a Buffer account ----

app.get(
  '/demo',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    if (!session.tokens && !session.demo) {
      startDemo(session);
      session.accountId = undefined;
      await session.save();
    }
    res.redirect('/?app');
  }),
);

app.post(
  '/api/demo/posts/:postId',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    if (!session.demo) return res.status(404).json({ error: 'Not found' });
    const { action, text } = req.body || {};
    const result = await practice(session, String(req.params.postId), String(action || ''), text);
    if (!result) return res.status(400).json({ error: 'That practice action did not apply.' });
    res.json(result);
  }),
);

app.post(
  '/auth/logout',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    session.destroy();
    res.json({ connected: false });
  }),
);

// ---- Account and channels ---------------------------------------------------------

const ACCOUNT = /* GraphQL */ `
  query Account {
    account {
      id
      email
      name
      organizations {
        id
        name
      }
    }
  }
`;

app.get(
  '/api/session',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    if (!session.tokens && !session.demo) return res.json({ connected: false, lab: config.labEnabled });
    const data = await gql(session, ACCOUNT);
    res.json({
      connected: true,
      demo: Boolean(session.demo),
      lab: config.labEnabled && !session.demo,
      flyer: flyerEnabled(),
      ideas: ideasAvailable(session),
      account: data.account,
    });
  }),
);

app.get(
  '/api/channels',
  wrap(async (req, res) => {
    const organizationId = String(req.query.organizationId || '');
    if (!organizationId) return res.status(400).json({ error: 'organizationId is required' });
    const session = await getSession(req, res);
    const data = await gql(session, CHANNELS, { organizationId });
    // Return every channel and let the page say which ones need reconnecting in Buffer.
    res.json({ channels: data.channels });
  }),
);

// ---- Lab: prove the edit-a-scheduled-post promise against the live API ------------
//
// Telly's core claim is that one change can repair a scheduled post's text, its image and
// its image description without touching the schedule. These endpoints test exactly that
// on a real post, so we know the claim holds before building the rest on top of it.

function requireLab(req, res, next) {
  if (!config.labEnabled) return res.status(404).json({ error: 'Not found' });
  next();
}

app.get(
  '/api/lab/post',
  requireLab,
  wrap(async (req, res) => {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ error: 'id is required' });
    const session = await getSession(req, res);
    const data = await gql(session, GET_POST, { id });
    res.json({ post: data.post });
  }),
);

app.post(
  '/api/lab/edit',
  requireLab,
  wrap(async (req, res) => {
    const { postId, text, imageUrl, altText } = req.body || {};
    if (!postId) return res.status(400).json({ error: 'postId is required' });
    if (imageUrl && !/^https:\/\//i.test(imageUrl)) {
      return res.status(400).json({ error: 'imageUrl must be a public https URL' });
    }
    if (imageUrl && !altText) {
      return res.status(400).json({ error: 'altText is required with imageUrl' });
    }
    const session = await getSession(req, res);

    const before = (await gql(session, GET_POST, { id: postId })).post;

    // Deliberately no `mode` or `dueAt`: Buffer documents that leaving them out keeps the
    // post's current schedule. That is the behaviour this test exists to confirm.
    const input = { id: postId };
    if (typeof text === 'string') input.text = text;
    if (imageUrl) input.assets = [{ image: { url: imageUrl, metadata: { altText } } }];

    const result = (await gql(session, EDIT_POST, { input })).editPost;
    if (!result?.post) {
      return res.status(422).json({ error: result?.message || 'Buffer refused the edit', before });
    }

    // Read the post back rather than trusting the mutation response.
    const after = (await gql(session, GET_POST, { id: postId })).post;

    const checks = {
      scheduleKept: before.dueAt === after.dueAt,
      statusKept: before.status === after.status,
      textChanged: typeof text === 'string' ? after.text === text : null,
      imageAltApplied: imageUrl
        ? after.assets.some((a) => a.image?.altText === altText)
        : null,
    };
    res.json({ before, after, checks });
  }),
);

app.use('/api/campaigns', campaignRoutes);

// ---- Static front end and errors --------------------------------------------------

app.use(express.static(path.join(root, 'public')));

app.use((error, req, res, next) => {
  const status = error instanceof BufferError ? error.status : 500;
  if (status >= 500) {
    const fields = { method: req.method, path: req.path, status, message: error.message, stack: error.stack?.split('\n').slice(0, 4).join(' | ') };
    // Buffer being briefly unreachable is logged; anything else is our bug and raises an alert.
    if (error instanceof BufferError) log('request_failed', fields);
    else alert('request_failed', fields).catch(() => {});
  }
  res.status(status).json({
    error: error instanceof BufferError ? error.message : 'Something went wrong on our side.',
    ...(status === 401 ? { reconnect: true } : {}),
  });
});
