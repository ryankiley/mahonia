// Gated, manual service-worker registration. @vite-pwa generates the SW + Workbox
// runtime at build, but we register it ONLY when the offline flag is on — so in
// production with the flag off, no SW is ever registered and real users are wholly
// unaffected (nuxt.config sets injectRegister:false, so nothing else registers it).
//
// Registered by hand rather than through virtual:pwa-register: the virtual module
// lazy-loads workbox-window (~2 KB brotli of client bundle) and, in autoUpdate
// mode, all it does with it is register() + reload the page when an UPDATED
// worker activates. Both are a few lines of platform API. The reload matters:
// the generated SW self-activates (skipWaiting) and purges the previous
// precache, so a tab still running the old shell would 404 on any lazy chunk it
// hasn't loaded yet — reloading moves it onto the fresh shell. A first-ever
// install has no stale shell, so it must NOT reload; that's the controller
// check. In dev no SW is emitted (devOptions.enabled:false) and /sw.js 404s —
// register() just rejects into the swallow, so the plugin stays harmless there.
export default defineNuxtPlugin(() => {
  if (useOfflineEnabled()) {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .register("/sw.js")
      .then((reg) => {
        if (!navigator.serviceWorker.controller) return; // first install
        const reloadWhenActivated = (sw: ServiceWorker | null) => {
          if (!sw) return;
          if (sw.state === "activated") return window.location.reload();
          sw.addEventListener("statechange", () => {
            if (sw.state === "activated") window.location.reload();
          });
        };
        // an update can already be installing by the time register() resolves
        reloadWhenActivated(reg.installing);
        reg.addEventListener("updatefound", () => reloadWhenActivated(reg.installing));
      })
      .catch(() => {});
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
