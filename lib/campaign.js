// Telly's campaign engine. Everything here is pure and deterministic: facts go in, posts and
// change plans come out. No network calls, no AI. Facts are only ever changed by a person, and
// wording is produced from them by fixed templates or by swapping old details for new ones in
// the organiser's own words, so a correction can never invent a detail.

export const KINDS = ['announcement', 'reminder', 'dayOf'];
export const MAX_POST_LENGTH = 280; // used when a channel's network is unknown
const MIN_LEAD_MS = 5 * 60 * 1000; // a post must be due at least five minutes from now
const HOUR = 60 * 60 * 1000;

// Character limits per network, as Buffer's channel `service` names them.
export const LIMITS = {
  twitter: 280, bluesky: 300, mastodon: 500, threads: 500, pinterest: 500, googlebusiness: 1500,
  instagram: 2200, tiktok: 2200, linkedin: 3000, facebook: 5000, youtube: 5000, startPage: 5000,
};
export const limitFor = (service) => LIMITS[service] ?? MAX_POST_LENGTH;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
/** Length as the networks count it: an emoji or accented letter counts once. */
export const textLength = (text) => [...segmenter.segment(String(text ?? ''))].length;

// Buffer may reformat whitespace or timestamps when it stores a post. Compare meaning, not bytes,
// so a harmless reformat is never mistaken for a change or for someone editing the post by hand.
export const sameText = (a, b) => String(a ?? '').replace(/\s+/g, ' ').trim() === String(b ?? '').replace(/\s+/g, ' ').trim();
export const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();

// When each post usually goes out, relative to the event, in the event's own timezone.
const SCHEDULE = {
  announcement: { daysBefore: 14, at: '09:00' },
  reminder: { daysBefore: 2, at: '09:00' },
  dayOf: { daysBefore: 0, at: '08:00' },
};

// ---- Time ------------------------------------------------------------------------

function offsetMinutes(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value]),
  );
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return (asIfUtc - Math.floor(utcMs / 1000) * 1000) / 60000;
}

/** Turn a wall-clock time ("2026-12-12T14:00") in a timezone into the real instant. */
export function zonedToUtc(local, timeZone) {
  const [date, time] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset even when the event sits near a daylight-saving change.
  let guess = naive - offsetMinutes(naive, timeZone) * 60000;
  guess = naive - offsetMinutes(guess, timeZone) * 60000;
  return new Date(guess);
}

/** The wall-clock time ("2026-12-12T14:00") of an instant in a timezone. */
export function utcToZoned(date, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function localDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const clean = (s) => s.replace(/\s+/g, ' ').trim();

export function formatDay(date, timeZone) {
  return clean(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long' }).format(date))
    .replace(',', '');
}

export function formatTime(date, timeZone) {
  return clean(new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(date));
}

// ---- Facts -----------------------------------------------------------------------

export function normalizeFacts(input = {}) {
  const text = (v) => (typeof v === 'string' ? clean(v) : '');
  return {
    title: text(input.title),
    startsLocal: text(input.startsLocal), // "2026-12-12T14:00", wall-clock time at the venue
    timeZone: text(input.timeZone),
    venue: text(input.venue),
    address: text(input.address),
    price: text(input.price),
    bookingUrl: text(input.bookingUrl),
    status: input.status === 'cancelled' ? 'cancelled' : 'upcoming',
  };
}

export function validateFacts(facts) {
  const errors = [];
  if (!facts.title) errors.push('Add the event title.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(facts.startsLocal)) errors.push('Add the start date and time.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: facts.timeZone });
    if (!facts.timeZone) throw new Error('missing');
  } catch {
    errors.push('Choose a valid timezone.');
  }
  if (!facts.venue) errors.push('Add the venue.');
  if (facts.bookingUrl && !/^https:\/\/\S+$/i.test(facts.bookingUrl)) errors.push('The booking link must be a full https:// address.');
  return errors;
}

export function startsAt(facts) {
  return zonedToUtc(facts.startsLocal, facts.timeZone);
}

/** The usual time for a post, before any adjustment for time that has already passed. */
export function publishAt(kind, facts) {
  const { daysBefore, at } = SCHEDULE[kind];
  const day = addDays(facts.startsLocal.slice(0, 10), -daysBefore);
  return zonedToUtc(`${day}T${at}`, facts.timeZone);
}

/** Which fields changed between two versions of the facts. */
export function diffFacts(before, after) {
  return ['title', 'startsLocal', 'timeZone', 'venue', 'address', 'price', 'bookingUrl', 'status'].filter(
    (key) => before[key] !== after[key],
  );
}

// ---- Schedule --------------------------------------------------------------------

function nextMorning(afterMs, timeZone) {
  const day = localDate(new Date(afterMs), timeZone);
  for (let i = 0; i < 3; i++) {
    const t = zonedToUtc(`${addDays(day, i)}T09:00`, timeZone).getTime();
    if (t >= afterMs) return t;
  }
  return null;
}

/** As soon as allowed, rounded up to the next quarter hour. */
export function soonest(now = new Date()) {
  const quarter = 15 * 60 * 1000;
  return new Date(Math.ceil((now.getTime() + MIN_LEAD_MS) / quarter) * quarter);
}

/**
 * When each post goes out. Each post keeps its usual time when it can. If that time has passed,
 * the post moves to the next morning, or for the announcement and day-of post to as soon as
 * possible, as long as it still lands before the next post. Otherwise it is skipped.
 */
export function planSchedule(facts, now = new Date()) {
  const earliest = now.getTime() + MIN_LEAD_MS;
  const start = startsAt(facts).getTime();
  const pick = (kind, limit, allowSoon) => {
    const usual = publishAt(kind, facts).getTime();
    if (usual >= earliest && usual < limit) return { dueAt: new Date(usual), moved: false };
    const morning = nextMorning(earliest, facts.timeZone);
    if (morning && morning >= earliest && morning < limit - HOUR) return { dueAt: new Date(morning), moved: true };
    const soon = soonest(now).getTime();
    if (allowSoon && soon < limit - HOUR) return { dueAt: new Date(soon), moved: true };
    return null;
  };
  const dayOf = pick('dayOf', start, true);
  const reminder = pick('reminder', dayOf?.dueAt.getTime() ?? start, false);
  const announcement = pick('announcement', reminder?.dueAt.getTime() ?? dayOf?.dueAt.getTime() ?? start, true);
  return { announcement, reminder, dayOf };
}

// ---- Wording ---------------------------------------------------------------------

export function whereLine(facts) {
  return facts.address && !facts.venue.includes(facts.address) ? `${facts.venue}, ${facts.address}` : facts.venue;
}

function linkLine(facts) {
  return facts.bookingUrl ? `Details and booking: ${facts.bookingUrl}` : '';
}

/**
 * Words like "today" and "tomorrow" are only used when they are true on the day the post goes
 * out. If the event moves, the wording changes with it instead of going stale.
 */
function relativeDay(publish, facts) {
  const tz = facts.timeZone;
  const eventDay = facts.startsLocal.slice(0, 10);
  const postDay = localDate(publish, tz);
  if (postDay === eventDay) return 'today';
  if (addDays(postDay, 1) === eventDay) return 'tomorrow';
  return null;
}

export function renderPost(kind, facts, publish = publishAt(kind, facts)) {
  const start = startsAt(facts);
  const day = formatDay(start, facts.timeZone);
  const time = formatTime(start, facts.timeZone);
  const rel = relativeDay(publish, facts);
  const when = `${day} at ${time}`;
  const lines = [];

  if (facts.status === 'cancelled') {
    lines.push(`Cancelled: ${facts.title}, planned for ${when}, will not go ahead.`, 'Sorry to everyone who was planning to come.');
    return lines.join('\n');
  }

  if (kind === 'announcement') {
    lines.push(facts.title, when, whereLine(facts), facts.price, linkLine(facts));
  } else if (kind === 'reminder') {
    const lead = rel === 'tomorrow' ? 'is tomorrow' : rel === 'today' ? 'is today' : `is on ${day}`;
    lines.push(`Reminder: ${facts.title} ${lead} at ${time}.`, whereLine(facts), facts.price, linkLine(facts));
  } else {
    const lead = rel === 'today' ? `Today: ${facts.title} at ${time}.` : `${facts.title} is on ${day} at ${time}.`;
    lines.push(lead, whereLine(facts), facts.price, linkLine(facts));
  }
  return lines.filter(Boolean).join('\n');
}

/** A short post telling people what changed, for when the original already went out. */
export function renderFollowUp(before, after) {
  if (after.status === 'cancelled') return renderPost('reminder', after);
  const changed = diffFacts(before, after);
  const start = startsAt(after);
  const when = `${formatDay(start, after.timeZone)} at ${formatTime(start, after.timeZone)}`;
  const parts = [];
  if (changed.includes('title')) parts.push(`it's now called ${after.title}`);
  if (changed.includes('startsLocal') || changed.includes('timeZone')) parts.push(`it's moved to ${when}`);
  if (changed.includes('venue') || changed.includes('address')) parts.push(`it's now at ${whereLine(after)}`);
  if (changed.includes('price') && after.price) parts.push(`entry is now ${after.price}`);
  if (changed.includes('bookingUrl') && after.bookingUrl) parts.push("there's a new booking link");
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'some details have changed';
  // The details that didn't change follow, so the post works for someone who missed the first one.
  const timeMoved = changed.includes('startsLocal') || changed.includes('timeZone');
  const placeMoved = changed.includes('venue') || changed.includes('address');
  return [
    `Change of plans for ${before.title}: ${list}.`,
    !timeMoved && when,
    !placeMoved && whereLine(after),
    !changed.includes('price') && after.price,
    linkLine(after),
  ].filter(Boolean).join('\n');
}

// Ways people commonly write a date or time, so a change can be found in hand-written text.
// Each list is in the same order for old and new, longest first, so pairs line up.
function dateForms(date, tz) {
  const part = (opts) => clean(new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(date)).replace(',', '');
  const us = (opts) => clean(new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(date));
  return [
    part({ weekday: 'long', day: 'numeric', month: 'long' }),
    us({ weekday: 'long', month: 'long', day: 'numeric' }),
    part({ weekday: 'short', day: 'numeric', month: 'short' }),
    us({ weekday: 'short', month: 'short', day: 'numeric' }),
    part({ day: 'numeric', month: 'long' }),
    us({ month: 'long', day: 'numeric' }),
    part({ day: 'numeric', month: 'short' }),
    us({ month: 'short', day: 'numeric' }),
    part({ weekday: 'long' }),
  ];
}

function timeForms(date, tz) {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(date).split(':').map(Number);
  const h12 = h % 12 || 12;
  const ap = h < 12 ? 'am' : 'pm';
  const mm = String(m).padStart(2, '0');
  const forms = [`${h12}:${mm} ${ap}`, `${h12}:${mm}${ap}`, `${h12}:${mm} ${ap.toUpperCase()}`, `${h12}:${mm}${ap.toUpperCase()}`, `${String(h).padStart(2, '0')}:${mm}`];
  if (m === 0) forms.push(`${h12} ${ap}`, `${h12}${ap}`, `${h12} ${ap.toUpperCase()}`, `${h12}${ap.toUpperCase()}`);
  return forms;
}

/**
 * Applies a change of details to wording a person wrote: each old detail found in the text is
 * replaced with the new one, and nothing else is touched. Returns the new text.
 */
export function correctText(text, before, after) {
  const pairs = [];
  for (const key of ['title', 'venue', 'address', 'price', 'bookingUrl']) {
    if (before[key] && before[key] !== after[key]) pairs.push([before[key], after[key] || '']);
  }
  if (before.startsLocal !== after.startsLocal || before.timeZone !== after.timeZone) {
    const a = startsAt(before);
    const b = startsAt(after);
    const [da, db] = [dateForms(a, before.timeZone), dateForms(b, after.timeZone)];
    if (localDate(a, before.timeZone) !== localDate(b, after.timeZone)) da.forEach((form, i) => pairs.push([form, db[i]]));
    const [ta, tb] = [timeForms(a, before.timeZone), timeForms(b, after.timeZone)];
    ta.forEach((form, i) => { if (form !== tb[i] && tb[i]) pairs.push([form, tb[i]]); });
    // "2pm" moving to half past keeps its style: "3:30pm".
    if (tb.length < ta.length) ta.slice(tb.length).forEach((form, i) => pairs.push([form, tb[i]]));
  }
  // Longest first, and through placeholders, so one replacement never feeds another.
  pairs.sort((x, y) => y[0].length - x[0].length);
  let out = String(text ?? '');
  pairs.forEach(([from], i) => { if (from) out = out.split(from).join(`\u0000${i}\u0000`); });
  if (!out.includes('\u0000')) return String(text ?? ''); // nothing in the text mentions what changed
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => pairs[Number(i)][1]);
  // Tidy anything a removed detail left behind.
  return out.split('\n').map((line) => line.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.])/g, '$1').trimEnd())
    .filter((line, i, all) => line.trim() || (all[i - 1] && all[i - 1].trim())).join('\n').trim();
}

/** Text description for the event card image. Built from the facts, never from the picture. */
export function describeCard(facts) {
  const start = startsAt(facts);
  const parts = [
    `Event card: ${facts.title}.`,
    `${formatDay(start, facts.timeZone)} at ${formatTime(start, facts.timeZone)}.`,
    `${whereLine(facts)}.`,
    facts.price ? `${facts.price}.` : '',
    facts.bookingUrl ? `Booking link: ${facts.bookingUrl}.` : '',
  ];
  return parts.filter(Boolean).join(' ');
}

// ---- Creating a campaign ---------------------------------------------------------

/**
 * The posts Telly proposes. `services` maps channel IDs to networks for length checks.
 * `edits` holds the organiser's changes from the preview, keyed by `${channelId}:${kind}`:
 * { text, dueLocal, skip }.
 */
export function buildCampaignPlan(facts, channelIds, now = new Date(), { services = {}, edits = {} } = {}) {
  const schedule = planSchedule(facts, now);
  const items = [];
  for (const channelId of channelIds) {
    const limit = limitFor(services[channelId]);
    for (const kind of KINDS) {
      const slot = schedule[kind];
      const edit = edits[`${channelId}:${kind}`] || {};
      const warnings = [];
      let skip = slot ? null : "This post's time has already passed, so Telly will skip it.";
      let due = slot?.dueAt ?? publishAt(kind, facts);
      let customTime = false;
      if (slot?.moved) warnings.push(`The usual time has passed, so this goes out ${formatDay(due, facts.timeZone)} at ${formatTime(due, facts.timeZone)} instead.`);
      if (typeof edit.dueLocal === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(edit.dueLocal)) {
        const chosen = zonedToUtc(edit.dueLocal, facts.timeZone);
        if (chosen.getTime() < now.getTime() + MIN_LEAD_MS) {
          skip = 'The time you chose has already passed. Pick a later one.';
        } else {
          due = chosen;
          customTime = !slot || !sameInstant(chosen, slot.dueAt);
          if (customTime) warnings.length = 0;
          skip = null;
        }
      }
      const template = renderPost(kind, facts, due);
      const custom = typeof edit.text === 'string' && edit.text.trim() && !sameText(edit.text, template);
      const text = custom ? edit.text.trim() : template;
      if (edit.skip) skip = 'You left this post out.';
      if (due.getTime() >= startsAt(facts).getTime() && !skip) warnings.push('This goes out after the event starts.');
      if (textLength(text) > limit) warnings.push(`${textLength(text)} characters. ${services[channelId] || 'This network'} allows ${limit}, so Buffer will refuse it.`);
      items.push({ kind, channelId, text, template, custom: Boolean(custom), customTime, dueAt: due.toISOString(), skip, warnings, limit });
    }
  }
  return items;
}

// ---- Changing a campaign ---------------------------------------------------------

/**
 * Compare what Telly last wrote with what is in Buffer now, and decide what each post needs.
 *
 * campaign.posts: [{ kind, channelId, postId, lastWrittenText, lastWrittenDueAt, writtenFacts?,
 *                    custom?, customTime?, card? }]
 * current: Map of postId -> the post as Buffer returns it (or undefined if it no longer exists)
 * cardFor: optional (facts) => { url, altText } for the event card image
 */
export function planChange(campaign, newFacts, current, now = new Date(), { cardFor } = {}) {
  const changed = diffFacts(campaign.facts, newFacts);
  const earliest = now.getTime() + MIN_LEAD_MS;
  let schedule;
  const items = campaign.posts.map((post) => {
    const base = { postId: post.postId, kind: post.kind, channelId: post.channelId };
    const live = current.get(post.postId);
    const before = post.writtenFacts ? normalizeFacts(post.writtenFacts) : campaign.facts;

    if (!live) return { ...base, type: 'missing', note: "This post isn't in Buffer any more." };
    if (live.status !== 'scheduled') {
      const needsFollowUp = diffFacts(before, newFacts).length > 0;
      return {
        ...base,
        type: 'published',
        note: "This one's already out, and Telly can't edit a published post.",
        current: live.text,
        needsFollowUp,
        suggested: needsFollowUp ? renderFollowUp(before, newFacts) : null,
      };
    }

    if (newFacts.status === 'cancelled') {
      return { ...base, type: 'delete', reason: "The event's off, so this post comes out of the queue.", current: live.text };
    }

    // The time changes only when the event's time did.
    const moved = diffFacts(before, newFacts).some((k) => k === 'startsLocal' || k === 'timeZone');
    let dueAt = new Date(live.dueAt || post.lastWrittenDueAt);
    if (moved && post.kind !== 'followUp') {
      if (post.customTime) {
        dueAt = new Date(dueAt.getTime() + (startsAt(newFacts) - startsAt(before)));
      } else {
        schedule ??= planSchedule(newFacts, now);
        dueAt = schedule[post.kind]?.dueAt ?? null;
      }
    }

    const editedByHand = !sameText(live.text, post.lastWrittenText);
    const ownWords = post.custom || editedByHand || post.kind === 'followUp';
    const text = ownWords
      ? correctText(editedByHand ? live.text : post.lastWrittenText, before, newFacts)
      : renderPost(post.kind, newFacts, dueAt ?? new Date(live.dueAt));

    if (!dueAt || dueAt.getTime() < earliest) {
      return { ...base, type: 'review', note: "With the new date, this post's time has already passed.", current: live.text, proposed: text };
    }
    const dueChanged = !live.dueAt || !sameInstant(live.dueAt, dueAt);

    // The image is replaced only if it is still the one Telly attached.
    let card = null;
    if (post.card && cardFor) {
      const next = cardFor(newFacts);
      const liveAlt = live.assets?.find((a) => a.image)?.image?.altText;
      if (next && next.url !== post.card.url && liveAlt === post.card.altText) card = next;
    }

    if (sameText(live.text, text) && !dueChanged && !card) return { ...base, type: editedByHand ? 'edited' : 'unchanged' };

    const extra = { current: live.text, proposed: text, dueAt: dueChanged ? dueAt.toISOString() : null, previousDueAt: live.dueAt, card };
    if (editedByHand && !sameText(live.text, text)) {
      return { ...base, type: 'conflict', note: 'You changed this post in Buffer. Telly made the same correction to your wording. Check it before you apply.', ...extra };
    }
    return { ...base, type: 'update', reason: changed.join(', '), ownWords: Boolean(ownWords), ...extra };
  });
  return { changedFields: changed, items };
}

const LABELS = [
  ['updated', 'updated'],
  ['kept', 'kept as you wrote it'],
  ['removed', 'removed'],
  ['followUps', 'follow-up scheduled'],
  ['review', 'need review'],
  ['manual', 'to correct by hand'],
  ['failed', 'failed'],
];

/** "3 updated · 1 need review · 1 failed" */
export function summarize(counts) {
  return LABELS.filter(([key]) => counts[key]).map(([key, label]) => `${counts[key]} ${label}`).join(' · ') || 'Nothing to change';
}
