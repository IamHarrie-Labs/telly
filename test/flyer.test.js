import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.ANTHROPIC_API_KEY;
process.env.TELLY_FAKE_FLYER = '1';
const { parseImage, readFlyer, flyerEnabled, FlyerError } = await import('../lib/flyer.js');

const tinyPng =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('parseImage accepts a small PNG data URL', () => {
  const image = parseImage(tinyPng);
  assert.equal(image.mediaType, 'image/png');
  assert.ok(image.data.length > 10);
});

test('parseImage rejects other types and junk', () => {
  assert.throws(() => parseImage('data:image/svg+xml;base64,PHN2Zz4='), FlyerError);
  assert.throws(() => parseImage('data:text/plain;base64,aGk='), FlyerError);
  assert.throws(() => parseImage('https://example.com/a.png'), FlyerError);
  assert.throws(() => parseImage(undefined), FlyerError);
});

test('parseImage rejects images over the size cap', () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(5 * 1024 * 1024);
  assert.throws(() => parseImage(big), (e) => e instanceof FlyerError && e.status === 413);
});

test('the local stand-in returns form-ready facts', async () => {
  assert.equal(flyerEnabled(), true);
  const facts = await readFlyer({ image: parseImage(tinyPng), timeZone: 'Europe/London', today: '2026-11-14' });
  assert.match(facts.startsLocal, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(facts.timeZone, 'Europe/London');
  assert.match(facts.bookingUrl, /^https:\/\//);
});

test('an invalid organiser time zone falls back to UTC', async () => {
  const facts = await readFlyer({ image: parseImage(tinyPng), timeZone: 'Not/AZone', today: '2026-11-14' });
  assert.equal(facts.timeZone, 'UTC');
});
