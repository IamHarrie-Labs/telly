import express from 'express';
import crypto from 'node:crypto';
import { getSession } from './session.js';
import { BufferError, gql } from './buffer.js';
import { ACCOUNT_ID, CREATE_POST, DELETE_POST, EDIT_POST, GET_POST } from './queries.js';
import { store } from './store.js';
import { cardFor } from './card.js';
import {
  buildCampaignPlan, normalizeFacts, planChange, renderFollowUp, sameInstant, sameText, soonest, summarize, validateFacts,
} from './campaign.js';

export const campaignRoutes = express.Router();
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const LOCK_MS = 60_000;

async function accountId(session) {
  if (session.accountId) return session.accountId;
  session.accountId = (await gql(session, ACCOUNT_ID)).account.id;
  await session.save();
  return session.accountId;
}

function readFacts(body) {
  const facts = normalizeFacts(body?.facts);
  return { facts, errors: validateFacts(facts) };
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

async function ownedCampaign(req, session) {
  const campaign = await store.get(req.params.id);
  if (!campaign || campaign.accountId !== (await accountId(session))) return null;
  return campaign;
}

// Read each managed post from Buffer. A post that no longer exists comes back as undefined.
async function fetchCurrent(session, posts) {
  const current = new Map();
  for (const post of posts) {
    try {
      const data = await gql(session, GET_POST, { id: post.postId });
      if (data.post) current.set(post.postId, data.post);
    } catch (error) {
      if (!(error instanceof BufferError) || error.status === 401 || error.status === 429) throw error;
      if (!/not found|does not exist/i.test(error.message)) throw error;
    }
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

// ---- Preview: nothing is sent to Buffer -------------------------------------------

campaignRoutes.post(
  '/preview',
  wrap(async (req, res) => {
    const { facts, errors } = readFacts(req.body);
    const channelIds = req.body?.channelIds;
    if (errors.length) return res.status(400).json({ errors });
    if (!Array.isArray(channelIds) || !channelIds.length) return res.status(400).json({ errors: ['Choose at least one channel.'] });
    const { services, edits } = readOptions(req.body);
    res.json({ facts, items: buildCampaignPlan(facts, channelIds, new Date(), { services, edits }), card: cardFor(facts) });
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
    const card = withCard ? cardFor(facts) : null;
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
      id: crypto.randomUUID(), accountId: owner, organizationId: organizationId || null,
      facts, posts, version: 1, createdAt: new Date().toISOString(),
    };
    await store.put(campaign);
    res.status(201).json({ campaign, results, summary, imageRefused });
  }),
);

campaignRoutes.get(
  '/',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    res.json({ campaigns: await store.list(await accountId(session)) });
  }),
);

// Delete everything Telly stores for this account. Posts already in Buffer stay there.
campaignRoutes.delete(
  '/',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const removed = await store.removeAccount(await accountId(session));
    res.json({ removed });
  }),
);

campaignRoutes.get(
  '/:id',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const campaign = await ownedCampaign(req, session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign });
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
        return {
          postId: item.postId, type: item.type, text: live?.text ?? null, status: live?.status ?? null, dueAt: live?.dueAt ?? null,
          image: live?.assets?.find((a) => a.image) ? { url: live.assets.find((a) => a.image).source, altText: live.assets.find((a) => a.image).image.altText } : null,
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
    const current = await fetchCurrent(session, campaign.posts);
    res.json({ ...planChange(campaign, facts, current, new Date(), { cardFor }), version: campaign.version });
  }),
);

campaignRoutes.post(
  '/:id/changes/apply',
  wrap(async (req, res) => {
    const session = await getSession(req, res);
    const campaign = await ownedCampaign(req, session);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const { facts, errors } = readFacts(req.body);
    if (errors.length) return res.status(400).json({ errors });
    if (req.body.version !== undefined && Number(req.body.version) !== campaign.version) {
      return res.status(409).json({ error: 'This campaign changed in another tab or window. Go back to it and review again.' });
    }
    if (!(await store.claim(campaign.id, LOCK_MS))) {
      return res.status(409).json({ error: 'Telly is already sending changes for this campaign. Wait a moment, then try again.' });
    }
    try {
      res.json(await applyChanges(session, campaign, facts, req.body));
    } finally {
      await store.release(campaign.id).catch(() => {});
    }
  }),
);

async function applyChanges(session, campaign, facts, body) {
  const approve = body.approve;
  const overwrite = new Set(Array.isArray(body.overwrite) ? body.overwrite : []);
  const followUps = new Set(Array.isArray(body.followUps) ? body.followUps : []);
  const isApproved = (postId) => approve === 'all' || (Array.isArray(approve) && approve.includes(postId));

  const current = await fetchCurrent(session, campaign.posts);
  const plan = planChange(campaign, facts, current, new Date(), { cardFor });
  const counts = { updated: 0, kept: 0, removed: 0, followUps: 0, review: 0, manual: 0, failed: 0 };
  const results = [];
  const record = (item, status, extra = {}) => results.push({ postId: item.postId, kind: item.kind, status, ...extra });
  const byId = new Map(campaign.posts.map((p) => [p.postId, p]));
  const removedIds = new Set();
  const followUpChannels = new Map(); // one follow-up per channel, however many posts went out there

  for (const item of plan.items) {
    if (item.type === 'unchanged' || item.type === 'edited') { record(item, 'unchanged'); continue; }
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
      record(item, 'dropped');
      continue;
    }
    if (item.type === 'review') { counts.review++; record(item, 'needs_review', { note: item.note }); continue; }
    if (!isApproved(item.postId)) { counts.review++; record(item, 'needs_review', { note: 'Waiting for your approval.' }); continue; }

    // "Keep mine": their wording becomes the new baseline. The time and picture still follow the event.
    const managed = byId.get(item.postId);
    let send = item;
    if (item.type === 'conflict' && !overwrite.has(item.postId)) {
      send = { ...item, proposed: item.current, kept: true };
      if (!item.dueAt && !item.card) {
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
        removedIds.add(item.postId);
        counts.removed++;
        record(item, 'removed');
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
      managed.lastWrittenText = after.text;
      managed.lastWrittenDueAt = after.dueAt;
      managed.writtenFacts = facts;
      if (send.ownWords || send.type === 'conflict') managed.custom = true;
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
      counts.followUps++;
    } catch (error) {
      if (fatal(error)) throw error;
      counts.failed++;
      results.push({ postId: item.postId, kind: 'followUp', status: 'failed', note: error.message });
    }
  }
  // Remember that the published posts have been dealt with, so they stop asking.
  for (const result of results) {
    if (result.status === 'follow_up') byId.get(result.postId).writtenFacts = facts;
  }

  campaign.posts = campaign.posts.filter((p) => !removedIds.has(p.postId));
  const changedSomething = counts.updated || counts.kept || counts.removed || counts.followUps || removedIds.size;
  if (changedSomething || plan.changedFields.length === 0) campaign.facts = facts;
  if (changedSomething) campaign.version += 1;
  await store.put(campaign);
  return { summary: summarize(counts), counts, results, campaign };
}
