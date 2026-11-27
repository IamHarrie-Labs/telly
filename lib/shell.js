// The frame around the pages the server writes (event pages, missing pages): the same side menu
// as the app and the privacy pages. public/pages.js runs the phone menu and swaps in the app's
// screens for someone who is signed in.

const MARK = '<svg class="wordmark-mark" viewBox="0 0 28 20" aria-hidden="true"><rect x="0" y="7" width="2" height="6" rx="1" /><rect x="4" y="3" width="2" height="14" rx="1" /><rect x="8" y="0" width="2" height="20" rx="1" /><rect x="12" y="5" width="2" height="10" rx="1" /><rect x="16" y="2" width="2" height="16" rx="1" /><rect x="20" y="6" width="2" height="8" rx="1" /><rect x="24" y="8" width="2" height="4" rx="1" /></svg>';
const LOGO = `<a href="/?home" class="wordmark" aria-label="Telly home page">${MARK}<span>Telly</span></a>`;

const icon = (d) => `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="${d}" /></svg>`;
const ICONS = {
  home: 'M3 9l7-6 7 6M5 8v9h10V8',
  play: 'M6 4l10 6-10 6z',
  grid: 'M3 3h6v6H3zM11 3h6v6h-6zM3 11h6v6H3zM11 11h6v6h-6z',
  list: 'M4 5h12M4 10h12M4 15h8',
  clock: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 6v4l3 2',
  cal: 'M3 5h14v12H3zM3 9h14M7 3v4M13 3v4',
  eye: 'M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5zM10 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  chat: 'M3 4h14v10H8l-5 3z',
  gear: 'M3 6h8M15 6h2M3 14h2M9 14h8M13 4v4M7 12v4',
  shield: 'M10 3 4 5v5c0 4 6 7 6 7s6-3 6-7V5z',
  doc: 'M5 3h7l3 3v11H5zM8 10h4M8 13h4',
  menu: 'M3 6h14M3 10h14M3 14h14',
};

const visitor = (href, name, label) => `<a class="side-link" href="${href}" data-signed-out>${icon(ICONS[name])}${label}</a>`;
const member = (href, name, label) => `<a class="side-link" href="${href}" data-signed-in hidden>${icon(ICONS[name])}${label}</a>`;
const anyone = (href, name, label) => `<a class="side-link" href="${href}">${icon(ICONS[name])}${label}</a>`;

/** A full page. `head` and `main` are HTML the caller has already escaped. */
export function shellPage({ head, main }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${head}
<meta name="robots" content="noindex">
<meta name="theme-color" content="#1a1915">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/favicon.ico">
</head>
<body data-mode="app" class="doc-page">
<a class="skip-link" href="#main">Skip to content</a>
<div id="app-shell" class="app-shell app">
<div class="app-top">
${LOGO}
<button id="app-menu" type="button" class="app-menu" aria-expanded="false" aria-controls="app-side">${icon(ICONS.menu)}Menu</button>
</div>
<div id="app-backdrop" class="app-backdrop" hidden></div>
<aside id="app-side" class="app-side" aria-label="Menu">
${LOGO}
<nav class="side-nav" aria-label="Pages">
${visitor('/?home', 'home', 'Home')}
${visitor('/demo', 'play', 'Try the demo')}
${member('/?app', 'grid', 'Dashboard')}
${member('/?app#list', 'list', 'Campaigns')}
${member('/?app#posts', 'clock', 'Scheduled posts')}
${member('/?app#calendar', 'cal', 'Calendar')}
${member('/?app#watch', 'eye', 'Watching')}
${anyone('/feedback', 'chat', 'Feedback')}
${member('/?app#settings', 'gear', 'Settings')}
<span class="side-rule" aria-hidden="true"></span>
${anyone('/privacy', 'shield', 'Privacy')}
${anyone('/terms', 'doc', 'Terms')}
</nav>
<div class="side-foot">
<a class="side-account" href="/?app#settings" data-signed-in hidden><span id="side-initial" class="side-initial" aria-hidden="true"></span><span class="side-who"><span id="side-name"></span><span id="side-org" class="side-org" hidden></span></span></a>
<a class="side-buffer" href="/auth/login" data-signed-out><span>Connect Buffer</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 8.5 8.5 3.5M4.5 3.5h4v4" /></svg></a>
</div>
</aside>
<main class="app-main" id="main">
<div class="view">
${main}
</div>
</main>
</div>
<script src="/pages.js" type="module"></script>
</body>
</html>`;
}
