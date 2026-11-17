import crypto from 'node:crypto';
import { config } from './config.js';

// The organiser's own flyer, kept so Buffer can attach it to posts. Buffer fetches images by
// address, so each one is served from a signed address that can't be guessed or altered.
// If a detail printed on the flyer changes later, Telly offers to swap it for the event card,
// so an old flyer never keeps showing the wrong venue or date.

const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const sign = (id) => crypto.createHmac('sha256', config.cardSecret || config.sessionSecret).update(`img:${id}`).digest('base64url').slice(0, 22);
const origin = () => new URL(config.redirectUri).origin;

export const newImageId = () => crypto.randomBytes(12).toString('base64url');
export const extFor = (mediaType) => TYPES[mediaType] || null;
export const imageUrl = (id, mediaType) => `${origin()}/img/${id}.${sign(id)}.${extFor(mediaType)}`;

/** Reads an image address made by imageUrl: its id, or null if it isn't one of ours. */
export function readImageToken(token) {
  const match = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.(jpg|png|webp|gif)$/.exec(String(token || ''));
  if (!match) return null;
  const expected = Buffer.from(sign(match[1]));
  const given = Buffer.from(match[2]);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? match[1] : null;
}

/** Checks that an address the browser sent back is an image Telly stored, and returns it tidied. */
export function readOwnImage(input) {
  if (!input || typeof input !== 'object') return null;
  const url = String(input.url || '');
  const prefix = `${origin()}/img/`;
  if (!url.startsWith(prefix) || !readImageToken(url.slice(prefix.length))) return null;
  const altText = String(input.altText || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (altText.length < 10) return null; // a picture always goes out with a real description
  return { url, altText, flyer: true };
}
