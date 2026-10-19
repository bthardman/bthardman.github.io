# Bandcamp wishlist -> genre playlists

Two parts:

1. `bandcamp-wishlist-export.user.js` - a Tampermonkey/Violentmonkey userscript. On your Bandcamp wishlist page it adds an **Export wishlist + genres** button. It lists every item, reads each release's tags (falling back to the parent album's tags for sparsely tagged tracks), looks the release up on Beatport for its genre, and downloads `wishlist.json`.
2. `index.html` - a static page that reads `wishlist.json` and groups releases by genre. Click a release to play it in the Bandcamp embedded player; Prev/Next steps through the current genre.

## Setup

1. Install Tampermonkey (or Violentmonkey) in your browser.
2. Create a new userscript and paste in `bandcamp-wishlist-export.user.js`. Save.
3. Open `https://bandcamp.com/<your-username>/wishlist` while logged in, click the blue button (bottom right), and wait. Bandcamp pages are fetched 3 at a time, then Beatport is searched 2 at a time, with short pauses, so a few hundred items take several minutes. Throttled requests are retried with backoff. Results are cached, so re-runs only fetch new or previously failed items (Beatport misses are re-checked after 30 days). Before fetching, the script also loads your published `wishlist.json` (`PREVIOUS_EXPORT_URL` at the top of the script) and reuses every item already in it, so a reinstalled script or a different browser doesn't start from scratch. Exports from older versions of the script only contribute items that have tags; new exports carry everything needed to be reused completely. The first time, Tampermonkey asks to allow requests to `beatport.com`; choose *Always allow domain*. Set `USE_BEATPORT = false` at the top of the script to skip Beatport.
4. Your browser downloads `wishlist.json`.

## Publish on GitHub Pages

1. Create a new GitHub repo (e.g. `bc-wishlist`).
2. Upload `index.html` and `wishlist.json` to the repo root.
3. Repo Settings -> Pages -> Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.
4. After a minute it is live at `https://<you>.github.io/bc-wishlist/`.

To update later: re-run the export, upload the new `wishlist.json` over the old one.

Note: a GitHub Pages site on a free account is public. Bandcamp wishlists are public by default anyway, but if yours is private, use a private-repo Pages plan or just open `index.html` locally and drop `wishlist.json` onto it.

## Tuning genres

Edit `GENRE_GROUPS` and `BEATPORT` at the top of the script in `index.html`. A matched Beatport genre decides the primary genre via `BEATPORT` (generic ones like *Dance / Pop* and *Electronica* are mapped to `null` and ignored). Otherwise `GENRE_GROUPS` is used: it is ordered most-specific to most-generic, and a release's primary genre is the first group any of its tags match. The "Most common tags not matched" panel at the bottom of the page shows what to add. Tick "List in every matching genre" to show a release under all of its genres instead of just one.

## Limits

- Beatport matching is by artist + title (or catalog number / ISRC when available) against Beatport's public search page. Releases that aren't on Beatport, or are titled very differently, fall back to Bandcamp tags. Beatport genres are chosen by the label, so they are occasionally odd.
- Bandcamp has no official wishlist API. The exporter reads data the wishlist page already embeds and an internal endpoint the page itself uses, so a Bandcamp change could break it.
- Bandcamp embeds can't be chained into one continuous playlist, so playback does not auto-advance to the next release. Use Next, or let an album play through on its own.
- Unpurchased tracks hit Bandcamp's per-track play limit for fan accounts.
