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
};
