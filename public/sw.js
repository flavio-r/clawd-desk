// Service Worker do ClawdDesk: deixa o app instalável e abre a interface mesmo se o PC
// estiver momentaneamente fora do ar (os dados em tempo real continuam vindo do WebSocket).
const CACHE = 'clawddesk-v3';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/style.css',
  '/js/app.js',
  '/js/mascot.js',
  '/js/mascot-art.js',
  '/js/audio.js',
  '/js/keepawake.js',
  '/js/theme.js',
  '/js/burnin.js',
  '/js/simulate.js',
  '/js/format.js',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/fonts/chakra-petch-latin-500-normal.woff2',
  '/fonts/chakra-petch-latin-600-normal.woff2',
  '/fonts/chakra-petch-latin-700-normal.woff2',
  '/fonts/jetbrains-mono-latin-500-normal.woff2',
  '/fonts/jetbrains-mono-latin-700-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Rede primeiro (para sempre pegar a versão nova do PC); cache só como reserva offline.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
  );
});
