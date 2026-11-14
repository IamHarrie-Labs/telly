import crypto from 'node:crypto';
import { config } from './config.js';
import { store } from './store.js';
import { BufferError, gql } from './buffer.js';
import { CHANNELS } from './queries.js';
import { fetchCurrent } from './routes-campaigns.js';
import { cardFor } from './card.js';
import { planChange, startsAt } from './campaign.js';
import { strip } from './vault.js';
import { alert, log } from './alert.js';

// Background watching: a scheduler calls /api/cron/watch every half hour, and each organiser
// who turned watching on is checked when their last check is older than config.watchEveryMs
// (six hours by default, to stay inside Buffer's API budget). Telly reads their upcoming posts from Buffer and looks for things
// that need a person: a post that failed to publish, a channel that disconnected or paused,
// or posts left out of date. When the set of problems changes, it emails them once.

const BATCH = 25;
const BUDGET_MS = 45_000;

// A stand-in for the browser session: tokens come from the vault, nothing is saved to a cookie.
const vaultSession = (accountId) => ({ tokens: { vault: accountId }, accountId, save: async () => {} });

/** What needs attention for one account right now. */
export async function checkAccount(accountId, now = new Date()) {
  const session = vaultSession(accountId);
  const campaigns = (await store.list(accountId)).filter(
    (c) => c.facts.status !== 'cancelled' && c.posts.length && startsAt(c.facts) > now,
  );
  const issues = [];
  const channelsByOrg = new Map();

  for (const campaign of campaigns) {
    const current = await fetchCurrent(session, campaign.posts);
    const plan = planChange(campaign, campaign.facts, current, now, { cardFor });
    const title = campaign.facts.title;

    for (const item of plan.items) {
      const live = current.get(item.postId);
      if (live?.status === 'error') {
        issues.push({ key: `failed:${item.postId}`, campaignId: campaign.id, text: `"${title}": a post failed to publish in Buffer.` });
      }
    }
    const stale = plan.items.filter((i) => i.type === 'update' || i.type === 'conflict').length;
    if (stale) {
      issues.push({
        key: `stale:${campaign.id}:${stale}`, campaignId: campaign.id,
        text: `"${title}": ${stale === 1 ? '1 scheduled post doesn\'t' : `${stale} scheduled posts don't`} match the event details.`,
      });
    }

    // Channels with posts still waiting to go out.
    const waiting = new Set(campaign.posts.filter((p) => current.get(p.postId)?.status === 'scheduled').map((p) => p.channelId));
    if (waiting.size && campaign.organizationId) {
      if (!channelsByOrg.has(campaign.organizationId)) {
        const data = await gql(session, CHANNELS, { organizationId: campaign.organizationId });
        channelsByOrg.set(campaign.organizationId, data.channels || []);
      }
      for (const channel of channelsByOrg.get(campaign.organizationId)) {
        if (!waiting.has(channel.id)) continue;
        const name = channel.displayName || channel.name;
        if (channel.isDisconnected) {
          issues.push({ key: `disconnected:${channel.id}`, campaignId: campaign.id, text: `${name} is disconnected in Buffer, so posts for "${title}" won't go out.` });
        } else if (channel.isQueuePaused) {
          issues.push({ key: `paused:${channel.id}`, campaignId: campaign.id, text: `The ${name} queue is paused in Buffer, so posts for "${title}" are on hold.` });
        }
      }
    }
  }
  // One line per problem, even if two campaigns share a channel.
  const seen = new Set();
  return issues.filter((i) => !seen.has(i.key) && seen.add(i.key));
}

const digest = (issues) => crypto.createHash('sha256').update(issues.map((i) => i.key).sort().join('|')).digest('hex').slice(0, 16);

async function sendEmail(to, issues) {
  if (!config.resendKey || !to) return false;
  const origin = new URL(config.redirectUri).origin;
  const lines = issues.map((i) => `- ${i.text}`).join('\n');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: config.alertFrom,
      to: [to],
      subject: issues.length === 1 ? 'Telly: a post needs a look' : `Telly: ${issues.length} things need a look`,
      text: `Telly checked your event posts in Buffer and found:\n\n${lines}\n\nOpen Telly to see them: ${origin}/\n\nYou're getting this because you turned on watching in Telly. Turn it off there at any time.`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Resend returned HTTP ${response.status}`);
  return true;
}

/** Checks one watcher and records the result. Never throws. */
export async function runWatcher(accountId) {
  const watcher = await store.getWatcher(accountId);
  if (!watcher || watcher.enabled === false) return { accountId, skipped: true };
  const data = strip(watcher);
  try {
    const issues = await checkAccount(accountId);
    const next = { ...data, issues, lastError: null, checkedAt: new Date().toISOString() };
    const fingerprint = issues.length ? digest(issues) : null;
    if (fingerprint && fingerprint !== data.lastDigest) {
      try {
        if (await sendEmail(data.email, issues)) next.notifiedAt = new Date().toISOString();
      } catch (error) {
        await alert('watch_email_failed', { message: error.message });
      }
    }
    next.lastDigest = fingerprint;
    await store.putWatcher(accountId, next, { ran: true });
    return { accountId, issues: issues.length };
  } catch (error) {
    if (error instanceof BufferError && error.status === 429) {
      // Not this account's fault: leave its record alone so it's first in line next run.
      log('watch_rate_limited', { accountId, retryAfter: error.retryAfter });
      return { accountId, error: 'rate_limited' };
    }
    const reconnect = error instanceof BufferError && error.status === 401;
    // getWatcher again: a failed refresh may already have switched watching off.
    const latest = strip(await store.getWatcher(accountId));
    await store.putWatcher(accountId, { ...latest, lastError: reconnect ? 'reconnect' : 'check_failed', ...(reconnect ? { enabled: false } : {}) }, { ran: true });
    if (!reconnect) log('watch_check_failed', { accountId, message: error.message });
    return { accountId, error: reconnect ? 'reconnect' : 'check_failed' };
  }
}

/** One scheduler tick: works through the watchers that are due, within a time budget. */
export async function runDueWatchers() {
  const started = Date.now();
  const due = await store.dueWatchers(config.watchEveryMs, BATCH);
  const results = [];
  for (const accountId of due) {
    if (Date.now() - started > BUDGET_MS) break;
    const result = await runWatcher(accountId);
    results.push(result);
    // Buffer's limit is shared by the whole app: when it says slow down, stop until next time.
    if (result.error === 'rate_limited') break;
  }
  const failed = results.filter((r) => r.error === 'check_failed').length;
  if (failed && failed === results.length) await alert('watch_run_failed', { checked: results.length });
  return { due: due.length, checked: results.length, failed, ms: Date.now() - started };
}
