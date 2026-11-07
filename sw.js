const CACHE_NAME = 'gatepass-cache-v4';
const urlsToCache = [
    './',
    './index.html',
    './style.css',
    './script.js',
    './firebase-config.js',
    './manifest.json',
    './zing-logo.png',
    'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'
];

// Install event: cache files
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                return cache.addAll(urlsToCache);
            })
    );
});

// Fetch event: serve from cache if available, else network
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Return cached version or fetch from network
                return response || fetch(event.request);
            })
    );
});