// Minimal service worker — just enables installability.
// We deliberately do NOT cache API/proxy responses (the whole point is fresh data),
// but we cache the app shell so the UI loads instantly when installed.
const SHELL = 'vw-shell-v5';
const SHELL_FILES = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES).catch(() => {})));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== SHELL).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Pass through API + proxy + cross-origin — never cache them.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/proxy') || url.origin !== location.origin) {
    return; // default network fetch
  }

  // App shell — network first with cache fallback.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && SHELL_FILES.includes(url.pathname)) {
          const clone = res.clone();
          caches.open(SHELL).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
