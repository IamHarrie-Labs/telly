import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Local development reads .env; production hosts set real environment variables.
// .env.local holds the database settings pulled from Vercel (`vercel env pull`).
for (const name of ['.env', '.env.local']) {
  try {
    process.loadEnvFile(path.join(root, name));
  } catch {
    /* file missing, which is fine in production */
  }
}

// Every Vercel deployment counts as production: real Buffer endpoints, no lab, no file store.
const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
const port = Number(process.env.PORT) || 3000;

function sessionSecret() {
  const fromEnv = (process.env.SESSION_SECRET || '').trim();
  if (fromEnv.length >= 32) return fromEnv;
  if (isProd) throw new Error('SESSION_SECRET must be set to 32+ characters in production');
  // Local development: generate once and keep it stable so restarts do not sign you out.
  const file = path.join(root, '.session-key');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return saved;
  } catch {
    /* first run */
  }
  const fresh = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, fresh, { mode: 0o600 });
  return fresh;
}

function defaultRedirect() {
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/callback`;
  }
  return `https://localhost:${port}/callback`;
}

// Endpoint overrides exist only so a local fake Buffer server can stand in during development.
// They are ignored in production so tokens can never be sent anywhere unexpected.
const endpoint = (name, real) => {
  const override = (process.env[name] || '').trim();
  return !isProd && override ? override : real;
};

// A 32-byte key, given as base64 or hex, or null when missing or the wrong size.
function key32(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw) return null;
  for (const encoding of ['base64', 'hex']) {
    const buf = Buffer.from(raw, encoding);
    if (buf.length === 32) return buf;
  }
  console.error(`${name} must be 32 bytes, as base64 or hex. Ignoring it.`);
  return null;
}

const cardSecret = (process.env.CARD_SECRET || '').trim();

export const config = {
  isProd,
  port,
  apiUrl: endpoint('BUFFER_API_URL', 'https://api.buffer.com'),
  authUrl: endpoint('BUFFER_AUTH_URL', 'https://auth.buffer.com/auth'),
  tokenUrl: endpoint('BUFFER_TOKEN_URL', 'https://auth.buffer.com/token'),
  clientId: (process.env.BUFFER_CLIENT_ID || '').trim(),
  clientSecret: (process.env.BUFFER_CLIENT_SECRET || '').trim(),
  // Must match the URI registered on the Buffer app client character for character.
  redirectUri: (process.env.REDIRECT_URI || defaultRedirect()).trim(),
  sessionSecret: sessionSecret(),
  // Telly reads and edits posts, so it needs posts:read and posts:write.
  scopes: 'account:read posts:read posts:write offline_access',
  // The lab endpoints exist to prove the edit-a-scheduled-post flow against the live API.
  labEnabled: !isProd || process.env.TELLY_LAB === '1',
  // Signs event card addresses. Kept apart from the session secret so rotating one never
  // breaks the other. Older cards signed with the session secret still verify.
  cardSecret: cardSecret.length >= 32 ? cardSecret : null,
  // Encrypts Buffer tokens stored for background watching. Without it, watching is off.
  tokenKey: key32('TOKEN_KEY'),
  // Shared secret the scheduler sends to /api/cron/watch.
  cronSecret: (process.env.CRON_SECRET || '').trim(),
  // Optional: a Slack- or Discord-style webhook that receives error alerts.
  alertWebhook: (process.env.ALERT_WEBHOOK_URL || '').trim(),
  // Optional: Resend, for emailing organisers when a watched post needs attention.
  resendKey: (process.env.RESEND_API_KEY || '').trim(),
  alertFrom: (process.env.ALERT_FROM || 'Telly <alerts@usetelly.xyz>').trim(),
  rateLimit: Number(process.env.RATE_LIMIT_MAX) || 120,
  // How long a watcher rests between checks. Buffer's per-app budget is about 500 calls a day
  // plus 25 per connected user, and a check costs a few calls per campaign, so the default is
  // four checks a day. WATCH_EVERY_HOURS changes it; tests use WATCH_EVERY_MS (ignored in production).
  watchEveryMs: (!isProd && Number(process.env.WATCH_EVERY_MS))
    || (Number(process.env.WATCH_EVERY_HOURS) >= 1 ? Number(process.env.WATCH_EVERY_HOURS) * 3600_000 : 6 * 3600_000),
  dataDir: (process.env.TELLY_DATA_DIR || '').trim() || path.join(root, 'data'),
};
