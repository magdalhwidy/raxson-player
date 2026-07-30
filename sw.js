const CACHE_NAME = 'raxson-v5';
const STATIC_ASSETS = ['/', '/index.html', '/manifest.json', '/images/logo1.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => 
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const { request } = e;

  // API calls — don't cache
  if (request.url.includes('player_api.php') || request.url.includes('/api')) {
    e.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }

  // External images (stream icons) — pass through without caching
  if (request.url.startsWith('http') && !request.url.includes(self.location.origin)) {
    e.respondWith(fetch(request));
    return;
  }

  // Everything else — cache first
  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return response;
      }).catch(() => cached);
    })
  );
});
