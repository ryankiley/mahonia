// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  // Pin date-gated Nuxt/Nitro defaults so builds are reproducible across CI/Vercel
  // (an unset compatibilityDate falls back to "today" and can shift under us).
  compatibilityDate: "2026-06-30",

  // @vercel/analytics ships its Nuxt module at the `/nuxt` subpath; the bare
  // specifier resolves to the plain inject()/track() API (NOT a defineNuxtModule),
  // so registering "@vercel/analytics" silently injected nothing.
  modules: ["@vueuse/nuxt", "@vercel/analytics/nuxt", "@vite-pwa/nuxt"],

  // Master switch for the offline plumbing (service worker + background sync, and
  // the offline catalog search). OFF by default so the whole feature ships DORMANT
  // — real users see no change until NUXT_PUBLIC_OFFLINE=true is set at deploy
  // time. Dev defaults ON (see $development below) so it's testable locally.
  runtimeConfig: {
    public: {
      offline: process.env.NUXT_PUBLIC_OFFLINE === "true",
    },
  },

  // @vite-pwa generates the service worker + Workbox runtime, but we keep it INERT
  // in production: `manifest: false` (no <link rel=manifest> → not installable, no
  // affordance), `injectRegister: false` (no auto-registration — a gated client
  // plugin, app/plugins/pwa.client.ts, calls registerSW() only when the offline
  // flag is on). `autoUpdate` = silent updates, never a "new version, reload?"
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
        // editor shell — Nuxt serves /e dynamically (ssr:false), so there's no
        // static HTML to precache; cache the navigation response instead so a prior
        // online visit lets the editor boot offline. NetworkFirst keeps online users
        // on the fresh shell (so its referenced chunks match the live precache).
        {
          urlPattern: /\/e\/?$/,
          handler: "NetworkFirst",
          options: {
            cacheName: "mahonia-shell",
            networkTimeoutSeconds: 3,
            expiration: { maxEntries: 4, maxAgeSeconds: 60 * 60 * 24 * 7 },
          },
        },
        // public read views — mirror their stale-while-revalidate edge headers so a
        // previously-opened list still renders offline
        {
          urlPattern: /\/api\/l\/.*/,
          handler: "StaleWhileRevalidate",
          options: {
            cacheName: "mahonia-list-data",
            expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 7 },
          },
        },
        {
          urlPattern: /\/l\/[^/]+$/,
          handler: "StaleWhileRevalidate",
          options: {
            cacheName: "mahonia-list-pages",
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
    },
  },

  // Per-route rendering. "/" is a tiny redirect shell: it mints a fresh list and
  // forwards into the editor (app/pages/index.vue), so it renders identically for
  // every visitor — ISR caches that prerendered shell, revalidated every 10 min. The
  // editor stays a pure client island (edit token in the URL fragment, no SSR value).
  // Everything else (legal pages, the public /l read view) is SSR by default.
  routeRules: {
    // opening the site forwards straight into the editor, which starts an unsaved
    // draft — no list row is created until you actually add content
    "/": { redirect: "/e" },
    "/e": { ssr: false },
  },
});
