/// <reference types="vite-plugin-pwa/vanillajs" />
import { registerSW } from "virtual:pwa-register";

// Gated, manual service-worker registration. @vite-pwa generates the SW + Workbox
// runtime at build, but we register it ONLY when the offline flag is on — so in
// production with the flag off, no SW is ever registered and real users are wholly
// unaffected (nuxt.config sets injectRegister:false, so nothing else registers it).
// autoUpdate means new SWs activate silently (no reload prompt). In dev the virtual
// registerSW is a no-op (devOptions disabled), so calling it here is harmless.
export default defineNuxtPlugin(() => {
  if (useOfflineEnabled()) {
    registerSW({ immediate: true });
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
