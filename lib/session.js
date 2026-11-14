import { getIronSession } from 'iron-session';
import { config } from './config.js';

// Tokens live in a sealed, HttpOnly cookie so page JavaScript can never read them.
// This is the simplest option that works on serverless hosts. Campaign data will need
// a real store later; tokens can move there at the same time.
export function getSession(req, res) {
  return getIronSession(req, res, {
    password: config.sessionSecret,
    cookieName: 'telly_sess',
    ttl: 60 * 60 * 24 * 30,
    cookieOptions: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
  });
}
