# Adversarial Security Review — Mahonia

**Date:** 2026-06-28
**Scope:** Full repository (Nuxt 4 / Nitro server, shared logic, DB layer, client).
**Method:** Manual adversarial review of every server endpoint, the capability
(auth) model, the DB/repository layer, the shared reducer/validation logic, the
import/export paths, and the client for injection sinks. Threat model: anonymous
internet attackers, malicious list editors (the shared-edit-link model means list
content can come from someone other than the viewer), and abuse of the public
catalog "wiki".

## Summary

The application is **well-hardened**. It uses a clean capability model (no
accounts, no cookies), parameterized queries throughout, allow-list input
normalization, and the source carries unusually careful security reasoning in
comments. No high- or critical-severity issues were found.

Two concrete defense-in-depth issues were identified and **fixed in this branch**;
several intentional design trade-offs are documented as accepted risk.

| # | Finding | Severity | Status |
|---|---------|----------|--------|
| 1 | CSV formula/DDE injection in CSV export | Low–Medium | **Fixed** |
| 2 | Admin/cron auth: non-constant-time compare + no rate limit | Low | **Fixed** |
| 3 | In-memory rate-limit fallback in prod when Upstash absent | Low | Accepted (documented) |
| 4 | Wiki-open weight edits for unverified catalog rows | Info | By design |
| 5 | Rate-limit IP trust for direct-to-origin requests | Info | Accepted (documented) |
| 6 | `lighterpackId` 500 on malformed percent-encoding (import) | Low | **Fixed (2nd pass)** |
| 7 | Community-intake catalog spam (branded + K-distinct) | Info | By design (2nd pass) |

---

## Findings

### 1. CSV formula / DDE injection in CSV export — Low–Medium — FIXED

`shared/exporters/csv.ts:listToCsv` quoted fields containing `" , \n` but did not
neutralize cells **beginning** with `=`, `+`, `-`, `@`, or a control character.
When such a CSV is opened in Excel / Google Sheets / LibreOffice, the cell is
interpreted as a formula (e.g. `=HYPERLINK(...)`, `=cmd|'/c calc'!A1` DDE),
enabling data exfiltration or, with the right client config, command execution.

**Why it is reachable with attacker-controlled content** (not just self-XSS):
- Mahonia's editing model shares a list via an **edit-link** — a second party can
  add items with crafted names/notes, then the list owner exports to CSV.
- The LighterPack URL importer ingests a third party's CSV into the user's editor;
  exporting it back out carries any malicious leading characters through.

**Fix:** export now prefixes any formula-leading cell with a single quote (the
standard mitigation), and `csvToListData` strips that guard again on import so the
app's own round-trip stays lossless. Added a regression test
(`tests/csv.test.ts` → "CSV formula-injection guard").

### 2. Admin & cron authentication — Low — FIXED

`catalog/revert.post.ts`, `admin/lists/restore.post.ts`, and
`routes/api/cron/corroborate-catalog.ts` compared the provided secret with `!==` /
`===`. String comparison short-circuits at the first differing byte, which is a
(theoretical, network-jitter-dominated) timing oracle on the secret. The two admin
endpoints also had **no rate limiting**, so the auth gate could be probed
unthrottled.

**Fix:** added `safeEqual()` in `server/utils/tokens.ts` — it SHA-256-hashes both
sides (so lengths are always equal and the raw secret length isn't observable) and
compares with `crypto.timingSafeEqual`. All three routes now use it, and the two
admin routes gained a per-IP `rateLimit(event, "admin", 30, 60_000)`. Behavior is
unchanged for legitimate callers (still 404 on any miss — no route-existence
oracle).

### 3. In-memory rate-limit fallback in production — Low — Accepted

`nuxt.config.ts`: when `KV_REST_API_URL`/`KV_REST_API_TOKEN` are not provisioned,
production falls back to an in-memory rate-limit store. On Vercel's serverless
fan-out this makes per-IP limits hold **per-instance** rather than globally,
materially weakening them. This is a deliberate "keep serving over fail closed"
choice and is documented in the config. **Recommendation:** ensure Upstash is
provisioned in prod, and consider a startup warning when it is absent.

### 4. Wiki-open weight edits for unverified catalog rows — Informational

`server/utils/catalog.ts:proposeCorrection` lets anyone change the weight of an
**unverified** catalog item instantly (rate-limited 20/min); a **verified** item's
weight only auto-applies with a citation from an allow-listed manufacturer/retailer
domain, otherwise it is recorded as `proposed`. This is the intended wiki model and
is well-bounded:
- `isTrustedSource` correctly guards the scheme first (rejecting
  `javascript://trusted.com/…`), strips `www.`, and matches host-or-subdomain.
- Every change is logged to `catalog_edits` and is admin-revertible.
- Poisoned weights do **not** retroactively change existing lists (list item
  weights are baked in at add time; catalog hydration only refreshes display
  names, never weights).

No change recommended; noted for awareness of the abuse surface.

### 5. Rate-limit client IP trust — Informational — Accepted

`server/utils/rateLimit.ts:getClientIp` deliberately avoids the spoofable leftmost
`X-Forwarded-For` and trusts only Vercel's edge-set headers. The residual — a
request sent directly to the `*.vercel.app` origin, bypassing the edge, could forge
those headers — is a platform exposure documented in the code. Out of scope to fix
here; mitigated by Vercel deployment protection if desired.

### 6. `lighterpackId` crashes on malformed percent-encoding — Low — FIXED (2nd pass)

`shared/lighterpack.ts:lighterpackId` ran `decodeURIComponent(m[1])` on the URL's
path segment. `decodeURIComponent` throws `URIError` on malformed percent-encoding
(e.g. `https://lighterpack.com/csv/%E0%A4%A`), and `server/api/import.post.ts` calls
`lighterpackId(...)` **outside** its `try/catch` — so such a URL produced an
unhandled 500 instead of the intended clean 400 ("Not a LighterPack share link").
A public, unauthenticated endpoint should degrade gracefully on hostile input.

**Fix:** the decode is now wrapped so `lighterpackId` is total — malformed input
returns `null` (→ 400), never throws. Regression test added in
`tests/lighterpack.test.ts`.

### 7. Community-intake catalog spam — Informational — by design (2nd pass)

Lists are free and unauthenticated, so an actor can create ≥ K distinct lists
(`CATALOG_MIN_DISTINCT_LISTS`, default 3) containing the same crafted item and get
it promoted into a **community/unverified** `catalog_items` row (visible in
autocomplete and the changes feed). This is well-gated and bounded, not a vuln:
- `isAcceptableTypedItem` strips PII/profanity and caps length; `isBrandedTypedItem`
  rejects bare generic nouns and requires a known brand prefix or a real model
  token; the median weight must fall in the category's plausibility band.
- Promoted names are rendered exclusively through Vue text interpolation (escaped) —
  **no XSS**; community rows rank below the cited spine; raw typed text is purged
  after 90 days; admins can remove/merge.
- Impact is catalog-content spam, not escalation: an attacker cannot make another
  user's item point at the injected row.

**Recommendation:** keep an eye on the changes feed / autocomplete for abuse;
consider a lightweight admin "remove catalog row" affordance if spam appears in
practice. No code change.

---

## Controls verified as sound (no action needed)

- **Capability model.** Internal numeric `id` and `edit_token_hash` never leave the
  repo layer; public surfaces expose only `slug` + `share_code`. Edit token is
  256-bit, stored only as SHA-256, and carried in the `Authorization` header (kept
  out of URLs/logs/Referer; `Referrer-Policy: no-referrer` set site-wide).
- **No enumeration oracle.** Misses return 404, never 403, across edit/share/slug
  and admin routes.
- **No SQL injection.** Drizzle parameterizes everything; the one raw fuzzy-search
  query uses bound params; all `sql.raw` is static DDL.
- **No SSRF.** The LighterPack importer hardcodes the host, sets `redirect: "error"`,
  constrains the id charset, caps body size, and times out.
- **No CSRF.** No cookies/ambient auth anywhere; capabilities travel in custom
  headers, so cross-site requests can't carry them.
- **No XSS sinks.** No `v-html`/`innerHTML`. The single user-URL-as-`href` path
  (`changes.vue`) is scheme-guarded; `productUrl`/`imageUrl` are never rendered as
  links. Feed facets (trip type/season) are closed allow-list enums.
- **Input clamping.** The `shared/ops.ts` reducer is the single source of truth and
  is shared by create/restore/mutate, so there's no clamp-bypass into raw JSONB
  (item/folder caps, weight/qty bounds, string length limits).
- **Concurrency.** List writes use compare-and-set on `version` with bounded retry;
  snapshot restore re-validates through the same normalizers.
- **Abuse controls.** List reports require a threshold of distinct (IP-deduped)
  reporters and only withhold from discovery — they never revoke owner access.
- **No secrets committed.** `.env` is gitignored; only `.env.example` (placeholders)
  is tracked.

### Additional checks in the second (deeper) pass

- **No prototype pollution.** The op reducer copies only whitelisted keys into
  fresh objects (`cleanItemPatch`/`cleanFolderPatch`/`normalizeItem`/`normalizeFolder`)
  before `Object.assign`, so a `__proto__`/`constructor` key in a patch can't reach
  an object prototype. Snapshot clone/equality use `JSON.parse(JSON.stringify(...))`.
- **No SSR head injection.** The public `/l/[slug]` page feeds the user's title /
  description into `useHead`/`useSeoMeta`; Unhead escapes title text and meta
  attribute values, and body content uses `{{ }}` interpolation — no raw HTML sink.
- **`imageUrl` is inert.** Stored on items/catalog but never rendered as an `<img>`
  `src` or any other sink anywhere in the client.
- **Snapshot restore is safe.** Reconstruction is bounded (`SNAPSHOT_CAP = 5`,
  newest is always a full base) and the restored state is re-run through the same
  normalizers/caps as a normal write — a tampered snapshot can't bypass clamps.
- **Integer-safe totals.** `MAX_ITEMS × qtyMax × UNIT_WEIGHT_MAX_MG ≈ 1e15 < 2^53`,
  so `bigint(mode:number)` rollups stay exact; negative parsed weights are rejected.
- **Edit-token handling.** The write capability lives only in the URL fragment
  (`/e#token`, never sent to the server) and `localStorage`; `Referrer-Policy:
  no-referrer` plus `replaceState` (not navigation) keep it out of the Referer and
  history side-channels.

## Files changed by this review

- `server/utils/tokens.ts` — added `safeEqual()` (constant-time secret compare).
- `server/api/catalog/revert.post.ts` — constant-time admin compare + rate limit.
- `server/api/admin/lists/restore.post.ts` — constant-time admin compare + rate limit.
- `server/routes/api/cron/corroborate-catalog.ts` — constant-time secret compare.
- `shared/exporters/csv.ts` — CSV formula-injection guard on export + strip on import.
- `tests/csv.test.ts` — regression test for the CSV guard.
- `shared/lighterpack.ts` — make `lighterpackId` total (no throw on malformed `%`).
- `tests/lighterpack.test.ts` — regression test for malformed percent-encoding.
