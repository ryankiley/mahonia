# Gear

A no-login ultralight gear-list / pack-weight tracker — a better LighterPack.

Make a packing list, see what it weighs, share it. No account, no closet, no trip log,
no AI. The list is the hero; weight is optional. Build and share a list with zero weights
and the totals simply don't show — the gear database and weight depth are the engine, kept
ambient, not the pitch.

## What it does

- **No-login editor** — build a list of folders and items in the browser; it persists to
  `localStorage` and syncs to the server only when you choose to share or publish.
- **Optional, unit-aware weights** — grams, kilograms, ounces, or pounds, stored as integer
  milligrams. Live **base / worn / consumable** totals with a progressively-disclosed
  breakdown and an SVG category bar. Packed-mode checklist.
- **Folders with inherited classification** — each folder carries a default classification
  (`base` / `worn` / `consumable`) that items inherit unless they override it. One field, not
  two booleans, so an item can't be both worn and consumable.
- **A cited gear catalog** — a curated, citation-backed weight database (~440 rows) powers
  item autocomplete. Picking a catalog item links it, so you get a nudge when the catalog
  weight later changes. Corrections are trust-tiered: a private per-user override, or a
  versioned "fix for everyone" with revert and citation-gated promotion.
- **Dual-link sharing, no accounts** — a secret **edit** link (saved to "My Lists" in
  `localStorage`) and a separate read-only **share** link. The public discovery feed only ever
  exposes the read capability. See the security notes below.
- **Public discovery feed** — publish a list to a browsable feed with trip-type tabs and
  recent / most-viewed / lightest sorts.
- **Exports** — Markdown, CSV, and a plain-text summary for pasting anywhere (~0 KB, no deps).

## Stack

- [Nuxt 4](https://nuxt.com) (Vue 3, Nitro) + TypeScript
- [Drizzle ORM](https://orm.drizzle.team) over Postgres — [Neon](https://neon.tech) in
  production, [PGlite](https://github.com/electric-sql/pglite) for local dev (driver-agnostic
  schema)
- [Upstash Redis](https://upstash.com) for the shared rate-limit store in production
  (in-memory in dev)
- SCSS design tokens; deployed on [Vercel](https://vercel.com)

Framework lock-in is kept near-zero by keeping domain logic in framework-agnostic `shared/`
modules and holding the URL + token schemes stable.

## Architecture

- **One op-reducer, two runtimes.** Mutations flow through a single reducer in
  [`shared/ops.ts`](shared/ops.ts), applied optimistically on the client and authoritatively
  on the server, so the two can't drift. A list's content (folders + items) lives in one JSONB
  `data` column; weight rollups are cached as columns for the feed leaderboard sort.
- **Capability-routed API.** The server is addressed by *capability* (edit token / share code),
  never by internal id — which is never exposed in a URL or response. Unknown capabilities get
  a 404, not a 403.
- **Ultralight code.** The product shaves grams; the codebase shaves bytes. Minimal JS/CSS, a
  brotli bundle-budget gate (`npm run bundle-budget`), hand-rolled SVG chart and CSV/Markdown
  exporters, no heavy dependencies, server-only data layer.

```
app/        Nuxt app — pages, components, composables, SCSS tokens
server/     Nitro API routes, Drizzle schema, capability repos, middleware
shared/     Framework-agnostic domain logic (types, op-reducer, weights, exporters)
scripts/    Catalog build / audit / seed, bundle-budget gate
seed/       catalog.csv + cited research JSON it's built from
tests/      Vitest unit tests
```

## Security model

- **Edit access is not URL-hackable.** A 256-bit edit token, hashed at rest. It travels in the
  URL *fragment* (kept out of server logs and `Referer`) and is sent as a header (CSRF-immune),
  and it's rotatable. Read sharing is a separate short Crockford-base32 code at `/s/{code}`.
- **Concurrency.** A `version` column with 409 optimistic concurrency, since a shared edit link
  can have two editors.
- **Rate limiting.** Per-IP token buckets on the public mutating endpoints, backed by a shared
  Upstash store and keyed on Vercel's trusted client-IP header (never the spoofable leftmost
  `X-Forwarded-For`).
- **Privacy.** No stored IP hashes; partial unique indexes with real hard-delete; snapshots for
  vandalism recovery.

## Local development

Requires **Node 24** — Nuxt 4.4.8's dev server does not run on Node 25. The version is pinned in
[`.nvmrc`](.nvmrc) / [`.node-version`](.node-version).

```bash
npm install

# Seed the local PGlite database (a fresh .data/pglite dir has the schema but
# zero catalog rows, so autocomplete will silently show nothing until you seed).
npm run seed

npm run dev          # http://localhost:3000
```

> If a blank page loads over `localhost`/IPv6, use `npm run dev:preview` (binds `::1`) — the
> dev server binds a stray IPv6 socket that 426s non-WS requests.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server |
| `npm run build` / `npm run preview` | Production build / preview |
| `npm test` | Run the Vitest unit suite |
| `npm run typecheck` | `vue-tsc` typecheck |
| `npm run bundle-budget` | Enforce the brotli JS/CSS budget |
| `npm run seed` | Seed the catalog into the local DB |
| `npm run catalog:build` | Rebuild `seed/catalog.csv` from `seed/_research/*.json` |
| `npm run catalog:audit` | Audit catalog rows |

### Catalog pipeline

`seed/catalog.csv` is a pure, faithful rebuild of `seed/_research/*.json` (a rebuild produces an
empty git diff). To add gear: write a new research file → `catalog:build` → `catalog:audit` →
`seed`.

## License

Private, for now.
