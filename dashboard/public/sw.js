// Mission Control Service Worker — offline-first for static assets.
const CACHE_NAME = "osa-mc-v1";
const SHELL = ["/", "/index.html"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Network-first for API / WebSocket
  if (url.pathname.startsWith("/api") || url.protocol === "ws:" || url.protocol === "wss:") {
    e.respondWith(fetch(e.request));
    return;
  }

  // Cache-first for static assets (icons, fonts, JS, CSS)
  if (url.pathname.startsWith("/icons") || url.pathname.startsWith("/assets") ||
      url.pathname.endsWith(".woff2") || url.pathname.endsWith(".woff")) {
    e.respondWith(
      caches.match(e.request).then((cached) => cached || fetch(e.request).then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
        return resp;
      }))
    );
    return;
  }

  // Network-first for HTML (app shell)
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request)).then((r) => r || caches.match("/index.html"))
  );
});
