// Minimal service worker: makes the app installable and launchable offline.
// Live traffic (API, WebSocket, ingest) is never cached.
const CACHE = 'netspeak-v1';
const SHELL = ['/', '/style.css', '/app.js', '/audio.js', '/syncplay.js', '/admin.js', '/worklet.js', '/icons/icon.svg'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin ||
      u.pathname.startsWith('/api/') || u.pathname === '/ws' || u.pathname.startsWith('/ingest/')) return;
  const nav = e.request.mode === 'navigate';
  e.respondWith(
    fetch(e.request).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(nav ? '/' : e.request, copy)); }
      return r;
    }).catch(() => caches.match(nav ? '/' : e.request))
  );
});
