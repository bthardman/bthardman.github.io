# Bandcamp wishlist -> genre playlists

Three parts:

1. `bandcamp-wishlist-export.user.js` - a Tampermonkey/Violentmonkey userscript. On any Bandcamp wishlist page it adds an **Export wishlist + genres** button. For every item it collects Bandcamp's tags, the release's Beatport genre and its Discogs styles, then downloads `<username>.json`.
2. `index.html` - a static page that groups releases by genre. Its start page lists every wishlist in `WISHLISTS`; `/<username>` (e.g. `https://bthardman.github.io/indent_uk`) opens one directly. Click a release to play it in the Bandcamp embedded player; Prev/Next steps through the current genre.
3. `wishlists/<username>.json` - one export per person, plus optional `wishlists/<username>.overrides.json` with genres set by hand. `404.html` makes the `/<username>` addresses work on GitHub Pages, which has no routing of its own.

## Setup

1. Install Tampermonkey (or Violentmonkey) in your browser.
2. Open <https://bthardman.github.io/bandcamp-wishlist-export.user.js> and click **Install**. Tampermonkey then updates the script from that address by itself. When you change the script, bump its `@version`, or installed copies won't pick up the change.
3. Open `https://bandcamp.com/<username>/wishlist` and click the blue button (bottom right). This works on anyone's public wishlist; a hidden wishlist (like your own when logged out) only works while you're logged in as its owner.
4. The first time, it asks for a **Discogs personal access token** (optional): create one at discogs.com -> Settings -> Developers -> *Generate new token* and paste it in. It is kept in Tampermonkey's storage in your browser, never in the script file, since that file is published. Shift-click the button to change it later.
5. Tampermonkey asks to allow requests to `beatport.com`, `api.discogs.com` and `bthardman.github.io`; choose *Always allow domain*.
6. Your browser downloads `<username>.json`.

The button shows progress for each stage:

| Stage | Source | Speed |
|---|---|---|
| Bandcamp tags | Bandcamp's app API (JSON, ~4 KB per release; falls back to the release page) | up to 4 a second, until Bandcamp's limit (see below) |
| Beatport | Beatport's search page | 2 at a time |
| Discogs | Discogs API | one at a time, 60/min with a token (25/min without) |

Throttled requests are retried with backoff (at most 30 s between tries). A release that has been removed from Bandcamp is skipped straight away.

Bandcamp lets a burst of roughly 140 requests through and then refuses them for a while. When that happens:
- The script slows down once, to a bit under the rate that tripped the limit.
- While Bandcamp is refusing, a single request checks every 5, 10, 20… s (up to a minute). The button counts down meanwhile, so it doesn't look stuck.
- Once requests go through again, it speeds up gently, but never back to the speed that tripped the limit.
- The learned speed is saved, so the next run starts there.

The browser console logs each limit (`[wishlist-export] Bandcamp limit hit…`). Set `USE_BEATPORT` or `USE_DISCOGS` to `false` at the top of the script to skip a source.

Since version 3.1 the export also records each release's date, price (the minimum, for name-your-price) and whether it is a pre-order or a free download. The page then shows them on the cards and offers "Release date" and "Price" sorts. Prices are in each label's own currency, so the price sorts compare them at Bandcamp's exchange rates. Exporter 3.3 and later save the rates of the day with the export; older exports use rates built into the page. For name-your-price releases the sorts use the minimum price. Each wishlist needs one re-export to pick these up. That run re-reads every release through Bandcamp's app API, which takes about 5 minutes per wishlist.

### Re-runs only fetch what's new

Results are cached per release in Tampermonkey's storage, so re-runs only fetch new or previously failed items. "Not found" results on Beatport or Discogs are re-checked after 30 days, and Beatport misses are also re-checked once whenever the matcher improves (`BP_MATCHER_VERSION`). Before fetching, the script also loads that user's published export (`PREVIOUS_EXPORT_URL`, `https://bthardman.github.io/wishlists/{user}.json`) and reuses every item already in it, so a reinstalled script or a different browser doesn't start from scratch. When a new script version needs more from Bandcamp (`BC_INFO_VERSION`), the first run after upgrading re-reads every item through the app API. Later runs only handle new items.

## Publish on GitHub Pages

1. Put the export in `wishlists/` (e.g. `wishlists/yu_vanessa.json`), commit and push.
2. For a new person, also add them to `WISHLISTS` at the top of the script in `index.html` (username and display name), so they appear on the start page, and save their Bandcamp profile photo as `avatars/<username>.jpg`. Without a photo the page shows the first letter of their name.
3. Repo Settings -> Pages -> Source: *Deploy from a branch*, branch `main`, folder `/ (root)`.

To update later: re-run the export and replace that person's file in `wishlists/`.

Note: a GitHub Pages site on a free account is public. Bandcamp wishlists are public by default anyway.

## How a release's genre is chosen

Every piece of evidence adds weight to a genre group (all set in `WEIGHTS` in `index.html`):

| Evidence | Weight | Why |
|---|---|---|
| Discogs style | 3 for the first, 2 for others | curated per release |
| Beatport genre | 2.5 (1.2 for the catch-alls *Bass / Club* and *Techno (Raw / Deep / Hypnotic)*), once per group even when a genre and its sub-genre both point there | set per track by the label |
| Bandcamp tag | 1 (1.5 for multi-word tags like "dub techno", 0.4 for broad ones like "bass" or "club") | set by the uploader |

- **Label-wide tags count less.** A tag that a label puts on at least 80% of its releases in the wishlist (labels with 3+) counts half, which stops cases like Ilian Tape tagging every release "drum & bass".
- **A tag counts towards its most specific group.** "dub techno" goes to Dub Techno, not Techno too. Case, accents and hyphens are ignored, so "uk-funky" matches "uk funky" and "Musique Concrète" matches "musique concrete".
- **Families.** Groups that are sub-genres of each other share a `family` (Techno: Dub Techno, Deep / Hypnotic, Techno; Bass: Dubstep / 140, UK Garage, Breaks, Bass / Club). The family with the most evidence wins, then the best group inside it. The family's `generic` group (Techno, Bass / Club) only wins if the specific ones have little evidence.

Hover or tap a card's genre to see the top three scores and what contributed to each. To tune, edit `GENRE_GROUPS`, `WEIGHTS`, `BEATPORT` and `DISCOGS` at the top of the script. The "Most common tags that match no genre" panel at the bottom counts, across every release, the tags, Beatport genres and Discogs styles that map to no group, such as rave, acid and tribal. Tick "Show in every matching genre" to also list a release under groups scoring at least 40% of its best.

## Using the page

- **Search** matches title, artist, label, tags and genres. Click an artist, label or tag on a card to list everything with exactly that; the search box shows it as `artist:…`, `label:"…"` or `tag:"…"`, and you can combine these with free text, e.g. `label:"Livity Sound" dub`.
- **Sorting.** Pick a sort, then use the button beside it to flip the order: newest/oldest first, low/high price, A to Z / Z to A. Releases without a date or price stay at the end either way.
- **Heard.** A release counts as heard once it has been in the player for 15 seconds, or when you tick ✓ on its cover. Heard cards are dimmed, and "Hide heard" takes them out of the list and out of Prev/Next.
- **New.** Releases that weren't in the export your browser saw last time get a "New" badge and a "New" entry at the top of the genre list. They stay new until the next export, or until you press "Mark all seen".
- **Shared.** Releases that are also on another wishlist on the site show that person's photo, and are listed under "Shared".
- **Owned by others.** Releases another person here has already bought show their photo ringed in amber, and are listed under "Owned by others". Buying a track's whole album counts too.
  - This needs that person's export from exporter 3.4 or later, which also lists their collection. Only the list is read, about one request per 100 purchases, with no lookups.
  - A private collection is only listed when the export is run logged in as its owner.
- Heard, new and hand-set genres are kept per wishlist in your browser.
- The start page shows each person's five main genres and how many releases they have in common with the others.
- On a phone the player sits at the bottom of the screen and the controls scroll away.

## Fixing genres by hand

Click ✎ on a card and pick a genre (or *Automatic* to go back to the score). Hand-set genres show in amber and are saved in your browser straight away. To make them permanent and visible on other devices, click **Export overrides** in the header and commit the downloaded `<username>.overrides.json` to `wishlists/`. The page merges that file with any newer picks made in the browser.

## Viewing locally

Opened straight from disk (`file:///...`), the browser won't let the page read the files in `wishlists/`, so it asks you to pick or drop one instead. To have it load automatically, serve the folder and open `http://localhost:3000`:

```
npx serve .
```

## Limits

- When the normal searches find nothing, both Beatport and Discogs try **artist-first**: find the artist, scan their own releases (Beatport: their 150 most recent tracks; Discogs: their release list), and match titles more loosely. One title can contain the other ("Feels So Gud" in "Feels So Gud EP"), and filler words, numbers and the artist's own name don't count ("Vol. 2" never matches "Vol. 3"). Earlier "not found" results are re-checked once with only this step.
- Beatport matching is by artist + title, catalogue number, label and (for albums) tracklist against Beatport's public search page. Many self-released EPs, edits, bootlegs and compilations simply aren't on Beatport.
- Discogs mostly catalogues physical releases, so digital-only releases are often missing there too. Results are checked against artist, title, label and catalogue number before being used.
- Bandcamp has no official wishlist API. The exporter reads data the wishlist page already embeds, the endpoint the page uses for "view all", and the endpoint Bandcamp's mobile app uses, so a Bandcamp change could break it.
- Bandcamp embeds can't be chained into one continuous playlist, so playback does not auto-advance to the next release. Use Next, or let an album play through on its own.
- Unpurchased tracks hit Bandcamp's per-track play limit for fan accounts.
- On GitHub Pages, `/<username>` is served by `404.html` with a 404 status before redirecting. Browsers don't mind, but link previews in chat apps may show "not found".
