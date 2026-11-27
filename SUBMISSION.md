# Telly: submission draft

**App:** https://usetelly.xyz
**Privacy:** https://usetelly.xyz/privacy
**Code:** https://github.com/IamHarrie-Labs/telly
**Client ID:** paste from Buffer → Settings → API → App Clients (it is public, but keep the secret out of here)

## Write-up (about 450 words)

**Telly: tell it once, keep it current.**

If you've promoted an event, you know this one. The venue moves or the start time slips, and three posts are already scheduled with the old details. You dig through the queue, fix one, forget another, and someone turns up at the wrong place.

With Telly you enter the event once (title, date, time, venue, price, booking link) or upload the flyer and let Claude fill the form in for you to check. Telly writes an announcement, a reminder two days out and a post for the day, and schedules them in Buffer on the event's local time. Each post carries an image: a clean event card Telly draws from the details, or your own flyer, both with alt text. Each post also has a Listen button, which is a quick way to catch a clumsy sentence.

When something changes, you edit the event, or just type it the way you'd say it ("moved to Friday at 8, same place") and Telly turns that into the edit for you to check. Telly fetches each scheduled post from Buffer and shows the old line crossed out above the new one. If the date moved, the posting times move with it, and the event card is redrawn. If you rewrote a post yourself in Buffer, Telly asks whether to keep your version or use the correction. Posts that already went out get suggested follow-up wording. Mark the event sold out or postponed and the posts say so; cancel it and whatever hasn't gone out is deleted. Every change is kept in a history, and a change that hasn't been posted yet can be undone.

Telly fetches the posts again after every change, so when it says "2 updated · 1 needs review", that's what Buffer holds. The campaign list runs the same check whenever you open it. Turn on watching and Telly keeps checking while you're away, then flags on your dashboard if a post failed to publish or the queue is paused.

The posts link to an event page that always shows the latest details, even for posts that went out last week, with a calendar entry that updates itself when the event moves. Running it again? Repeat the event and start from a copy a week later. Campaigns are shared with everyone in your Buffer organization, and the wording can be saved to Buffer as ideas for posts Telly doesn't schedule (and the details as a snippet, on Buffer plans that include snippets).

No Buffer account? usetelly.xyz/demo runs the whole thing on a practice queue.

**Built on the Buffer API:** OAuth 2.0 with PKCE and rotating refresh tokens; `account` and `channels` to pick where to post; `createPost` with a custom schedule and image assets with alt text; `post` to fetch each post back; `editPost` for text, images, and time only when the time changed; `deletePost` for cancellations; `createIdea`, `createSnippet` and `updateSnippet` for Save to Buffer. Sign-in tokens stay in an encrypted cookie in the browser; only if you turn watching on are they also stored, encrypted, in the database, and they're removed when you turn it off. The code is public at https://github.com/IamHarrie-Labs/telly.

## Demo video plan (under 2 minutes)

1. 0:00–0:10: the problem, with one line on screen: "The venue changed. Three posts are already scheduled."
2. 0:10–0:30: connect Buffer, enter the details, preview the three posts with the event card, press Listen on one.
3. 0:30–0:42: schedule, then show the posts sitting in the Buffer queue.
4. 0:42–0:52: edit the reminder by hand in Buffer, as a real organiser would.
5. 0:52–1:20: type "moved to Friday at 8, same place" into Tell Telly what changed. Show the review: two "Will update" posts and one "You edited this" post, and the new card. Choose Keep mine, then apply. Show Buffer updated.
6. 1:20–1:35: open the event page from a post; it already shows Friday, with the calendar entry.
7. 1:35–1:50: cancel the event. The posts that hadn't gone out are removed from Buffer.
8. 1:50–2:00: "Telly. Tell it once. Keep it current."
