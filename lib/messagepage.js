// A short page for dead ends (missing pages, a sign-in that couldn't finish), in the same frame
// as the rest of Telly. Only fixed text from the server goes in here.
import { shellPage } from './shell.js';

export function messagePage(title, text) {
  return shellPage({
    head: `<title>${title} · Telly</title>`,
    main: `<header class="page-head"><div><h1>${title}</h1></div></header>
<div class="stack narrow-card">
<section class="dash-card">
<p>${text}</p>
<div class="ev-actions"><a class="ev-button dark" href="/">Go to Telly</a></div>
</section>
</div>`,
  });
}
