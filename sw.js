const CACHE_NAME = 'raxson-player-v17';
const STATIC_ASSETS = [
  '/manifest.json',
  '/logo1.png'
];

self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching assets...');
      return Promise.all(
        STATIC_ASSETS.map(url => 
          fetch(url).then(response => {
            if (response.ok) return cache.put(url, response);
          }).catch(() => {})
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never cache API or stream requests
  if (url.pathname === '/api' || url.pathname === '/stream') {
    event.respondWith(fetch(request));
    return;
  }

  // For index.html - ALWAYS fetch from network, never cache
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // For other assets - cache first, fallback to network
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, clone);
          });
        }
        return response;
      }).catch(() => new Response('Offline', { status: 503 }));
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
