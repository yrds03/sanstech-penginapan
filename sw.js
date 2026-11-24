'use strict';
const CACHE_PREFIX = 'sanstech-penginapan-';
const CACHE_NAME = CACHE_PREFIX + 'v2';
const APP_FILES = ['./', './index.html', './app.js', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './vendor/tailwind.css', './vendor/sweetalert2.all.min.js', './vendor/xlsx.full.min.js', './vendor/fontawesome.min.css', './vendor/webfonts/fa-solid-900.woff2', './vendor/webfonts/fa-regular-400.woff2', './vendor/webfonts/fa-brands-400.woff2'];
self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => (key.startsWith(CACHE_PREFIX) || key === 'hotel-pos-cache-v1') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
    const request = event.request, url = new URL(request.url);
    // Never intercept API calls, writes, private spreadsheets, or other origins.
    if (request.method !== 'GET' || url.origin !== self.location.origin || url.search) return;
    const known = APP_FILES.some(file => new URL(file, self.registration.scope).pathname === url.pathname);
    if (!known) return;
    event.respondWith(fetch(request).then(response => {
        if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(request, copy)));
        }
        return response;
    }).catch(async () => (await caches.match(request)) || new Response('Application unavailable offline.', { status: 503, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } })));
});
