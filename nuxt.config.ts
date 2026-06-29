// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ["@vueuse/nuxt", "@vercel/analytics"],

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

  future: { compatibilityVersion: 4 },
});
