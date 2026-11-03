/* HIGHWALL - service worker.

   Network-first with a cache fallback for the app's own page: online you always get the freshly
   deployed build, offline the last good copy still opens.

   AND THE SHARED FILES THIS PAGE CANNOT DRAW WITHOUT (v2037). This worker used to handle only
   same-origin GETs inside /highwall/, on the reasoning that "the boats, the six Claude Design
   buildings and the cars live under /assets/ ... and they are shared with the page at / whose own
   worker already caches them". That has not been true since v1973. The app at the root moved to
   /garage/ and the root became a launcher whose whole job is to UNREGISTER the old root worker;
   /garage/ carries no three.js and never asks for a .glb or for GLTFLoader (see the note in
   garage/sw.js), so nothing on this origin had cached a single model since. This is the only page
   that wants them, so there is no second worker to race: the warning that reasoning ended in
   still holds, and this is now the one worker that caches them.

   What that cost, on a phone: ~19 MB of building models plus the loader and the meshopt decoder
   re-fetched on every launch, and a fetch that fails three times is abandoned - so a dropped
   connection left a designed building as a plain massing block. Reported as "several of the
   buildings are not rendering".

   Three policies, chosen so nothing can ever be served stale in a way the user cannot fix:

   1. This app's own pages - NETWORK-FIRST, cache as a fallback. A cache that can pin a broken
      build in place is worse than a slow launch; online, one deploy is always one reload away.
      v2800: HANDED STRAIGHT THROUGH, AND THE COPY KEPT OFF ITS PATH. The page is ten megabytes, and
      it was cloned on its way to the window so the copy could be written into the cache on every
      launch: measured from a local server, with the worker the page arrived at 1.35-1.48 s and
      without it at 0.28-0.45, the same file from the browser's own cache - the clone is the whole
      difference (the response handed through alone: 0.28-0.31 s). So the network's answer is
      compared with the copy's by its headers first (sameBuild): the same build is handed through
      untouched, which is nearly every launch, and only a new build is cloned on its way, once a
      deploy. (Reading it a second time from the browser's cache instead, to keep the clone off the
      page's path altogether, was tried: the second read waited on the first, the page's own, and the
      launch after a deploy hung.) The request starts while the worker wakes (navigation preload).
      And a network that has not answered in PAGE_WAIT, with a good copy here, no longer holds the
      launch: the copy opens, and the network's answer, when it comes, is the next copy. ("I restarted my
      computer and the map took over a minute": a network that is up but not yet answering is what
      a laptop has for a while after a restart, and the page waited on it for as long as it took.)

   2. Content-addressed assets anywhere on the origin - CACHE-FIRST, permanently. Anything
      carrying ?v= is keyed on a hash of its own content (see _d3carGlbPath), so the URL changes
      the instant the bytes do and there is no staleness to worry about. When a new version of one
      arrives the older versions of that same path are dropped.

   3. The vendored loader and decoder under /vendor/js/ - stale-while-revalidate. They are pinned
      and change rarely, and without them a model cannot be decoded at all.

   Anything else - cross-origin, a POST, the sync endpoint - goes straight to the network.

   v2841: ONE COPY OF THE PAGE. The page was kept under the exact address it was asked by, and the
   shell named it twice ('./' and './index.html'), so a first visit downloaded it twice and every
   installed copy held two; a launch from the home screen ('./'), a link to index.html and a
   ⟳ Refresh (index.html?_r=<time>) each kept a copy of their own, and the refresh's copy, under a
   one-off address, was never opened again - so after a Refresh an offline start from the home
   screen found only the copy from the day the worker was installed. Every request for the page,
   whatever its address, is now kept and looked up under one key, PAGE. */

var VERSION = 'highwall-v2';       /* the app shell: swept on every activation (v2841: v2, so the copies kept twice go) */
var PAGE_WAIT = 4000;             /* ms a page waits for the network's first answer before it opens from its copy */
var ASSETS = 'highwall-assets';    /* content-addressed models: pruned per path, never swept */
var PAGE = new URL('./index.html', self.location).href;   /* v2841: the one key the page is kept under */
var SHELL = ['./index.html', './manifest.json', './favicon.svg',
             './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(VERSION).then(function (c) {
    /* addAll is atomic — one 404 would abort the whole install, and a missing
       icon should not cost us the app shell. */
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    /* Only Drift 101's own. caches.keys() is ORIGIN-wide, so this used to delete RC Garage's
       cache and The Ledger's on every activation, and theirs deleted this one's right back -
       each deploy cost every app on the origin its offline copy. */
    return Promise.all(keys.map(function (k) {
      /* v1981: THIS APP'S OWN HISTORY, and nothing else. The game has been called three things -
         Drift 101 at /drift/, Solstice at /solstice/, HighWall now - and the sweep only ever
         named the first, so every rename left its predecessor's cache behind for good. */
      var mine = (k.indexOf('drift-') === 0 || k.indexOf('solstice-') === 0
                  || k.indexOf('highwall-') === 0);
      /* v2037: EXCEPT the model cache. It is content-addressed, so it can never go stale, and
         sweeping it on a version bump would throw ~19 MB away and re-download it - which is the
         v1810 mistake (a one-line CSS change re-minting every model URL) in another form. */
      if (k === ASSETS) return null;
      return (k !== VERSION && mine) ? caches.delete(k) : null;
    }));
  }).then(function () {
    /* v2800: the page's request starts while the worker wakes, rather than after it */
    var np = self.registration && self.registration.navigationPreload;
    return np ? np.enable().catch(function () {}) : null;
  }).then(function () { return self.clients.claim(); }));
});

/* Only ever store a complete, same-origin 200. An opaque or partial response cached here would
   be served back as if it were the real thing. */
async function putSafe(cache, req, res) {
  if (!res || !res.ok || res.type === 'opaque' || res.status !== 200) return;
  try { await cache.put(req, res.clone()); } catch (e) { /* quota, or an unsupported request */ }
}

/* When a new version of a hashed asset lands, the older ones for that same path are dead - the
   URL only changes when the content does, so nothing will ask for them again. */
async function pruneOldVersions(cache, url) {
  try {
    var keys = await cache.keys();
    await Promise.all(keys.map(function (k) {
      var u = new URL(k.url);
      if (u.origin !== url.origin || u.pathname !== url.pathname) return null;
      if (u.searchParams.get('v') === url.searchParams.get('v')) return null;
      return cache.delete(k);
    }));
  } catch (e) { /* pruning is a nicety; never let it fail a response */ }
}

/* v2800: is this the same build as that? ETag is what GitHub Pages varies per deploy; with none, Last-Modified and the
   length together. Neither said: not the same, so the copy is written as it always was. */
function sameBuild(a, b) {
  var ea = a.headers.get('etag'), eb = b.headers.get('etag');
  if (ea && eb) return ea === eb;
  var la = a.headers.get('last-modified'), lb = b.headers.get('last-modified');
  var ca = a.headers.get('content-length'), cb = b.headers.get('content-length');
  return !!(la && lb && ca && cb && la === lb && ca === cb);
}
/* v2800: a response worth keeping as the page's copy */
function keepable(res) { return !!(res && res.ok && res.status === 200 && res.type !== 'opaque'); }
function wait(ms) { return new Promise(function (r) { setTimeout(function () { r(null); }, ms); }); }

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  if (!/^https?:$/.test(url.protocol)) return;

  /* 2. content-addressed: cache-first, for ever. This is where the models live, and a worker's
     scope limits which PAGES it controls, not which of their requests it may answer - the same
     reason firstlight/sw.js serves /vendor/three/ from outside its own directory. */
  if (url.searchParams.has('v')) {
    e.respondWith((async function () {
      var cache = await caches.open(ASSETS);
      var hit = await cache.match(req);
      if (hit) return hit;
      var res = await fetch(req);
      await putSafe(cache, req, res);
      pruneOldVersions(cache, url);          // deliberately not awaited
      return res;
    })());
    return;
  }

  /* 3. the loader and the meshopt decoder: stale-while-revalidate. Without these a .glb cannot
     be decoded at all, and they carry no version in their URL. */
  if (url.pathname.indexOf('/vendor/js/') === 0) {
    e.respondWith((async function () {
      var cache = await caches.open(VERSION);
      var hit = await cache.match(req);
      var net = fetch(req).then(async function (res) {
        await putSafe(cache, req, res); return res;
      }).catch(function () { return null; });
      if (hit) return hit;
      var res = await net;
      return res || Response.error();
    })());
    return;
  }

  /* 1. this app's own pages and files: network-first. */
  if (url.pathname.indexOf('/highwall/') !== 0) return;

  /* v2841: the page, by any of its addresses, is one entry */
  var page = (url.pathname === '/highwall/' || url.pathname === '/highwall/index.html'), key = page ? PAGE : req;
  var net = Promise.resolve(e.preloadResponse).then(function (r) { return r || fetch(req); });
  e.respondWith((async function () {
    var cache = await caches.open(VERSION), own = await cache.match(key), hit = own;
    if (!hit && req.mode === 'navigate') hit = await cache.match('./index.html');
    /* nothing here to open: the network, however long it takes, and its answer kept, as before */
    if (!hit) {
      var first = await net.catch(function () { return null; });
      if (!first) return Response.error();
      if (keepable(first)) e.waitUntil(putSafe(cache, key, first));
      return first;
    }
    var res = await Promise.race([net.catch(function () { return null; }), wait(PAGE_WAIT)]);
    if (!res) {
      /* the network has said nothing: the copy opens, and the network's answer, when it comes, is the next copy -
         read by nothing else, so written whole */
      e.waitUntil(net.then(function (late) { if (keepable(late) && !sameBuild(own || hit, late)) return cache.put(key, late); }, function () {}));
      return hit;
    }
    /* the network answered: the same build as the copy is handed through untouched; a new one is copied on its way */
    if (keepable(res) && !(own && sameBuild(own, res))) e.waitUntil(putSafe(cache, key, res));
    return res;
  })());
});
