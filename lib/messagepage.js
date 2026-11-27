// A short page for dead ends (missing pages, a sign-in that couldn't finish), in the same
// style as the rest of Telly. Only fixed text from the server goes in here.

const MARK = '<svg class="wordmark-mark" viewBox="0 0 28 20" aria-hidden="true"><rect x="0" y="7" width="2" height="6" rx="1" /><rect x="4" y="3" width="2" height="14" rx="1" /><rect x="8" y="0" width="2" height="20" rx="1" /><rect x="12" y="5" width="2" height="10" rx="1" /><rect x="16" y="2" width="2" height="16" rx="1" /><rect x="20" y="6" width="2" height="8" rx="1" /><rect x="24" y="8" width="2" height="4" rx="1" /></svg>';

export function messagePage(title, text) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Telly</title>
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/favicon.ico">
</head>
<body class="msg-page">
<main class="msg">
<a href="/?home" class="wordmark" aria-label="Telly home page">${MARK}<span>Telly</span></a>
<h1>${title}</h1>
<p>${text}</p>
<a class="msg-action" href="/">Go to Telly</a>
</main>
</body>
</html>`;
}
