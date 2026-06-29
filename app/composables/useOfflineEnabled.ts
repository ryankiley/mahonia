// Master switch for the dormant offline plumbing — the service worker + background
// sync and the offline catalog search all gate on this. Reads
// runtimeConfig.public.offline: OFF in production unless NUXT_PUBLIC_OFFLINE=true,
// ON in dev (see nuxt.config $development). Non-reactive (runtimeConfig is static),
// so it returns a plain boolean.
export function useOfflineEnabled(): boolean {
  return useRuntimeConfig().public.offline === true;
}
