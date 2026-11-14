// Runs the end-to-end checks: starts the fake Buffer and a local Telly that talks only to it,
// waits until both answer, runs each flow, then stops everything. Used locally and in CI.
//   node e2e/run.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3100;
const MOCK_PORT = 4010;
const BASE = `http://localhost:${PORT}`;

// A throwaway working copy of the data folder so runs never touch real local data.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telly-e2e-'));

const env = {
  ...process.env,
  TELLY_PLAIN_HTTP: '1',
  PORT: String(PORT),
  MOCK_PORT: String(MOCK_PORT),
  REDIRECT_URI: `${BASE}/callback`,
  BUFFER_CLIENT_ID: 'mock',
  BUFFER_CLIENT_SECRET: 'mock',
  BUFFER_API_URL: `http://localhost:${MOCK_PORT}/`,
  BUFFER_AUTH_URL: `http://localhost:${MOCK_PORT}/auth`,
  BUFFER_TOKEN_URL: `http://localhost:${MOCK_PORT}/token`,
  // Empty values win over .env files, so the run uses the file store and no paid APIs.
  ANTHROPIC_API_KEY: '',
  DATABASE_URL: '',
  POSTGRES_URL: '',
  ALERT_WEBHOOK_URL: '',
  RESEND_API_KEY: '',
  TELLY_DATA_DIR: dataDir,
  TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
  CRON_SECRET: 'e2e-cron-secret-0123456789abcdef',
  RATE_LIMIT_MAX: '100000',
  WATCH_EVERY_MS: '1',
  // Access tokens from the fake Buffer last about a second, so refreshes (and the single-use
  // refresh tokens) are exercised constantly.
  MOCK_TOKEN_TTL: '31',
};

const children = [];
function start(file) {
  const child = spawn(process.execPath, [file], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  child.output = () => output;
  children.push(child);
  return child;
}

async function waitFor(url, label) {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`${label} did not start`);
}

function stopAll() {
  for (const child of children) child.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

let failed = false;
try {
  start('scripts/mock-buffer.js');
  const telly = start('server.js');
  await waitFor(`http://localhost:${MOCK_PORT}/health`, 'Fake Buffer');
  await waitFor(`${BASE}/api/health`, 'Telly').catch((error) => {
    console.error(telly.output());
    throw error;
  });

  for (const flow of ['buffer-flow.mjs', 'demo-flow.mjs', 'watch-flow.mjs']) {
    console.log(`\n== ${flow}`);
    const code = await new Promise((resolve) => {
      const run = spawn(process.execPath, [path.join('e2e', flow)], { cwd: root, env: { ...env, BASE }, stdio: 'inherit' });
      run.on('exit', resolve);
    });
    if (code !== 0) failed = true;
  }
  if (failed) console.error(`\n-- Telly server output --\n${telly.output()}`);
} catch (error) {
  console.error(error.message);
  failed = true;
} finally {
  stopAll();
}
process.exit(failed ? 1 : 0);
