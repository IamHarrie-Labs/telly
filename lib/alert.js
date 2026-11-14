import { config } from './config.js';

// One JSON line per event, so Vercel's log search can filter by name.
export const log = (event, fields = {}) => console.error(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

// Sends an alert to the webhook in ALERT_WEBHOOK_URL (Slack and Discord both accept this
// shape), at most once every ten minutes per kind of problem on each server instance, so a
// bad deploy produces a handful of messages rather than thousands.
const lastSent = new Map();
const QUIET_MS = 10 * 60 * 1000;

export async function alert(event, fields = {}) {
  log(event, fields);
  if (!config.alertWebhook) return;
  const now = Date.now();
  if (now - (lastSent.get(event) || 0) < QUIET_MS) return;
  lastSent.set(event, now);
  const detail = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${String(v).slice(0, 300)}`)
    .join('\n');
  const text = `Telly alert: ${event}${detail ? `\n${detail}` : ''}`;
  try {
    await fetch(config.alertWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text.slice(0, 1900) }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    log('alert_send_failed', { message: error.message });
  }
}
