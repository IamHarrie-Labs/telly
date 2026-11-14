// A FAKE Buffer for local development. It imitates Buffer's OAuth (PKCE, rotating refresh
// tokens) and the handful of GraphQL operations Telly uses, with in-memory data.
//
// It tests Telly's own logic. It cannot prove how the real Buffer behaves: for example, its
// editPost keeps the schedule because we coded it to follow Buffer's documentation, not because
// Buffer was asked. Anything that matters for the claims we make must be checked on the real API.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT) || 4010;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

const codes = new Map(); // authorization code -> { challenge, redirectUri }
const refreshTokens = new Set();
const accessTokens = new Set();

const channels = [
  { id: 'ch_demo', name: 'telly-demo.bsky.social', displayName: 'Telly Demo', service: 'bluesky', avatar: null, isDisconnected: false, isQueuePaused: false },
];
const posts = new Map();
let seq = 1;

function makePost({ text, channelId = 'ch_demo', dueAt, imageUrl, altText }) {
  const id = `post_${seq++}`;
  const now = new Date().toISOString();
  const post = {
    id, text, status: 'scheduled', dueAt, updatedAt: now, shareMode: 'customScheduled', isCustomScheduled: true,
    channelId, channelService: 'bluesky', assets: [],
  };
  if (imageUrl) post.assets.push(makeAsset(imageUrl, altText));
  posts.set(id, post);
  return post;
}
function makeAsset(url, altText = '') {
  return { id: `asset_${seq++}`, type: 'image', mimeType: 'image/png', source: url, image: { altText, width: 1080, height: 1080 } };
}
makePost({ text: 'Workshop at the Library, Sat 12 Dec, 2pm. Free entry.', dueAt: '2026-12-10T14:00:00.000Z', imageUrl: 'https://example.com/flyer-v1.png', altText: 'Poster' });

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });

function issueTokens() {
  const accessToken = `mock_at_${crypto.randomBytes(12).toString('hex')}`;
  const refreshToken = `mock_rt_${crypto.randomBytes(12).toString('hex')}`;
  accessTokens.add(accessToken);
  refreshTokens.add(refreshToken);
  return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: Number(process.env.MOCK_TOKEN_TTL) || 3600 };
}

function handleGraphql(query, variables) {
  if (/editPost\s*\(/.test(query)) {
    const input = variables.input;
    const post = posts.get(input.id);
    if (!post) return { editPost: { message: 'Post not found' } };
    if (typeof input.text === 'string') post.text = input.text;
    if (Array.isArray(input.assets)) {
      post.assets = input.assets.map((a) => makeAsset(a.image.url, a.image.metadata?.altText ?? ''));
    }
    // Follows the documented behaviour: schedule changes only when dueAt is sent.
    if (input.dueAt) post.dueAt = input.dueAt;
    post.updatedAt = new Date().toISOString();
    return { editPost: { post } };
  }
  if (/createPost\s*\(/.test(query)) {
    const i = variables.input;
    const post = makePost({ text: i.text, channelId: i.channelId, dueAt: i.dueAt, imageUrl: i.assets?.[0]?.image?.url, altText: i.assets?.[0]?.image?.metadata?.altText });
    return { createPost: { post } };
  }
  if (/deletePost\s*\(/.test(query)) {
    posts.delete(variables.input.id);
    return { deletePost: { __typename: 'DeletePostSuccess' } };
  }
  if (/\bpost\s*\(/.test(query)) return { post: posts.get(variables.id) ?? null };
  if (/\bposts\s*\(/.test(query)) return { posts: { edges: [...posts.values()].map((node) => ({ node })) } };
  if (/\bchannels\s*\(/.test(query)) return { channels };
  if (/\baccount\s*\{/.test(query)) {
    return { account: { id: 'acct_mock', email: 'mock@example.com', name: 'Mock User', organizations: [{ id: 'org_mock', name: 'Mock Organization' }] } };
  }
  throw new Error('The fake Buffer does not implement this operation');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/auth') {
    const q = url.searchParams;
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
      res.writeHead(400); return res.end('PKCE with S256 is required');
    }
    const code = b64url(crypto.randomBytes(16));
    codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri') });
    const back = new URL(q.get('redirect_uri'));
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state'));
    res.writeHead(302, { Location: back.toString() }); // auto-approves: no consent screen here
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/token') {
    const p = new URLSearchParams(await readBody(req));
    if (p.get('grant_type') === 'authorization_code') {
      const entry = codes.get(p.get('code'));
      codes.delete(p.get('code'));
      const ok = entry && entry.redirectUri === p.get('redirect_uri') &&
        b64url(crypto.createHash('sha256').update(p.get('code_verifier') || '').digest()) === entry.challenge;
      return ok ? json(res, 200, issueTokens()) : json(res, 400, { error: 'invalid_grant', error_description: 'Code invalid or PKCE failed' });
    }
    if (p.get('grant_type') === 'refresh_token') {
      const rt = p.get('refresh_token');
      if (!refreshTokens.delete(rt)) return json(res, 400, { error: 'invalid_grant', error_description: 'Refresh token already used or unknown' });
      return json(res, 200, issueTokens()); // single use: the old one is gone
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }

  if (req.method === 'POST' && url.pathname === '/') {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!accessTokens.has(token)) return json(res, 401, { errors: [{ message: 'Unauthorized' }] });
    try {
      const { query, variables = {} } = JSON.parse(await readBody(req));
      return json(res, 200, { data: handleGraphql(query, variables) });
    } catch (error) {
      return json(res, 200, { errors: [{ message: error.message }] });
    }
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => console.log(`FAKE Buffer listening on http://localhost:${PORT} (seed post: post_1)`));
