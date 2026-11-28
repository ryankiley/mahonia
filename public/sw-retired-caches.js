// A one-off, run inside the service worker (config/pwa.ts, importScripts). The worker
// used to keep share pages and their data in two runtime caches, with Workbox's record
// of each entry's age in IndexedDB. Nothing reads them now and nothing expires them.
// They go when a worker activates, because the worker that served from them is gone by
// then; a page can't tell that of the worker controlling it.
//
// Safe to delete after 2027-01-15, with its line in config/pwa.ts and its test in
// tests/pwaConfig.test.ts.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all(["mahonia-list-data", "mahonia-list-pages"].map((name) => caches.delete(name))).catch(() => {}),
  );
  try {
    indexedDB.deleteDatabase("workbox-expiration");
  } catch {
    // no IndexedDB here: nothing was recorded there either
  }
});
