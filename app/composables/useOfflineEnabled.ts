// Master switch for the offline plumbing — the service worker + background sync
// and the offline catalog search all gate on this. Reads
// runtimeConfig.public.offline: ON by default (the site is a PWA out of the box);
// NUXT_PUBLIC_OFFLINE=false at build time is the kill switch (see nuxt.config).
// Non-reactive (runtimeConfig is static), so it returns a plain boolean.
export function useOfflineEnabled(): boolean {
  return useRuntimeConfig().public.offline === true;
}
