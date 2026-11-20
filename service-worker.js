// Offline support.
//
// Strategy: network first for everything same-origin, falling back to the
// cache when offline or when the network is too slow. This means a deploy
// reaches users on their next load (the old cache-first worker never updated),
// while the app still works with no connection.
//
// Bump VERSION whenever the list of shell files changes.
const VERSION = 'hasbuk-v5';
const NETWORK_TIMEOUT_MS = 4000;

const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/data.js',
  'js/text.js',
  'js/picker.js',
  'js/store.js',
  'js/gestures.js',
  'js/mushaf.js',
  'js/challenge.js',
  'js/room.js',
  'js/vendor/qrcode.js',
  'data/quran.min.json',
  'fonts/UthmanicHafs1Ver18.woff2',
  'fonts/surah-header.woff2',
  'manifest.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(event, request));
});

async function networkFirst(event, request) {
  const cache = await caches.open(VERSION);
  // Navigations (any path) are served by the app shell when offline.
  const cacheKey = request.mode === 'navigate' ? 'index.html' : request;
  const cached = await cache.match(cacheKey, { ignoreSearch: request.mode === 'navigate' });

  let saved = Promise.resolve();
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') saved = cache.put(cacheKey, response.clone());
    return response;
  });
  // Keep the worker alive to finish updating the cache even if the timeout wins.
  event.waitUntil(network.then(() => saved).catch(() => {}));

  if (!cached) return network;

  // With a cached copy available, don't leave the user waiting on a bad connection.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(cached), NETWORK_TIMEOUT_MS));
  return Promise.race([network.catch(() => cached), timeout]);
}
