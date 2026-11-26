import type { ModuleOptions } from "@vite-pwa/nuxt";

/**
 * A precached HTML entry needs a new revision for every deployment, not merely
 * for every Git commit. Rebuilding the same commit after a build-time setting
 * changes (notably NUXT_PUBLIC_OFFLINE) changes the static shell too. Vercel's
 * deployment ID has that property; the SHA remains a stable fallback for older
 * Vercel projects, and a local build gets its own timestamp.
 */
interface VercelBuildEnvironment {
  VERCEL_DEPLOYMENT_ID?: string;
  VERCEL_GIT_COMMIT_SHA?: string;
}

export function pwaPrecacheRevision(
  env: VercelBuildEnvironment = {
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  },
  fallback = String(Date.now()),
): string {
  return env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || fallback;
}

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
    // A first visit is offline-ready at once: the new worker takes control of the
    // page without a reload. An UPDATE does not take over by itself (skipWaiting
    // stays off); it waits for every Mahonia page to close, because activating it
    // deletes the chunks an open tab is running on (app/plugins/pwa.client.ts).
    // vite-pwa sets both options for "autoUpdate" only when it injects the
    // registration itself, so with injectRegister:false they are stated here.
    skipWaiting: false,
    clientsClaim: true,
    // precache the client shell (hashed JS/CSS/fonts) so it boots from cache
    globPatterns: ["**/*.{js,css,woff2}"],
    // …plus the bare address, the manifest's start_url, by name. It is a prerendered
    // static shell that only resolves on the client (app/pages/index.vue), so it belongs
    // in the precache — an installed app launched offline gets it instantly, then the
    // client resolves to the last list in-app, which needs no HTML at all. It can't
    // come in through the glob above: this worker is generated during the client build,
    // before Nitro prerenders index.html, so the file isn't there to glob. Listed by URL
    // instead, and stamped per build so a deploy replaces the cached copy — `null` here
    // would tell Workbox the URL versions itself, and "/" never changes its name.
    // Without any of this the offline launch was a browser error page: nothing below
    // matches "/", and navigateFallback is deliberately empty.
    //
    // "/_shell" rides along for the same reason: it is the offline fallback for every
    // edit link, below.
    additionalManifestEntries: [
      { url: "/", revision: pwaPrecacheRevision() },
      { url: "/_shell", revision: pwaPrecacheRevision() },
    ],
    // Disable the plugin's default catch-all navigation fallback: it binds to a
    // non-precached "/" (the auto-precache of the fallback only runs in dev, not
    // the prod build), so it would throw on every navigation. The `/e` route
    // below handles the editor shell explicitly instead.
    navigateFallback: "",
    runtimeCaching: [
      // the app's own pages — /e and /e/{shareCode}, /gear, /account, and the static
      // /help, /about and /legal. Online it is always the network: the bare /e and the
      // static pages are prerendered, the rest rendered per request. Offline, every one
      // of them gets the precached client-only /_shell (nuxt.config routeRules), never
      // a copy of the page itself. Only /e had this at first, so an installed app that
      // reopened on /gear, or a reload there, was the browser's error page while every
      // chunk the page needed sat in the precache (2026-11-09). The static pages'
      // payloads are precached by the glob, so the shell renders them whole. /s has its
      // own rules below; /authorize and /auth/callback need the network.
      //
      // It used to be a runtime cache of each page (NetworkFirst, 16 entries, a
      // week), and that copy was broken offline after any deploy: its HTML names the
      // hashed chunks of the build it came from, and the updated worker deletes those
      // from the precache when it activates, so the page loaded as a blank editor.
      // The precached shell is replaced along with the chunks it names, so it always
      // matches them. It boots at the address it was opened for, and the editor takes
      // its list from the #token fragment (or the account) and the copy in IndexedDB,
      // so nothing on /e/{shareCode} offline needs that route's own HTML; /gear draws
      // the account's gear from this device's copy (app/composables/useVaultList.ts).
      {
        // Navigations only, matched on the path: /api/s/e or /e/_payload.json must
        // never be answered with app HTML. The pattern is written inline because
        // Workbox copies this function's source into sw.js, where nothing outside it
        // exists.
        urlPattern: ({ request, url }) =>
          request.mode === "navigate" &&
          /^\/(?:e(?:\/[^/]+)?|gear|account|help|about|legal)\/?$/.test(url.pathname),
        handler: "NetworkOnly",
        // No networkTimeoutSeconds: Workbox accepts it only on NetworkFirst, which
        // would store the page — the copy this rule exists not to keep.
        options: { precacheFallback: { fallbackURL: "/_shell" } },
      },
      // the shared read view (/s) — cached so a previously-opened list still
      // renders offline; its API also feeds the /e/{shareCode} SSR head. (The
      // public /l pages these rules also covered were retired with publishing.)
      // The DATA is stale-while-revalidate (JSON references no hashed
      // assets, so staleness is only content-lag); the page HTML is NetworkFirst
      // like the /e shell — SWR-serving week-old HTML can reference hashed
      // /_nuxt assets that no longer exist after a redeploy (once the SW has
      // updated and purged the old precache), leaving an unstyled, unhydrated
      // page for an ONLINE user. NetworkFirst costs one network round-trip when
      // online and still falls back to cache offline.
      {
        urlPattern: /\/api\/s\/.*/,
        handler: "StaleWhileRevalidate",
        options: {
          cacheName: "mahonia-list-data",
          expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
        },
      },
      {
        urlPattern: /\/s\/[^/]+$/,
        handler: "NetworkFirst",
        options: {
          cacheName: "mahonia-list-pages",
          networkTimeoutSeconds: 3,
          expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
        },
      },
      // NO RULE FOR /api/edit/mutate, and no worker-side queue of writes. The editor
      // already keeps every edit the server hasn't acknowledged in IndexedDB and sends
      // it again itself, rebased on what the server holds (app/composables/useGearList).
      // A Workbox background-sync queue sat here as well until 2026-11: it kept a copy
      // of each send that failed and replayed it whenever the browser next woke the
      // worker, by which time the editor's own retry and newer edits could have
      // landed. Ops merge by arrival and carry no version, so the late copy put back
      // what those edits had changed (tests/pwaConfig.test.ts shows it on the reducer).
    ],
  },
};
