import fs from 'node:fs/promises';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { config } from './config.js';

// Storage. With DATABASE_URL set (Neon, added through Vercel), everything lives in Postgres.
// Without it, local development and the test runs fall back to JSON files. Production refuses
// to start without a database, because a serverless host has no persistent disk.
//
// Watcher tokens are stored apart from the rest of a watcher's record and only ever changed
// by setWatcherTokens, so a slow job saving its status can never write back a used-up token.

// ---- Schema, as numbered migrations ---------------------------------------------------
// Each runs once, in order, inside a transaction, and is recorded in schema_migrations.
// Add new steps at the end; never edit one that has shipped.
export const MIGRATIONS = [
  {
    version: 1,
    name: 'campaigns and demo queues',
    statements: [
      `CREATE TABLE IF NOT EXISTS campaigns (
        id text PRIMARY KEY,
        account_id text NOT NULL,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS campaigns_account_idx ON campaigns (account_id, created_at DESC)',
      `CREATE TABLE IF NOT EXISTS demo_queues (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    version: 2,
    name: 'shared rate limit',
    statements: [
      `CREATE TABLE IF NOT EXISTS rate_limits (
        key text NOT NULL,
        window_start timestamptz NOT NULL,
        count integer NOT NULL DEFAULT 0,
        PRIMARY KEY (key, window_start)
      )`,
    ],
  },
  {
    version: 3,
    name: 'background watching',
    statements: [
      `CREATE TABLE IF NOT EXISTS watchers (
        account_id text PRIMARY KEY,
        tokens text NOT NULL,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        lock_until timestamptz,
        last_run timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS watchers_last_run_idx ON watchers (last_run NULLS FIRST)',
    ],
  },
  {
    version: 4,
    name: 'feedback',
    statements: [
      `CREATE TABLE IF NOT EXISTS feedback (
        id bigserial PRIMARY KEY,
        account_id text,
        page text,
        message text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`,
    ],
  },
  {
    version: 5,
    name: 'campaigns shared within a Buffer organization',
    statements: [
      "CREATE INDEX IF NOT EXISTS campaigns_org_idx ON campaigns ((data->>'organizationId'), created_at DESC)",
    ],
  },
];

// ---- Local JSON files ------------------------------------------------------------------

function fileStore(dir) {
  const file = (name) => path.join(dir, `${name}.json`);
  const read = async (name) => {
    try {
      return JSON.parse(await fs.readFile(file(name), 'utf8'));
    } catch {
      return {};
    }
  };
  const write = async (name, data) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file(name), JSON.stringify(data, null, 2));
  };
  const hits = new Map();
  const watcherOut = (w) => (w ? { ...w.data, accountId: w.accountId, tokens: w.tokens, lastRun: w.lastRun ?? null } : null);

  const methods = {
    async migrate() {
      return [];
    },
    async get(id) {
      return (await read('campaigns'))[id] ?? null;
    },
    async list(accountId) {
      return Object.values(await read('campaigns'))
        .filter((c) => c.accountId === accountId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async listForOrg(accountId, organizationId) {
      return Object.values(await read('campaigns'))
        .filter((c) => c.organizationId === organizationId || (c.accountId === accountId && !c.organizationId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async removeAccount(accountId) {
      const all = await read('campaigns');
      const keep = Object.fromEntries(Object.entries(all).filter(([, c]) => c.accountId !== accountId));
      await write('campaigns', keep);
      const watchers = await read('watchers');
      delete watchers[accountId];
      await write('watchers', watchers);
      return Object.keys(all).length - Object.keys(keep).length;
    },
    async put(campaign) {
      const all = await read('campaigns');
      all[campaign.id] = campaign;
      await write('campaigns', all);
      return campaign;
    },
    async claim(id, ms) {
      const all = await read('campaigns');
      const c = all[id];
      if (!c || (c.lockUntil && Date.parse(c.lockUntil) > Date.now())) return false;
      c.lockUntil = new Date(Date.now() + ms).toISOString();
      await write('campaigns', all);
      return true;
    },
    async release(id) {
      const all = await read('campaigns');
      if (!all[id]) return;
      delete all[id].lockUntil;
      await write('campaigns', all);
    },
    async ping() {
      return true;
    },
    async getDemo(id) {
      return (await read('demo-queues'))[id] ?? null;
    },
    async putDemo(id, data) {
      const all = await read('demo-queues');
      all[id] = data;
      await write('demo-queues', all);
    },
    // One process, so an in-memory count is exact here.
    async hit(key, windowMs) {
      const start = Math.floor(Date.now() / windowMs) * windowMs;
      const entry = hits.get(key);
      if (!entry || entry.start !== start) {
        hits.set(key, { start, count: 1 });
        if (hits.size > 5000) for (const [k, v] of hits) if (v.start !== start) hits.delete(k);
        return 1;
      }
      return ++entry.count;
    },
    async getWatcher(accountId) {
      return watcherOut((await read('watchers'))[accountId]);
    },
    async createWatcher(accountId, tokens, data) {
      const all = await read('watchers');
      all[accountId] = { accountId, tokens, data, lastRun: null, lockUntil: null };
      await write('watchers', all);
    },
    async putWatcher(accountId, data, { ran = false } = {}) {
      const all = await read('watchers');
      if (!all[accountId]) return;
      all[accountId].data = data;
      if (ran) all[accountId].lastRun = new Date().toISOString();
      await write('watchers', all);
    },
    async setWatcherTokens(accountId, tokens) {
      const all = await read('watchers');
      if (!all[accountId]) return;
      all[accountId].tokens = tokens;
      await write('watchers', all);
    },
    async removeWatcher(accountId) {
      const all = await read('watchers');
      delete all[accountId];
      await write('watchers', all);
    },
    async claimWatcher(accountId, ms) {
      const all = await read('watchers');
      const w = all[accountId];
      if (!w || (w.lockUntil && Date.parse(w.lockUntil) > Date.now())) return false;
      w.lockUntil = new Date(Date.now() + ms).toISOString();
      await write('watchers', all);
      return true;
    },
    async releaseWatcher(accountId) {
      const all = await read('watchers');
      if (!all[accountId]) return;
      all[accountId].lockUntil = null;
      await write('watchers', all);
    },
    async dueWatchers(olderThanMs, limit) {
      const cutoff = Date.now() - olderThanMs;
      return Object.values(await read('watchers'))
        .filter((w) => w.data?.enabled !== false && (!w.lastRun || Date.parse(w.lastRun) < cutoff
          || (w.data?.nextCheckAt && Date.parse(w.data.nextCheckAt) <= Date.now())))
        .sort((a, b) => (a.lastRun || '').localeCompare(b.lastRun || ''))
        .slice(0, limit)
        .map((w) => w.accountId);
    },
    async addFeedback(entry) {
      const all = await read('feedback');
      const id = String(Object.keys(all).length + 1);
      all[id] = { ...entry, createdAt: new Date().toISOString() };
      await write('feedback', all);
    },
  };

  // Every call reads and rewrites a whole file, so run them one at a time. That also makes
  // claim and claimWatcher real locks within this process.
  let queue = Promise.resolve();
  const serial = (fn) => (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };
  return {
    kind: 'file',
    ...Object.fromEntries(Object.entries(methods).map(([name, fn]) => [name, serial(fn)])),
  };
}

// ---- Postgres (Neon) -------------------------------------------------------------------

function postgresStore(url) {
  const sql = neon(url);
  let ready;

  async function migrate() {
    await sql.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await sql.query('SELECT version FROM schema_migrations')).map((r) => r.version));
    const applied = [];
    for (const step of MIGRATIONS) {
      if (done.has(step.version)) continue;
      // Every statement is idempotent, so two instances racing here end in the same state.
      await sql.transaction([
        ...step.statements.map((statement) => sql.query(statement)),
        sql.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING', [step.version, step.name]),
      ]);
      applied.push(step.version);
    }
    return applied;
  }

  const ensure = () => {
    ready ??= migrate().catch((error) => {
      ready = undefined; // try again on the next request
      throw error;
    });
    return ready;
  };
  const watcherOut = (r) => (r ? { ...r.data, accountId: r.account_id, tokens: r.tokens, lastRun: r.last_run ? new Date(r.last_run).toISOString() : null } : null);

  return {
    kind: 'postgres',
    migrate: ensure,
    async get(id) {
      await ensure();
      const rows = await sql`SELECT data FROM campaigns WHERE id = ${id}`;
      return rows[0]?.data ?? null;
    },
    async list(accountId) {
      await ensure();
      const rows = await sql`SELECT data FROM campaigns WHERE account_id = ${accountId} ORDER BY created_at DESC`;
      return rows.map((r) => r.data);
    },
    // A team's campaigns: everything in the organization, plus your own from before sharing.
    async listForOrg(accountId, organizationId) {
      await ensure();
      const rows = await sql`SELECT data FROM campaigns
        WHERE data->>'organizationId' = ${organizationId}
           OR (account_id = ${accountId} AND data->>'organizationId' IS NULL)
        ORDER BY created_at DESC`;
      return rows.map((r) => r.data);
    },
    async removeAccount(accountId) {
      await ensure();
      await sql`DELETE FROM watchers WHERE account_id = ${accountId}`;
      return (await sql`DELETE FROM campaigns WHERE account_id = ${accountId} RETURNING id`).length;
    },
    async put(campaign) {
      await ensure();
      await sql`INSERT INTO campaigns (id, account_id, data, created_at)
        VALUES (${campaign.id}, ${campaign.accountId}, ${JSON.stringify(campaign)}::jsonb, ${campaign.createdAt})
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
        WHERE campaigns.account_id = EXCLUDED.account_id`;
      return campaign;
    },
    // A short lock while changes are sent to Buffer, so two tabs cannot apply at once.
    async claim(id, ms) {
      await ensure();
      const until = new Date(Date.now() + ms).toISOString();
      const rows = await sql`UPDATE campaigns SET data = jsonb_set(data, '{lockUntil}', to_jsonb(${until}::text))
        WHERE id = ${id} AND (data->>'lockUntil' IS NULL OR (data->>'lockUntil')::timestamptz < now())
        RETURNING id`;
      return rows.length === 1;
    },
    async release(id) {
      await ensure();
      await sql`UPDATE campaigns SET data = data - 'lockUntil' WHERE id = ${id}`;
    },
    async ping() {
      await sql`SELECT 1`;
      return true;
    },
    async getDemo(id) {
      await ensure();
      const rows = await sql`SELECT data FROM demo_queues WHERE id = ${id}`;
      return rows[0]?.data ?? null;
    },
    async putDemo(id, data) {
      await ensure();
      await sql`INSERT INTO demo_queues (id, data) VALUES (${id}, ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
    },
    // Demo data older than a week is removed whenever someone starts a new demo.
    async sweepDemos() {
      await ensure();
      await sql`DELETE FROM demo_queues WHERE updated_at < now() - interval '7 days'`;
      await sql`DELETE FROM campaigns WHERE account_id LIKE 'demo\\_%' AND updated_at < now() - interval '7 days'`;
    },
    // Counts a request in the current window across every server instance.
    async hit(key, windowMs) {
      await ensure();
      const start = new Date(Math.floor(Date.now() / windowMs) * windowMs).toISOString();
      const rows = await sql`INSERT INTO rate_limits (key, window_start, count) VALUES (${key}, ${start}, 1)
        ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
        RETURNING count`;
      // Now and then, clear out windows that have ended.
      if (Math.random() < 0.01) sql`DELETE FROM rate_limits WHERE window_start < now() - interval '10 minutes'`.catch(() => {});
      return rows[0].count;
    },
    async getWatcher(accountId) {
      await ensure();
      const rows = await sql`SELECT account_id, tokens, data, last_run FROM watchers WHERE account_id = ${accountId}`;
      return watcherOut(rows[0]);
    },
    async createWatcher(accountId, tokens, data) {
      await ensure();
      await sql`INSERT INTO watchers (account_id, tokens, data) VALUES (${accountId}, ${tokens}, ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (account_id) DO UPDATE SET tokens = EXCLUDED.tokens, data = EXCLUDED.data, updated_at = now()`;
    },
    async putWatcher(accountId, data, { ran = false } = {}) {
      await ensure();
      if (ran) await sql`UPDATE watchers SET data = ${JSON.stringify(data)}::jsonb, last_run = now(), updated_at = now() WHERE account_id = ${accountId}`;
      else await sql`UPDATE watchers SET data = ${JSON.stringify(data)}::jsonb, updated_at = now() WHERE account_id = ${accountId}`;
    },
    async setWatcherTokens(accountId, tokens) {
      await ensure();
      await sql`UPDATE watchers SET tokens = ${tokens}, updated_at = now() WHERE account_id = ${accountId}`;
    },
    async removeWatcher(accountId) {
      await ensure();
      await sql`DELETE FROM watchers WHERE account_id = ${accountId}`;
    },
    // Only one process may refresh a watcher's tokens at a time: Buffer's refresh tokens are single use.
    async claimWatcher(accountId, ms) {
      await ensure();
      const until = new Date(Date.now() + ms).toISOString();
      const rows = await sql`UPDATE watchers SET lock_until = ${until}
        WHERE account_id = ${accountId} AND (lock_until IS NULL OR lock_until < now())
        RETURNING account_id`;
      return rows.length === 1;
    },
    async releaseWatcher(accountId) {
      await ensure();
      await sql`UPDATE watchers SET lock_until = NULL WHERE account_id = ${accountId}`;
    },
    async dueWatchers(olderThanMs, limit) {
      await ensure();
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const rows = await sql`SELECT account_id FROM watchers
        WHERE COALESCE((data->>'enabled')::boolean, true)
          AND (last_run IS NULL OR last_run < ${cutoff} OR (data->>'nextCheckAt')::timestamptz <= now())
        ORDER BY last_run NULLS FIRST LIMIT ${limit}`;
      return rows.map((r) => r.account_id);
    },
    async addFeedback({ accountId, page, message }) {
      await ensure();
      await sql`INSERT INTO feedback (account_id, page, message) VALUES (${accountId ?? null}, ${page ?? null}, ${message})`;
    },
  };
}

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (config.isProd && !databaseUrl) {
  throw new Error('DATABASE_URL is required in production. Add Neon to the Vercel project.');
}

export const store = databaseUrl ? postgresStore(databaseUrl) : fileStore(config.dataDir);
