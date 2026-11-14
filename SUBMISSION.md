# Telly: submission draft

**App:** https://usetelly.xyz
**Privacy:** https://usetelly.xyz/privacy.html
**Client ID:** paste from Buffer → Settings → API → App Clients (it is public, but keep the secret out of here)

## Write-up (about 300 words)

**Telly: tell it once, keep it current.**

If you've promoted an event, you know this one. The venue moves or the start time slips, and three posts are already scheduled with the old details. You dig through the queue, fix one, forget another, and someone turns up at the wrong place.

With Telly you enter the event once (title, date, time, venue, price, booking link) or upload the flyer and let Claude fill the form in for you to check. Telly writes an announcement, a reminder two days out and a post for the day, and schedules them in Buffer on the event's local time. Each post has a Listen button, which is a quick way to catch a clumsy sentence.

When something changes, you edit the event. Telly fetches each scheduled post from Buffer and shows the old line crossed out above the new one. If the date moved, the posting times move with it. If you rewrote a post yourself in Buffer, Telly spots that and asks whether to keep your version or use the correction. Posts that already went out get flagged with suggested follow-up wording. Cancelling the event deletes whatever hasn't been published.

Telly fetches the posts again after every change, so when it says "2 updated · 1 needs review", that's what Buffer holds. The campaign list runs the same check whenever you open it and shows a badge if a post was edited or deleted in Buffer.

No Buffer account? usetelly.xyz/demo runs the whole thing on a practice queue.

**Built on the Buffer API:** OAuth 2.0 with PKCE and rotating refresh tokens; `account` and `channels` to pick where to post; `createPost` with a custom schedule; `post` to fetch each post back; `editPost` for text, and for time only when the time changed; `deletePost` for cancellations. Sign-in tokens stay in an encrypted cookie in the browser, and the database holds campaign records only.

## Demo video plan (under 2 minutes)

1. 0:00–0:12: the problem, with one line on screen: "The venue changed. Three posts are already scheduled."
2. 0:12–0:35: connect Buffer, enter the details, preview the three posts, press Listen on one.
3. 0:35–0:50: schedule, then show the posts sitting in the Buffer queue.
4. 0:50–1:05: edit the reminder by hand in Buffer, as a real organiser would.
5. 1:05–1:35: change the venue in Telly. Show the review: two "Will update" posts and one "You edited this" post. Choose Keep mine, then apply. The result line appears; show Buffer updated.
6. 1:35–1:50: cancel the event. The posts that hadn't gone out are removed from Buffer.
7. 1:50–2:00: "Telly. Tell it once. Keep it current."
