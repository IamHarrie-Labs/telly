import crypto from 'node:crypto';
import { config } from './config.js';

// One calendar address per organiser with all their events in it. Calendar apps fetch it without
// signing in, so the address carries the account, signed so it can't be guessed or altered.

const sign = (data) => crypto.createHmac('sha256', config.cardSecret || config.sessionSecret).update(`feed:${data}`).digest('base64url').slice(0, 22);
const origin = () => new URL(config.redirectUri).origin;

export function feedUrl(accountId) {
  const data = Buffer.from(String(accountId), 'utf8').toString('base64url');
  return `${origin()}/cal/${data}.${sign(data)}.ics`;
}

/** Reads a feed address made by feedUrl: the account id, or null if it isn't one of ours. */
export function readFeedToken(token) {
  const match = /^([A-Za-z0-9_-]{1,200})\.([A-Za-z0-9_-]{22})$/.exec(String(token || ''));
  if (!match) return null;
  const expected = Buffer.from(sign(match[1]));
  const given = Buffer.from(match[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return Buffer.from(match[1], 'base64url').toString('utf8') || null;
}
