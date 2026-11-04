const CACHE = 'egc-sample-lab-shell-v3';
const SHELL = ['./', './index.html', './style.css', './app.js', './audio.js', './taxonomy.js', './storage.js',
    './pipeline.js', './worker.js', './inference.js', './assets.json', './prototypes.json', './mel-filters.json',
    './about.html', '../egc1.png', './vendor/analysis.mjs', './vendor/analysis.wasm',
    './vendor/ort.wasm.min.mjs', './vendor/ort-wasm-simd-threaded.mjs', './vendor/ort-wasm-simd-threaded.wasm'];
self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => Promise.all(SHELL.map(async path => {
        const url = new URL(path, self.location.href);
        try {
            const response = await fetch(url, {cache: 'reload'});
            if (!response.ok) { throw new Error(`HTTP ${response.status}`); }
            // Buffer assets before committing so a failed stream never becomes an offline entry.
            const body = await response.arrayBuffer();
            const headers = new Headers(response.headers);
            headers.delete('content-encoding'); headers.delete('content-length');
            await cache.put(url, new Response(body, {headers}));
        } catch (error) { throw new Error(`${path}: ${error.message}`); }
    }))).catch(async error => {
        for (const client of await self.clients.matchAll({includeUncontrolled: true})) {
            client.postMessage({type: 'offline-cache-error', message: error.message});
        }
        throw error;
    }));
});
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) {
            if (key.startsWith('egc-sample-lab-shell-') && key !== CACHE) { await caches.delete(key); }
        }
        await self.clients.claim();
    })());
});
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(new URL('./', self.location.href).pathname)) { return; }
    event.respondWith((async () => {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(event.request, {ignoreSearch: true});
        if (cached) { return cached; }
        return fetch(event.request);
    })());
});
