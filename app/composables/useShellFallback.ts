// The address an edit link actually asked for, when the service worker answered it
// with the precached /e because the network was gone (config/pwa.ts). Nuxt hydrates
// a prerendered page at the address it was rendered for, so /e/{code} boots as /e;
// app/plugins/pwa.client.ts records the real address here before the router moves
// it, and moves back to it once hydration is done. Null on every ordinary load.
export const useShellFallback = () => useState<string | null>("shell-fallback", () => null);
