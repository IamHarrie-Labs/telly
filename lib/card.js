import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';
import { describeCard, startsAt, whereLine, formatDay, formatTime } from './campaign.js';

// The event card: a square image Telly attaches to each post, with alt text written from the
// same details. Its address carries the details themselves, signed so nobody can use Telly to
// draw arbitrary images. When a detail changes the address changes, which tells Telly the
// picture on a scheduled post needs replacing.

const SIZE = 1080;
const sign = (data) => crypto.createHmac('sha256', config.sessionSecret).update(`card:${data}`).digest('base64url').slice(0, 22);

function cardFields(facts) {
  const start = startsAt(facts);
  return {
    t: facts.title,
    d: formatDay(start, facts.timeZone),
    h: formatTime(start, facts.timeZone),
    w: whereLine(facts),
    p: facts.price || '',
  };
}

const origin = () => new URL(config.redirectUri).origin;

/** The card's public address and its alt text, or null for a cancelled event. */
export function cardFor(facts) {
  if (facts.status === 'cancelled') return null;
  const data = Buffer.from(JSON.stringify(cardFields(facts))).toString('base64url');
  return { url: `${origin()}/card/${data}.${sign(data)}.png`, altText: describeCard(facts) };
}

/** Checks a card token from a URL and returns the fields to draw, or null. */
export function readCardToken(token) {
  const match = /^([A-Za-z0-9_-]{10,1500})\.([A-Za-z0-9_-]{22})\.png$/.exec(String(token || ''));
  if (!match) return null;
  const expected = Buffer.from(sign(match[1]));
  const given = Buffer.from(match[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const fields = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
    return typeof fields.t === 'string' ? fields : null;
  } catch {
    return null;
  }
}

let fonts;
const loadFonts = () => (fonts ??= [400, 600].map((weight) => ({
  name: 'Poppins',
  weight,
  style: 'normal',
  data: fs.readFileSync(new URL(`./fonts/poppins-latin-${weight}-normal.woff`, import.meta.url)),
})));

// Plain element objects, so no JSX build step is needed.
const h = (type, style, ...children) => ({ type, props: { style, children: children.flat().filter((c) => c !== null && c !== '') } });

function layout(f) {
  const titleSize = f.t.length > 60 ? 64 : f.t.length > 34 ? 80 : 100;
  return h('div', {
    width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    background: '#ece7dc', color: '#2b2a22', padding: '84px 88px', fontFamily: 'Poppins',
  },
  h('div', { display: 'flex', fontSize: 28, letterSpacing: 6, textTransform: 'uppercase', color: '#6b6857' }, 'Event'),
  h('div', { display: 'flex', flexDirection: 'column' },
    h('div', { display: 'flex', fontSize: titleSize, fontWeight: 600, lineHeight: 1.05, letterSpacing: -2 }, f.t),
    h('div', { display: 'flex', width: 120, height: 8, background: '#413f32', marginTop: 48, marginBottom: 48 }),
    h('div', { display: 'flex', fontSize: 46, fontWeight: 600 }, f.d),
    h('div', { display: 'flex', fontSize: 46, marginTop: 6 }, f.h),
    h('div', { display: 'flex', fontSize: 40, marginTop: 34, color: '#413f32' }, f.w),
  ),
  h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', fontSize: 34 },
    f.p ? h('div', { display: 'flex', background: '#413f32', color: '#f6f3ec', padding: '14px 28px', borderRadius: 999 }, f.p) : h('div', { display: 'flex' }, ''),
  ));
}

/** Draws the card as a PNG. */
export async function renderCard(fields) {
  const [{ default: satori }, { Resvg }] = await Promise.all([import('satori'), import('@resvg/resvg-js')]);
  const svg = await satori(layout(fields), { width: SIZE, height: SIZE, fonts: loadFonts() });
  return new Resvg(svg, { fitTo: { mode: 'width', value: SIZE } }).render().asPng();
}
