import path from 'node:path';
import express from 'express';
import { config, root } from './config.js';
import { getSession } from './session.js';
import { BufferError, authorizeUrl, createPkce, exchangeCode, gql, safeEqual } from './buffer.js';
import { EDIT_POST, GET_POST } from './queries.js';
import { campaignRoutes } from './routes-campaigns.js';
import { FlyerError, flyerEnabled, parseImage, readFlyer } from './flyer.js';
import { practice, startDemo } from './demo.js';
import { readCardToken, renderCard } from './card.js';
import { store } from './store.js';

// One JSON line per event, so Vercel's log search can filter by name.
export const log = (event, fields = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

export const app = express();
app.disable('x-powered-by');
// Vercel's proxy puts the visitor's address in X-Forwarded-For; trust its first hop only.
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
});

const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

// A simple per-address limit on API calls. Each server instance counts on its own, so this
// stops runaway scripts rather than a determined attacker.
const hits = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 120;
app.use(['/api', '/auth', '/card'], (req, res, next) => {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const entry = hits.get(key);
  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(key, { start: now, count: 1 });
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
    return next();
  }
  if (++entry.count > MAX_PER_WINDOW) {
    res.set('Retry-After', String(Math.ceil((entry.start + WINDOW_MS - now) / 1000)));
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
      log('health_db_failed', { message: error.message });
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
      const facts = await readFlyer({ image, timeZone: req.body?.timeZone, today: req.body?.today });
      res.json({ facts });
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
      res.redirect('/');
    } catch (e) {
      await session.save();
      res.redirect(`/?error=${encodeURIComponent(e.code || 'token_exchange_failed')}`);
    }
  }),
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
    res.redirect('/');
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

const CHANNELS = /* GraphQL */ `
  query Channels($organizationId: OrganizationId!) {
    channels(input: { organizationId: $organizationId }) {
      id
      name
      displayName
      service
      avatar
      isDisconnected
      isQueuePaused
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
  if (status >= 500) log('request_failed', { method: req.method, path: req.path, status, message: error.message, stack: error.stack?.split('\n').slice(0, 4).join(' | ') });
  res.status(status).json({
    error: error instanceof BufferError ? error.message : 'Something went wrong on our side.',
    ...(status === 401 ? { reconnect: true } : {}),
  });
});
