import type { ModuleOptions } from "@vite-pwa/nuxt";

// The PWA: service worker, runtime caching, and what an offline visit still does.
//
// Lifted out of nuxt.config.ts because it is a self-contained subsystem with its own
// reasoning — ~80 lines about cache strategies and kill switches that has nothing to
// say about the rest of the Nuxt config, and buried the things that do.
//
// Read as: what gets precached, what is fetched network-first, and what an offline
// visitor still sees. The env kill switch (NUXT_PUBLIC_OFFLINE=false) is honoured by
// the caller — see nuxt.config.ts.
//
// @vite-pwa generates the service worker + Workbox runtime. `injectRegister: false`
// = no auto-registration — a gated client plugin, app/plugins/pwa.client.ts,
// registers /sw.js by hand only while the offline flag is on, so the env kill switch
// fully disables it. `manifest: false` = the module doesn't GENERATE a manifest; the
// hand-written public/manifest.webmanifest (name/icons/standalone) is linked from
// app.head and is what makes the site installable. `autoUpdate` = silent updates,
// never a "new version, reload?" prompt. `devOptions.enabled:false` = no SW under
// `nuxt dev` (in dev the virtual registerSW is a no-op, so the gated plugin is
// harmless there).
//
// DELIBERATE DUPLICATION, in the same spirit as tokens.scss's breakpoints: because
// the manifest is hand-written and static, `name` and `description` in
// public/manifest.webmanifest are a second copy of the title and description in
// nuxt.config.ts's app.head, byte for byte. Change one and change the other — an
// installed app whose name disagrees with its own page title is the failure, and
// nothing catches it. Generating the manifest from one constant (the way
// robots.txt.ts and sitemap.xml.ts are generated) is the real fix; it is not taken
// here because turning a precached static asset into a route is a PWA change, not a
// tidy-up.
export const PWA_OPTIONS: Partial<ModuleOptions> = {
  registerType: "autoUpdate",
  injectRegister: false,
  // @vite-pwa/nuxt ships its OWN client plugin that auto-registers the SW
  // unconditionally — disable it so registration is solely our gated plugin
  // (app/plugins/pwa.client.ts). Without this the SW registers even with the
  // flag off, defeating the dormancy.
  client: { registerPlugin: false },
  manifest: false,
  devOptions: { enabled: false },
  workbox: {
    // precache the client shell (hashed JS/CSS/fonts) so it boots from cache
    globPatterns: ["**/*.{js,css,woff2}"],
    // Disable the plugin's default catch-all navigation fallback: it binds to a
    // non-precached "/" (the auto-precache of the fallback only runs in dev, not
    // the prod build), so it would throw on every navigation. The `/e` route
    // below handles the editor shell explicitly instead.
    navigateFallback: "",
    runtimeCaching: [
      // editor shell — the bare /e is prerendered and /e/{shareCode} is uncached
      // SSR (see nuxt.config), and neither is precached (globPatterns is
      // assets-only), so cache the
      // navigation response: a prior online visit lets the editor boot offline.
      // The pattern covers BOTH the bare /e and the named-link /e/{shareCode} so
      // a saved pretty link opens offline too. NetworkFirst keeps online users on
      // the fresh shell (so its referenced chunks match the live precache).
      {
        urlPattern: /\/e(?:\/[^/]+)?\/?$/,
        handler: "NetworkFirst",
        options: {
          cacheName: "mahonia-shell",
          // room for the bare shell + several distinct /e/{shareCode} links
          networkTimeoutSeconds: 3,
          expiration: { maxEntries: 16, maxAgeSeconds: 60 * 60 * 24 * 7 },
        },
      },
      // public + shared read views — cached so a previously-opened list still
      // renders offline. /s (the share-code read) is included alongside /l: it's
      // the most-shared link shape, and its API also feeds the /e/{shareCode}
      // SSR head. The DATA is stale-while-revalidate (JSON references no hashed
      // assets, so staleness is only content-lag); the page HTML is NetworkFirst
      // like the /e shell — SWR-serving week-old HTML can reference hashed
      // /_nuxt assets that no longer exist after a redeploy (once the SW has
      // updated and purged the old precache), leaving an unstyled, unhydrated
      // page for an ONLINE user. NetworkFirst costs one network round-trip when
      // online and still falls back to cache offline.
      {
        urlPattern: /\/api\/[ls]\/.*/,
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "mahonia-list-data",
          expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
        },
      },
      {
        urlPattern: /\/[ls]\/[^/]+$/,
        handler: "NetworkFirst",
        options: {
          cacheName: "mahonia-list-pages",
          networkTimeoutSeconds: 3,
          expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
        },
      },
      // queue list edits made offline and replay them on reconnect — even after
      // the tab closes. Safe because /api/edit/mutate is idempotent (CAS version
      // + merge-designed ops → a replayed op set no-ops; see server/utils/listRepo).
      {
        urlPattern: /\/api\/edit\/mutate$/,
        method: "POST",
        handler: "NetworkOnly",
        options: {
          backgroundSync: {
            name: "mahonia-mutate-queue",
            options: { maxRetentionTime: 60 * 24 },
          },
        },
      },
    ],
  },
};
