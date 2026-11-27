import crypto from 'node:crypto';
import { config } from './config.js';

export class BufferError extends Error {
  constructor(message, status = 500, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

// ---- PKCE and authorization URL ------------------------------------------------

export function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('base64url');
  return { verifier, challenge, state };
}

export function authorizeUrl({ state, challenge }) {
  const url = new URL(config.authUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  }).toString();
  return url.toString();
}

export function safeEqual(a, b) {
  // A missing value never matches, even another missing value.
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---- Tokens --------------------------------------------------------------------

function toTokenSet(json) {
  if (!json.access_token || !json.refresh_token) {
    throw new BufferError('Buffer did not return a refresh token. Check the offline_access scope.', 502);
  }
  // Store the moment of expiry, minus a margin so a token does not lapse mid-request.
  const expiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000 - 30_000;
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt };
}

async function tokenRequest(params) {
  const body = new URLSearchParams({ client_id: config.clientId, ...params });
  if (config.clientSecret) body.set('client_secret', config.clientSecret);
  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new BufferError(json.error_description || json.error || 'Token request failed', 401, {
      code: json.error,
    });
  }
  return toTokenSet(json);
}

export function exchangeCode(code, verifier) {
  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
}

// Refresh tokens are single use: a second refresh with the same token revokes the grant.
// Share one in-flight refresh per token so parallel requests in this process cannot collide.
const inflight = new Map();

export function refreshTokens(refreshToken) {
  if (!inflight.has(refreshToken)) {
    const pending = tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }).finally(() =>
      setTimeout(() => inflight.delete(refreshToken), 5000),
    );
    inflight.set(refreshToken, pending);
  }
  return inflight.get(refreshToken);
}

export async function accessToken(session) {
  const tokens = session.tokens;
  if (!tokens) throw new BufferError('Not connected to Buffer', 401);
  if (tokens.vault) {
    // Background watching is on: the tokens live encrypted in the database (see vault.js).
    const { vaultAccessToken } = await import('./vault.js');
    try {
      return await vaultAccessToken(tokens.vault);
    } catch (error) {
      if (error instanceof BufferError && error.status === 401) {
        session.tokens = undefined;
        await session.save();
      }
      throw error;
    }
  }
  if (Date.now() < tokens.expiresAt) return tokens.accessToken;
  try {
    // Save the replacement before anything else can use it.
    session.tokens = await refreshTokens(tokens.refreshToken);
    await session.save();
    return session.tokens.accessToken;
  } catch (error) {
    session.tokens = undefined;
    await session.save();
    throw new BufferError('Your Buffer connection expired. Please connect again.', 401);
  }
}

// ---- GraphQL -------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one GraphQL request. With { partial: true } it returns { data, errors } instead of
 * throwing on field errors, for batched reads where one missing post must not sink the rest.
 */
export async function gql(session, query, variables = {}, { partial = false } = {}) {
  if (session.demo?.id) {
    // Demo visitors talk to a practice queue, never to Buffer.
    const { demoGql } = await import('./demo.js');
    try {
      const data = await demoGql(session, query, variables);
      return partial ? { data, errors: data.__errors || [] } : data;
    } catch (error) {
      throw new BufferError(error.message, 502);
    }
  }
  // Only reads are retried: repeating a create or edit after a lost reply could post twice.
  const canRetry = !/^\s*mutation\b/.test(query);
  for (let attempt = 1; ; attempt++) {
    const token = await accessToken(session);
    let response;
    try {
      response = await fetch(config.apiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      // A dropped connection or timeout: one quick retry, then report it.
      if (attempt === 1 && canRetry) { await sleep(400); continue; }
      throw new BufferError("Couldn't reach Buffer. Check the post in Buffer, then try again.", 503);
    }
    if (response.status >= 502 && response.status <= 504 && attempt === 1 && canRetry) {
      await sleep(600);
      continue;
    }

    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after')) || 0;
      if (attempt === 1 && wait > 0 && wait <= 5) {
        await sleep(wait * 1000 + Math.random() * 250);
        continue;
      }
      throw new BufferError(`Buffer rate limit reached. Try again in ${wait || 'a few'} seconds.`, 429, {
        retryAfter: wait,
      });
    }
    if (response.status === 401) {
      session.tokens = undefined;
      await session.save();
      throw new BufferError('Your Buffer connection expired. Please connect again.', 401);
    }

    const json = await response.json().catch(() => null);
    if (!json) throw new BufferError(`Buffer returned an unreadable response (HTTP ${response.status})`, 502);
    // When every part of a partial read fails (say, all the posts asked about were deleted),
    // Buffer sends data: null rather than an object of nulls. The caller sorts the errors.
    if (partial && (json.data || json.errors?.length)) return { data: json.data || {}, errors: json.errors || [] };
    if (json.errors?.length) {
      throw new BufferError(json.errors.map((e) => e.message).join('; '), 502, { graphql: json.errors });
    }
    return json.data;
  }
}
