// ==UserScript==
// @name         Bandcamp Wishlist Genre Exporter
// @namespace    local.bc-wishlist
// @version      2.0.0
// @description  Adds an "Export wishlist" button to your Bandcamp wishlist page. Collects every item, its Bandcamp tags and (optionally) its Beatport genre, and downloads wishlist.json.
// @match        https://bandcamp.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      bandcamp.com
// @connect      www.beatport.com
// @connect      bthardman.github.io
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const BC_CONCURRENCY = 3;     // parallel Bandcamp page requests
  const BP_CONCURRENCY = 2;     // parallel Beatport searches
  const DELAY_MS = 300;         // pause after each request (be polite)
  const USE_BEATPORT = true;    // look each release up on Beatport for a cleaner genre
  const BP_MISS_TTL_DAYS = 30;  // re-try Beatport "no match" results after this long
  const CACHE_KEY = 'tagCacheV2'; // V1 cached failed fetches as [] forever, so it is not reused
  // Your published wishlist.json. Items already in it are not fetched again. '' to disable.
  const PREVIOUS_EXPORT_URL = 'https://bthardman.github.io/wishlist.json';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function readBlob() {
    const el = document.querySelector('#pagedata');
    if (!el) return null;
    try { return JSON.parse(el.getAttribute('data-blob')); } catch (e) { return null; }
  }

  function normItem(raw) {
    if (!raw) return null;
    if (raw.item_type && !['album', 'track'].includes(raw.item_type)) return null; // skip merch
    const type = raw.tralbum_type || (raw.item_type === 'track' ? 't' : 'a');
    if (type !== 'a' && type !== 't') return null;
    const id = raw.tralbum_id || raw.item_id;
    if (!id) return null;
    let url = raw.item_url || raw.url || '';
    if (url.startsWith('//')) url = 'https:' + url;
    let art = raw.item_art_url || '';
    if (!art && raw.item_art_id) art = 'https://f4.bcbits.com/img/a' + raw.item_art_id + '_9.jpg';
    return {
      key: type + id,
      id: Number(id),
      type,
      title: raw.item_title || raw.album_title || '',
      artist: raw.band_name || '',
      url,
      art,
      tags: [],
      beatport: null,
    };
  }

  async function collectWishlist(blob, onProgress) {
    const fanId = blob.fan_data && blob.fan_data.fan_id;
    const wl = blob.wishlist_data || {};
    const map = new Map();

    const cached = (blob.item_cache && blob.item_cache.wishlist) || {};
    for (const raw of Object.values(cached)) {
      const it = normItem(raw);
      if (it) map.set(it.key, it);
    }

    let token = wl.last_token;
    let more = (wl.item_count || 0) > map.size;
    while (more && token) {
      const res = await fetch('https://bandcamp.com/api/fancollection/1/wishlist_items', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fan_id: fanId, older_than_token: token, count: 100 }),
      });
      if (!res.ok) throw new Error('Wishlist API returned HTTP ' + res.status);
      const data = await res.json();
      const before = map.size;
      for (const raw of data.items || []) {
        const it = normItem(raw);
        if (it) map.set(it.key, it);
      }
      onProgress('Listing wishlist… ' + map.size + (wl.item_count ? '/' + wl.item_count : ''));
      more = !!data.more_available && map.size > before;
      token = data.last_token;
    }
    return [...map.values()];
  }

  /* ---- HTTP -------------------------------------------------------------- */

  class HttpError extends Error {
    constructor(status, retryAfter) { super('HTTP ' + status); this.status = status; this.retryAfter = retryAfter; }
  }

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 30000,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) return resolve(r.responseText);
          const m = /retry-after:\s*(\d+)/i.exec(r.responseHeaders || '');
          reject(new HttpError(r.status, m ? Number(m[1]) : 0));
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  // Fetches url and runs parse(html). parse returns null when the page is not
  // what we expected (a rate-limit or challenge page served with HTTP 200), which
  // is retried like a 429. 404/410 are final and resolve to null.
  async function fetchParsed(url, parse, attempts = 4) {
    for (let a = 1; ; a++) {
      try {
        const out = parse(await gmGet(url));
        if (out) return out;
        throw new Error('unexpected page content');
      } catch (e) {
        if (e.status === 404 || e.status === 410) return null;
        if (a >= attempts || (e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 403)) throw e;
        await sleep(e.retryAfter ? e.retryAfter * 1000 : 2000 * 3 ** (a - 1)); // 2s, 6s, 18s
      }
    }
  }

  // Runs fn over items with a fixed number of workers.
  async function pool(items, concurrency, fn) {
    let i = 0;
    async function worker() {
      while (i < items.length) {
        await fn(items[i++]);
        await sleep(DELAY_MS);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  /* ---- Bandcamp page parsing -------------------------------------------- */

  const ISRC_RE = /^[a-z]{2}[a-z0-9]{3}\d{7}$/i;

  function ldJson(doc) {
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        let j = JSON.parse(s.textContent);
        if (Array.isArray(j)) j = j[0];
        const t = [].concat(j && j['@type']);
        if (t.includes('MusicAlbum') || t.includes('MusicRecording')) return j;
      } catch (e) { /* try next */ }
    }
    return null;
  }

  // Returns { tags, artist, label, album, albumUrl, isrc } or null if this is
  // not a release page.
  function parseBandcamp(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ld = ldJson(doc);
    if (!ld) return null;

    const pub = ld.publisher || {};
    const location = (pub.foundingLocation && pub.foundingLocation.name) ||
      ((doc.querySelector('#band-name-location .location, span.location') || {}).textContent || '');
    const locParts = new Set(location.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
    locParts.add([...locParts].join(' ')); // "London, UK" is also tagged "london uk"

    let raw = [...doc.querySelectorAll('.tralbum-tags a.tag')].map((a) => a.textContent);
    const kw = Array.isArray(ld.keywords) ? ld.keywords : String(ld.keywords || '').split(',');
    if (!raw.length) raw = kw;

    const album = ld.inAlbum || {};
    return {
      tags: cleanTags(raw, locParts),
      artist: (ld.byArtist && ld.byArtist.name) || '',
      label: pub.name || '',
      album: album.name || '',
      albumUrl: album['@id'] || '',
      // Keywords repeat the tags plus the artist's location and sometimes an ISRC.
      isrc: findIsrc(kw),
    };
  }

  const findIsrc = (tags) => (tags.map((t) => String(t).trim()).find((t) => ISRC_RE.test(t)) || '').toUpperCase();

  function cleanTags(raw, locParts = new Set()) {
    const tags = [];
    for (let t of raw) {
      t = String(t).trim().replace(/^#+/, '').toLowerCase();
      if (!t || ISRC_RE.test(t) || locParts.has(t) || tags.includes(t)) continue;
      tags.push(t);
    }
    return tags;
  }

  /* ---- Beatport lookup --------------------------------------------------- */

  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/&/g, ' and ').replace(/[_/]/g, ' ').replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }

  const CAT_RE = /^\s*\[?([a-z]{2,6}[ :.-]?\d{1,4}(?:\.\d+)?)\]?\s*(?:[-–—:|]\s*|\s+(?=\S))/i;
  const FORMAT_RE = /[\s([-]*\b(e\.?p|l\.?p|album|single|remixes|remixed|vinyl)\b\.?[)\]]?\s*$/i;

  // "IT078 - Sequence EP [feat. X]" -> { title: "Sequence", cat: "it078" }
  function cleanTitle(title) {
    let t = String(title || '');
    let cat = '';
    const m = CAT_RE.exec(t);
    if (m && /\d/.test(m[1]) && t.length > m[0].length) { cat = norm(m[1]).replace(/ /g, ''); t = t.slice(m[0].length); }
    const bracketCat = /\[([a-z]{2,6}[ :.-]?\d{1,4})\]\s*$/i.exec(t);
    if (bracketCat) { cat = cat || norm(bracketCat[1]).replace(/ /g, ''); t = t.slice(0, bracketCat.index); }
    t = t.replace(/\s*[([](?:feat|ft|incl|inc)\.?[^)\]]*[)\]]/gi, '');
    for (let k = 0; k < 2; k++) t = t.replace(FORMAT_RE, '');
    return { title: t.trim() || String(title || '').trim(), cat };
  }

  function words(s) { return norm(s).split(' ').filter((w) => w && w !== 'the' && w !== 'and'); }

  function dice(a, b) {
    const A = words(a), B = words(b);
    if (!A.length || !B.length) return 0;
    const setB = new Set(B);
    const hit = A.filter((w) => setB.has(w)).length;
    return (2 * hit) / (A.length + B.length);
  }

  function splitArtists(s) {
    return String(s || '').split(/\s*(?:,|&|\band\b|\bx\b|\bvs\.?|\bfeat\.?|\bft\.?|\bpresents\b|\bmeets\b|\/)\s*/i)
      .map(norm).filter(Boolean);
  }

  function artistMatch(bcArtists, bpNames) {
    const bp = bpNames.flatMap(splitArtists);
    for (const a of bcArtists) {
      for (const b of bp) {
        if (a === b || dice(a, b) >= 0.67) return true;
        if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
      }
    }
    return false;
  }

  function bpSearchData(html) {
    const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) return null;
    try {
      const qs = JSON.parse(m[1]).props.pageProps.dehydratedState.queries;
      const q = qs.find((x) => x.state && x.state.data && (x.state.data.tracks || x.state.data.releases));
      if (!q) return { tracks: [], releases: [] };
      const d = q.state.data;
      const list = (x) => (x ? (Array.isArray(x) ? x : x.data || []) : []);
      return { tracks: list(d.tracks), releases: list(d.releases) };
    } catch (e) { return null; }
  }

  const slug = (s) => norm(s).replace(/ /g, '-') || 'x';
  const genreNames = (o) => [].concat(o.genre || [], o.sub_genre || []).map((g) => g.genre_name || g.sub_genre_name || g.name).filter(Boolean);

  const VARIOUS = new Set(['v a', 'va', 'various artists', 'various']);

  // Who and what to look for. Label and V/A accounts title releases
  // "Artist - Title (Remix)", so the left side of a dash is a candidate artist.
  // The wishlist's band_name comes before ld+json byArtist, which is often the label.
  function describe(it, info) {
    const { title: full, cat } = cleanTitle(it.title);
    const dash = /^(.+?)\s+[-–—]\s+(.+)$/.exec(full);
    const titles = dash ? [dash[2], full] : [full];
    const artists = [...new Set([].concat(
      dash ? splitArtists(dash[1]) : [], splitArtists(it.artist), splitArtists(info.artist),
    ))].filter((a) => !VARIOUS.has(a));
    return { titles, artists, cat, album: info.album ? cleanTitle(info.album).title : '' };
  }

  const bestDice = (titles, s) => Math.max(...titles.map((t) => dice(t, s)));

  // Picks the best Beatport hit for a wishlist item, or null.
  function bestMatch(it, info, data) {
    const isTrack = it.type === 't';
    const { titles, artists: bcArtists, cat, album } = describe(it, info);
    const bare = titles.map((t) => t.replace(/\s*[([][^)\]]*[)\]]/g, '')); // without "(X Remix)"
    const label = norm(info.label);

    let best = null;
    const consider = (score, how, genres, url) => {
      if (genres.length && (!best || score > best.score)) best = { score, match: how, genres: [...new Set(genres)], url };
    };

    for (const t of data.tracks) {
      const genres = genreNames(t);
      const url = 'https://www.beatport.com/track/' + slug(t.track_name) + '/' + t.track_id;
      if (info.isrc && t.isrc && t.isrc.toUpperCase() === info.isrc) { consider(100, 'isrc', genres, url); continue; }
      const names = (t.artists || []).concat(t.remixers || []).map((a) => a.artist_name);
      const aOk = artistMatch(bcArtists, names) || (label && t.label && norm(t.label.label_name) === label && bcArtists.length === 0);
      if (!aOk) continue;
      if (isTrack) {
        const mix = t.mix_name && !/^original( mix)?$/i.test(t.mix_name) ? ' ' + t.mix_name : '';
        const s = Math.max(bestDice(titles, t.track_name + mix), bestDice(bare, t.track_name) * 0.9);
        if (s >= 0.6) consider(s * 2, 'track', genres, url);
      } else if (t.release) {
        const s = bestDice(titles, cleanTitle(t.release.release_name).title);
        if (s >= 0.7) consider(s * 1.5, 'release-track', genres,
          'https://www.beatport.com/release/' + slug(t.release.release_name) + '/' + t.release.release_id);
      }
    }

    for (const r of data.releases) {
      const genres = genreNames(r);
      const url = 'https://www.beatport.com/release/' + slug(r.release_name) + '/' + r.release_id;
      const catOk = cat && r.catalog_number && norm(r.catalog_number).replace(/ /g, '') === cat;
      const names = (r.artists || []).map((a) => a.artist_name);
      const aOk = artistMatch(bcArtists, names) || (label && r.label && norm(r.label.label_name) === label);
      if (!aOk && !catOk) continue;
      if (isTrack) {
        // A track whose parent album is this release.
        if (album && dice(album, cleanTitle(r.release_name).title) >= 0.7) consider(1.2, 'album', genres, url);
      } else {
        const s = bestDice(titles, cleanTitle(r.release_name).title);
        if (catOk && (s >= 0.3 || aOk)) consider(3, 'catalog', genres, url);
        else if (aOk && s >= 0.7) consider(s * 2.2, 'release', genres, url);
      }
    }
    return best && { genres: best.genres, url: best.url, match: best.match };
  }

  function bpQueries(it, info) {
    const { titles, artists, cat, album } = describe(it, info);
    const artist = artists[0] || '';
    const q = [];
    if (cat && it.type === 'a') q.push(cat);
    q.push((artist + ' ' + titles[0]).trim());
    if (it.type === 't' && album) q.push((artist + ' ' + album).trim());
    else if (titles.length > 1) q.push(titles[1]);
    return [...new Set(q)].slice(0, 3);
  }

  async function lookupBeatport(it, info) {
    for (const q of bpQueries(it, info)) {
      const data = await fetchParsed('https://www.beatport.com/search?q=' + encodeURIComponent(q), bpSearchData, 3);
      const hit = data && bestMatch(it, info, data);
      if (hit) return hit;
      await sleep(DELAY_MS);
    }
    return null;
  }

  /* ---- Cache ------------------------------------------------------------- */

  function loadCache() {
    try {
      const c = JSON.parse(GM_getValue(CACHE_KEY, '{}'));
      return { bc: c.bc || {}, album: c.album || {}, bp: c.bp || {} };
    } catch (e) { return { bc: {}, album: {}, bp: {} }; }
  }
  function saveCache(c) { GM_setValue(CACHE_KEY, JSON.stringify(c)); }

  // Fills cache gaps from a previous wishlist.json so only new or failed items
  // are fetched again (useful after reinstalling the script or on another
  // browser). Entries already in the local cache win. Returns how many items
  // were reused.
  function seedFromExport(cache, data) {
    let reused = 0;
    for (const it of (data && data.items) || []) {
      if (!it || !it.key || cache.bc[it.key]) continue;
      if (data.version >= 2) {
        // v2 exports mark fetched items with `lookup` (or `gone`).
        if (it.gone) cache.bc[it.key] = { tags: [], gone: true };
        else if (it.lookup) cache.bc[it.key] = Object.assign({ tags: it.tags || [], label: it.label || '' }, it.lookup);
        else continue;
        if (!cache.bp[it.key]) {
          if (it.beatport) cache.bp[it.key] = it.beatport;
          else if (it.bpMiss) cache.bp[it.key] = { miss: true, at: it.bpMiss };
        }
      } else {
        // v1 exports: empty tags meant "fetch failed", so only reuse non-empty
        // ones. Locations can't be stripped (not recorded) but match no genre.
        if (!Array.isArray(it.tags) || !it.tags.length) continue;
        cache.bc[it.key] = { tags: cleanTags(it.tags), isrc: findIsrc(it.tags), seededV1: true };
      }
      reused++;
    }
    return reused;
  }

  // Copies cached results onto the items being exported. The inverse of seedFromExport.
  function applyCache(items, cache) {
    for (const it of items) {
      const info = cache.bc[it.key];
      if (info && info.gone) it.gone = true;
      else if (info) {
        it.tags = info.tags;
        if (info.label) it.label = info.label;
        it.lookup = {};
        for (const k of ['artist', 'album', 'albumUrl', 'isrc']) if (info[k]) it.lookup[k] = info[k];
      }
      const hit = cache.bp[it.key];
      if (hit && !hit.miss) it.beatport = hit;
      else if (hit) it.bpMiss = hit.at;
    }
  }

  async function loadPreviousExport() {
    if (!PREVIOUS_EXPORT_URL) return null;
    try {
      return JSON.parse(await gmGet(PREVIOUS_EXPORT_URL + (PREVIOUS_EXPORT_URL.includes('?') ? '&' : '?') + 't=' + Date.now()));
    } catch (e) {
      console.warn('[wishlist-export] previous export not loaded:', e.message);
      return null;
    }
  }

  /* ---- Enrichment -------------------------------------------------------- */

  // Bandcamp: own tags, plus the parent album's tags for tracks that have few.
  async function fetchAllTags(items, cache, onProgress) {
    const todo = items.filter((it) => it.url && !cache.bc[it.key]);
    let done = 0, failed = 0;
    await pool(todo, BC_CONCURRENCY, async (it) => {
      try {
        const info = await fetchParsed(it.url, parseBandcamp);
        if (info) {
          if (it.type === 't' && info.albumUrl && info.tags.filter((t) => t !== 'electronic').length < 3) {
            let alb = cache.album[info.albumUrl];
            if (!alb) {
              const a = await fetchParsed(info.albumUrl, parseBandcamp).catch(() => null);
              if (a) cache.album[info.albumUrl] = alb = a.tags;
            }
            if (alb) info.tags = [...new Set(info.tags.concat(alb))];
          }
          cache.bc[it.key] = info;
        } else {
          cache.bc[it.key] = { tags: [], gone: true };
        }
      } catch (e) {
        failed++;
        console.warn('[wishlist-export] Bandcamp failed for', it.url, e.message);
      }
      done++;
      onProgress('Bandcamp tags… ' + done + '/' + todo.length + (failed ? ' (' + failed + ' failed)' : ''));
      if (done % 20 === 0) saveCache(cache);
    });
    saveCache(cache);
    return failed;
  }

  async function fetchAllBeatport(items, cache, onProgress) {
    const stale = Date.now() - BP_MISS_TTL_DAYS * 864e5;
    const todo = items.filter((it) => {
      const c = cache.bp[it.key];
      return cache.bc[it.key] && !cache.bc[it.key].gone && (!c || (c.miss && c.at < stale));
    });
    let done = 0, failed = 0, found = 0, blockedRun = 0;
    await pool(todo, BP_CONCURRENCY, async (it) => {
      if (blockedRun >= 5) return; // Beatport is refusing us; stop rather than hammer it
      try {
        const hit = await lookupBeatport(it, cache.bc[it.key]);
        cache.bp[it.key] = hit || { miss: true, at: Date.now() };
        if (hit) found++;
        blockedRun = 0;
      } catch (e) {
        failed++;
        blockedRun++;
        console.warn('[wishlist-export] Beatport failed for', it.title, e.message);
      }
      done++;
      onProgress('Beatport… ' + done + '/' + todo.length + ', ' + found + ' matched' + (failed ? ', ' + failed + ' failed' : ''));
      if (done % 20 === 0) saveCache(cache);
    });
    saveCache(cache);
    return { failed, blocked: blockedRun >= 5 };
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function addButton(blob) {
    const btn = document.createElement('button');
    btn.textContent = 'Export wishlist + genres';
    Object.assign(btn.style, {
      position: 'fixed', right: '16px', bottom: '16px', zIndex: 99999,
      padding: '10px 14px', font: '600 14px system-ui, sans-serif',
      background: '#1da0c3', color: '#fff', border: 0, borderRadius: '8px',
      cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,.3)',
    });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const say = (t) => { btn.textContent = t; };
      try {
        say('Listing wishlist…');
        const items = await collectWishlist(blob, say);
        if (!items.length) throw new Error('No wishlist items found');
        const cache = loadCache();
        if (items.some((it) => !cache.bc[it.key])) {
          say('Checking previous export…');
          const reused = seedFromExport(cache, await loadPreviousExport());
          if (reused) { saveCache(cache); say('Reused ' + reused + ' items from previous export'); await sleep(1000); }
        }
        const bcFailed = await fetchAllTags(items, cache, say);
        const bp = USE_BEATPORT ? await fetchAllBeatport(items, cache, say) : { failed: 0 };
        applyCache(items, cache);
        const user = (location.pathname.split('/')[1] || '').toLowerCase();
        download('wishlist.json', JSON.stringify({
          version: 2,
          exported: new Date().toISOString(),
          user,
          count: items.length,
          items,
        }, null, 1));
        const notes = [];
        if (bcFailed) notes.push(bcFailed + ' without tags');
        if (bp.blocked) notes.push('Beatport blocked: open beatport.com in a tab, then retry');
        else if (bp.failed) notes.push(bp.failed + ' Beatport errors');
        say('Done: ' + items.length + ' items, ' + items.filter((i) => i.beatport).length + ' on Beatport' +
          (notes.length ? ' (' + notes.join('; ') + '; click again to retry)' : ''));
      } catch (e) {
        console.error(e);
        say('Failed: ' + e.message + ' (click to retry)');
      } finally {
        btn.disabled = false;
      }
    });
    document.body.appendChild(btn);
  }

  const blob = readBlob();
  if (blob && blob.fan_data && blob.wishlist_data) addButton(blob);
})();
