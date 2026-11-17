import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

// Reads an event flyer image with Claude and returns the details for the facts form.
// Nothing here is saved: the image goes to Claude once and the person checks every field
// before anything reaches Buffer.

const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
// The browser shrinks images before sending; this cap keeps requests under Vercel's 4.5 MB body limit.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const FIELDS = ['title', 'startsLocal', 'timeZone', 'venue', 'address', 'price', 'bookingUrl'];

const SCHEMA = {
  type: 'object',
  properties: {
    isEventFlyer: { type: 'boolean' },
    title: { type: 'string' },
    startsLocal: { type: 'string' },
    timeZone: { type: 'string' },
    venue: { type: 'string' },
    address: { type: 'string' },
    price: { type: 'string' },
    bookingUrl: { type: 'string' },
    altText: { type: 'string' },
  },
  required: ['isEventFlyer', ...FIELDS, 'altText'],
  additionalProperties: false,
};

const SYSTEM = `You read event flyers and posters and pull out the event details so an organiser can schedule social posts about the event. The organiser reviews every field before anything is posted, so leave a field as an empty string whenever the flyer does not show it, rather than guessing.

Field rules:
- isEventFlyer: false when the image is not an event flyer or poster; then leave every other field empty.
- title: the event's name as printed, in normal capitalisation (not all caps).
- startsLocal: the start date and time at the venue, formatted YYYY-MM-DDTHH:MM in 24-hour time. When the flyer leaves out the year, use the next date on or after today's date (given below). When it shows a date but no start time, leave this field empty.
- timeZone: an IANA time zone name such as Europe/London, only when the city, country or a printed zone makes it clear. Otherwise use the organiser's time zone given below.
- venue: the place name only, for example "Town Hall".
- address: the street address or area, without repeating the venue name.
- price: short, as printed, for example "Free", "£5 on the door" or "$10 / $8 students".
- bookingUrl: a full https:// address for tickets or details, only when it is printed in full or clearly implied by a printed domain. Never invent one.
- altText: a description of the flyer for someone who can't see it, under 400 characters. Say what kind of image it is, then every piece of text it shows in reading order, then a few words on the main picture or style. No "image of" opener.`;

export function flyerEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY) || (!config.isProd && process.env.TELLY_FAKE_FLYER === '1');
}

export class FlyerError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
  }
}

// Accepts a data: URL from the browser and checks it is a small image of a supported type.
export function parseImage(dataUrl) {
  const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match || !MEDIA_TYPES.has(match[1])) {
    throw new FlyerError('Choose a JPEG, PNG, WebP or GIF image.', 400);
  }
  const bytes = Math.floor((match[2].length * 3) / 4);
  if (bytes > MAX_IMAGE_BYTES) throw new FlyerError('That image is too large. Try one under 3 MB.', 413);
  return { mediaType: match[1], data: match[2] };
}

function tidy(raw, fallbackZone) {
  const facts = {};
  for (const field of FIELDS) facts[field] = typeof raw[field] === 'string' ? raw[field].trim().slice(0, 300) : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(facts.startsLocal)) facts.startsLocal = '';
  try {
    if (facts.timeZone) new Intl.DateTimeFormat('en-US', { timeZone: facts.timeZone });
  } catch {
    facts.timeZone = '';
  }
  if (!facts.timeZone) facts.timeZone = fallbackZone;
  if (facts.bookingUrl && !/^https:\/\/\S+$/i.test(facts.bookingUrl)) facts.bookingUrl = '';
  return facts;
}

function validZone(zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

let client;

export async function readFlyer({ image, timeZone, today }) {
  const zone = validZone(String(timeZone || 'UTC'));
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) ? today : new Date().toISOString().slice(0, 10);

  if (!process.env.ANTHROPIC_API_KEY) {
    // Local stand-in so the flow can be tested without an API key. Never active in production.
    if (!config.isProd && process.env.TELLY_FAKE_FLYER === '1') {
      return {
        altText: 'Event poster. Riverside Night Market, 12 December, 6pm, Market Square, 1 Riverside Walk. Free entry. Lanterns over market stalls.',
        ...tidy(
        {
          title: 'Riverside Night Market',
          startsLocal: `${day.slice(0, 4)}-12-12T18:00`,
          timeZone: zone,
          venue: 'Market Square',
          address: '1 Riverside Walk',
          price: 'Free entry',
          bookingUrl: 'https://example.com/night-market',
        },
        zone,
        ),
      };
    }
    throw new FlyerError('Reading flyers is not switched on.', 404);
  }

  client ??= new Anthropic();
  let response;
  try {
    response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
            { type: 'text', text: `Today's date: ${day}. Organiser's time zone: ${zone}. Read this flyer.` },
          ],
        },
      ],
    });
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) throw new FlyerError('Flyer reading is busy. Try again in a minute.', 503);
    if (error instanceof Anthropic.BadRequestError) throw new FlyerError('Claude could not read that image. Try another one.', 422);
    if (error instanceof Anthropic.APIError) {
      console.error('flyer read failed', error.status, error.message);
      throw new FlyerError('Flyer reading failed. Fill in the details by hand.', 502);
    }
    throw error;
  }

  if (response.stop_reason === 'refusal') throw new FlyerError('Claude could not read that image. Try another one.', 422);
  const text = response.content.find((block) => block.type === 'text')?.text;
  let raw;
  try {
    raw = JSON.parse(text || '');
  } catch {
    throw new FlyerError('Flyer reading failed. Fill in the details by hand.', 502);
  }
  if (!raw.isEventFlyer) throw new FlyerError("That doesn't look like an event flyer. Try another image.", 422);
  return { ...tidy(raw, zone), altText: typeof raw.altText === 'string' ? raw.altText.trim().slice(0, 1000) : '' };
}

// ---- "Tell Telly what changed" ------------------------------------------------------
// The organiser describes a change in their own words ("we've moved to the Town Hall and start
// at 7"). Claude turns it into updated details, which open in the usual review: nothing is sent
// to Buffer until the organiser has checked the new details and the corrected posts.

const STATUS_VALUES = ['upcoming', 'soldOut', 'postponed', 'cancelled'];
const CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    understood: { type: 'boolean' },
    ...Object.fromEntries(FIELDS.map((f) => [f, { type: 'string' }])),
    status: { type: 'string', enum: STATUS_VALUES },
  },
  required: ['understood', ...FIELDS, 'status'],
  additionalProperties: false,
};

const CHANGE_SYSTEM = `An event organiser tells you, in their own words, what has changed about their event. You get the event's current details as JSON and their message. Return the full set of details after the change.

Rules:
- Copy every field the message doesn't change exactly as it is.
- Change only what the message clearly says. Never guess a detail it doesn't give.
- startsLocal is YYYY-MM-DDTHH:MM in 24-hour time at the venue. "7pm" on the same day keeps the date and changes the time. A new date with no time keeps the old time.
- status: upcoming (going ahead, including "it's back on" or "tickets available again"), soldOut, postponed or cancelled.
- When the venue changes and the message gives no address, set address to an empty string rather than keeping the old one.
- understood: false when the message doesn't describe a change to these details. Then copy every field unchanged.`;

function fakeChange(text, facts) {
  const t = text.toLowerCase();
  const next = { ...facts };
  if (/sold out/.test(t)) next.status = 'soldOut';
  else if (/postpone/.test(t)) next.status = 'postponed';
  else if (/cancel/.test(t)) next.status = 'cancelled';
  else if (/back on|going ahead/.test(t)) next.status = 'upcoming';
  const venue = /(?:moved to|now at|new venue is)\s+(?:the\s+)?([^,.;]+)/i.exec(text);
  if (venue) { next.venue = venue[1].trim(); next.address = ''; }
  return { ...next, understood: JSON.stringify(next) !== JSON.stringify(facts) };
}

export async function readChange({ text, facts, today }) {
  const message = String(text || '').trim().slice(0, 1000);
  if (message.length < 3) throw new FlyerError(`Say what changed, for example "we've moved to the Town Hall".`, 400);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(today || '')) ? today : new Date().toISOString().slice(0, 10);
  const current = Object.fromEntries([...FIELDS, 'status'].map((f) => [f, facts[f] ?? '']));
  let raw;

  if (!process.env.ANTHROPIC_API_KEY) {
    if (config.isProd || process.env.TELLY_FAKE_FLYER !== '1') throw new FlyerError('This is not switched on.', 404);
    raw = fakeChange(message, current);
  } else {
    client ??= new Anthropic();
    let response;
    try {
      response = await client.beta.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 4000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: CHANGE_SCHEMA } },
        system: CHANGE_SYSTEM,
        messages: [{ role: 'user', content: `Today's date: ${day}.
Current details:
${JSON.stringify(current, null, 2)}

The organiser's message:
${message}` }],
      });
    } catch (error) {
      if (error instanceof Anthropic.RateLimitError) throw new FlyerError('Telly is busy. Try again in a minute, or edit the details by hand.', 503);
      if (error instanceof Anthropic.APIError) {
        console.error('change read failed', error.status, error.message);
        throw new FlyerError("Telly couldn't read that. Edit the details by hand instead.", 502);
      }
      throw error;
    }
    if (response.stop_reason === 'refusal') throw new FlyerError("Telly couldn't read that. Edit the details by hand instead.", 422);
    try {
      raw = JSON.parse(response.content.find((b) => b.type === 'text')?.text || '');
    } catch {
      throw new FlyerError("Telly couldn't read that. Edit the details by hand instead.", 502);
    }
  }

  if (!raw.understood) throw new FlyerError("Telly couldn't tell what changed. Try saying it another way, or edit the details by hand.", 422);
  const next = tidy(raw, facts.timeZone);
  // Anything the reply left out or got wrong stays as it was, rather than being wiped.
  if (!next.startsLocal) next.startsLocal = facts.startsLocal;
  if (!next.title) next.title = facts.title;
  if (!next.venue) next.venue = facts.venue;
  return { ...next, status: STATUS_VALUES.includes(raw.status) ? raw.status : facts.status };
}
