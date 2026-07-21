// Minimal service worker: network passthrough. Exists so the app satisfies
// PWA installability; data is live from Supabase, so no offline caching —
// stale financial numbers are worse than an offline error page.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
