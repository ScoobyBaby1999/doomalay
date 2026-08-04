// sw.js — Doomalay service worker. Caches the app shell for offline use
// + instant load on repeat visits. The chat data itself is NOT cached here
// (it lives in the engine's SQLite + the PWA's IndexedDB).
//
// SECURITY: this SW only caches same-origin static assets (JS/CSS/icons).
// It never intercepts /api/* requests (those always go to the network → engine).

const CACHE_NAME = 'doomalay-v0.1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // NEVER intercept API or WebSocket requests — always go to the engine.
  if (url.pathname.startsWith('/api/')) return;
  // Only handle GET (not POST/WS).
  if (event.request.method !== 'GET') return;
  // Cache-first for same-origin static assets.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          // Cache successful responses (not errors/opaque).
          if (response.ok && response.type === 'basic') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        }).catch(() => cached); // offline → fallback to cache
      })
    );
  }
});
