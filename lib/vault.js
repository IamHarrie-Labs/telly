import crypto from 'node:crypto';
import { config } from './config.js';
import { store } from './store.js';
import { BufferError, refreshTokens } from './buffer.js';
import { log } from './alert.js';

// Background watching needs Buffer tokens when the organiser isn't on the page, so for
// people who turn it on, Telly keeps their tokens in the database, encrypted with TOKEN_KEY
// (AES-256-GCM). The browser cookie then holds only a pointer: { vault: accountId }.
//
// Buffer's refresh tokens are single use, so the stored copy is the only copy, and a lock
// makes sure only one request at a time can swap it for a new one.

export const watchAvailable = () => Boolean(config.tokenKey);

export function seal(tokens) {
  if (!config.tokenKey) throw new Error('TOKEN_KEY is not set');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.tokenKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function open(sealed) {
  const [version, iv, tag, body] = String(sealed).split('.');
  if (version !== 'v1' || !config.tokenKey) throw new Error('Cannot read stored tokens');
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.tokenKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOCK_MS = 20_000;

/** A valid access token for a watched account, refreshing the stored tokens when needed. */
export async function vaultAccessToken(accountId) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const watcher = await store.getWatcher(accountId);
    if (!watcher) throw new BufferError('Your Buffer connection expired. Please connect again.', 401);
    const tokens = open(watcher.tokens);
    if (Date.now() < tokens.expiresAt) return tokens.accessToken;

    if (!(await store.claimWatcher(accountId, LOCK_MS))) {
      await sleep(250); // someone else is refreshing; use their result
      continue;
    }
    try {
      const latest = open((await store.getWatcher(accountId)).tokens);
      if (Date.now() < latest.expiresAt) return latest.accessToken;
      let fresh;
      try {
        fresh = await refreshTokens(latest.refreshToken);
      } catch (error) {
        // Buffer won't renew the connection (revoked or expired): stop watching until they reconnect.
        log('watch_refresh_failed', { accountId, message: error.message });
        const w = await store.getWatcher(accountId);
        await store.putWatcher(accountId, { ...strip(w), enabled: false, lastError: 'reconnect' });
        throw new BufferError('Your Buffer connection expired. Please connect again.', 401);
      }
      await store.setWatcherTokens(accountId, seal(fresh));
      return fresh.accessToken;
    } finally {
      await store.releaseWatcher(accountId).catch(() => {});
    }
  }
  throw new BufferError('Buffer sign-in is busy. Try again in a moment.', 503);
}

/** Moves a signed-in browser's tokens into the vault and leaves a pointer in the cookie. */
export async function startWatching(session, accountId, data) {
  const existing = await store.getWatcher(accountId);
  if (session.tokens?.vault) {
    await store.putWatcher(accountId, { ...strip(existing), ...data, enabled: true, lastError: null });
    return;
  }
  await store.createWatcher(accountId, seal(session.tokens), { ...data, enabled: true, lastError: null, createdAt: new Date().toISOString() });
  session.tokens = { vault: accountId };
  await session.save();
}

/** Takes the tokens back into the cookie and deletes the stored copy. */
export async function stopWatching(session, accountId) {
  const watcher = await store.getWatcher(accountId);
  if (!watcher) return;
  if (session.tokens?.vault === accountId) {
    try {
      await vaultAccessToken(accountId); // make sure the copy we hand back is current
      session.tokens = open((await store.getWatcher(accountId)).tokens);
    } catch {
      session.tokens = undefined; // the stored connection had expired; they'll need to reconnect
    }
    await session.save();
  }
  await store.removeWatcher(accountId);
}

/** After a fresh sign-in, a watched account's stored tokens are replaced with the new ones. */
export async function adoptLogin(session, accountId) {
  const watcher = await store.getWatcher(accountId);
  if (!watcher || !session.tokens || session.tokens.vault) return false;
  await store.setWatcherTokens(accountId, seal(session.tokens));
  await store.putWatcher(accountId, { ...strip(watcher), enabled: true, lastError: null });
  session.tokens = { vault: accountId };
  await session.save();
  return true;
}

// The watcher's own fields, without the columns store.getWatcher adds.
export function strip(watcher) {
  if (!watcher) return {};
  const { tokens, accountId, lastRun, ...data } = watcher;
  return data;
}
