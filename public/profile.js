// Who is signed in, as the sidebar and the greeting show it.
// Buffer's account name is often a username ("sam_events01"), which reads badly in a greeting,
// so people can tell Telly what to call them. That choice stays in this browser only.

const NAME_KEY = (accountId) => `telly-name:${accountId}`;
const PROFILE_KEY = 'telly-profile';

const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Private browsing: the choice just doesn't stick.
  }
};

/** The name someone chose in Settings, if any. */
export const chosenName = (accountId) => (accountId ? read(NAME_KEY(accountId)) || '' : '');
export const saveChosenName = (accountId, name) => write(NAME_KEY(accountId), String(name || '').trim().slice(0, 40));

/** A username or an email address, rather than a person's name. */
export function looksLikeHandle(name) {
  const text = String(name || '').trim();
  if (!text) return true;
  if (/\s/.test(text)) return false;
  return /[\d_.@]/.test(text) || text === text.toLowerCase();
}

/** The name to greet someone by, or '' when there's nothing friendly to use. */
export function greetingName(accountName, chosen) {
  if (chosen) return chosen.split(/\s+/)[0];
  const full = String(accountName || '').trim();
  if (/\s/.test(full)) return full.split(/\s+/)[0];
  return looksLikeHandle(full) ? '' : full;
}

export function greeting(name, now = new Date()) {
  const hour = now.getHours();
  const part = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${part}, ${name}` : part;
}

/** Remembers the avatar and organization so other pages can show them without asking Buffer. */
export function rememberProfile(profile) {
  write(PROFILE_KEY, JSON.stringify(profile));
}
export function recalledProfile() {
  try {
    return JSON.parse(read(PROFILE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

/** Fills the sidebar's account block: picture (or initial), name, organization. */
export function renderProfile({ name, org, avatar }) {
  const label = String(name || 'Your account');
  const initial = document.getElementById('side-initial');
  const nameEl = document.getElementById('side-name');
  const orgEl = document.getElementById('side-org');
  if (nameEl) nameEl.textContent = label;
  if (orgEl) {
    orgEl.textContent = org || '';
    orgEl.hidden = !org;
  }
  if (!initial) return;
  initial.textContent = label[0].toUpperCase();
  if (!avatar || !/^https:\/\//.test(avatar)) return;
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.onload = () => initial.replaceChildren(img);
  img.src = avatar;
}
