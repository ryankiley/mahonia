// https://nuxt.com/docs/api/configuration/nuxt-config

import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// The one external host, the CSP built from it, and the headers every route
// carries — all in config/security.ts, with the reasoning that goes with them.
// Imported rather than inlined so tests/csp.test.ts can read the real values
// instead of regexing them out of this file.
import { SECURITY_HEADERS, TILE_ORIGIN } from "./config/security";
import { PWA_OPTIONS } from "./config/pwa";
// The canonical origin, single-sourced — the server reads the same constant to
// decide what host a sign-in link may point at (server/utils/origin.ts), so the
// social card and that decision can't drift onto different domains.
import { CANONICAL_ORIGIN } from "./shared/site";

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
      // The map reads its host from here rather than hardcoding it, so the tile URL
      // and the CSP that permits it can never drift apart — one constant feeds both.
      tileOrigin: TILE_ORIGIN,
    },
  },

  // service worker, Workbox runtime caching, and what an offline visit still
  // does — config/pwa.ts, with the reasoning for each choice. Honours the
  // offline kill switch above by way of app/plugins/pwa.client.ts.
  pwa: PWA_OPTIONS,

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
  //
  // DO NOT "CLEAN UP" @upstash/redis. `driver: "upstash"` below is a string, so
  // nothing in this repo imports the package — a dependency audit will report it
  // as having zero references and it looks exactly like dead weight. It isn't:
  // unstorage declares @upstash/redis as an OPTIONAL peer dependency, so the
  // direct entry in package.json is the only thing that installs the client this
  // driver resolves at runtime. Removing it breaks rate limiting in production
  // only, silently, on the branch no local run ever takes.
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
    // Keep PGlite's ~17 MB wasm OUT of the deployed server bundle (it was 77% of
    // the output). It's the local-dev DB only — production always has
    // DATABASE_URL and takes the Neon branch in server/utils/db.ts. The
    // drizzle-orm/pglite driver file still ships (tiny JS); only the wasm
    // package is dropped. Locally, Node resolves @electric-sql/pglite by walking
    // up from .output to the workspace's node_modules, so `nuxt preview` and the
    // seed/audit scripts keep working unchanged.
    externals: {
      // Bundle the icon package INTO the server build rather than shipping it as
      // an external: it is sideEffects-free and only a handful of icons are used,
      // so inlining tree-shakes it to those, where the external copy was the whole
      // package (24 MB / 6,000 files, 65% of the server output) plus a 673 KB
      // barrel loaded on every cold start.
      inline: ["@hugeicons/core-free-icons"],
      traceOptions: {
        // function form: node-file-trace matches string globs against paths
        // relative to its base ("/"), which proved brittle — predicate it instead
        ignore: (path: string) => path.includes("node_modules/@electric-sql/pglite/"),
      },
    },

    hooks: {
      // Ship harfbuzz's wasm by hand, because nothing else will.
      //
      // satori 0.33 shapes text with harfbuzz (that's what moved the OG card's
      // glyph advances), and harfbuzzjs locates its binary as
      // `__dirname + "/hb.wasm"` — a runtime string concat. node-file-trace only
      // follows STATIC requires, so it copies hb.js and leaves hb.wasm behind:
      // `find .output -name '*.wasm'` came back empty. `externals.traceInclude`
      // is no help either; it adds trace ENTRY POINTS, and tracing from hb.js is
      // exactly what already fails.
      //
      // The failure this prevents is not a missing image, it's a dead instance.
      // harfbuzzjs/index.js is `module.exports = new Promise(...)` built at
      // IMPORT time, so the ENOENT surfaces as an unhandled rejection that never
      // passes through the try/catch in server/utils/ogCard.ts — under Node's
      // default --unhandled-rejections=throw the lambda dies, taking every
      // concurrent request with it. And nothing catches this before production:
      // /og/l/:slug and /og/s/:code are runtime SSR (never prerendered, so the
      // build never renders a card), and vitest resolves satori from the intact
      // node_modules where hb.wasm sits right next to hb.js.
      //
      // serverDir rather than a hardcoded path so this follows the preset —
      // .output/server locally, .vercel/output/functions/__fallback.func on
      // Vercel.
      async compiled(nitro) {
        const src = join(dirname(createRequire(import.meta.url).resolve("harfbuzzjs")), "hb.wasm");
        const dest = join(nitro.options.output.serverDir, "node_modules/harfbuzzjs/hb.wasm");
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(src, dest);
      },
    },
  },

  vite: {
    // Compile out Vue's Options-API runtime (data()/mixins/computed-object
    // components). Every component here is <script setup>, and the client's Vue
    // dependencies are too (vue-router's views, Nuxt's own components; the icon
    // component is app/utils/hugeicon.ts, functional). The flag is Vue's own
    // documented tree-shaking switch — a few KB off every page for code nothing
    // calls. TRIPWIRE: a future dependency that ships an Options-API component
    // will break loudly at runtime with this off; if one ever must be adopted,
    // delete this define (the cost is only the bytes coming back).
    define: {
      __VUE_OPTIONS_API__: false,
    },
    // NOTE ON LICENSE BANNERS, so the next person doesn't retry what didn't
    // work. Leaflet ships its BSD-2 copyright in a `/* @preserve */` banner, and
    // the build strips it — grep .output/public after a build and "Agafonkin"
    // appears zero times while Leaflet's code is plainly there. Setting
    // `esbuild: { legalComments: "eof" }` here does NOT bring it back (tried,
    // rebuilt, still absent): Vite's esbuild option governs the source transform,
    // not the minify pass that drops it. The notice requirement is met by
    // public/licenses.txt instead, which is deterministic and covers every
    // bundled library rather than only the ones that happen to carry a banner.
    // Shared SCSS breakpoint vars, prepended to every SFC `lang="scss"` style
    // block so plain `@media (max-width: $bp-stack)` queries share the tokens'
    // anchors. Sass module scoping keeps this injection out of @use'd files, so
    // foundations/tokens.scss carries the same declarations (`!default`) for its
    // own math — a retune must change both places.
    css: {
      preprocessorOptions: {
        scss: {
          additionalData: "$bp-stack: 720px; $bp-full: 1024px;",
        },
      },
    },
    // Dev-only: the dev server runs behind a proxy (preview tooling) whose Host
    // header isn't localhost; Vite 7 otherwise rejects those requests with 426
    // Upgrade Required. Only affects `nuxt dev`, never the prod build.
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
      // KEEP IN STEP WITH public/manifest.webmanifest, which repeats this title as
      // `name` and the description below as `description`. That file is strict JSON
      // and hand-written (pwa.manifest is false), so it can carry no comment of its
      // own and nothing checks the two agree — an installed app whose name disagrees
      // with its page title is the failure mode. See config/pwa.ts.
      title: "Mahonia — pack lists, weighed",
      // no charset entry: Nuxt prepends { charset: "utf-8" } itself when none is set
      meta: [
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
        // Social card. The editor (the landing page) is prerendered, and this static
        // set is what unfurls the bare domain for a crawler that reads no further.
        // og:image MUST be absolute and the prerendered shell has no request
        // context, so the canonical prod host is used here (from shared/site.ts, which
        // is now the one place that host is written down; sitemap/robots still derive
        // theirs from the request, since a forged host there answers only itself). SSR
        // routes (/s, /l) override og:title/description per-list via their own useSeoMeta.
        { property: "og:type", content: "website" },
        { property: "og:site_name", content: "Mahonia" },
        { property: "og:title", content: "Mahonia — pack lists, weighed" },
        {
          property: "og:description",
          content: "Make a packing list, see what it weighs, share it. No login.",
        },
        { property: "og:image", content: `${CANONICAL_ORIGIN}/og.png` },
        { property: "og:image:width", content: "1200" },
        { property: "og:image:height", content: "630" },
        { property: "og:image:type", content: "image/png" },
        { property: "og:image:alt", content: "The Mahonia M. Pack lists, weighed." },
        { name: "twitter:card", content: "summary_large_image" },
        { name: "twitter:image", content: `${CANONICAL_ORIGIN}/og.png` },
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

  // Per-route rendering. "/" is a bare redirect into the editor (the rule below —
  // there is no index page); the editor stays a pure client island (edit token in
  // the URL fragment, no SSR value). Everything else (legal pages, the public /l
  // read view) is SSR by default.
  routeRules: {
    // Security headers on EVERY route — including prerendered/static ones. A
    // server middleware would only run for dynamic responses, leaving prerendered
    // routes (/e, the legal pages) with NO security headers — which is how they
    // once shipped; setting them here (Nitro applies routeRules headers to the
    // prerendered + static output too) closes that gap and adds the CSP site-wide.
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
    // on the site's most-hit route.
    //
    // /e/{shareCode} is rendered per request, NOT cached. It used to carry
    // `isr: 60`, on the reasoning that the head "tolerates 60 s of staleness" —
    // which was true of the visitor that rule was written for (an unfurl bot, once,
    // when you paste the link) and false of the one who actually reloads this route.
    // That's the list's OWNER: rename a list, hit refresh, and the tab came back
    // wearing the old name, because the cached HTML was minted before the rename.
    // The body was always right — it loads client-side — so the two disagreed, on
    // the one surface you can't scroll away from.
    //
    // The cost of dropping it is one invocation per open of a capability link, which
    // is the cheapest traffic on the site: /s/{code} and /l/{slug} carry the PUBLIC
    // share traffic and are already uncached SSR, so this can't be the expensive
    // route. Freshness on your own list's name is worth more than collapsing a
    // burst that, on an edit link, is one bot deep.
    //
    // Note this is the ONLY cache in the head's path: /api/s sets s-maxage, but a
    // server-side useFetch calls that handler in-process and never passes the CDN,
    // so the SSR render always reads live. (Verified: a browser fetch of /api/s
    // returned the pre-rename title from stale-while-revalidate while the same
    // moment's full reload rendered the new one.)
    "/e": { prerender: true },
    // pure-static pages → build-time prerender (CDN-served, zero invocations)
    "/about": { prerender: true },
    "/legal": { prerender: true },
    // Privacy + Terms were merged into /legal (two sections), and What's new into
    // /about the same way — keep the old URLs working with a permanent redirect
    // (bookmarks, external links, llms.txt history). No #hash on the changelog
    // redirect: a fragment never reaches the server, so it can't be preserved
    // through one; /about carries the "Jump to What's new" link instead.
    "/privacy": { redirect: { to: "/legal", statusCode: 301 } },
    "/terms": { redirect: { to: "/legal", statusCode: 301 } },
    "/changelog": { redirect: { to: "/about", statusCode: 301 } },
    // "Your lists" was a page; it is the editor's switcher now, and the two actions it
    // owned (forget on this device, delete for everyone) are rows in the editor's ⋯
    // menu. Redirected rather than dropped: it was linked from the footer of every
    // page for the app's whole life, so it is in bookmarks and in other people's
    // links. /e is where the lists now are.
    "/mine": { redirect: { to: "/e", statusCode: 301 } },
    // "Your gear vault" became "My Gear" in the chrome a while back, but the URL kept
    // the old name — the one place the retired word was still shown to anyone. The
    // internal word stays put on purpose (the API is /api/vault/*, the tables are
    // vault_*, the classes are .vault__*); this is only what people see and share.
    "/vault": { redirect: { to: "/gear", statusCode: 301 } },
    // the catalog-changes page reads a slow-moving feed — a 10-minute ISR window
    // makes repeat views free without letting it go meaningfully stale
    "/changes": { isr: 600 },
  },
});
