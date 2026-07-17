// https://nuxt.com/docs/api/configuration/nuxt-config

// Content-Security-Policy — defense-in-depth for a public, anyone-can-write app.
// `'unsafe-inline'` is required for script + style: Nuxt SSR/prerender emits inline
// bootstrap/payload scripts and Vue `:style` produces inline styles, and there's no
// per-request nonce for prerendered static files. Everything else is same-origin —
// Vercel Analytics injects `/_vercel/insights` (self), and the PWA service worker,
// fonts, and images are all served from our own origin — so no external hosts are
// allowed (this also backstops the folder-colorKey `url()` beacon).
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

const SECURITY_HEADERS = {
  "Content-Security-Policy": CSP,
  "Referrer-Policy": "no-referrer", // keep the URL-fragment edit token out of the Referer
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY", // legacy clickjacking guard (frame-ancestors covers modern browsers)
};

export default defineNuxtConfig({
  // Pin date-gated Nuxt/Nitro defaults so builds are reproducible across CI/Vercel
  // (an unset compatibilityDate falls back to "today" and can shift under us).
  compatibilityDate: "2026-06-30",

  // @vercel/analytics ships its Nuxt module at the `/nuxt` subpath; the bare
  // specifier resolves to the plain inject()/track() API (NOT a defineNuxtModule),
  // so registering "@vercel/analytics" silently injected nothing.
  modules: ["@vercel/analytics/nuxt", "@vite-pwa/nuxt"],

  // Master switch for the offline plumbing (service worker + background sync, and
  // the offline catalog search). ON by default — the site is a full PWA out of the
  // box (installable, boots from cache, offline edits queue + replay). Setting
  // NUXT_PUBLIC_OFFLINE=false (that exact string) is the kill switch: the gated
  // plugin then unregisters any SW + drops its caches, a clean rollback (see
  // app/plugins/pwa.client.ts). NOTE the flag must be present AT BUILD TIME:
  // prerendered routes (/e, the legal pages) bake runtimeConfig into their static
  // payload. On Vercel that's automatic — changing an env var redeploys, which
  // rebuilds — but a bare `NUXT_PUBLIC_OFFLINE=false node server` won't reach the
  // prerendered landing route.
  runtimeConfig: {
    public: {
      offline: process.env.NUXT_PUBLIC_OFFLINE !== "false",
    },
  },

  // @vite-pwa generates the service worker + Workbox runtime. `injectRegister:
  // false` = no auto-registration — a gated client plugin, app/plugins/
  // pwa.client.ts, registers /sw.js by hand only while the offline flag is on,
  // so the env kill switch above fully disables it. `manifest: false` = the module
  // doesn't GENERATE a manifest; the hand-written public/manifest.webmanifest
  // (name/icons/standalone) is linked from app.head and is what makes the site
  // installable. `autoUpdate` = silent updates, never a "new version, reload?"
  // prompt. `devOptions.enabled:false` = no SW under `nuxt dev` (in dev the
  // virtual registerSW is a no-op, so the gated plugin is harmless there).
  pwa: {
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
        // editor shell — the bare /e is prerendered and /e/{shareCode} is ISR, but
        // neither is precached (globPatterns is assets-only), so cache the
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
  },

  // Rate-limit counter store (server/utils/rateLimit.ts). Prod prefers Upstash
  // Redis — a single shared store across every Vercel serverless instance, so the
  // per-IP limit holds globally instead of per-instance. Provisioned via the
  // Vercel Marketplace Upstash KV integration, which auto-populates
  // KV_REST_API_URL + KV_REST_API_TOKEN; the unstorage upstash driver defaults
  // to UPSTASH_REDIS_REST_* names, so we point url/token at Vercel's vars
  // explicitly. When those creds are absent (no Upstash provisioned), fall back
  // to the in-memory driver rather than instantiating a urlless Upstash client
  // that throws on every request — rate limiting then holds per-instance only,
  // which is degraded but keeps the app serving. Dev always uses in-memory.
  $development: {
    // offline plumbing defaults ON in dev so it's testable locally without setting
    // an env var (the SW itself still needs a prod build — see pwa.devOptions)
    runtimeConfig: { public: { offline: true } },
    nitro: {
      storage: {
        kv: { driver: "memory" },
      },
    },
  },
  $production: {
    nitro: {
      storage: {
        kv:
          process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
            ? {
                driver: "upstash",
                url: process.env.KV_REST_API_URL,
                token: process.env.KV_REST_API_TOKEN,
              }
            : { driver: "memory" },
      },
    },
  },

  nitro: {
    // Pre-compress static assets (the client JS/CSS) at build time so they ship
    // gzip + brotli. Nitro serves the .br/.gz variant with the right
    // Content-Encoding + Vary on node-server / self-host / `nuxt preview`; on
    // Vercel the edge compresses on the fly, so this is a harmless belt-and-
    // braces that also keeps the site fast off-Vercel (portable Nitro, decision
    // #10). Dynamic SSR/API responses are compressed by Vercel's edge in prod.
    compressPublicAssets: { gzip: true, brotli: true },
    // Keep PGlite's ~17 MB wasm OUT of the deployed server bundle (it was 77% of
    // the output). It's the local-dev DB only — production always has
    // DATABASE_URL and takes the Neon branch in server/utils/db.ts. The
    // drizzle-orm/pglite driver file still ships (tiny JS); only the wasm
    // package is dropped. Locally, Node resolves @electric-sql/pglite by walking
    // up from .output to the workspace's node_modules, so `nuxt preview` and the
    // seed/audit scripts keep working unchanged.
    externals: {
      traceOptions: {
        // function form: node-file-trace matches string globs against paths
        // relative to its base ("/"), which proved brittle — predicate it instead
        ignore: (path: string) => path.includes("node_modules/@electric-sql/pglite/"),
      },
    },
  },

  // Dev-only: the dev server runs behind a proxy (preview tooling) whose Host
  // header isn't localhost; Vite 7 otherwise rejects those requests with 426
  // Upgrade Required. Only affects `nuxt dev`, never the prod build.
  vite: {
    server: {
      allowedHosts: true,
    },
  },

  css: ["~/assets/styles/main.scss"],

  components: [
    // pathPrefix:false so components register without directory prefixes
    // (e.g. ItemRow, not ListItemRow) — same convention as the portfolio.
    { path: "~/components", pathPrefix: false },
  ],

  devtools: { enabled: false },

  app: {
    head: {
      htmlAttrs: { lang: "en" },
      title: "Mahonia — pack lists, weighed",
      meta: [
        { charset: "utf-8" },
        {
          name: "viewport",
          // viewport-fit=cover lets content reach the screen edges (safe-area insets
          // handle the notch). The iOS pinch-zoom phantom-margin bug (WebKit 240860)
          // is NOT fixed here — `minimum-scale=1` is inert on iOS (it always allows
          // pinch-zoom as an a11y override) — it's fixed in CSS via overflow-x:clip
          // on BOTH html and body (see app/assets/styles/foundations/reset.scss).
          content: "width=device-width, initial-scale=1, viewport-fit=cover",
        },
        // Resolve light-dark() to the right mode on first paint (no flash).
        { name: "color-scheme", content: "light dark" },
        // Browser/PWA chrome colour (address bar, installed-app title bar) tracks
        // the page's --paper in each mode.
        { name: "theme-color", media: "(prefers-color-scheme: light)", content: "#ffffff" },
        { name: "theme-color", media: "(prefers-color-scheme: dark)", content: "#000000" },
        {
          name: "description",
          content:
            "Make a packing list, see what it weighs, share it. No login.",
        },
        // Social card. The editor (the landing page) is `ssr: false`, so runtime
        // useSeoMeta can't reach crawlers there — this static set is what unfurls the
        // bare domain. og:image MUST be absolute and the editor shell has no request
        // context, so the canonical prod host is pinned here (the one place we hard-set
        // a URL; sitemap/SSR routes still derive the host from the request). SSR routes
        // (/s, /l) override og:title/description per-list via their own useSeoMeta.
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "Mahonia" },
        { property: "og:title", content: "Mahonia — pack lists, weighed" },
        {
          property: "og:description",
          content: "Make a packing list, see what it weighs, share it. No login.",
        },
        { property: "og:image", content: "https://mahonia.app/og.jpg" },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { property: "og:image:type", content: "image/jpeg" },
        { property: "og:image:alt", content: "Mahonia — Oregon grape in flower and fruit" },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:image", content: "https://mahonia.app/og.jpg" },
      ],
      link: [
        // Icon set (files in public/). The SVG is the primary favicon (vector,
        // dark-mode aware); the ICO is the legacy/RSS fallback — Safari takes the
        // apple-touch-icon since it ignores SVG favicons.
        { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
        { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
        { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
        { rel: "manifest", href: "/manifest.webmanifest" },
      ],
    },
  },

  // Per-route rendering. "/" is a tiny redirect shell: it mints a fresh list and
  // forwards into the editor (app/pages/index.vue), so it renders identically for
  // every visitor — ISR caches that prerendered shell, revalidated every 10 min. The
  // editor stays a pure client island (edit token in the URL fragment, no SSR value).
  // Everything else (legal pages, the public /l read view) is SSR by default.
  routeRules: {
    // Security headers on EVERY route — including prerendered/static ones. The
    // server middleware only runs for dynamic responses, so prerendered routes
    // (/e, the legal pages) previously shipped with NO security headers; setting
    // them here (Nitro applies routeRules headers to the prerendered + static
    // output too) closes that gap and adds the CSP site-wide.
    "/**": { headers: SECURITY_HEADERS },
    // opening the site forwards straight into the editor, which starts an unsaved
    // draft — no list row is created until you actually add content
    "/": { redirect: "/e" },
    // The editor routes (/e and /e/{shareCode}) are SSR, but the editor BODY is a
    // client-only component (GearEditor.client.vue — IndexedDB, the singleton
    // controller, window refs), so it still runs only in the browser and no list data
    // is rendered server-side. SSR exists purely for the <head>: /e stays the generic
    // site card, while /e/{shareCode} resolves the list's name (by its PUBLIC share
    // code) so link-preview bots unfurl it. The secret edit token lives in the URL
    // fragment and is never sent to the server. (Previously /e was ssr:false; that
    // rule also suppressed data/head SSR on the nested /e/{shareCode} route.)
    //
    // Bare /e renders identically for everyone (generic head + a client-only body),
    // so PRERENDER it — the landing route (where "/" redirects) becomes a static
    // file served from the CDN: fastest possible TTFB and zero function invocations
    // on the site's most-hit route. /e/{shareCode} differs per code, so it gets a
    // short ISR window instead (collapses repeat opens + crawler bursts on a shared
    // pretty link; the head tolerates 60 s of staleness — the list BODY is always
    // live, it loads client-side from the fragment token).
    // `isr: N` (not `swr: N`): on the Vercel preset, `swr` maps through nitro's
    // deprecated back-compat path to `{ expiration: false }` — cached until the
    // NEXT DEPLOY, not for N seconds (verified in nitropack's vercel preset).
    // `isr: N` writes `{ expiration: N }`, the intended revalidation window; on
    // non-Vercel targets it's simply inert.
    "/e": { prerender: true },
    "/e/**": { isr: 60 },
    // pure-static pages → build-time prerender (CDN-served, zero invocations)
    "/about": { prerender: true },
    "/changelog": { prerender: true },
    "/legal": { prerender: true },
    // Privacy + Terms were merged into /legal (two sections) — keep the old URLs
    // working with a permanent redirect (bookmarks, external links, llms.txt history)
    "/privacy": { redirect: { to: "/legal", statusCode: 301 } },
    "/terms": { redirect: { to: "/legal", statusCode: 301 } },
    // "Your lists" is a device-local read-out (localStorage) — prerender the shell,
    // the list fills in client-side; noindex (set per-page)
    "/mine": { prerender: true },
    // the catalog-changes page reads a slow-moving feed — a 10-minute ISR window
    // makes repeat views free without letting it go meaningfully stale
    "/changes": { isr: 600 },
  },
});
