import express from 'express';
import crypto from 'node:crypto';
import { getSession } from './session.js';
import { BufferError, gql } from './buffer.js';
import {
  ACCOUNT_ME, CREATE_IDEA, CREATE_POST, CREATE_SNIPPET, DELETE_POST, EDIT_POST, GET_POST, UPDATE_SNIPPET, postsBatch,
} from './queries.js';
import { store } from './store.js';
import { cardFor } from './card.js';
import { config } from './config.js';
import { PAGE_ID, newPageId, pageUrlFor } from './eventpage.js';
import { readOwnImage } from './images.js';
import { feedUrl } from './feed.js';
import { FlyerError, flyerEnabled, readChange } from './flyer.js';
import {
  KINDS, buildCampaignPlan, diffFacts, normalizeFacts, planChange, renderFollowUp, sameInstant, sameText, snippetText,
  soonest, summarize, validateFacts,
} from './campaign.js';

export const campaignRoutes = express.Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const LOCK_MS = 60_000;
const ORGS_FRESH_MS = 10 * 60 * 1000;
const HISTORY_MAX = 40;

// ---- Who is asking -----------------------------------------------------------------

// One read tells Telly who is signed in and which Buffer organizations they belong to.
// Organizations are remembered for a few minutes so every request doesn't ask again.
async function whoAmI(session) {
  const data = await gql(session, ACCOUNT_ME);
  session.accountId = data.account.id;
  session.accountName = data.account.name || '';
  session.orgs = { ids: (data.account.organizations || []).map((o) => o.id), at: Date.now() };
  await session.save();
}

export async function accountId(session) {
  if (!session.accountId) await whoAmI(session);
  return session.accountId;
}

export async function organizationIds(session) {
  if (!session.orgs || Date.now() - session.orgs.at > ORGS_FRESH_MS) await whoAmI(session);
  return session.orgs.ids;
}

/**
 * A campaign belongs to the person who made it and is shared with everyone in the same Buffer
 * organization, so a team can keep one event current together. Buffer still decides what each
 * person may do to each post: a teammate without access to a channel gets Buffer's own error.
 */
async function canUse(session, campaign) {
  if (!campaign) return false;
  if (campaign.accountId === (await accountId(session))) return true;
  // Every demo visitor shares one practice organization, so demo campaigns are never shared.
  if (session.demo) return false;
  return Boolean(campaign.organizationId) && (await organizationIds(session)).includes(campaign.organizationId);
}

async function ownedCampaign(req, session) {
  const campaign = await store.get(req.params.id);
  return (await canUse(session, campaign)) ? campaign : null;
}

const byLine = (session) => session.accountName || (session.demo ? 'Demo organiser' : 'A teammate');

// ---- Reading the request -----------------------------------------------------------

function readFacts(body) {
  const facts = normalizeFacts(body?.facts);
  delete facts.pageUrl; // only the server decides the event page
  return { facts, errors: validateFacts(facts) };
}

// The event page belongs to the campaign and never changes, whatever the browser sends.
function withPage(facts, pageId) {
  if (pageId) facts.pageUrl = pageUrlFor(pageId);
  else delete facts.pageUrl;
  return facts;
}

// A new campaign gets an event page unless the organiser turned it off. The preview picks the
// page id so the posts it shows already carry the real link; scheduling keeps that id.
async function choosePageId(body) {
  if (body?.eventPage === false) return null;
  const wanted = String(body?.pageId || '');
  if (PAGE_ID.test(wanted) && !(await store.getByPage(wanted))) return wanted;
  return newPageId();
}

// The organiser's choices from the preview: networks for length checks, and their edits.
function readOptions(body) {
  const services = {};
  for (const [id, service] of Object.entries(body?.services || {})) {
    if (typeof service === 'string') services[String(id)] = service.slice(0, 40);
  }
  const edits = {};
  for (const [key, edit] of Object.entries(body?.edits || {})) {
    if (!edit || typeof edit !== 'object') continue;
    edits[String(key)] = {
      text: typeof edit.text === 'string' ? edit.text.slice(0, 5000) : undefined,
      dueLocal: typeof edit.dueLocal === 'string' ? edit.dueLocal : undefined,
      skip: edit.skip === true,
    };
  }
  return { services, edits, withCard: body?.withCard !== false };
}

// ---- Reading posts back from Buffer ------------------------------------------------

const BATCH_SIZE = 25; // Buffer allows 30 aliases in one query
const notFound = (message) => /not found|does not exist/i.test(String(message || ''));

/**
 * Reads each managed post from Buffer, up to 25 in a single request. A post that no longer
 * exists comes back as undefined. Posts on hold are not in Buffer, so they are skipped.
 */
export async function fetchCurrent(session, posts) {
  const current = new Map();
  const ids = [...new Set(posts.filter((p) => !p.held && p.postId).map((p) => p.postId))];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const chunk = ids.slice(i, i + BATCH_SIZE);
    const { query, variables } = postsBatch(chunk);
    const { data, errors } = await gql(session, query, variables, { partial: true });
    chunk.forEach((id, n) => {
      const post = data?.[`p${n}`];
      if (post) current.set(id, post);
    });
    const real = errors.filter((e) => !notFound(e.message));
    if (real.length) throw new BufferError(real.map((e) => e.message).join('; '), 502, { graphql: real });
  }
  return current;
}

const cardAsset = (card) => [{ image: { url: card.url, metadata: { altText: card.altText } } }];
const fatal = (error) => error instanceof BufferError && (error.status === 401 || error.status === 429);

async function createPost(session, { text, channelId, dueAt, card }) {
  const input = { text, channelId, schedulingType: 'automatic', mode: 'customScheduled', dueAt, assets: card ? cardAsset(card) : [] };
  const result = (await gql(session, CREATE_POST, { input })).createPost;
  if (!result?.post) throw new BufferError(result?.message || 'Buffer did not accept this post.', 422);
  return result.post;
}

// ---- History -----------------------------------------------------------------------

function addHistory(campaign, entry) {
  campaign.history = [...(campaign.history || []), { id: crypto.randomUUID(), at: new Date().toISOString(), ...entry }].slice(-HISTORY_MAX);
  return campaign.history.at(-1);
}

/** The newest change, if it can still be undone: nothing has happened to the campaign since. */
function undoable(campaign) {
  const entry = campaign.history?.at(-1);
  if (!entry || entry.type === 'created' || entry.undoneBy || entry.version !== campaign.version) return null;
  if (!entry.before || !entry.posts?.some((p) => UNDOABLE.has(p.action)) && !diffFacts(entry.before, entry.after).length) return null;
  return entry;
}
const UNDOABLE = new Set(['updated', 'kept', 'held', 'removed', 'restored', 'followUp']);

/** What planChange needs to walk a change back: the old wording and times, and what to withdraw. */
function undoOptions(entry, current) {
  const restore = new Map();
  const withdraw = new Set();
  const withdrawnChannels = new Set();
  for (const p of entry.posts || []) {
    if (p.action === 'followUp' && current.get(p.postId)?.status === 'scheduled') {
      withdraw.add(p.postId);
      withdrawnChannels.add(p.channelId);
    }
  }
  for (const p of entry.posts || []) {
    if (p.action === 'updated' || p.action === 'kept' || p.action === 'held') {
      restore.set(p.postId, { text: p.before.text, dueAt: p.before.dueAt, custom: p.before.custom });
    }
    // The correction is coming out again, so the published post is back to matching what it said.
    if (p.action === 'followedUp' && withdrawnChannels.has(p.channelId)) {
      restore.set(p.postId, { writtenFacts: p.before.writtenFacts });
    }
  }
  return { restore, withdraw };
}

// ---- Preview: nothing is sent to Buffer -------------------------------------------

campaignRoutes.post(
  '/preview',
  wrap(async (req, res) => {
    const { facts, errors } = readFacts(req.body);
    const channelIds = req.body?.channelIds;
    if (errors.length) return res.status(400).json({ errors });
    if (!Array.isArray(channelIds) || !channelIds.length) return res.status(400).json({ errors: ['Choose at least one channel.'] });
    const { services, edits } = readOptions(req.body);
    const pageId = await choosePageId(req.body);
    withPage(facts, pageId);
    res.json({ facts, pageId, items: buildCampaignPlan(facts, channelIds, new Date(), { services, edits }), card: cardFor(facts) });
  }),
);

// ---- Create: schedule the posts in Buffer ----------------------------------------

campaignRoutes.post(
  '/',
  wrap(async (req, res) => {
    const { facts, errors } = readFacts(req.body);
    const { channelIds, organizationId } = req.body || {};
    if (errors.length) return res.status(400).json({ errors });
    if (!Array.isArray(channelIds) || !channelIds.length) return res.status(400).json({ errors: ['Choose at least one channel.'] });
    const { services, edits, withCard } = readOptions(req.body);

    const session = await getSession(req, res);
    const owner = await accountId(session);
    // Only share with an organization this person actually belongs to.
    const orgId = organizationId && (await organizationIds(session)).includes(organizationId) ? organizationId : null;
    const pageId = await choosePageId(req.body);
    withPage(facts, pageId);
    // The organiser's own flyer, with their description, or Telly's event card.
    const ownImage = readOwnImage(req.body?.image);
    const card = ownImage || (withCard ? cardFor(facts) : null);
    const posts = [];
    const results = [];
    let imageRefused = false;

    for (const item of buildCampaignPlan(facts, channelIds, new Date(), { services, edits })) {
      const label = { kind: item.kind, channelId: item.channelId };
      if (item.skip) {
        results.push({ ...label, status: 'skipped', note: item.skip });
        continue;
      }
      try {
        let post;
        let attached = card && !imageRefused ? card : null;
        try {
          post = await createPost(session, { text: item.text, channelId: item.channelId, dueAt: item.dueAt, card: attached });
        } catch (error) {
          if (!attached || fatal(error)) throw error;
          // If Buffer won't take the image, the words still matter more: post without it.
          imageRefused = true;
          attached = null;
          post = await createPost(session, { text: item.text, channelId: item.channelId, dueAt: item.dueAt, card: null });
        }
        // The baseline for spotting hand edits is what Buffer actually stored, not what we sent.
        posts.push({
          ...label, postId: post.id, lastWrittenText: post.text, lastWrittenDueAt: post.dueAt, writtenFacts: facts,
          custom: item.custom, customTime: item.customTime, card: attached && post.assets?.length ? attached : null,
        });
        results.push({ ...label, status: 'created', postId: post.id, dueAt: post.dueAt });
      } catch (error) {
        if (fatal(error)) throw error;
        results.push({ ...label, status: 'failed', note: error.message });
      }
    }

    const count = (status) => results.filter((r) => r.status === status).length;
    const summary = [`${count('created')} scheduled`, count('skipped') && `${count('skipped')} skipped`, count('failed') && `${count('failed')} failed`]
      .filter(Boolean).join(' · ');

    if (!posts.length) return res.status(422).json({ results, summary });
    const campaign = {
      id: crypto.randomUUID(), accountId: owner, organizationId: orgId, createdBy: byLine(session), pageId,
      facts, posts, version: 1, createdAt: new Date().toISOString(), history: [],
    };
    addHistory(campaign, { type: 'created', by: byLine(session), after: facts, summary, version: 1 });
    await store.put(campaign);
    res.status(201).json({ campaign, results, summary, imageRefused });
  }),
);

// Campaigns for the chosen Buffer organization: your own and your teammates'.
campaignRoutes.get(
  '/',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const me = await accountId(session);
    const orgId = String(req.query.organizationId || '');
    const campaigns = orgId && !session.demo && (await organizationIds(session)).includes(orgId)
      ? await store.listForOrg(me, orgId)
      : await store.list(me);
    res.json({ campaigns: campaigns.map((c) => ({ ...c, mine: c.accountId === me, undo: undoable(c)?.id ?? null })) });
  }),
);

// Delete everything Telly stores for this account. Posts already in Buffer stay there.
campaignRoutes.delete(
  '/',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const owner = await accountId(session);
    // Watching keeps the Buffer tokens in the database; hand them back to this browser first.
    const { stopWatching } = await import('./vault.js');
    await stopWatching(session, owner);
    const removed = await store.removeAccount(owner);
    res.json({ removed });
  }),
);

// The address of a calendar with all of this organiser's events, to subscribe to.
campaignRoutes.get(
  '/feed',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const url = feedUrl(await accountId(session));
    res.json({ url, webcal: url.replace(/^https?:/, 'webcal:') });
  }),
);

campaignRoutes.get(
  '/:id',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const campaign = await ownedCampaign(req, session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign: { ...campaign, mine: campaign.accountId === (await accountId(session)), undo: undoable(campaign)?.id ?? null } });
  }),
);

// ---- Live status: what Buffer holds now, checked against the current details ------

campaignRoutes.get(
  '/:id/status',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const campaign = await ownedCampaign(req, session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const current = await fetchCurrent(session, campaign.posts);
    const plan = planChange(campaign, campaign.facts, current, new Date(), { cardFor });
    res.json({
      checkedAt: new Date().toISOString(),
      posts: plan.items.map((item) => {
        const live = current.get(item.postId);
        const image = live?.assets?.find((a) => a.image);
        return {
          postId: item.postId, type: item.type, text: live?.text ?? null, status: live?.status ?? null, dueAt: live?.dueAt ?? null,
          image: image ? { url: image.source, altText: image.image.altText } : null,
        };
      }),
    });
  }),
);

// ---- Change a fact: preview, then apply what was approved --------------------------

campaignRoutes.post(
  '/:id/changes/preview',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const campaign = await ownedCampaign(req, session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const { facts, errors } = readFacts(req.body);
    if (errors.length) return res.status(400).json({ errors });
    withPage(facts, campaign.pageId);
    const current = await fetchCurrent(session, campaign.posts);
    res.json({ ...planChange(campaign, facts, current, new Date(), { cardFor }), version: campaign.version });
  }),
);

// Undo the newest change: the same review as any change, with the earlier details and wording.
campaignRoutes.post(
  '/:id/history/:entryId/undo/preview',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const campaign = await ownedCampaign(req, session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const entry = undoable(campaign);
    if (!entry || entry.id !== req.params.entryId) {
      return res.status(409).json({ error: 'Only the latest change can be undone, and only before anything else changes.' });
    }
    const current = await fetchCurrent(session, campaign.posts);
    const facts = withPage(normalizeFacts(entry.before), campaign.pageId);
    res.json({ ...planChange(campaign, facts, current, new Date(), { cardFor, ...undoOptions(entry, current) }), version: campaign.version, facts, undo: entry.id });
  }),
);

campaignRoutes.post(
  '/:id/changes/apply',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const campaign = await ownedCampaign(req, session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    let undoEntry = null;
    if (req.body?.undo) {
      undoEntry = undoable(campaign);
      if (!undoEntry || undoEntry.id !== req.body.undo) {
        return res.status(409).json({ error: 'This change can no longer be undone. Something else changed since.' });
      }
    }
    const { facts, errors } = undoEntry ? { facts: normalizeFacts(undoEntry.before), errors: [] } : readFacts(req.body);
    if (errors.length) return res.status(400).json({ errors });
    withPage(facts, campaign.pageId);
    if (req.body.version !== undefined && Number(req.body.version) !== campaign.version) {
      return res.status(409).json({ error: 'This campaign changed in another tab, or a teammate changed it. Go back to it and review again.' });
    }
    if (!(await store.claim(campaign.id, LOCK_MS))) {
      return res.status(409).json({ error: 'Telly is already sending changes for this campaign. Wait a moment, then try again.' });
    }
    try {
      res.json(await applyChanges(session, campaign, facts, req.body, undoEntry));
    } finally {
      await store.release(campaign.id).catch(() => {});
    }
  }),
);

async function applyChanges(session, campaign, facts, body, undoEntry = null) {
  const approve = body.approve;
  const overwrite = new Set(Array.isArray(body.overwrite) ? body.overwrite : []);
  const followUps = new Set(Array.isArray(body.followUps) ? body.followUps : []);
  const isApproved = (postId) => approve === 'all' || (Array.isArray(approve) && approve.includes(postId));

  const factsBefore = campaign.facts;
  const current = await fetchCurrent(session, campaign.posts);
  const options = undoEntry ? undoOptions(undoEntry, current) : {};
  const plan = planChange(campaign, facts, current, new Date(), { cardFor, ...options });
  const counts = { updated: 0, kept: 0, removed: 0, held: 0, restored: 0, followUps: 0, review: 0, manual: 0, failed: 0 };
  const results = [];
  const touched = []; // what this change did to each post, for the history and for undo
  const record = (item, status, extra = {}) => results.push({ postId: item.postId, kind: item.kind, status, ...extra });
  const byId = new Map(campaign.posts.map((p) => [p.postId, p]));
  const removedIds = new Set();
  const followUpChannels = new Map(); // one follow-up per channel, however many posts went out there
  const snapshot = (managed, text, dueAt) => ({ text, dueAt, custom: Boolean(managed.custom), writtenFacts: managed.writtenFacts ?? null });

  for (const item of plan.items) {
    if (item.type === 'unchanged' || item.type === 'edited' || item.type === 'held') { record(item, 'unchanged'); continue; }
    if (item.type === 'expired') { record(item, 'unchanged', { note: item.note }); continue; }
    if (item.type === 'published') {
      if (item.needsFollowUp && followUps.has(item.postId)) {
        if (!followUpChannels.has(item.channelId)) followUpChannels.set(item.channelId, item);
        record(item, 'follow_up');
      } else if (item.needsFollowUp) {
        counts.manual++;
        record(item, 'manual', { note: item.note, suggested: item.suggested });
      } else {
        record(item, 'unchanged');
      }
      continue;
    }
    if (item.type === 'missing') {
      // Deleted in Buffer by the organiser: stop tracking it.
      removedIds.add(item.postId);
      touched.push({ postId: item.postId, kind: item.kind, channelId: item.channelId, action: 'dropped' });
      record(item, 'dropped');
      continue;
    }
    if (item.type === 'review') { counts.review++; record(item, 'needs_review', { note: item.note }); continue; }
    if (!isApproved(item.postId)) { counts.review++; record(item, 'needs_review', { note: 'Waiting for your approval.' }); continue; }

    const managed = byId.get(item.postId);
    const label = { postId: item.postId, kind: item.kind, channelId: item.channelId };

    // "Keep mine": their wording becomes the new baseline. The time and picture still follow the event.
    let send = item;
    if (item.type === 'conflict' && !overwrite.has(item.postId)) {
      send = { ...item, proposed: item.current, kept: true };
      if (!item.dueAt && !item.card) {
        touched.push({ ...label, action: 'kept', before: snapshot(managed, item.current, managed.lastWrittenDueAt), after: { text: item.current, dueAt: managed.lastWrittenDueAt } });
        Object.assign(managed, { lastWrittenText: item.current, writtenFacts: facts, custom: true });
        counts.kept++;
        record(item, 'kept');
        continue;
      }
    }

    try {
      if (item.type === 'delete') {
        const out = (await gql(session, DELETE_POST, { input: { id: item.postId } })).deletePost;
        if (out?.__typename !== 'DeletePostSuccess') throw new BufferError(out?.message || 'Buffer did not delete the post.', 422);
        // Read back: the post should be gone.
        const gone = await fetchCurrent(session, [{ postId: item.postId }]);
        if (gone.has(item.postId)) throw new BufferError('Buffer still shows the post after deleting it.', 502);
        const before = snapshot(managed, item.current, current.get(item.postId)?.dueAt ?? managed.lastWrittenDueAt);
        if (item.hold) {
          // Out of Buffer, but remembered, so it can come back if the event goes ahead.
          Object.assign(managed, { held: true, heldAt: new Date().toISOString(), lastWrittenText: item.current, lastWrittenDueAt: before.dueAt });
          counts.held++;
          touched.push({ ...label, action: 'held', before });
          record(item, 'held');
        } else {
          removedIds.add(item.postId);
          counts.removed++;
          touched.push({ ...label, action: 'removed', before });
          record(item, 'removed');
        }
        continue;
      }

      if (item.type === 'resume') {
        // A held post goes back into Buffer as a new post, with the wording for the details now.
        let card = item.card;
        let post;
        try {
          post = await createPost(session, { text: item.proposed, channelId: item.channelId, dueAt: item.dueAt, card });
        } catch (error) {
          if (!card || fatal(error)) throw error;
          card = null;
          post = await createPost(session, { text: item.proposed, channelId: item.channelId, dueAt: item.dueAt, card: null });
        }
        Object.assign(managed, {
          postId: post.id, held: false, heldAt: undefined, lastWrittenText: post.text, lastWrittenDueAt: post.dueAt,
          writtenFacts: facts, custom: item.custom, card: card && post.assets?.length ? card : null,
        });
        counts.restored++;
        touched.push({ ...label, postId: post.id, previousPostId: item.postId, action: 'restored', after: { text: post.text, dueAt: post.dueAt } });
        record(item, 'restored', { postId: post.id, dueAt: post.dueAt });
        continue;
      }

      // update, a conflict the user chose to overwrite, or a kept wording whose time or picture moves
      const input = { id: send.postId, text: send.proposed };
      if (send.dueAt) { input.dueAt = send.dueAt; input.mode = 'customScheduled'; } // only when the time really changes
      if (send.card) input.assets = cardAsset(send.card);
      const saved = (await gql(session, EDIT_POST, { input })).editPost;
      if (!saved?.post) throw new BufferError(saved?.message || 'Buffer did not accept the edit.', 422);
      const after = (await gql(session, GET_POST, { id: send.postId })).post;
      const afterAlt = after?.assets?.find((a) => a.image)?.image?.altText;
      const ok = after && sameText(after.text, send.proposed) && (!send.dueAt || sameInstant(after.dueAt, send.dueAt))
        && (!send.card || afterAlt === send.card.altText);
      if (!ok) throw new BufferError('Buffer did not save the change exactly as sent.', 502);
      touched.push({
        ...label, action: send.kept ? 'kept' : 'updated',
        before: snapshot(managed, item.current, item.previousDueAt ?? managed.lastWrittenDueAt),
        after: { text: after.text, dueAt: after.dueAt },
      });
      managed.lastWrittenText = after.text;
      managed.lastWrittenDueAt = after.dueAt;
      managed.writtenFacts = facts;
      managed.custom = send.type === 'conflict' ? true : Boolean(send.custom);
      if (send.card) managed.card = send.card;
      if (send.kept) { counts.kept++; record(item, 'kept', { dueAt: after.dueAt }); } else { counts.updated++; record(item, 'updated', { dueAt: after.dueAt }); }
    } catch (error) {
      if (fatal(error)) throw error;
      counts.failed++;
      record(item, 'failed', { note: error.message });
    }
  }

  // Posts that already went out get a short correction, scheduled as soon as Buffer allows.
  for (const [channelId, item] of followUpChannels) {
    const sent = byId.get(item.postId);
    const before = sent.writtenFacts ? normalizeFacts(sent.writtenFacts) : campaign.facts;
    try {
      const text = renderFollowUp(before, facts);
      const post = await createPost(session, { text, channelId, dueAt: soonest().toISOString(), card: null });
      campaign.posts.push({
        kind: 'followUp', channelId, postId: post.id, lastWrittenText: post.text, lastWrittenDueAt: post.dueAt,
        writtenFacts: facts, custom: true, customTime: true, card: null,
      });
      touched.push({ postId: post.id, kind: 'followUp', channelId, action: 'followUp', after: { text: post.text, dueAt: post.dueAt } });
      counts.followUps++;
    } catch (error) {
      if (fatal(error)) throw error;
      counts.failed++;
      results.push({ postId: item.postId, kind: 'followUp', status: 'failed', note: error.message });
    }
  }
  // Remember that the published posts have been dealt with, so they stop asking.
  for (const result of results) {
    if (result.status !== 'follow_up') continue;
    const sent = byId.get(result.postId);
    touched.push({ postId: sent.postId, kind: sent.kind, channelId: sent.channelId, action: 'followedUp', before: { writtenFacts: sent.writtenFacts ?? null } });
    sent.writtenFacts = facts;
  }

  campaign.posts = campaign.posts.filter((p) => !removedIds.has(p.postId));
  const changedSomething = counts.updated || counts.kept || counts.removed || counts.held || counts.restored || counts.followUps || removedIds.size;
  // A new status with nothing changed in Buffer is saved only when no post is still waiting on
  // the organiser or failed. Otherwise the event would say "postponed" while its posts are still live.
  const statusChanged = factsBefore.status !== facts.status && !counts.review && !counts.failed;
  if (changedSomething || statusChanged || plan.changedFields.length === 0) campaign.facts = facts;
  const summary = summarize(counts);
  let entry = null;
  if (changedSomething || (statusChanged && campaign.facts === facts)) {
    campaign.version += 1;
    campaign.updatedAt = new Date().toISOString();
    entry = addHistory(campaign, {
      type: undoEntry ? 'undo' : 'change', by: byLine(session), undoOf: undoEntry?.id ?? null,
      before: factsBefore, after: campaign.facts, changedFields: diffFacts(factsBefore, campaign.facts),
      summary, posts: touched, version: campaign.version,
    });
    if (undoEntry) {
      const original = campaign.history.find((h) => h.id === undoEntry.id);
      if (original) original.undoneBy = entry.id;
    }
  }

  // The Buffer snippet holding the event details follows the change too.
  let snippet = null;
  if (campaign.snippet && campaign.facts === facts && diffFacts(factsBefore, facts).length) {
    snippet = await syncSnippet(session, campaign).then(() => 'updated', (error) => {
      if (fatal(error)) throw error;
      return 'failed';
    });
  }

  await store.put(campaign);
  return { summary, counts, results, campaign: { ...campaign, mine: campaign.accountId === (await accountId(session)), undo: undoable(campaign)?.id ?? null }, snippet };
}

// ---- Tell Telly what changed, in plain words ---------------------------------------
// Turns "we've moved to the Town Hall" into updated details. Nothing changes here: the
// browser opens the usual review with these details, and the organiser checks them first.

campaignRoutes.post(
  '/:id/understand',
  wrap(async (req, res) => {
    if (!flyerEnabled()) return res.status(404).json({ error: 'Not found' });
    const session = await getSession(req, res);
    const campaign = await ownedCampaign(req, session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const reads = Number(session.flyerReads) || 0;
    if (reads >= (session.demo ? 10 : 60)) return res.status(429).json({ error: 'Edit the details by hand for now.' });
    session.flyerReads = reads + 1;
    await session.save();
    try {
      const facts = await readChange({ text: req.body?.text, facts: campaign.facts, today: req.body?.today });
      const changed = diffFacts(campaign.facts, normalizeFacts(facts));
      if (!changed.length) return res.status(422).json({ error: "That matches the details Telly already has. Nothing to change." });
      res.json({ facts: normalizeFacts(facts), changed });
    } catch (error) {
      if (error instanceof FlyerError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  }),
);

// ---- Buffer Ideas and Snippets -----------------------------------------------------

export const ideasAvailable = (session) => Boolean(session.demo) || config.ideasEnabled;

function mutationResult(out, wanted, what) {
  if (out?.__typename === wanted || out?.id || out?.snippet) return out;
  if (out?.__typename === 'UnauthorizedError') {
    throw new BufferError(`Buffer hasn't allowed Telly to save ${what} yet. Disconnect, then connect Buffer again to allow it.`, 403);
  }
  throw new BufferError(out?.message || `Buffer did not save the ${what}.`, 422);
}

async function syncSnippet(session, campaign) {
  const input = { organizationId: campaign.snippet.organizationId, name: `Telly: ${campaign.facts.title}`.slice(0, 100), text: snippetText(campaign.facts) };
  if (campaign.snippet.id) {
    const out = mutationResult((await gql(session, UPDATE_SNIPPET, { input: { ...input, id: campaign.snippet.id } })).updateSnippet, 'UpdateSnippetSuccess', 'snippet');
    campaign.snippet = { ...campaign.snippet, text: out.snippet.text, savedAt: new Date().toISOString() };
  } else {
    const out = mutationResult((await gql(session, CREATE_SNIPPET, { input })).createSnippet, 'CreateSnippetSuccess', 'snippet');
    campaign.snippet = { ...campaign.snippet, id: out.snippet.id, text: out.snippet.text, savedAt: new Date().toISOString() };
  }
}

// Save the confirmed details as a Buffer snippet. Telly keeps it current when the details change.
campaignRoutes.post(
  '/:id/snippet',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    if (!ideasAvailable(session)) return res.status(404).json({ error: 'Not found' });
    const campaign = await ownedCampaign(req, session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const organizationId = campaign.organizationId || String(req.body?.organizationId || '');
    if (!organizationId || !(await organizationIds(session)).includes(organizationId)) {
      return res.status(400).json({ error: 'Choose the Buffer organization to save the snippet in.' });
    }
    campaign.snippet = { ...(campaign.snippet || {}), organizationId };
    try {
      await syncSnippet(session, campaign);
    } catch (error) {
      // Buffer keeps snippets for paid plans and says so in its own words.
      if (/entitlement/i.test(error.message)) {
        return res.status(402).json({ error: "Your Buffer plan doesn't include snippets. Save the posts as ideas instead." });
      }
      throw error;
    }
    await store.put(campaign);
    res.json({ snippet: campaign.snippet });
  }),
);

const KIND_NAMES = { announcement: 'Announcement', reminder: 'Reminder', dayOf: 'Day-of post', followUp: 'Correction' };

// Save wording to Buffer's Ideas: either one piece of text (a correction you'll post yourself)
// or one idea per post in the campaign, to reuse on channels Telly doesn't schedule for.
campaignRoutes.post(
  '/:id/ideas',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    if (!ideasAvailable(session)) return res.status(404).json({ error: 'Not found' });
    const campaign = await ownedCampaign(req, session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const organizationId = campaign.organizationId || String(req.body?.organizationId || '');
    if (!organizationId || !(await organizationIds(session)).includes(organizationId)) {
      return res.status(400).json({ error: 'Choose the Buffer organization to save ideas in.' });
    }
    const title = campaign.facts.title;
    let drafts;
    if (typeof req.body?.text === 'string' && req.body.text.trim()) {
      drafts = [{ kind: req.body.kind in KIND_NAMES ? req.body.kind : 'followUp', text: req.body.text.trim().slice(0, 5000) }];
    } else {
      drafts = KINDS.map((kind) => campaign.posts.find((p) => p.kind === kind))
        .filter(Boolean).map((p) => ({ kind: p.kind, text: p.lastWrittenText }));
    }
    if (!drafts.length) return res.status(400).json({ error: 'There is nothing to save yet.' });
    const saved = [];
    for (const draft of drafts) {
      const input = { organizationId, content: { title: `${title}: ${KIND_NAMES[draft.kind]}`.slice(0, 200), text: draft.text } };
      const out = mutationResult((await gql(session, CREATE_IDEA, { input })).createIdea, 'Idea', 'ideas');
      saved.push({ id: out.id, kind: draft.kind, at: new Date().toISOString() });
    }
    campaign.ideas = [...(campaign.ideas || []), ...saved].slice(-30);
    await store.put(campaign);
    res.json({ saved: saved.length, ideas: campaign.ideas });
  }),
);

