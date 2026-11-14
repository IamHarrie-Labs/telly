import fs from 'node:fs/promises';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { config, root } from './config.js';

// Campaign storage. With DATABASE_URL set (Neon, added through Vercel), campaigns live in
// Postgres. Without it, local development falls back to a JSON file. Production refuses
// to start without a database, because a serverless host has no persistent disk.

function fileStore() {
  const dir = path.join(root, 'data');
  const file = path.join(dir, 'campaigns.json');
  const demoFile = path.join(dir, 'demo-queues.json');
  const readAll = async () => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    kind: 'file',
    async get(id) {
      return (await readAll())[id] ?? null;
    },
    async list(accountId) {
      return Object.values(await readAll())
        .filter((c) => c.accountId === accountId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async removeAccount(accountId) {
      const all = await readAll();
      const keep = Object.fromEntries(Object.entries(all).filter(([, c]) => c.accountId !== accountId));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(keep, null, 2));
      return Object.keys(all).length - Object.keys(keep).length;
    },
    async put(campaign) {
      const all = await readAll();
      all[campaign.id] = campaign;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(all, null, 2));
      return campaign;
    },
    async claim(id, ms) {
      const all = await readAll();
      const c = all[id];
      if (!c || (c.lockUntil && Date.parse(c.lockUntil) > Date.now())) return false;
      c.lockUntil = new Date(Date.now() + ms).toISOString();
      await fs.writeFile(file, JSON.stringify(all, null, 2));
      return true;
    },
    async release(id) {
      const all = await readAll();
      if (!all[id]) return;
      delete all[id].lockUntil;
      await fs.writeFile(file, JSON.stringify(all, null, 2));
    },
    async ping() {
      return true;
    },
    async getDemo(id) {
      try {
        return JSON.parse(await fs.readFile(demoFile, 'utf8'))[id] ?? null;
      } catch {
        return null;
      }
    },
    async putDemo(id, data) {
      let all = {};
      try {
        all = JSON.parse(await fs.readFile(demoFile, 'utf8'));
      } catch {
        /* first demo */
      }
      all[id] = data;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(demoFile, JSON.stringify(all, null, 2));
    },
  };
}

function postgresStore(url) {
  const sql = neon(url);
  let ready;
  const ensureTable = () => {
    ready ??= (async () => {
      await sql`CREATE TABLE IF NOT EXISTS campaigns (
        id text PRIMARY KEY,
        account_id text NOT NULL,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE INDEX IF NOT EXISTS campaigns_account_idx ON campaigns (account_id, created_at DESC)`;
      // Practice queues for demo visitors (see demo.js). Never real Buffer data.
      await sql`CREATE TABLE IF NOT EXISTS demo_queues (
        id text PRIMARY KEY,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`;
    })().catch((error) => {
      ready = undefined; // try again on the next request
      throw error;
    });
    return ready;
  };
  return {
    kind: 'postgres',
    async get(id) {
      await ensureTable();
      const rows = await sql`SELECT data FROM campaigns WHERE id = ${id}`;
      return rows[0]?.data ?? null;
    },
    async list(accountId) {
      await ensureTable();
      const rows = await sql`SELECT data FROM campaigns WHERE account_id = ${accountId} ORDER BY created_at DESC`;
      return rows.map((r) => r.data);
    },
    async removeAccount(accountId) {
      await ensureTable();
      return (await sql`DELETE FROM campaigns WHERE account_id = ${accountId} RETURNING id`).length;
    },
    async put(campaign) {
      await ensureTable();
      await sql`INSERT INTO campaigns (id, account_id, data, created_at)
        VALUES (${campaign.id}, ${campaign.accountId}, ${JSON.stringify(campaign)}::jsonb, ${campaign.createdAt})
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
        WHERE campaigns.account_id = EXCLUDED.account_id`;
      return campaign;
    },
    // A short lock while changes are sent to Buffer, so two tabs cannot apply at once.
    async claim(id, ms) {
      await ensureTable();
      const until = new Date(Date.now() + ms).toISOString();
      const rows = await sql`UPDATE campaigns SET data = jsonb_set(data, '{lockUntil}', to_jsonb(${until}::text))
        WHERE id = ${id} AND (data->>'lockUntil' IS NULL OR (data->>'lockUntil')::timestamptz < now())
        RETURNING id`;
      return rows.length === 1;
    },
    async release(id) {
      await ensureTable();
      await sql`UPDATE campaigns SET data = data - 'lockUntil' WHERE id = ${id}`;
    },
    async ping() {
      await sql`SELECT 1`;
      return true;
    },
    async getDemo(id) {
      await ensureTable();
      const rows = await sql`SELECT data FROM demo_queues WHERE id = ${id}`;
      return rows[0]?.data ?? null;
    },
    async putDemo(id, data) {
      await ensureTable();
      await sql`INSERT INTO demo_queues (id, data) VALUES (${id}, ${JSON.stringify(data)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
    },
    // Demo data older than a week is removed whenever someone starts a new demo.
    async sweepDemos() {
      await ensureTable();
      await sql`DELETE FROM demo_queues WHERE updated_at < now() - interval '7 days'`;
      await sql`DELETE FROM campaigns WHERE account_id LIKE 'demo\\_%' AND updated_at < now() - interval '7 days'`;
    },
  };
}

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (config.isProd && !databaseUrl) {
  throw new Error('DATABASE_URL is required in production. Add Neon to the Vercel project.');
}

export const store = databaseUrl ? postgresStore(databaseUrl) : fileStore();
