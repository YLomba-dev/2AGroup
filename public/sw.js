// Installable-app service worker. Caches only the app shell (pages, styles, scripts,
// icons) so the app opens fast. Case data and files (/api) are never cached: they
// always come from the server, so nothing confidential stays on the device.
const CACHE = '2a-shell-v1';
const SHELL = ['/', '/login.html', '/client.html', '/staff.html', '/account.html', '/css/app.css',
  '/js/common.js', '/js/login.js', '/js/client.js', '/js/staff.js', '/js/account.js',
  '/vendor/supabase.js', '/icons/icon.svg', '/icons/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first so updates show at once; the cached shell is the offline fallback.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
