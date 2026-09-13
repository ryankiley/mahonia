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
import { hugeiconsPrecision } from "./config/icons";
import { parseDevAllowedHosts } from "./config/devHosts";
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
    vite: {
      // The icon package bundled INTO the SSR build, so config/icons.ts's rounding
      // reaches the server side too. Vite's SSR build externalises node_modules and
      // Nitro bundles them afterwards, past every Vite transform, so without this the
      // share views would render a glyph's full-precision `d` on the server and
      // hydrate the rounded one on the client.
      //
      // PRODUCTION ONLY, like the plugin it exists for. Under `nuxt dev` the same
      // line makes vite-node inline the package's 6,025-re-export barrel — every
      // re-export a sequential awaited `__vite_ssr_import__` — which was measured at
      // 7–25 s on the first render of every dev start and ~+800 MB RSS. Dev leaves
      // both sides at full precision, which agree with each other regardless.
      ssr: { noExternal: ["@hugeicons/core-free-icons"] },
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
      // barrel loaded on every cold start. Since the production Vite SSR build
      // bundles the package itself (`$production.vite.ssr.noExternal`, for the
      // rounding), Nitro no longer meets a bare import of it and this entry is a
      // belt to that brace — keep both: dropping the other reintroduces a
      // server/client mismatch on every share view's glyphs.
      inline: ["@hugeicons/core-free-icons"],
      traceOptions: {
        // function form: node-file-trace matches string globs against paths
        // relative to its base ("/"), which proved brittle — predicate it instead
        ignore: (path: string) => path.includes("node_modules/@electric-sql/pglite/"),
      },
    },

  },

  hooks: {
    // Ship harfbuzz's wasm by hand, because nothing else will.
    //
    // satori 0.33 shapes text with harfbuzz (that's what moved the OG card's
    // glyph advances), and harfbuzzjs locates its binary as
    // `__dirname + "/hb.wasm"` — a runtime string concat. node-file-trace only
    // follows STATIC requires, so it copies hb.js and leaves hb.wasm behind:
    // `find .output -name '*.wasm'` came back empty. `nitro.externals.traceInclude`
    // is no help either; it adds trace ENTRY POINTS, and tracing from hb.js is
    // exactly what already fails.
    //
    // The failure this prevents is not a missing image, it's a dead instance.
    // harfbuzzjs/index.js is `module.exports = new Promise(...)` built at IMPORT
    // time, so the ENOENT surfaces as an unhandled rejection that never passes
    // through the try/catch in server/utils/ogCard.ts — under Node's default
    // --unhandled-rejections=throw the lambda dies, taking every concurrent
    // request with it. And nothing catches this before production: /og/l/:slug
    // and /og/s/:code are runtime SSR (never prerendered, so the build renders no
    // card), and vitest resolves satori from the intact node_modules where
    // hb.wasm sits right next to hb.js.
    //
    // REGISTERED THROUGH `nitro:init`, NOT `nitro.hooks`, and that distinction is
    // load-bearing. Nitro merges config-level hooks with defu, which cannot merge
    // two functions on the same key — it keeps ours and DROPS the preset's. The
    // vercel preset's own `compiled` hook is what writes .vercel/output/config.json,
    // so declaring `nitro: { hooks: { compiled } }` silently deleted the Build
    // Output API config and Vercel failed the deploy looking for a "dist"
    // directory, with a perfectly green nitro build above it. `nitro.hooks.hook()`
    // APPENDS a listener instead, so both run.
    //
    // serverDir rather than a hardcoded path so this follows the preset —
    // .output/server locally, .vercel/output/functions/__fallback.func on Vercel.
    "nitro:init"(nitro) {
      nitro.hooks.hook("compiled", async () => {
        const src = join(dirname(createRequire(import.meta.url).resolve("harfbuzzjs")), "hb.wasm");
        const dest = join(nitro.options.output.serverDir, "node_modules/harfbuzzjs/hb.wasm");
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(src, dest);
      });
    },
  },

  // Hidden client sourcemaps on request — `.map` files beside the chunks, never
  // referenced by them, so the JS is byte-identical with or without. CI builds with
  // BUNDLE_MAPS=1 so scripts/bundle-budget.mjs can charge each chunk's bytes back
  // to the source files that make it up, and post a PR's delta against main by
  // source rather than by hash. Off by default: Vercel's build doesn't need them
  // and shouldn't ship them.
  //
  // `undefined`, not `{ client: false }`, when they're not asked for: the schema
  // resolves an absent key to `{ server: true, client: dev }`, and an object here
  // is spread OVER that default — `client: false` (or `client: undefined`, the key
  // is copied) switched off `nuxt dev`'s CSS sourcemaps for everyone. Measured.
  sourcemap: process.env.BUNDLE_MAPS === "1" ? { client: "hidden" } : undefined,

  vite: {
    // the icon set's path data rounded to two decimals at build time — see
    // config/icons.ts for the measurement and the proof that nothing moves
    plugins: [hugeiconsPrecision()],
    // (…and bundled into the SSR build so the server side rounds too — but only in
    // production; see `$production.vite.ssr` above for why not in dev.)
    build: {
      rolldownOptions: {
        // Skip loading the 6,000 re-exports of @hugeicons/core-free-icons' barrel
        // that nothing imports. Rolldown otherwise loads and transforms every one of
        // them on both build sides to keep the ~70 the app draws (measured: 6,026
        // modules → 3, ~890 → ~220 ms, output byte-identical). The package is
        // `sideEffects: false` and its index is pure re-exports, which is the shape
        // the optimisation is for; rolldown plans to make it the default. Here, not
        // under $client, so the SSR build gets it too.
        experimental: { lazyBarrel: true },
      },
    },
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
    // How the client build is cut into files. Client only: the same groups on the
    // server build broke Nitro's style chunks with an unresolvable placeholder name.
    //
    // Left to itself the bundler makes one chunk per distinct SET of importers, so
    // every module the app shell shares with a lazy panel or a route lands in its
    // own file. The editor's first load was 39 script files, 22 of them under 1 KB
    // brotli (one held a single 27-byte module), and the split cost twice: 38 extra
    // requests, and ~17 KB brotli of compression lost at the file boundaries — the
    // same bytes compress to 128 KB as one file and 145 KB as thirty-nine.
    //
    // Two groups, both over `$initial` (modules statically reachable from the entry,
    // i.e. downloaded by every page before anything renders — so merging them can't
    // put a byte on a page that didn't already carry it):
    //   vendor — the framework runtime (vue, vue-router, unhead, ofetch…). A leaf:
    //            nothing in it imports app code, so it is a stable file whose hash
    //            only moves on a dependency bump, and returning visitors keep it
    //            cached across deploys. nuxt's own runtime and the analytics
    //            module are kept OUT because they import app modules (plugins,
    //            app.vue) — inside vendor they would make the two chunks import
    //            each other, and a circular chunk pair can evaluate app code
    //            before the vue bindings it reads exist. Dependencies are not
    //            captured recursively for the same reason: the entry's imports
    //            reach the whole app. The budget script fails the build if this
    //            chunk ever imports another: a future dependency on the boot path
    //            that reaches for #app would be captured here and form exactly
    //            that cycle, and nothing else would notice before production.
    //   boot   — everything else on the boot path: nuxt runtime, plugins, app.vue,
    //            the composables the session plugin pulls in.
    // Measured on the same tree: the editor's first load went from 45 files to 19
    // (39 → 14 scripts) and 158.4 → 148.2 KB brotli; every route lost ~26 files and
    // ~10 KB. The largest chunk is now `boot` (52.9 KB) rather than Leaflet.
    //
    // TRIED AND DROPPED: a third, entries-aware group merging the small chunks the
    // editor shares with the read views (rolldown's entriesAwareMergeThreshold).
    // It merged toward the wrong neighbours — the editor lost 4 files while /about
    // and /account gained ~13 KB of editor-only code. What remains split is shared
    // between routes with different needs, and the automatic cut is the right one.
    // Pages and layouts must never be captured by a group: a captured page loses
    // its manifest identity and its chunk drops out of the HTML's preload hints.
    $client: {
      build: {
        rolldownOptions: {
          output: {
            // The framework chunk keeps its group name in the file name, so the
            // bundle-budget script can find it and check that it is still a LEAF —
            // see the vendor group below for why a vendor chunk that imports app
            // code is a boot crash, not a slowdown. Everything else keeps Nuxt's
            // hash-only name; the `_nuxt/` prefix is Nuxt's own buildAssetsDir
            // default, restated here because a file-name option replaces it whole.
            chunkFileNames: (chunk: { name: string }) =>
              chunk.name === "vendor" ? "_nuxt/vendor.[hash].js" : "_nuxt/[hash].js",
            // The hidden maps (BUNDLE_MAPS) carry no source text: bundle-budget's
            // attribution reads only `sources` and `mappings`, and `sourcesContent`
            // was 82 % of 4.5 MB of maps nobody opens. Inert when maps are off.
            sourcemapExcludeSources: true,
            codeSplitting: {
              groups: [
                {
                  name: "vendor",
                  test: /node_modules\/(?!\.cache\/|nuxt\/|@vercel\/)/,
                  tags: ["$initial"],
                  includeDependenciesRecursively: false,
                  priority: 2,
                },
                { name: "boot", tags: ["$initial"], priority: 1 },
              ],
            },
          },
        },
      },
    },
    // Dev-only, and only for a dev server on a loopback host (`dev:preview`, the
    // Browser pane's). Vite accepts localhost and IP addresses by default; a proxy
    // or a phone reaching the server by another name (a .local hostname) adds it
    // through MAHONIA_DEV_ALLOWED_HOSTS (documented in .env.example). This is NOT
    // the DNS-rebinding guard it looks like: `npm run dev` binds 0.0.0.0, and for a
    // public host @nuxt/cli sets allowedHosts to `true` itself after this config
    // is read (its #createListener), so there any Host is answered whatever is
    // written here. Never reaches the prod build.
    server: {
      allowedHosts: parseDevAllowedHosts(process.env.MAHONIA_DEV_ALLOWED_HOSTS),
    },
  },

  experimental: {
    // "client", not the default `true`: the prerendered pages (/, /e, /about, /legal)
    // used to ship their Nuxt payload as a separate `_payload.json` that hydration
    // waits on — a request on the critical path of the site's two front doors, for
    // a payload that is 69 bytes of nothing. With "client" the payload is inlined
    // in the HTML on first load, and the `_payload.json` files are still written and
    // still used for client-side navigation (the footer's link to /about reads the
    // prerendered page from its payload instead of rendering again). This is
    // the default Nuxt 5 will move to.
    payloadExtraction: "client",
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
            "Make a packing list, see what it weighs, share it. No login needed.",
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
          content: "Make a packing list, see what it weighs, share it. No login needed.",
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

  // Per-route rendering. "/" is a tiny client-decided page (app/pages/index.vue: the
  // list you opened last, else a fresh draft); the editor stays a pure client island (edit token in
  // the URL fragment, no SSR value). Everything else (legal pages, the public /l
  // read view) is SSR by default.
  routeRules: {
    // Security headers on EVERY route — including prerendered/static ones. A
    // server middleware would only run for dynamic responses, leaving prerendered
    // routes (/e, the legal pages) with NO security headers — which is how they
    // once shipped; setting them here (Nitro applies routeRules headers to the
    // prerendered + static output too) closes that gap and adds the CSP site-wide.
    "/**": { headers: SECURITY_HEADERS },
    // opening the site lands on the list you had open last, or on /e (an unsaved
    // draft — no list row is created until you actually add content). The page
    // decides in the browser, so it renders the same nothing for everyone: prerender
    // it, like /e.
    "/": { prerender: true },
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
    // so PRERENDER it — the landing route (where "/" sends a first-time visitor) becomes a static
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
    // Privacy + Terms were merged into /legal (two sections) — keep the old URLs
    // working with a permanent redirect (bookmarks, external links, llms.txt history).
    // The changelog is GitHub's Releases now — the same entries, one release per day
    // that ships something, with a feed — so /changelog goes there. It was a page, then
    // a section of /about, then a page again, and the site was only ever mirroring it.
    "/privacy": { redirect: { to: "/legal", statusCode: 301 } },
    "/terms": { redirect: { to: "/legal", statusCode: 301 } },
    "/changelog": { redirect: { to: "https://github.com/ryankiley/mahonia/releases", statusCode: 301 } },
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
