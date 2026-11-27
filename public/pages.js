// Privacy, terms and feedback pages: the phone menu, and the right menu for whoever is here.
// Visitors see Home and the demo; someone signed in (or in the demo) sees the app's screens.

const $ = (id) => document.getElementById(id);

function setMenu(open) {
  $('app-shell').classList.toggle('nav-open', open);
  $('app-menu').setAttribute('aria-expanded', String(open));
  $('app-backdrop').hidden = !open;
}
$('app-menu').addEventListener('click', () => setMenu(!$('app-shell').classList.contains('nav-open')));
$('app-backdrop').addEventListener('click', () => setMenu(false));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') setMenu(false); });

try {
  const session = await (await fetch('/api/session')).json();
  if (session.connected) {
    const name = session.demo ? 'Demo workspace' : session.account?.name || 'Your account';
    for (const item of document.querySelectorAll('[data-signed-in]')) item.hidden = false;
    for (const item of document.querySelectorAll('[data-signed-out]')) item.hidden = true;
    for (const logo of document.querySelectorAll('a.wordmark')) {
      logo.href = '/?app';
      logo.setAttribute('aria-label', 'Dashboard');
    }
    $('side-name').textContent = name;
    $('side-initial').textContent = name[0].toUpperCase();
  }
} catch {
  // Offline or signed out: the visitor's menu is already showing.
}
