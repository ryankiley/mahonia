import type { ModuleOptions } from "@vite-pwa/nuxt";

// Stamps the precached pages. It must be new on every build, or a deploy keeps the old copy.
const BUILD_REVISION = String(Date.now());

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
    // One-off: deletes the two caches the worker kept share pages in, once the worker
    // that served from them is gone. Safe to delete after 2027-01-15, with the file
    // (public/sw-retired-caches.js) and its test.
    importScripts: ["/sw-retired-caches.js"],
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
      { url: "/", revision: BUILD_REVISION },
      { url: "/_shell", revision: BUILD_REVISION },
    ],
    // Disable the plugin's default catch-all navigation fallback: it binds to a
    // non-precached "/" (the auto-precache of the fallback only runs in dev, not
    // the prod build), so it would throw on every navigation. The `/e` route
    // below handles the editor shell explicitly instead.
    navigateFallback: "",
    runtimeCaching: [
      // the app's own pages — /e and /e/{shareCode}, a share link (/s/{code}), /gear,
      // /account, and the static /help, /about and /legal. Online it is always the
      // network: the bare /e and the static pages are prerendered, the rest rendered per
      // request. Offline, every one of them gets the precached client-only /_shell
      // (nuxt.config routeRules), never a copy of the page itself. Only /e had this at
      // first, so an installed app that reopened on /gear, or a reload there, was the
      // browser's error page while every chunk the page needed sat in the precache
      // (2026-11-09). The static pages' payloads are precached by the glob, so the shell
      // renders them whole. /authorize and /auth/callback need the network.
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
      //
      // A share link is server-rendered with its list inside the HTML, so the browser
      // never asks for the list and this worker never sees it; the shell alone would
      // have nothing to show. The page keeps the list it was given on the device and
      // reads it back when the server can't be reached (app/utils/sharedListCopy.ts).
      // The worker keeps no copy of a list, as a page or as data: it couldn't say that
      // an answer was a copy or how old, and it would go on holding a list the server
      // has since answered 404 for.
      {
        // Navigations only, matched on the path: /api/s/e or /e/_payload.json must
        // never be answered with app HTML, and neither must /s/{code}.md, the page's
        // Markdown twin (a share code has no dot in it). The pattern is written inline
        // because Workbox copies this function's source into sw.js, where nothing
        // outside it exists.
        urlPattern: ({ request, url }) =>
          request.mode === "navigate" &&
          /^\/(?:e(?:\/[^/]+)?|s\/[^/.]+|gear|account|help|about|legal)\/?$/.test(url.pathname),
        handler: "NetworkOnly",
        // No networkTimeoutSeconds: Workbox accepts it only on NetworkFirst, which
        // would store the page — the copy this rule exists not to keep.
        options: { precacheFallback: { fallbackURL: "/_shell" } },
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
