// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: ["@vueuse/nuxt"],

  // Rate-limit counter store (server/utils/rateLimit.ts). Prod is Upstash Redis
  // — a single shared store across every Vercel serverless instance, so the
  // per-IP limit holds globally instead of per-instance. Provisioned via the
  // Vercel Marketplace Upstash KV integration, which auto-populates
  // KV_REST_API_URL + KV_REST_API_TOKEN; the unstorage upstash driver defaults
  // to UPSTASH_REDIS_REST_* names, so we point url/token at Vercel's vars
  // explicitly. Dev uses an in-memory driver so local runs need no Upstash.
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
        kv: {
          driver: "upstash",
          url: process.env.KV_REST_API_URL,
          token: process.env.KV_REST_API_TOKEN,
        },
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
      title: "Gear — pack lists, weighed",
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

  // The editor is a client island; read views SSR. Per-route rendering is
  // tuned in a later phase (ISR feed, SSR read views, ssr:false editor).
  // For the client-first slice both routes are localStorage-driven → ssr:false.
  routeRules: {
    "/": { ssr: false },
    "/e": { ssr: false },
  },

  future: { compatibilityVersion: 4 },
});
