// Gated, manual service-worker registration. @vite-pwa generates the SW + Workbox
// runtime at build, but we register it ONLY when the offline flag is on — so in
// production with the flag off, no SW is ever registered and real users are wholly
// unaffected (nuxt.config sets injectRegister:false, so nothing else registers it).
//
// Registered by hand rather than through virtual:pwa-register: the virtual module
// lazy-loads workbox-window (~2 KB brotli of client bundle), and all this needs is
// register(). In dev no SW is emitted (devOptions.enabled:false) and
// /sw.js 404s — register() just rejects into the swallow, so the plugin stays
// harmless there.
//
// AN UPDATE NEVER TAKES OVER A PAGE THAT IS OPEN. A deploy's worker installs in
// the background and waits (config/pwa.ts leaves skipWaiting off) until no Mahonia
// page is left: the last tab closing or navigating away, or the installed app
// being closed. The browser then activates it before the next page loads, so that
// page boots straight onto the new shell with no reload. Activating it any earlier
// deletes the previous build's chunks from the precache while a tab is still
// running on them ("/" and "/e" boot from that precache), and every lazy chunk the
// tab hasn't loaded yet (dialogs, the share panel, the exporters) then fails, as
// does Vercel for old hashes online. Forcing it at launch was tried and dropped: an
// open page can hold activation off for as long as an event in the old worker runs
// (a background-sync replay, say), so the reload landed mid-session after all.
//
// It also finishes the offline fallback for edit links. Offline, the worker serves
// every /e/{code} with the precached /e, and Nuxt hydrates that page at its own
// address and then keeps it: the router lands on /e#{token}, dropping the code.
// With a token that still opens the list, but a claimed link has no token, so it
// would land on a fresh draft. So the real address is recorded here, before the
// router moves, and navigated back to once hydration is done. In-app navigation to
// /e/{code} needs no network (its /api/s fetch is server-only). Meanwhile
// pages/e/index.vue renders nothing, so no throwaway draft starts and overwrites
// the on-device draft slot.
export default defineNuxtPlugin((nuxtApp) => {
  if (useOfflineEnabled()) {
    const { pathname, search, hash } = window.location;
    if (nuxtApp.payload.path === "/e" && /^\/e\/[^/]+\/?$/.test(pathname)) {
      const target = pathname + search + hash;
      const fallback = useShellFallback();
      const router = useRouter();
      fallback.value = target;
      // After Nuxt's own move to the hydrated address, which also runs on
      // app:suspense:resolve; a later navigation supersedes it.
      nuxtApp.hooks.hookOnce("app:suspense:resolve", () => {
        setTimeout(() => {
          void router
            .replace(target)
            .finally(() => (fallback.value = null));
        });
      });
    }
    if (!("serviceWorker" in navigator)) return;
    // The editor shell used to be runtime-cached under this name; nothing reads it now.
    if (typeof caches !== "undefined") caches.delete("mahonia-shell").catch(() => {});
    navigator.serviceWorker.register("/sw.js").catch(() => {});
    return;
  }
  // Flag off: actively tear down any service worker + Workbox caches a previously
  // ENABLED build may have left registered, so toggling the flag back off is a
  // clean, complete rollback (a SW otherwise persists until manually unregistered).
  // Touches only the Cache Storage the SW created — NOT IndexedDB, where Tier-1's
  // always-on on-device drafts live.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {});
  }
  if (typeof caches !== "undefined") {
    caches
      .keys()
      .then((keys) => keys.forEach((k) => caches.delete(k)))
      .catch(() => {});
  }
});
