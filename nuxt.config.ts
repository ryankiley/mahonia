// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ["@vueuse/nuxt"],

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
          content:
            "width=device-width, initial-scale=1, viewport-fit=cover",
        },
        // Resolve light-dark() to the right mode on first paint (no flash).
        { name: "color-scheme", content: "light dark" },
        {
          name: "description",
          content:
            "Make a packing list, see what it weighs, share it. No login.",
        },
      ],
    },
  },

  // Per-route rendering. The home discovery feed is ISR (server-rendered + cached,
  // revalidated every 10 min) for SEO/FCP; its localStorage "My Lists" section is
  // wrapped in <ClientOnly> so it can't cause a hydration mismatch. The editor
  // stays a pure client island (edit token in the URL fragment, no SSR value).
  routeRules: {
    "/": { isr: 600 },
    "/e": { ssr: false },
  },

  future: { compatibilityVersion: 4 },
});
