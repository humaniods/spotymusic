// The app shell cache. Offline listening needs two things: the recordings (kept in
// IndexedDB by src/library.mjs) and OpenMic itself, which has to still open with no
// network. This worker caches only OpenMic's own files - never /api, never a provider's
// audio, never an embed frame - so nothing here can serve somebody else's content.
const CACHE = 'openmic-shell-v1';
const ASSETS = [
  './',
  './index.html',
  './src/styles.css',
  './src/free-music.css',
  './src/artist.css',
  './src/app.mjs',
  './src/artist.mjs',
  './src/audius.mjs',
  './src/community-api.mjs',
  './src/core.mjs',
  './src/demo-audio.mjs',
  './src/dialogs.mjs',
  './src/free-catalog.mjs',
  './src/itunes.mjs',
  './src/library.mjs',
  './src/providers.mjs',
  './src/youtube.mjs',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

function isOwnFile(url) {
  if (url.origin !== self.location.origin) return false;
  // The API is live data: sessions, quota-billed searches, artist uploads and takedowns.
  // Caching any of it would serve stale rights decisions from a disk.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  return true;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (!isOwnFile(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put('./index.html', copy));
        return response;
      }).catch(() => caches.match('./index.html').then(cached => cached || caches.match('./')))
    );
    return;
  }

  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then(cached => {
      if (cached) {
        // Serve from disk now, refresh in the background, so a cold start offline still
        // gets the last version this device actually ran.
        fetch(request).then(response => {
          if (!response || !response.ok) return;
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }).catch(() => {});
        return cached;
      }
      return fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
