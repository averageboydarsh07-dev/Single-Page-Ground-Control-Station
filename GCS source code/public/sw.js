/* ==========================================================================
   Service Worker for Ground Control Station (public/sw.js)
   Provides 100% offline capability by caching the shell and local libraries.
   ========================================================================== */

const CACHE_NAME = 'gcs-offline-cache-v1';

// Static files and offline libraries to cache
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/libs/leaflet.js',
  '/libs/leaflet.css',
  '/libs/chart.js',
  '/libs/three.js',
  '/libs/lucide.js'
];

// Install Event - Caches all core assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[ServiceWorker] Pre-caching static assets for offline GCS usage...');
        return cache.addAll(ASSETS_TO_CACHE);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate Event - Clean up old cache revisions
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[ServiceWorker] Removing stale cache version:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Cache-First fallback to network strategy
self.addEventListener('fetch', (event) => {
  // Only intercept HTTP/HTTPS schemes (avoid chrome-extension issues)
  if (!event.request.url.startsWith(self.location.origin)) {
    return;
  }

  // Do not intercept server-sent events or API endpoints used by the app.
  // ServiceWorkers can interfere with streaming EventSource connections,
  // so bypass them to keep SSE working reliably.
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/stream') || url.pathname.startsWith('/command') || url.pathname.startsWith('/ports') || url.pathname.startsWith('/stats') || url.pathname.startsWith('/export') || url.pathname.startsWith('/data/')) {
    return; // allow network to handle these
  }

  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        // Fetch from network if not in cache, and cache it dynamically
        return fetch(event.request)
          .then((networkResponse) => {
            if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
              return networkResponse;
            }

            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });

            return networkResponse;
          })
          .catch((err) => {
            console.error('[ServiceWorker] Network request failed offline:', err);
            // Return index.html as a fallback for standard pages
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
          });
      })
  );
});
