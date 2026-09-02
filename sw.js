const CACHE_NAME = 'raxson-v3';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo1.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => caches.delete(name))
      );
    }).then(() => clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // NEVER intercept video/media streams or /stream proxy
  // Let video requests go directly (either to source or via /stream proxy)
  const isVideo = url.pathname === '/stream' || 
                  url.pathname.match(/\.(ts|mp4|m3u8|m3u|aac|mp3|m4a|m4v|vtt|webvtt)$/i);

  if (isVideo) {
    return; // Pass through to network directly - no caching, no interception
  }

  // For API calls, always go network-first
  if (url.pathname === '/api') {
    event.respondWith(fetch(event.request));
    return;
  }

  // For static assets, cache-first
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request).then((fetchResponse) => {
        // Only cache same-origin static assets
        if (fetchResponse.ok && url.origin === self.location.origin) {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, fetchResponse.clone());
            return fetchResponse;
          });
        }
        return fetchResponse;
      });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
