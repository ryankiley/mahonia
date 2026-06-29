/// <reference types="vite-plugin-pwa/vanillajs" />
import { registerSW } from "virtual:pwa-register";

// Gated, manual service-worker registration. @vite-pwa generates the SW + Workbox
// runtime at build, but we register it ONLY when the offline flag is on — so in
// production with the flag off, no SW is ever registered and real users are wholly
// unaffected (nuxt.config sets injectRegister:false, so nothing else registers it).
// autoUpdate means new SWs activate silently (no reload prompt). In dev the virtual
// registerSW is a no-op (devOptions disabled), so calling it here is harmless.
export default defineNuxtPlugin(() => {
  if (!useOfflineEnabled()) return;
  registerSW({ immediate: true });
});
