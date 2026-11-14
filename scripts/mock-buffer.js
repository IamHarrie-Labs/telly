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
const accessTokens = new Map(); // access token -> account id
const refreshOwners = new Map(); // refresh token -> account id
// Test control: who the next sign-in belongs to. A teammate shares org_mock; an outsider doesn't.
const ACCOUNTS = {
  acct_mock: { id: 'acct_mock', email: 'mock@example.com', name: 'Mock User', organizations: [{ id: 'org_mock', name: 'Mock Organization' }] },
  acct_teammate: { id: 'acct_teammate', email: 'team@example.com', name: 'Team Mate', organizations: [{ id: 'org_mock', name: 'Mock Organization' }] },
  acct_outsider: { id: 'acct_outsider', email: 'out@example.com', name: 'Out Sider', organizations: [{ id: 'org_other', name: 'Other Organization' }] },
};
let nextLogin = 'acct_mock';

const channels = [
  { id: 'ch_demo', name: 'telly-demo.bsky.social', displayName: 'Telly Demo', service: 'bluesky', avatar: null, isDisconnected: false, isQueuePaused: false },
];
const posts = new Map();
const ideas = [];
const snippets = new Map();
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

function issueTokens(owner = nextLogin) {
  const accessToken = `mock_at_${crypto.randomBytes(12).toString('hex')}`;
  const refreshToken = `mock_rt_${crypto.randomBytes(12).toString('hex')}`;
  accessTokens.set(accessToken, owner);
  refreshTokens.add(refreshToken);
  refreshOwners.set(refreshToken, owner);
  return { access_token: accessToken, refresh_token: refreshToken, token_type: 'Bearer', expires_in: Number(process.env.MOCK_TOKEN_TTL) || 3600 };
}

function handleGraphql(query, variables, who = 'acct_mock') {
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
  if (/createIdea\s*\(/.test(query)) {
    const idea = { id: `idea_${seq++}`, content: variables.input.content };
    ideas.push(idea);
    return { createIdea: { __typename: 'Idea', id: idea.id } };
  }
  if (/createSnippet\s*\(/.test(query)) {
    const snippet = { id: `snippet_${seq++}`, name: variables.input.name, text: variables.input.text };
    snippets.set(snippet.id, snippet);
    return { createSnippet: { __typename: 'CreateSnippetSuccess', snippet } };
  }
  if (/updateSnippet\s*\(/.test(query)) {
    const snippet = snippets.get(variables.input.id);
    if (!snippet) return { updateSnippet: { __typename: 'VoidMutationError', message: 'Snippet not found' } };
    Object.assign(snippet, { name: variables.input.name, text: variables.input.text });
    return { updateSnippet: { __typename: 'UpdateSnippetSuccess', snippet } };
  }
  if (/query PostsBatch/.test(query)) {
    const data = {};
    for (const [key, id] of Object.entries(variables)) data[`p${key.slice(2)}`] = posts.get(id) ?? null;
    return data;
  }
  if (/deletePost\s*\(/.test(query)) {
    posts.delete(variables.input.id);
    return { deletePost: { __typename: 'DeletePostSuccess' } };
  }
  if (/\bpost\s*\(/.test(query)) return { post: posts.get(variables.id) ?? null };
  if (/\bposts\s*\(/.test(query)) return { posts: { edges: [...posts.values()].map((node) => ({ node })) } };
  if (/\bchannels\s*\(/.test(query)) return { channels };
  if (/\baccount\s*\{/.test(query)) {
    return { account: ACCOUNTS[who] };
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
      return json(res, 200, issueTokens(refreshOwners.get(rt))); // single use: the old one is gone
    }
    return json(res, 400, { error: 'unsupported_grant_type' });
  }

  // Test controls: make a post fail, pause or disconnect a channel, or expire access tokens,
  // so the end-to-end checks can see how Telly reacts. The real Buffer has nothing like this.
  if (req.method === 'GET' && url.pathname === '/_state') return json(res, 200, { ideas, snippets: [...snippets.values()] });

  if (req.method === 'POST' && url.pathname === '/_control') {
    const c = JSON.parse((await readBody(req)) || '{}');
    if (c.postId && posts.has(c.postId)) Object.assign(posts.get(c.postId), c.set || {});
    if (c.channelId) Object.assign(channels.find((ch) => ch.id === c.channelId) || {}, c.set || {});
    if (c.expireAccessTokens) accessTokens.clear();
    if (c.nextLogin && ACCOUNTS[c.nextLogin]) nextLogin = c.nextLogin;
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/') {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!accessTokens.has(token)) return json(res, 401, { errors: [{ message: 'Unauthorized' }] });
    try {
      const { query, variables = {} } = JSON.parse(await readBody(req));
      return json(res, 200, { data: handleGraphql(query, variables, accessTokens.get(token)) });
    } catch (error) {
      return json(res, 200, { errors: [{ message: error.message }] });
    }
  }

  res.writeHead(404); res.end();
});

server.listen(PORT, () => console.log(`FAKE Buffer listening on http://localhost:${PORT} (seed post: post_1)`));
