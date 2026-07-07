# Infrastructure / build / service worker

## v1 — Dev and build are separate browser-storage universes (2026-07-06)
**Problem:** "Works in dev, broken in build" confusion: `:5173` (dev) and `:4173` (vite preview)
have separate localStorage AND separate OPFS/IndexedDB — proxies, flags, and local media built on
one origin do not exist on the other. First session on the build origin rebuilds proxies (paused).
**Fix:** understanding + the cold-origin "Optimizing media" toast. Not a bug — expected behavior.

## v2 — Service worker served stale bundles across fixes (2026-07-06)
**Problem:** Two "the fix didn't work" reports were the OLD CacheFirst service worker serving
pre-fix chunks (and it intercepts module-worker chunk fetches too — span/transcode workers).
**Fix:** JS/wasm runtime caching CacheFirst → NetworkFirst (vite.config.ts): deployed bytes always
win when the server is reachable; cache is only the offline/deleted-chunk fallback.
**Rule:** before believing any "not fixed" on `:4173`, check the console's `index-*.js` hash against
the latest build output; if stale → DevTools → Application → Service Workers → Unregister → reload ×2.
