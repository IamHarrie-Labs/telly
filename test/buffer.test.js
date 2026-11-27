import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createPkce, authorizeUrl, safeEqual } from '../lib/buffer.js';

test('PKCE challenge is the base64url SHA-256 of the verifier', () => {
  const { verifier, challenge } = createPkce();
  const expected = crypto.createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
  assert.ok(verifier.length >= 43, 'verifier must be at least 43 characters');
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
});

test('every authorization starts with fresh values', () => {
  const a = createPkce();
  const b = createPkce();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

test('authorize URL carries PKCE, state and the scopes Telly needs', () => {
  const pkce = createPkce();
  const url = new URL(authorizeUrl(pkce));
  assert.equal(url.origin + url.pathname, 'https://auth.buffer.com/auth');
  const p = url.searchParams;
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('code_challenge'), pkce.challenge);
  assert.equal(p.get('state'), pkce.state);
  assert.equal(p.get('prompt'), 'consent');
  const scopes = p.get('scope').split(' ');
  for (const needed of ['posts:read', 'posts:write', 'account:read', 'offline_access']) {
    assert.ok(scopes.includes(needed), `missing scope ${needed}`);
  }
  assert.ok(!p.has('code_verifier'), 'the verifier must never be sent to the authorize endpoint');
});

test('state comparison rejects mismatches and missing values', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.equal(safeEqual(undefined, undefined), false);
});

test('a partial read where every post is gone reports not-found errors instead of throwing', async (t) => {
  const { gql } = await import('../lib/buffer.js');
  const { fetchCurrent } = await import('../lib/routes-campaigns.js');
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  // What Buffer now sends when the only post asked about was deleted.
  globalThis.fetch = async () => new Response(JSON.stringify({ data: null, errors: [{ message: 'Post not found for id: abc', path: ['p0'] }] }), { status: 200 });
  const session = { tokens: { accessToken: 'x', expiresAt: Date.now() + 60_000 }, save: async () => {} };
  const { data, errors } = await gql(session, 'query { p0: post(input: {id: "abc"}) { id } }', {}, { partial: true });
  assert.deepEqual(data, {});
  assert.equal(errors.length, 1);
  const current = await fetchCurrent(session, [{ postId: 'abc' }]);
  assert.equal(current.size, 0, 'a deleted post reads back as gone, not as a failure');
});
