import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Set before the modules load, since config reads the environment once.
process.env.TOKEN_KEY = crypto.randomBytes(32).toString('base64');
process.env.CARD_SECRET = 'c'.repeat(40);
process.env.DATABASE_URL = '';
process.env.POSTGRES_URL = '';

const { config } = await import('../lib/config.js');
const { seal, open } = await import('../lib/vault.js');
const { cardFor, readCardToken } = await import('../lib/card.js');
const { MIGRATIONS } = await import('../lib/store.js');
const { SECURITY_HEADERS } = await import('../lib/app.js');

test('stored tokens round-trip through encryption', () => {
  const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: 123 };
  const sealed = seal(tokens);
  assert.ok(!sealed.includes('rt'), 'the refresh token is not readable in storage');
  assert.deepEqual(open(sealed), tokens);
  assert.notEqual(seal(tokens), sealed, 'each seal uses a fresh IV');
});

test('tampered tokens are rejected', () => {
  const sealed = seal({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1 });
  const parts = sealed.split('.');
  const body = Buffer.from(parts[3], 'base64url');
  body[0] ^= 1;
  parts[3] = body.toString('base64url');
  assert.throws(() => open(parts.join('.')));
});

const facts = { title: 'Key Test', startsLocal: '2026-12-10T18:00', timeZone: 'Africa/Lagos', venue: 'Hall', price: 'Free' };

test('new cards are signed with the card key', () => {
  const { url } = cardFor(facts);
  const token = url.split('/card/')[1];
  assert.ok(readCardToken(token));
  const [data] = token.split('.');
  const withCardKey = crypto.createHmac('sha256', config.cardSecret).update(`card:${data}`).digest('base64url').slice(0, 22);
  assert.equal(token, `${data}.${withCardKey}.png`);
});

test('cards signed before the card key existed still load', () => {
  const data = cardFor(facts).url.split('/card/')[1].split('.')[0];
  const legacy = crypto.createHmac('sha256', config.sessionSecret).update(`card:${data}`).digest('base64url').slice(0, 22);
  assert.ok(readCardToken(`${data}.${legacy}.png`));
  assert.equal(readCardToken(`${data}.${'A'.repeat(22)}.png`), null);
});

test('migrations are numbered once each, in order', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
  assert.equal(new Set(versions).size, versions.length);
  assert.ok(MIGRATIONS.every((m) => m.statements.every((s) => /IF NOT EXISTS/i.test(s))), 'every statement is safe to repeat');
});

test('vercel.json sends the same security headers as the server', () => {
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const sent = Object.fromEntries(vercel.headers[0].headers.map((h) => [h.key, h.value]));
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(sent[name], value, name);
});

test('the logo opens the landing page, even for signed-in visitors', () => {
  for (const file of ['index.html', 'privacy.html', 'terms.html', 'feedback.html']) {
    const html = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    const logos = html.match(/<a href="[^"]*" class="wordmark"[^>]*>/g) || [];
    assert.ok(logos.length, `${file} has a logo link`);
    for (const logo of logos.filter((l) => !l.includes('wordmark-lg'))) assert.match(logo, /href="\/\?home"/, `${file}: ${logo}`);
  }
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /params\.has\('home'\)/, 'the app shows the landing page for ?home');
});

test('signed-in visitors land on the landing page; the dashboard opens at /?app', () => {
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /!params\.has\('app'\)/, 'without ?app the app shows the landing page');
  assert.match(app, /setAttribute\('href', '\/\?app'\)/, '"Open your dashboard" opens /?app');
  const server = fs.readFileSync(new URL('../lib/app.js', import.meta.url), 'utf8');
  assert.match(server, /'\/demo'[\s\S]*?res\.redirect\('\/\?app'\)/, 'the demo opens straight into the dashboard');
  for (const file of ['privacy.html', 'terms.html', 'feedback.html']) {
    const html = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(html, /href="\/\?app">Back to Telly/, `${file}: Back to Telly opens the dashboard`);
  }
});
