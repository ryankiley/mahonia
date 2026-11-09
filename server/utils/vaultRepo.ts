// Vault persistence: the capture upsert, the browse read, the autocomplete pool,
// and the tombstone. Ranking is NOT here — it lives in shared/vault.ts so the
// ordering is identical whichever engine is underneath, exactly as the catalog
// does it.

import { sweepWindow, toIso } from "./time";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import { vaultFolders, vaultItems, vaultKitParts, vaults } from "../db/schema";
import { isUniqueViolation, type Db } from "./db";
import { liveCatalogRows } from "./catalog";
import type { CatalogSearchResult } from "../../shared/catalogSearch";
import {
  VAULT_CAPTURE_MAX,
  VAULT_IMPORT_MAX,
  VAULT_NAME_MAX,
  VAULT_SHORT_MAX,
  VAULT_URL_MAX,
  vaultNormKey,
  type VaultCapture,
  type VaultEntry,
  type VaultGearKey,
  type VaultKitCapture,
  type VaultKitPart,
  type VaultKitPartRef,
  type VaultItemOp,
  type VaultItemPatch,
  type VaultPinField,
  ownedOf,
} from "../../shared/vault";
export type { VaultItemOp, VaultItemPatch };
import type { VaultImportRow } from "../../shared/vaultImport";
import { VAULT_KIT_PARTS_MAX, VAULT_KIT_QTY_MAX, kitWeightMg } from "../../shared/vaultKit";
import { CLASSIFICATIONS, UNITS, type Classification, type Unit } from "../../shared/types";
import { clampUnitWeightMg, isSerialId, KCAL_MAX } from "../../shared/ops";
import { PRICE_MAX_CENTS } from "../../shared/money";
import { tidyText } from "../../shared/tidyText";
import { isGearGlyph, type GearGlyph } from "../../shared/gearGlyph";
import { enoughToSearch } from "../../shared/searchText";
import { rankVaultRows } from "../../shared/vaultSearch";

/** Upper bound on the rows pulled into memory for a search or a browse. A vault is
 *  personal gear, so real ones are dozens of rows; this only bounds the pathological
 *  case, and the JS ranker over a few hundred rows is far cheaper than the round
 *  trip that fetched them. */
const POOL_LIMIT = 1000;

/** Ceiling on TOTAL rows (live + removed) one vault may hold. Twice POOL_LIMIT:
 *  the reads truncate at 1000 anyway, so rows past that are invisible to their
 *  own owner — the ceiling bounds junk, not use. Capture drops new keys over the
 *  cap rather than erroring; updates to existing rows always land. */
export const VAULT_ITEMS_MAX = 2000;

type Row = typeof vaultItems.$inferSelect;

/** Pin token ↔ its column, in ONE table so the read (pinsOf), the write
 *  (cleanVaultPatch) and the release (unpin) cannot drift apart. */
const PIN_COLUMN = [
  ["name", "namePinned"],
  ["weight", "weightPinned"],
  ["commonName", "commonNamePinned"],
  ["classification", "classificationPinned"],
  ["kcal", "kcalPinned"],
  ["productUrl", "productUrlPinned"],
  // one flag over price_cents AND currency — see the token's note in shared/vault
  ["price", "pricePinned"],
] as const satisfies readonly (readonly [VaultPinField, keyof Row])[];

/** Six booleans in, one small array out — absent when nothing is pinned, the same
 *  "SQL nulls become absent fields" shape the rest of toEntry produces. */
function pinsOf(row: Row): VaultPinField[] | undefined {
  const out = PIN_COLUMN.filter(([, col]) => row[col]).map(([token]) => token);
  return out.length ? out : undefined;
}

/** DB row → wire shape: SQL nulls become absent fields, so the client sees the same
 *  optional-property shape the capture side produces. */
// The vault's backfill, in the one place every read converts a row (the live list, the
// MCP's reads and the autocomplete all land here). Rows captured before the tidy
// existed hold straight apostrophes and doubled spaces, and a vault row sits directly
// beside list rows that are tidied — in the autocomplete menu they are adjacent lines.
//
// Display only, and safe to be: identity is `normKey`, which folds through
// foldForSearch (non-alphanumerics stripped), so "Arc'teryx" and "Arc’teryx" produce
// the SAME key. Tidying what's shown cannot re-key a row, split one in two, or miss the
// upsert target. The stored column keeps whatever it had until the next capture
// rewrites it from an already-tidied list item.
/** A unit off the wire or out of the column, or undefined for anything else. */
const unitOf = (v: unknown): Unit | undefined => (UNITS.includes(v as Unit) ? (v as Unit) : undefined);
/** A classification off the wire or out of the column, or undefined for anything else:
 *  the CHECK would reject it, and a 500 is the wrong answer to one bad field. */
export const classificationOf = (v: unknown): Classification | undefined =>
  CLASSIFICATIONS.includes(v as Classification) ? (v as Classification) : undefined;

function toEntry(row: Row): VaultEntry {
  return {
    id: row.id,
    normKey: row.normKey,
    brand: row.brand ? tidyText(row.brand) || undefined : undefined,
    name: tidyText(row.name),
    variant: row.variant ? tidyText(row.variant) || undefined : undefined,
    commonName: row.commonName ? tidyText(row.commonName) || undefined : undefined,
    // a pick whose icon has left the set reads as no pick, so the type's icon shows
    icon: isGearGlyph(row.icon) ? row.icon : undefined,
    entryUnit: unitOf(row.entryUnit),
    owned: ownedOf(row.owned),
    weightMg: Number(row.weightMg),
    classification: classificationOf(row.classification),
    kcal: row.kcal ?? undefined,
    catalogItemId: row.catalogItemId ?? undefined,
    productUrl: row.productUrl ?? undefined,
    priceCents: row.priceCents ?? undefined,
    // never on its own: a currency with no amount is a unit with nothing to measure
    currency: row.priceCents != null ? (row.currency ?? undefined) : undefined,
    pinned: pinsOf(row),
    timesSeen: row.timesSeen,
    lastUsedAt: toIso(row.lastUsedAt),
    createdAt: toIso(row.createdAt),
    // A kit's stored weight is its OWN; withKits replaces weightMg with the derived
    // total once the parts are read. Until then the two agree, which is also the
    // honest figure for a kit whose parts were never read.
    ...(row.kind === "kit" ? { kind: "kit" as const, ownWeightMg: Number(row.weightMg), parts: [] } : {}),
  };
}

/**
 * Fill in the kit fields on entries read from this vault: a kit's parts and its
 * derived weight, a piece's kits.
 *
 * ONE query for the whole vault's links, whatever the entries asked about: a vault is
 * at most VAULT_ITEMS_MAX rows and a kit a handful of links, so reading them all is
 * cheaper than a second round trip shaped to the entries. Both ends of a link are
 * held to this vault and to their kinds in the WHERE, so a link that somehow broke
 * the rules setKitParts keeps is simply not read rather than trusted.
 */
async function withKits(db: Db, vaultId: number, entries: VaultEntry[]): Promise<VaultEntry[]> {
  if (!entries.length) return entries;
  const part = alias(vaultItems, "part");
  const links = await db
    .select({
      kitId: vaultKitParts.kitId,
      partId: vaultKitParts.partId,
      qty: vaultKitParts.qty,
      kitRemovedAt: vaultItems.removedAt,
      brand: part.brand,
      name: part.name,
      variant: part.variant,
      weightMg: part.weightMg,
      partRemovedAt: part.removedAt,
    })
    .from(vaultKitParts)
    .innerJoin(vaultItems, eq(vaultItems.id, vaultKitParts.kitId))
    .innerJoin(part, eq(part.id, vaultKitParts.partId))
    .where(
      and(
        eq(vaultItems.vaultId, vaultId),
        eq(vaultItems.kind, "kit"),
        eq(part.vaultId, vaultId),
        eq(part.kind, "piece"),
      ),
    )
    .orderBy(asc(vaultKitParts.sortOrder), asc(vaultKitParts.partId));
  if (!links.length) return entries;

  const partsOf = new Map<number, VaultKitPart[]>();
  const kitsOf = new Map<number, number[]>();
  for (const l of links) {
    const p: VaultKitPart = {
      id: l.partId,
      qty: l.qty,
      brand: l.brand ? tidyText(l.brand) || undefined : undefined,
      name: tidyText(l.name),
      variant: l.variant ? tidyText(l.variant) || undefined : undefined,
      weightMg: Number(l.weightMg),
      ...(l.partRemovedAt ? { removed: true } : {}),
    };
    const list = partsOf.get(l.kitId);
    if (list) list.push(p);
    else partsOf.set(l.kitId, [p]);
    // a piece is "in" the kits you can see: one that's put away doesn't claim it
    if (!l.kitRemovedAt) {
      const kits = kitsOf.get(l.partId);
      if (kits) kits.push(l.kitId);
      else kitsOf.set(l.partId, [l.kitId]);
    }
  }
  return entries.map((e) => {
    if (e.kind === "kit") {
      const parts = partsOf.get(e.id) ?? [];
      return { ...e, parts, weightMg: kitWeightMg(e.ownWeightMg ?? 0, parts) };
    }
    const kits = kitsOf.get(e.id);
    return kits ? { ...e, inKits: [...new Set(kits)].sort((a, b) => a - b) } : e;
  });
}

/** A string field off the wire: typed, capped, tidied — or dropped. The shipped
 *  client already sends clean values; this is for the direct POST that doesn't.
 *  tidyText rather than a bare trim, so a hand-rolled POST can't seed the vault with
 *  text the editor would never have stored (and toEntry would only re-tidy on read). */
function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  return tidyText(v.slice(0, max)) || undefined;
}

/** A URL off the wire: typed and capped, but NOT tidied. tidyText curls a
 *  letter-flanked apostrophe, and a path can legitimately carry one
 *  (…/mens-jacket vs …/men's-jacket) — curling it rewrites the address to a page
 *  that isn't there. shared/ops.ts exempts productUrl from cleanText for exactly
 *  this reason; str() below does not, so the gear was curling them. */
function url(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return v.trim().slice(0, VAULT_URL_MAX) || undefined;
}

/** A weight off the wire, clamped by the same rule the list reducer applies. Flooring
 *  at zero was not enough: a direct POST
 *  of 1e19 reached the bigint column and errored the whole multi-row capture, so
 *  one hostile row took a whole list's gear down with it. */
/** kcal off the wire: a positive whole number under the reducer's own ceiling, or
 *  absent — the same bounds shared/ops applies to a list row, so a direct POST
 *  can't store a value the editor could never have produced. */
function kcalOf(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const k = Math.round(v);
  return k > 0 ? Math.min(KCAL_MAX, k) : undefined;
}

/** A price off the wire: whole cents, floored at zero and capped so an integer
 *  column can hold it. Zero reads as absent, like kcal — nobody records paying
 *  nothing, and a stored 0 would print as "0.00" on every row that never had one. */
function centsOf(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const c = Math.round(v);
  return c > 0 ? Math.min(PRICE_MAX_CENTS, c) : undefined;
}

/** The currency for a price, or absent. Three letters, upper-cased — the column is
 *  ISO 4217 and a free-text POST is the only thing that could put prose in it. */
function currencyOf(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const code = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/**
 * A catalog pick is kept under the catalog's CURRENT spelling, whatever the list row
 * still says (2026-10-31).
 *
 * My Gear knows gear by its folded brand + name + variant, and a list row stores the
 * spelling its product had the day it was picked. When the catalog tidies a variant,
 * the seed renames the catalog row and My Gear's row in place, but not the text saved
 * inside every list, and the sign-in backfill (claimRepo) captures from that saved
 * text. So each sign-in sent "Men's M" to a vault that now held "Men's Medium" and
 * minted a second row for one hoodie. A retired catalog row did the same, with nothing
 * to catch up to.
 *
 * Only a row the list marks as untouched since the pick (catalogSpelling) is
 * respelled: a row someone renamed keeps its own text and its own identity. Every
 * linked capture takes its live successor's id, so the link outlives the row it was
 * picked under. Best effort, like capture itself: if the catalog can't be read, the
 * gear is captured as the list spells it rather than not at all.
 */
async function respellCatalogPicks(db: Db, caps: VaultCapture[]): Promise<VaultCapture[]> {
  const ids = caps.flatMap((c) => (c && isSerialId(c.catalogItemId) ? [c.catalogItemId] : []));
  if (!ids.length) return caps;
  let live: Map<number, CatalogSearchResult>;
  try {
    live = await liveCatalogRows(db, ids);
  } catch {
    return caps;
  }
  return caps.map((c) => {
    const row = c && isSerialId(c.catalogItemId) ? live.get(c.catalogItemId) : undefined;
    if (!row) return c;
    if (c.catalogSpelling !== true) return { ...c, catalogItemId: row.id };
    return { ...c, catalogItemId: row.id, brand: row.brand ?? undefined, name: row.name, variant: row.variant ?? undefined };
  });
}

/** Re-derive the identity server-side rather than trusting the client's normKey —
 *  a forged key could otherwise collide two unrelated items into one row (or dodge
 *  a tombstone). Drops anything that doesn't survive normalization. Fields are
 *  rebuilt explicitly (no spread) so nothing rides in untyped or uncapped: the
 *  caps are the same ones captureFromList applies client-side. A capture's folder
 *  name is not kept: My Gear groups by kind, not by the list's folders. One row in,
 *  one row (or null) out, so a caller holding something beside each row — an
 *  import's pins, a kit part's client key — reads its answer at the same index. */
function sanitizeOne(c: Omit<VaultCapture, "normKey">): VaultCapture | null {
  const name = str(c?.name, VAULT_NAME_MAX);
  if (!name) return null;
  const brand = str(c.brand, VAULT_SHORT_MAX);
  const variant = str(c.variant, VAULT_SHORT_MAX);
  const normKey = vaultNormKey(brand, name, variant);
  if (!normKey) return null;
  return {
    normKey,
    name,
    brand,
    variant,
    commonName: str(c.commonName, VAULT_SHORT_MAX),
    productUrl: url(c.productUrl),
    priceCents: centsOf(c.priceCents),
    // dropped without an amount, so the pair can never half-exist in the table
    currency: centsOf(c.priceCents) != null ? currencyOf(c.currency) : undefined,
    weightMg: Number.isFinite(c.weightMg) ? clampUnitWeightMg(c.weightMg) : 0,
    classification: classificationOf(c.classification),
    kcal: kcalOf(c.kcal),
    // catalog_items.id is a Postgres integer. Keep a forged capture/import ID
    // from turning the whole otherwise-valid upsert into an overflow error.
    catalogItemId: isSerialId(c.catalogItemId) ? c.catalogItemId : undefined,
  };
}

/** Each identity once, the last spelling of it winning. Load-bearing for the upsert
 *  below, not just tidy: Postgres rejects an ON CONFLICT DO UPDATE that would touch
 *  the same row twice within one command. */
function onePerKey(caps: (VaultCapture | null | undefined)[]): VaultCapture[] {
  const out = new Map<string, VaultCapture>();
  for (const c of caps) if (c) out.set(c.normKey, c);
  return [...out.values()];
}

/** A capture request's rows through sanitizeOne, bounded and one per identity. */
function sanitize(caps: VaultCapture[]): VaultCapture[] {
  return onePerKey(caps.slice(0, VAULT_CAPTURE_MAX).map(sanitizeOne));
}

/**
 * Fold a list's gear into the user's vault.
 *
 * One INSERT ... ON CONFLICT per capture, and every field's merge rule is a
 * deliberate answer to "which copy is the truth?":
 *
 *  • name / brand / variant — take the incoming spelling. They fold to the same
 *    key either way, so this just lets a tidied-up capitalisation win.
 *  • weight — fill a missing vault weight, never replace one. A list is a record
 *    of what was carried on that trip, while My Gear is the owner's current source
 *    of truth. An explicit Save to My Gear press opts into replacing an unpinned
 *    value; background capture never does.
 *  • common name / classification / kcal / catalog link — coalesce: a capture
 *    that carries the field sets it, one that doesn't leaves what's there. These
 *    accumulate rather than flip-flop as the same gear appears in different lists.
 *  • removed_at — UNTOUCHED. Capture is automatic, so if it cleared the tombstone
 *    every list still holding the item would resurrect it and "remove" would mean
 *    nothing. Only an explicit restore (or re-add from /gear) clears it.
 *  • a PINNED field — untouched, whatever the rule above says. Correcting a field
 *    on /gear is a statement that your value is the truth about your own gear, and
 *    an automatic write must not argue with a deliberate one. times_seen and
 *    last_used_at still move: those are facts about USE, not about the gear.
 *
 * Returns the gear that is LIVE in the vault afterwards — the honest answer to
 * "what did you store?", which a 2xx alone is not (a tombstoned row is written
 * and stays put away, and rows past the ceiling are dropped). Most callers
 * want the count instead; captureVaultItems below is that.
 */
export async function captureVaultItemsReporting(
  db: Db,
  vaultId: number,
  caps: VaultCapture[],
  { overwriteWeight = false }: { overwriteWeight?: boolean } = {},
): Promise<{ keys: VaultGearKey[]; full: boolean }> {
  return upsertCaptures(db, vaultId, sanitize(await respellCatalogPicks(db, caps)), { overwriteWeight });
}

/**
 * The ON CONFLICT set a capture writes over a row the vault already holds, with the
 * merge rules captureVaultItemsReporting describes. ONE set for the two writes that
 * use it — a list's capture and a group's save as a kit (captureKit) — so a field
 * can't be merged by one and forgotten by the other. The weight rule is the caller's,
 * since that is where the two differ.
 */
function captureSet(now: Date, weightMg: SQL) {
  return {
    // brand/name/variant move as ONE spelling: they fold to the same key either
    // way, so capture takes the incoming one — unless you've corrected it on
    // /gear, in which case yours is the truth and no list can talk over it.
    brand: keepIfPinned(vaultItems.namePinned, vaultItems.brand, sql`excluded.brand`),
    name: keepIfPinned(vaultItems.namePinned, vaultItems.name, sql`excluded.name`),
    variant: keepIfPinned(vaultItems.namePinned, vaultItems.variant, sql`excluded.variant`),
    commonName: keepIfPinned(
      vaultItems.commonNamePinned,
      vaultItems.commonName,
      sql`coalesce(excluded.common_name, ${vaultItems.commonName})`,
    ),
    weightMg,
    classification: keepIfPinned(
      vaultItems.classificationPinned,
      vaultItems.classification,
      sql`coalesce(excluded.classification, ${vaultItems.classification})`,
    ),
    kcal: keepIfPinned(
      vaultItems.kcalPinned,
      vaultItems.kcal,
      sql`coalesce(excluded.kcal, ${vaultItems.kcal})`,
    ),
    productUrl: keepIfPinned(
      vaultItems.productUrlPinned,
      vaultItems.productUrl,
      sql`coalesce(excluded.product_url, ${vaultItems.productUrl})`,
    ),
    // The pair moves under ONE pin, and the currency follows the amount rather
    // than coalescing on its own — a kept "399" under a newly-arrived "GBP"
    // would be a price nobody paid.
    priceCents: keepIfPinned(
      vaultItems.pricePinned,
      vaultItems.priceCents,
      sql`coalesce(excluded.price_cents, ${vaultItems.priceCents})`,
    ),
    currency: keepIfPinned(
      vaultItems.pricePinned,
      vaultItems.currency,
      sql`case when excluded.price_cents is not null then excluded.currency else ${vaultItems.currency} end`,
    ),
    // Not pinnable, and deliberately: the link is already first-write-wins, so a
    // pin would say nothing the coalesce doesn't already say.
    catalogItemId: sql`coalesce(excluded.catalog_item_id, ${vaultItems.catalogItemId})`,
    // Usage, not content. A pinned row is still gear a list just reached for,
    // and the autocomplete ranks on exactly these two — so they are never
    // guarded, however much of the row you've corrected by hand.
    timesSeen: sql`${vaultItems.timesSeen} + 1`,
    lastUsedAt: now,
    updatedAt: now,
  };
}

/**
 * The per-vault ceiling, the one rule for every write that can add rows: which of
 * these rows fit under VAULT_ITEMS_MAX, in order. A key the vault already holds
 * always fits — writing it adds no row — and a new key takes the room that is left,
 * first come first served. The rest come back as `over`, for the caller to answer
 * for in its own way: capture drops them, an add refuses them, an import skips them.
 *
 * One cheap indexed count, and the held keys read only when this batch could
 * actually cross the line.
 */
async function underCeiling<T>(
  db: Db,
  vaultId: number,
  rows: T[],
  keyOf: (row: T) => string,
): Promise<{ fit: T[]; over: T[] }> {
  if (!rows.length) return { fit: [], over: [] };
  const room = VAULT_ITEMS_MAX - (await vaultItemCount(db, vaultId));
  if (rows.length <= room) return { fit: rows, over: [] };
  const held = new Set(
    (
      await db
        .select({ k: vaultItems.normKey })
        .from(vaultItems)
        .where(and(eq(vaultItems.vaultId, vaultId), inArray(vaultItems.normKey, rows.map(keyOf))))
    ).map((r) => r.k),
  );
  let budget = Math.max(0, room);
  const fit: T[] = [];
  const over: T[] = [];
  for (const row of rows) {
    if (held.has(keyOf(row))) fit.push(row);
    else if (budget > 0) {
      budget--;
      fit.push(row);
    } else over.push(row);
  }
  return { fit, over };
}

/** The upsert half of a capture, for rows already sanitized (one per identity). */
async function upsertCaptures(
  db: Db,
  vaultId: number,
  clean: VaultCapture[],
  { overwriteWeight }: { overwriteWeight: boolean },
): Promise<{ keys: VaultGearKey[]; full: boolean }> {
  // The ceiling: new keys past it are dropped silently, since capture is an
  // automatic side effect of editing a list and refusing loudly would put an error
  // in front of someone who didn't ask for anything.
  // ...silently to the LIST, which never asked — but not to a hand press, which
  // did. `full` is how the one deliberate caller tells "the vault refused this
  // for space" from "you removed this gear", two states that need different
  // words: one is fixed by adding the piece again on /gear, the other by making room.
  const { fit, over } = await underCeiling(db, vaultId, clean, (c) => c.normKey);
  const full = over.length > 0;
  if (!fit.length) return { keys: [], full };

  const now = new Date();
  // ONE multi-row statement, not one per item. A 40-item list was 40 sequential
  // round trips, which on Neon's HTTP driver (no pipelining) is the difference
  // between a capture that's imperceptible and one that isn't — and the backfill
  // folds a whole list's worth of gear in at once. Safe as a single statement
  // because every caller hands in one row per key (onePerKey).
  // No folders: My Gear groups by kind now (shared/vaultView), so the list-folder
  // name a capture still carries (the client groups its chooser by it) files nothing.
  const written = await db
    .insert(vaultItems)
    .values(fit.map((c) => rowValues(c, vaultId, now)))
    .onConflictDoUpdate({
      target: [vaultItems.vaultId, vaultItems.normKey],
      set: captureSet(
        now,
        // A background capture fills only an unknown weight. Lists can be old trip
        // records, so replaying their whole capture set after any edit must not roll
        // My Gear back to a historical figure. A direct Save to My Gear press is the
        // deliberate exception, and may replace an unpinned value.
        //
        // A KIT takes no weight from a list at all, either way. Its stored weight is
        // its own (the stuff sack, usually 0) and its total is its parts', so an old
        // list still holding the kit as one flat row at the full figure would
        // otherwise fill that 0 and count every part twice. Usage still moves.
        sql`case when ${vaultItems.kind} = 'kit' then ${vaultItems.weightMg} else ${keepIfPinned(
          vaultItems.weightPinned,
          vaultItems.weightMg,
          overwriteWeight
            ? sql`case when excluded.weight_mg > 0 then excluded.weight_mg else ${vaultItems.weightMg} end`
            : sql`case when ${vaultItems.weightMg} = 0 and excluded.weight_mg > 0 then excluded.weight_mg else ${vaultItems.weightMg} end`,
        )} end`,
      ),
    })
    // What the write actually produced, in the one statement that produced it.
    // The alternative was a second SELECT keyed on the CLIENT's normKeys — but
    // sanitize() re-derives the key from the tidied text, so those two spellings
    // diverge wherever tidyText and foldForSearch disagree (a zero-width space is
    // deleted by one and folded to a gap by the other), and each divergence read
    // as "the vault refused this row" on a row it had stored correctly.
    // No-arg, and it has to be: the two drivers' typed `.returning({ col })`
    // overloads don't unify, so the bare form is the Db union's only shared one
    // (see server/utils/db.ts). Read the fields off the full row instead.
    .returning();
  // LIVE rows only. The upsert deliberately leaves `removed_at` alone, so gear you
  // put away on /gear is written and stays put away — the row comes back here, and
  // the caller must not be told it landed.
  return {
    keys: written.filter((r) => !r.removedAt).map(gearKeyOf),
    full,
  };
}

/** A row as the editor asks about it: its identity, the weight a capture could
 *  still write into it (null for a pinned one), and whether it is a kit. A kit's
 *  weight is no list's to push, like a pinned one — and it is named as a kit so a
 *  group row can tell "My Gear holds this set" from "My Gear holds a piece of this
 *  name", which its own save would turn into the set. */
function gearKeyOf(r: Pick<Row, "normKey" | "weightMg" | "weightPinned" | "kind">): VaultGearKey {
  if (r.kind === "kit") return [r.normKey, null, "kit"];
  return [r.normKey, r.weightPinned ? null : r.weightMg];
}

/**
 * Fold a list's gear into a vault, reporting only HOW MANY rows were written.
 *
 * The shape almost every caller wants (the claim backfill, the tests), kept so
 * the one caller that needs to know WHICH gear landed — the capture endpoint,
 * which tells the editor what it may stop offering to save — doesn't push a
 * second return value through eighty call sites.
 */
export async function captureVaultItems(
  db: Db,
  vaultId: number,
  caps: VaultCapture[],
): Promise<number> {
  return (await captureVaultItemsReporting(db, vaultId, caps)).keys.length;
}

/** The INSERT half a captured row and a hand-added one share — every content
 *  column off a sanitized capture, plus the usage stamps a brand-new row starts
 *  with. The pins are NOT here: capture asserts none and an add asserts them
 *  all, which is the whole difference between the two (see addVaultItem). */
function rowValues(c: VaultCapture, vaultId: number, now: Date) {
  return {
    vaultId,
    normKey: c.normKey,
    brand: c.brand ?? null,
    name: c.name,
    variant: c.variant ?? null,
    commonName: c.commonName ?? null,
    weightMg: c.weightMg,
    classification: c.classification ?? null,
    kcal: c.kcal ?? null,
    catalogItemId: c.catalogItemId ?? null,
    productUrl: c.productUrl ?? null,
    priceCents: c.priceCents ?? null,
    currency: c.currency ?? null,
    timesSeen: 1,
    lastUsedAt: now,
    updatedAt: now,
  };
}

/** How many rows (live AND removed — tombstones hold a slot) a vault holds: the
 *  count the ceiling is measured against (underCeiling, and captureKit's one new
 *  row). One cheap indexed count. */
async function vaultItemCount(db: Db, vaultId: number): Promise<number> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(vaultItems)
    .where(eq(vaultItems.vaultId, vaultId));
  return Number(n);
}

/** A vault's live rows, most-recently-used first, bounded to POOL_LIMIT — the
 *  one read behind both the /vault browse and the autocomplete's candidate pool
 *  (idx_vault_recent serves exactly this shape). */
function liveRows(db: Db, vaultId: number) {
  return db
    .select()
    .from(vaultItems)
    .where(liveIn(vaultId))
    // id breaks the tie, so the order is TOTAL — captureVaultItems stamps one
    // `now` onto a whole batch, so a 200-row import leaves 200 rows sharing a
    // last_used_at, and an untotal order lets two queries truncate at POOL_LIMIT
    // on different subsets of them.
    .orderBy(desc(vaultItems.lastUsedAt), asc(vaultItems.id))
    .limit(POOL_LIMIT);
}

/** "A live row of this vault" — the predicate, written once. The browse, the
 *  membership read and capture's landed-keys check all mean the same thing by it,
 *  and a fourth condition on what counts as live (an archive flag, a per-row
 *  visibility column) has to reach all of them or the membership set starts
 *  claiming rows /gear won't show. */
function liveIn(vaultId: number) {
  return and(eq(vaultItems.vaultId, vaultId), isNull(vaultItems.removedAt));
}

/**
 * Wrap a merge rule so a PINNED field keeps whatever the gear already holds.
 *
 * One helper rather than six hand-written CASEs, so a field cannot be made pinnable
 * with its guard accidentally left off.
 */
function keepIfPinned(flag: PgColumn, keep: PgColumn, rule: SQL): SQL {
  return sql`case when ${flag} then ${keep} else ${rule} end`;
}

/** Every live row in a user's vault, most-recently-used first — the /vault page's
 *  read. Small by nature, so it's one unpaginated query. */
export async function listVaultItems(db: Db, vaultId: number): Promise<VaultEntry[]> {
  return withKits(db, vaultId, (await liveRows(db, vaultId)).map(toEntry));
}

/**
 * What this vault holds OF THIS GEAR: the rows matching the keys asked about,
 * with the one number a capture could still write into them.
 *
 * Scoped to an ask, not to the vault, and that is the whole design. The editor's
 * question is about the ~40 rows of one open list, so answering it with the
 * vault's entire contents shipped up to POOL_LIMIT rows to a page that renders
 * none of them — and made the answer an app-lifetime cache, which is where the
 * lifetime bugs came from (see the composable that used to hold it). Ask about a
 * list, get a list back, and the answer dies with the list.
 *
 * It also retires an argument the whole-vault read needed: bounded at
 * POOL_LIMIT, a key OUTSIDE that window hid the save button on a row its owner
 * could not see, remove or restore on /gear. An ask has no window.
 *
 * `weightMg`, or null when the row's weight is PINNED. Membership alone is not
 * the question the button asks — it asks whether pressing would DO anything, and
 * on a row whose weight you have just corrected it still would, because capture
 * takes the incoming weight. A pinned weight is one you fixed by hand on /gear,
 * which no capture may argue with, so there is nothing left to push.
 *
 * Removed rows are excluded because capture never resurrects a tombstone (see
 * captureVaultItems), so gear you put away is genuinely not in your vault.
 */
export async function vaultGearAmong(
  db: Db,
  vaultId: number,
  normKeys: string[],
): Promise<VaultGearKey[]> {
  if (!normKeys.length) return [];
  const rows = await db
    .select({
      normKey: vaultItems.normKey,
      weightMg: vaultItems.weightMg,
      weightPinned: vaultItems.weightPinned,
      kind: vaultItems.kind,
    })
    .from(vaultItems)
    .where(and(liveIn(vaultId), inArray(vaultItems.normKey, normKeys.slice(0, VAULT_CAPTURE_MAX))));
  return rows.map(gearKeyOf);
}

/**
 * One row of the vault by id, live or put away, or null. The MCP gear tools read a
 * piece back after an edit that answered with a boolean
 * and no row. vaultId sits in the WHERE as on every other read here, so an id from
 * some other vault is null, indistinguishable from an id that never existed.
 */
export async function vaultItemById(db: Db, vaultId: number, id: number): Promise<VaultEntry | null> {
  if (!isSerialId(id)) return null;
  const rows = await db
    .select()
    .from(vaultItems)
    .where(and(eq(vaultItems.id, id), eq(vaultItems.vaultId, vaultId)))
    .limit(1);
  // a kit with its items and its derived weight, a piece with the kits it is in
  return rows[0] ? ((await withKits(db, vaultId, [toEntry(rows[0])]))[0] ?? null) : null;
}

/**
 * The live row with this identity (brand + name + variant, folded as vaultNormKey
 * folds them), or null. The MCP gear tools answer an add that came back as a
 * duplicate with the piece it duplicated, so an assistant has the id it needs next
 * (to put that piece in a kit, say) without a second search.
 */
export async function vaultItemByNormKey(db: Db, vaultId: number, normKey: string): Promise<VaultEntry | null> {
  if (!normKey) return null;
  const rows = await db.select().from(vaultItems).where(and(liveIn(vaultId), eq(vaultItems.normKey, normKey))).limit(1);
  return rows[0] ? ((await withKits(db, vaultId, [toEntry(rows[0])]))[0] ?? null) : null;
}

/** Rank a user's vault against an autocomplete query. Recall is the whole (bounded)
 *  live set; the fine ranking is the shared JS cascade — the catalog's PGlite
 *  strategy, applied here on both engines because a vault is always small.
 *
 *  PIECES ONLY for the row's autocomplete (the default): a pick fills that one row,
 *  and a kit is not one row — it goes onto a list as a group with its items under it,
 *  which the gear pane does (addVaultKit) and a row's name field can't. Offering a
 *  kit there would land it flat, at its total, with its items lost. The connector's
 *  search asks for kits too (`kits: true`), with their items, since a kit is gear it
 *  holds and the tools name what a kit is. */
export async function searchVaultItems(
  db: Db,
  vaultId: number,
  q: string,
  limit?: number,
  { kits = false }: { kits?: boolean } = {},
): Promise<VaultEntry[]> {
  // The ranker asks this too; asking first saves the query for a "keep typing".
  if (!enoughToSearch((q ?? "").trim())) return [];
  const all = await liveRows(db, vaultId);
  const rows = kits ? all : all.filter((r) => r.kind !== "kit");
  // rank the ROWS, then convert the handful that survive — toEntry allocates two
  // Dates and two ISO strings per row, and the ranker reads neither. `limit` falls
  // back to the autocomplete's six; a search over the connector asks for a page.
  const ranked = rankVaultRows(rows, q, limit).map(toEntry);
  return kits ? withKits(db, vaultId, ranked) : ranked;
}

/**
 * Tombstone a row: stop offering it, keep the record so automatic capture can't
 * bring it back. Scoped by vaultId as well as id, so an id from another vault
 * simply matches nothing (no existence oracle, no 403). Returns whether a live row
 * was actually removed.
 */
export async function removeVaultItem(db: Db, vaultId: number, id: number): Promise<boolean> {
  if (!isSerialId(id)) return false;
  const done = await db
    .update(vaultItems)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(vaultItems.id, id), eq(vaultItems.vaultId, vaultId), isNull(vaultItems.removedAt)),
    )
    .returning();
  return done.length > 0;
}

/** Lift a tombstone — the undo behind the remove action. Ownership is part of the
 *  WHERE, not a check on the result: filtering afterwards would already have
 *  written to another account's row. */
export async function restoreVaultItem(db: Db, vaultId: number, id: number): Promise<boolean> {
  if (!isSerialId(id)) return false;
  const done = await db
    .update(vaultItems)
    .set({ removedAt: null, updatedAt: new Date() })
    .where(and(eq(vaultItems.id, id), eq(vaultItems.vaultId, vaultId)))
    .returning();
  return done.length > 0;
}

// ---------------------------------------------------------------------------
// the nightly reaper
// ---------------------------------------------------------------------------
// Vaults are minted lazily and never signed out of, so without this they only ever
// accumulate: every abandoned device, every browser that captured once and never
// came back. `last_seen_at` is bumped by requireVault on EVERY vault request
// — capture included, which for anyone actively building lists is constant — so
// "not seen in months" is a strong signal and not a proxy for "quiet lately".
//
// Two stages, the shape lists already use (see listRepo): soft-delete first, hard
// delete only after a grace window. That matters more here than it does for a
// list: there is no account and no email behind a vault, so a hard reap would be
// unrecoverable for someone who kept the link in a note and came back late. Inside
// the grace, using the link is enough — requireVault clears deleted_at.

/** Untouched for this long and a vault is presumed abandoned. Much longer than a
 *  list's 30: a list is reaped for being EMPTY as well as stale, whereas a full
 *  vault is exactly what someone might return to after a season off. */
const VAULT_REAP_STALE_DAYS = Math.max(1, Number(process.env.VAULT_REAP_STALE_DAYS) || 180);
/** How long a soft-deleted vault stays revivable — the same 90 days a list gets. */
const VAULT_PURGE_GRACE_DAYS = Math.max(
  1,
  Number(process.env.VAULT_PURGE_GRACE_DAYS) || 90,
);
const VAULT_REAP_BATCH_MAX = 10_000;

/** Soft-delete vaults not seen in `staleDays`. Batched, so one run can never issue
 *  an unbounded write — a backlog just drains over successive nights. */
export async function reapAbandonedVaults(
  db: Db,
  opts?: { staleDays?: number; limit?: number },
): Promise<{ vaultsReaped: number }> {
  const { cutoff, limit } = sweepWindow(opts?.staleDays, VAULT_REAP_STALE_DAYS, opts?.limit, VAULT_REAP_BATCH_MAX);
  const candidates = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(isNull(vaults.deletedAt), lt(vaults.lastSeenAt, cutoff)))
    .limit(limit);
  if (!candidates.length) return { vaultsReaped: 0 };

  const done = await db
    .update(vaults)
    .set({ deletedAt: new Date() })
    .where(inArray(vaults.id, candidates.map((c) => c.id)))
    .returning();
  return { vaultsReaped: done.length };
}

/** Hard-delete vaults soft-deleted more than `graceDays` ago, with their gear (and
 *  any folders left from before My Gear dropped them). This is the stage that
 *  actually reclaims the storage. */
export async function purgeDeletedVaults(
  db: Db,
  opts?: { graceDays?: number; limit?: number },
): Promise<{ vaultsPurged: number }> {
  const { cutoff, limit } = sweepWindow(opts?.graceDays, VAULT_PURGE_GRACE_DAYS, opts?.limit, VAULT_REAP_BATCH_MAX);
  const doomed = await db
    .select({ id: vaults.id })
    .from(vaults)
    .where(and(isNotNull(vaults.deletedAt), lt(vaults.deletedAt, cutoff)))
    .limit(limit);
  if (!doomed.length) return { vaultsPurged: 0 };
  const ids = doomed.map((r) => r.id);

  // children first — there's no DB-level FK here (same as lists → snapshots), so
  // the cascade is manual, and doing it in this order means a run that dies partway
  // leaves orphaned NOTHING: the vault row is the last thing to go. A kit's links go
  // before the rows they join, by the same rule.
  await db
    .delete(vaultKitParts)
    .where(
      inArray(
        vaultKitParts.kitId,
        db.select({ id: vaultItems.id }).from(vaultItems).where(inArray(vaultItems.vaultId, ids)),
      ),
    );
  await db.delete(vaultItems).where(inArray(vaultItems.vaultId, ids));
  await db.delete(vaultFolders).where(inArray(vaultFolders.vaultId, ids));
  await db.delete(vaults).where(inArray(vaults.id, ids));
  return { vaultsPurged: ids.length };
}

// ---------------------------------------------------------------------------
// the row verbs: add a piece of gear by hand, correct one in place
// ---------------------------------------------------------------------------

/** The pin flags a deliberate write asserts, returned in the SAME object as the
 *  values they protect — so a field structurally cannot be written without being
 *  pinned alongside it. */
type ItemWrite = Partial<typeof vaultItems.$inferInsert>;

/**
 * Turn a patch off the wire into a scoped SET, pinning every field it touches.
 *
 * Returns null when the patch would leave the row nameless: `name` is NOT NULL, and
 * the row's whole identity was folded out of it.
 */
function cleanVaultPatch(patch: unknown): ItemWrite | null {
  const p = (patch ?? {}) as Record<string, unknown>;
  const out: ItemWrite = {};

  // one pin for the three: the stored SPELLING is one decision (VAULT_PIN_FIELDS)
  let spelled = false;
  if (typeof p.name === "string") {
    const name = str(p.name, VAULT_NAME_MAX);
    if (!name) return null;
    out.name = name;
    spelled = true;
  }
  if (typeof p.brand === "string" || p.brand === null) {
    out.brand = str(p.brand, VAULT_SHORT_MAX) ?? null;
    spelled = true;
  }
  if (typeof p.variant === "string" || p.variant === null) {
    out.variant = str(p.variant, VAULT_SHORT_MAX) ?? null;
    spelled = true;
  }
  if (spelled) out.namePinned = true;

  if (typeof p.commonName === "string" || p.commonName === null) {
    out.commonName = str(p.commonName, VAULT_SHORT_MAX) ?? null;
    out.commonNamePinned = true;
  }
  if (typeof p.productUrl === "string" || p.productUrl === null) {
    out.productUrl = url(p.productUrl) ?? null;
    out.productUrlPinned = true;
  }
  if (typeof p.weightMg === "number" && Number.isFinite(p.weightMg)) {
    const mg = clampUnitWeightMg(p.weightMg);
    out.weightMg = mg;
    // Zero is the gear's own sentinel for "not weighed yet", and the merge rule
    // already refuses to let one overwrite a real weight. Pinning a zero would lock
    // the row out of ever learning its weight from a list, so clearing UNPINS.
    out.weightPinned = mg > 0;
  }
  if ("classification" in p) {
    // anything but a classification is ignored rather than stored (classificationOf)
    const cls = p.classification === null ? null : classificationOf(p.classification);
    if (cls !== undefined) {
      out.classification = cls;
      out.classificationPinned = true;
    }
  }
  if ("kcal" in p) {
    if (p.kcal === null) {
      out.kcal = null;
      out.kcalPinned = true;
    } else if (typeof p.kcal === "number" && Number.isFinite(p.kcal)) {
      out.kcal = kcalOf(p.kcal) ?? null; // ≤0 reads as "clear", like the reducer's
      out.kcalPinned = true;
    }
  }
  if ("catalogItemId" in p) {
    // the column is a Postgres integer: the bound sanitize() holds a capture to
    if (p.catalogItemId === null) out.catalogItemId = null;
    else if (isSerialId(p.catalogItemId)) out.catalogItemId = p.catalogItemId;
  }
  if ("owned" in p) {
    // a count, or back to one; anything else is ignored rather than stored
    if (p.owned === null) out.owned = null;
    else if (typeof p.owned === "number" && Number.isFinite(p.owned)) out.owned = ownedOf(p.owned) ?? null;
  }
  if ("entryUnit" in p) {
    // anything but a unit is ignored, not stored: the row would read in nothing
    if (p.entryUnit === null) out.entryUnit = null;
    else if (unitOf(p.entryUnit)) out.entryUnit = unitOf(p.entryUnit)!;
  }
  if ("icon" in p) {
    // a name outside the set is ignored, not stored: it would draw nothing
    if (p.icon === null) out.icon = null;
    else if (isGearGlyph(p.icon)) out.icon = p.icon;
  }
  // The amount carries the currency: they are one field with two columns, so the
  // currency is only ever read in the same breath as a price, and clearing the
  // price clears it. A patch naming currency alone is ignored — see the field.
  if ("priceCents" in p) {
    const cents = p.priceCents === null ? undefined : centsOf(p.priceCents);
    out.priceCents = cents ?? null;
    out.currency = cents != null ? (currencyOf(p.currency) ?? null) : null;
    out.pricePinned = true;
  }
  return out;
}

/**
 * Apply one row op, always scoped to the caller's gear.
 *
 * Every WHERE carries vaultId alongside the
 * id, so an id from another gear matches nothing rather than being checked and
 * rejected. Returns the row as the client should now see it, or null — and null is
 * deliberately the one answer for "not yours", "doesn't exist" and "wouldn't
 * validate", so the endpoint never confirms another gear's row is real.
 */
export async function applyVaultItemOp(
  db: Db,
  vaultId: number,
  op: VaultItemOp,
): Promise<{ item: VaultEntry } | AddRefusal | null> {
  if (op?.t === "kit") return kitVaultItem(db, vaultId, op);
  const done =
    op?.t === "add" ? ((await addVaultItems(db, vaultId, [op]))[0] ?? null)
    : op?.t === "edit" ? await editVaultItem(db, vaultId, op)
    : null;
  // the row as every other read shows it: a kit with its parts and derived weight,
  // a piece with the kits it is in
  if (done && "item" in done && done.item) {
    const [item = done.item] = await withKits(db, vaultId, [done.item]);
    return { item };
  }
  return done;
}

/** Why an add wrote nothing. A duplicate names the key the server derived for it —
 *  the row it duplicates is under that key, which re-folding the typed text can miss
 *  (a zero-width space, a name past the cap) — so a caller can answer with that row. */
type AddRefusal = { refused: "duplicate"; normKey: string } | { refused: "full" };
type AddOutcome = { item: VaultEntry } | AddRefusal | null;

/**
 * Add pieces of gear nobody's list has carried yet — one from the gear page, or up
 * to fifty from the connector — in one round of queries: the count taken once, and a
 * single INSERT for the lot. The
 * answer is one outcome per op, in order.
 *
 * Cannot route through captureVaultItems, and the difference is the point: capture
 * is an automatic side effect of editing a list, so it can never clear a field, can
 * never set a weight to zero, and must never lift a tombstone (every list still
 * holding the gear would resurrect it, and "remove" would mean nothing). Typing a
 * row in by hand is the opposite of all three — it is you saying so.
 */
export async function addVaultItems(
  db: Db,
  vaultId: number,
  ops: Extract<VaultItemOp, { t: "add" }>[],
): Promise<AddOutcome[]> {
  const results: AddOutcome[] = ops.map(() => null);
  // Straight through capture's own sanitizer, one op at a time so each keeps its
  // answer: a hand-typed row is capped, tidied and IDENTIFIED by exactly the rules a
  // captured one is. One identity rule, not two.
  const cleaned = ops.map((op) => sanitizeOne({ ...op, weightMg: op.weightMg ?? 0 }));

  // each key once: a second op on the same key in one call is a duplicate of the
  // first, and the INSERT may not touch a row twice
  const rows: { index: number; cap: VaultCapture }[] = [];
  const seen = new Set<string>();
  ops.forEach((op, index) => {
    const cap = cleaned[index];
    if (!cap) return;
    if (seen.has(cap.normKey)) {
      results[index] = { refused: "duplicate", normKey: cap.normKey };
      return;
    }
    seen.add(cap.normKey);
    rows.push({ index, cap });
  });

  // The ceiling, as capture measures it — but a DELIBERATE add REFUSES where capture
  // drops silently, the way a deliberate press should.
  const { fit: landing, over } = await underCeiling(db, vaultId, rows, (r) => r.cap.normKey);
  for (const r of over) results[r.index] = { refused: "full" };
  if (!landing.length) return results;

  const now = new Date();
  const done = await db
    .insert(vaultItems)
    .values(
      landing.map(({ index, cap }) => ({
        ...rowValues(cap, vaultId, now),
        entryUnit: unitOf(ops[index]!.entryUnit) ?? null,
        owned: ownedOf(ops[index]!.owned) ?? null,
        // Typing it in is choosing it: every field you supplied is yours, and no list
        // may overwrite it. A zero weight pins nothing — see cleanVaultPatch.
        namePinned: true,
        weightPinned: cap.weightMg > 0,
        commonNamePinned: cap.commonName != null,
        classificationPinned: cap.classification != null,
        kcalPinned: cap.kcal != null,
        productUrlPinned: cap.productUrl != null,
        pricePinned: cap.priceCents != null,
      })),
    )
    .onConflictDoUpdate({
      target: [vaultItems.vaultId, vaultItems.normKey],
      // THE difference from capture, and the whole reason this can't route through
      // it: an explicit add LIFTS a tombstone. It also means a conflict with a LIVE
      // row updates nothing and returns nothing — which is how the mapping below
      // tells "you already have this" from "welcome back". Re-adding gear you
      // already hold should say so, not silently rewrite the row you were looking at.
      setWhere: isNotNull(vaultItems.removedAt),
      set: {
        // An add is an EXPLICIT act, so what you typed wins outright — no pin check
        // (you ARE the pin) and no coalesce on the fields you actually filled in.
        brand: sql`excluded.brand`,
        name: sql`excluded.name`,
        variant: sql`excluded.variant`,
        commonName: sql`coalesce(excluded.common_name, ${vaultItems.commonName})`,
        // re-adding a put-away KIT by name brings it back, but never with the typed
        // weight as its own — that figure is its parts' (see the capture guard)
        weightMg: sql`case when ${vaultItems.kind} <> 'kit' and excluded.weight_mg > 0 then excluded.weight_mg else ${vaultItems.weightMg} end`,
        classification: sql`coalesce(excluded.classification, ${vaultItems.classification})`,
        kcal: sql`coalesce(excluded.kcal, ${vaultItems.kcal})`,
        productUrl: sql`coalesce(excluded.product_url, ${vaultItems.productUrl})`,
        priceCents: sql`coalesce(excluded.price_cents, ${vaultItems.priceCents})`,
        currency: sql`case when excluded.price_cents is not null then excluded.currency else ${vaultItems.currency} end`,
        // pins UNION — an add must never RELEASE one an earlier edit earned
        namePinned: sql`true`,
        weightPinned: sql`${vaultItems.weightPinned} or excluded.weight_pinned`,
        commonNamePinned: sql`${vaultItems.commonNamePinned} or excluded.common_name_pinned`,
        classificationPinned: sql`${vaultItems.classificationPinned} or excluded.classification_pinned`,
        kcalPinned: sql`${vaultItems.kcalPinned} or excluded.kcal_pinned`,
        productUrlPinned: sql`${vaultItems.productUrlPinned} or excluded.product_url_pinned`,
        pricePinned: sql`${vaultItems.pricePinned} or excluded.price_pinned`,
        removedAt: null,
        // surfaces at the top of /gear, which orders by last_used_at desc
        lastUsedAt: now,
        updatedAt: now,
        // times_seen is NOT bumped: it counts CAPTURES — it ranks the autocomplete
        // by how often a LIST reaches for the gear — and typing a row in isn't one.
      },
    })
    .returning();
  // no row back for a key = its conflict was with a live row and setWhere declined it
  const back = new Map(done.map((row) => [row.normKey, row]));
  for (const r of landing) {
    const row = back.get(r.cap.normKey);
    results[r.index] = row ? { item: toEntry(row) } : { refused: "duplicate", normKey: r.cap.normKey };
  }
  return results;
}

/**
 * Correct a row in place.
 *
 * NO conflict handling, and none is possible: an edit changes the stored SPELLING
 * and never re-derives norm_key, so it cannot collide with (vault_id, norm_key). The
 * key is the gear’s IDENTITY; the spelling is a separate axis the vault has always
 * treated as overwritable (see captureFingerprint in shared/vault.ts).
 *
 * Re-deriving would orphan the row from the list that feeds it — and because capture
 * runs automatically from every open editor, that list would recreate the row under
 * its old name within seconds, unprompted. Freezing the key fails only if you go and
 * edit the list too, which is a second deliberate act.
 */
async function editVaultItem(db: Db, vaultId: number, op: Extract<VaultItemOp, { t: "edit" }>) {
  if (!isSerialId(op.id)) return null;
  const set = cleanVaultPatch(op.patch);
  if (!set) return null;
  if (Array.isArray(op.unpin)) {
    for (const [token, col] of PIN_COLUMN) if (op.unpin.includes(token)) set[col] = false;
  }
  if (!Object.keys(set).length) return null;

  // removed_at is untouched: editing a row you can see in the "removed" disclosure
  // is not the same as asking for it back, and restore is its own verb.
  // last_used_at and times_seen are untouched too — they mean "a list used this",
  // and an edit is not a use. Two of /gear's sort orders read them.
  const done = await db
    .update(vaultItems)
    .set({ ...set, updatedAt: new Date() })
    // ownership is IN the where, not a check on the result — see removeVaultItem.
    // A weight is refused on a KIT the same way: its weight is its parts', and a
    // total written into its own weight would count every part twice. A kit's own
    // weight travels with its parts, in the "kit" op.
    .where(
      and(
        eq(vaultItems.id, op.id),
        eq(vaultItems.vaultId, vaultId),
        set.weightMg !== undefined ? eq(vaultItems.kind, "piece") : undefined,
      ),
    )
    .returning();
  if (!done[0]) return null;
  // owning fewer than a kit holds: every kit holding this piece comes down to it
  if ("owned" in set) {
    const owned = ownedOf(done[0].owned) ?? 1;
    await db
      .update(vaultKitParts)
      .set({ qty: owned })
      .where(and(eq(vaultKitParts.partId, done[0].id), sql`${vaultKitParts.qty} > ${owned}`));
  }
  return { item: toEntry(done[0]) };
}

// ---------------------------------------------------------------------------
// kits: a row that names a set of pieces
// ---------------------------------------------------------------------------

/** A part off the wire: an id, and a count clamped to what the editor can step. */
function partQty(raw: unknown): number | null {
  const qty = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 1;
  return qty < 1 ? null : Math.min(VAULT_KIT_QTY_MAX, qty);
}

/**
 * Write a kit's links, replacing whatever it held: ONE delete and one insert, in the
 * order given, so the kit reads back in the order it was made. The caller has
 * already checked the rules (captureKit); this is only the write. setKitParts does the
 * same delete and insert inline, so its delete can run beside the row's update.
 */
async function writeKitLinks(db: Db, kitId: number, parts: { partId: number; qty: number }[]): Promise<void> {
  await db.delete(vaultKitParts).where(eq(vaultKitParts.kitId, kitId));
  if (parts.length) {
    await db
      .insert(vaultKitParts)
      .values(parts.map((p, i) => ({ kitId, partId: p.partId, qty: p.qty, sortOrder: i })));
  }
}

/** Is this row already some kit's part? One level deep means it can't then hold
 *  parts of its own — a kit always unfolds onto a list as exactly one group. */
async function isSomeonesPart(db: Db, id: number): Promise<boolean> {
  const rows = await db
    .select({ kitId: vaultKitParts.kitId })
    .from(vaultKitParts)
    .where(eq(vaultKitParts.partId, id))
    .limit(1);
  return rows.length > 0;
}

/**
 * Make a row a kit of these pieces, or replace an existing kit's parts, and set its
 * OWN weight. Answers null, writing nothing, when any rule fails.
 *
 * The rules a table constraint can't reach, all checked before the first write:
 *  • the kit and every part are rows of THIS vault — an id from another vault fails
 *    the whole call rather than being skipped, so nothing is half-made;
 *  • every part is a piece, and the kit is not itself some kit's part — one level
 *    deep, the rule list nesting keeps, so a kit always maps onto a list group;
 *  • a kit is never its own part, and has at least one.
 *
 * A count is held to how many of the piece you own (`owned`, one when unsaid): a kit
 * can't hold two lighters you have one of. Clamped rather than refused, so a save that
 * changes something else still lands, and the row reads back what the kit now holds.
 *
 * `ownWeightMg` is required rather than defaulted to what the row holds: making a
 * kit of a row that was typed in as the whole set ("Cook kit, 540 g") has to say what
 * is left of that figure once the parts count for themselves — usually nothing — or
 * the parts are counted twice. The weight pin comes off with it: a kit's weight is
 * nobody's to pin, since no capture may write one (the guard in captureVaultItems).
 *
 * Answers the kit's row as written, so the kit op can decorate it without reading it
 * back. Four round trips, not eight: the three checks are independent reads and go
 * together, and so do the row's update and the old links' delete; only the new links
 * wait for that.
 */
export async function setKitParts(
  db: Db,
  vaultId: number,
  kitId: number,
  parts: { id: number; qty?: number }[],
  { ownWeightMg }: { ownWeightMg: number },
): Promise<Row | null> {
  if (!isSerialId(kitId) || !Array.isArray(parts) || !Number.isFinite(ownWeightMg)) return null;
  const qtyOf = new Map<number, number>();
  for (const p of parts) {
    if (!isSerialId(p?.id) || p.id === kitId) return null;
    const qty = partQty(p.qty);
    if (qty === null) return null;
    qtyOf.set(p.id, qty);
  }
  if (!qtyOf.size || qtyOf.size > VAULT_KIT_PARTS_MAX) return null;
  const ids = [...qtyOf.keys()];

  const [[kit], nested, found] = await Promise.all([
    db
      .select({ id: vaultItems.id })
      .from(vaultItems)
      .where(and(eq(vaultItems.id, kitId), eq(vaultItems.vaultId, vaultId))),
    isSomeonesPart(db, kitId),
    db
      .select({ id: vaultItems.id, kind: vaultItems.kind, owned: vaultItems.owned })
      .from(vaultItems)
      .where(and(eq(vaultItems.vaultId, vaultId), inArray(vaultItems.id, ids))),
  ]);
  if (!kit || nested) return null;
  if (found.length !== ids.length || found.some((r) => r.kind !== "piece")) return null;
  for (const r of found) qtyOf.set(r.id, Math.min(qtyOf.get(r.id)!, ownedOf(r.owned) ?? 1));

  const [[row]] = await Promise.all([
    db
      .update(vaultItems)
      .set({ kind: "kit", weightMg: clampUnitWeightMg(ownWeightMg), weightPinned: false, updatedAt: new Date() })
      .where(and(eq(vaultItems.id, kitId), eq(vaultItems.vaultId, vaultId)))
      .returning(),
    db.delete(vaultKitParts).where(eq(vaultKitParts.kitId, kitId)),
  ]);
  await db
    .insert(vaultKitParts)
    .values(ids.map((partId, i) => ({ kitId, partId, qty: qtyOf.get(partId)!, sortOrder: i })));
  return row ?? null;
}

/**
 * Turn a kit back into a piece. Its weight becomes the total it showed a moment ago
 * (its own plus its live parts), so the row reads the same number before and after;
 * the parts stay where they are, as the pieces they always were. False when the row
 * isn't a kit of this vault.
 */
async function clearKit(db: Db, vaultId: number, kitId: number): Promise<Row | null> {
  const kit = await vaultItemById(db, vaultId, kitId);
  if (!kit || kit.kind !== "kit") return null;
  // the row's update and the links' delete are independent: one round trip for both
  const [[row]] = await Promise.all([
    db
      .update(vaultItems)
      .set({ kind: "piece", weightMg: clampUnitWeightMg(kit.weightMg), updatedAt: new Date() })
      .where(and(eq(vaultItems.id, kitId), eq(vaultItems.vaultId, vaultId)))
      .returning(),
    db.delete(vaultKitParts).where(eq(vaultKitParts.kitId, kitId)),
  ]);
  return row ?? null;
}

/** The "kit" op: set a row's parts, or clear them. The row comes back as every read
 *  shows it, or null for anything setKitParts refuses — the one answer, as for edit. */
async function kitVaultItem(db: Db, vaultId: number, op: Extract<VaultItemOp, { t: "kit" }>) {
  if (!isSerialId(op.id) || !Array.isArray(op.parts)) return null;
  const row = op.parts.length
    ? await setKitParts(db, vaultId, op.id, op.parts, { ownWeightMg: op.ownWeightMg ?? 0 })
    : await clearKit(db, vaultId, op.id);
  if (!row) return null;
  // the written row, decorated once (a kit with its parts and derived weight, a piece
  // with the kits it is in): no read back
  const [item] = await withKits(db, vaultId, [toEntry(row)]);
  return item ? { item } : null;
}

/** The parts a kit capture names, cleaned: real keys, counts the editor could step,
 *  one entry per identity (the first wins), bounded. */
function cleanPartRefs(raw: unknown): VaultKitPartRef[] {
  if (!Array.isArray(raw)) return [];
  const out = new Map<string, VaultKitPartRef>();
  for (const p of raw as Partial<VaultKitPartRef>[]) {
    if (typeof p?.normKey !== "string" || !p.normKey || out.has(p.normKey)) continue;
    const qty = partQty(p.qty);
    if (qty === null) continue;
    out.set(p.normKey, { normKey: p.normKey, qty });
    if (out.size >= VAULT_KIT_PARTS_MAX) break;
  }
  return [...out.values()];
}

/** A row as a kit's parts are resolved against it: enough to tell a piece from a
 *  kit, link it, and hold its count. */
type KitPartRow = Pick<Row, "id" | "normKey" | "kind" | "owned">;

/** The vault's rows under these identities — a kit's parts and, for a save, the
 *  kit's own — in one read, by identity. Rows of either kind: which of them can be
 *  parts is kitLinks' to say. */
async function kitPartRows(db: Db, vaultId: number, keys: string[]): Promise<Map<string, KitPartRow>> {
  if (!keys.length) return new Map();
  const rows = await db
    .select({ id: vaultItems.id, normKey: vaultItems.normKey, kind: vaultItems.kind, owned: vaultItems.owned })
    .from(vaultItems)
    .where(and(eq(vaultItems.vaultId, vaultId), inArray(vaultItems.normKey, keys)));
  return new Map(rows.map((r) => [r.normKey, r]));
}

/**
 * A kit's parts named by identity, resolved: each ref whose row is a PIECE, in the
 * kit's order, with the group's count. A child that shares its name with a kit is
 * skipped rather than nested (one level deep), and so is the kit's own identity. A
 * put-away piece still links — it is listed under the kit and stops counting, which
 * is what its row says on /gear — and a name with no row is skipped: what's missing
 * was refused for space or was never gear. Nothing left means no kit to make.
 */
function kitLinks<R extends { kind: string }>(
  refs: VaultKitPartRef[],
  rowOf: (normKey: string) => R | undefined,
  kitKey?: string,
): { row: R; qty: number }[] {
  return refs.flatMap((p) => {
    const row = p.normKey === kitKey ? undefined : rowOf(p.normKey);
    return row?.kind === "piece" ? [{ row, qty: p.qty }] : [];
  });
}

/**
 * Write a kit's resolved links (writeKitLinks). A kit never holds more of a piece
 * than you own, and here the list is the evidence: a group carrying two lighters says
 * you have two, so a piece owned fewer times is raised to the group's count (never
 * lowered) rather than the kit cut short of it. The row's count is kept up to date
 * as it is raised, for the next kit that reads it.
 */
async function linkKitParts(
  db: Db,
  vaultId: number,
  kitId: number,
  links: { row: Pick<KitPartRow, "id" | "owned">; qty: number }[],
): Promise<void> {
  for (const { row, qty } of links) {
    if (qty <= (ownedOf(row.owned) ?? 1)) continue;
    await db.update(vaultItems).set({ owned: qty }).where(and(eq(vaultItems.id, row.id), eq(vaultItems.vaultId, vaultId)));
    row.owned = qty;
  }
  await writeKitLinks(db, kitId, links.map(({ row, qty }) => ({ partId: row.id, qty })));
}

/** Why a group's save did or didn't make a kit. Each is a different thing for the
 *  row to SAY (see useVault.captureOne for the piece's own set of answers). */
type CaptureKitOutcome = "saved" | "removed" | "nested" | "full" | "refused";

/**
 * A group row, offered to the vault as a kit — the group row's own Save to My Gear.
 *
 * Two writes, in this order. The PARTS go first, through the ordinary capture, as
 * the pieces they are: pins, tombstones and the ceiling all apply, and a press on the
 * group is a press on each of them (overwriteWeight is the caller's, as captureOne
 * sends it). Then the KIT: its row is upserted like a capture's, except that its
 * kind becomes `kit` and its weight is stated outright — the group's OWN weight, the
 * stuff sack — because this is the deliberate act, and a hand-typed row of the same
 * name ("Cook kit, 540 g") converting in place would otherwise keep that total as
 * its own and count every part twice. The pin comes off the weight with it. Finally
 * the links, by identity (kitLinks).
 *
 * Every refusal is settled BEFORE anything is written to the kit's row: a piece that
 * is already some kit's part can't become a kit (one level deep), a new kit needs
 * room under the ceiling, and a group none of whose parts can be a part is no kit.
 * Upserting the row first and finding that out second would leave it overwritten —
 * its weight, its pin, its spelling — by a save that didn't happen.
 *
 * A tombstoned kit is written and stays put away, like any capture — the parts still
 * link, so putting it back on /gear brings back the set — and reports "removed"
 * rather than landing, which is the answer captureOne gives a piece in that state.
 */
export async function captureKit(
  db: Db,
  vaultId: number,
  kit: VaultKitCapture,
  partCaps: VaultCapture[],
  { overwriteWeight = false }: { overwriteWeight?: boolean } = {},
): Promise<{ keys: VaultGearKey[]; full: boolean; kit: CaptureKitOutcome }> {
  // The kit and its parts take the catalog's current spelling in ONE read, as every
  // capture takes it (respellCatalogPicks), and each is cleaned at its own index — so
  // a part's key as the CLIENT folded it maps to the key its row is stored under:
  // respelled, and re-derived from the tidied text, where tidyText and foldForSearch
  // can disagree (a zero-width space, say). A ref that missed its row would silently
  // drop an item from the kit.
  const parts = partCaps.slice(0, VAULT_CAPTURE_MAX);
  const [clean, ...cleanParts] = (await respellCatalogPicks(db, [kit, ...parts])).map(sanitizeOne);
  const landed = await upsertCaptures(db, vaultId, onePerKey(cleanParts), { overwriteWeight });
  const serverKey = new Map<string, string>();
  parts.forEach((c, i) => {
    const s = cleanParts[i];
    if (s && typeof c?.normKey === "string") serverKey.set(c.normKey, s.normKey);
  });
  const refs = cleanPartRefs(kit?.parts).map((p) => ({ ...p, normKey: serverKey.get(p.normKey) ?? p.normKey }));
  if (!clean || !refs.length) return { ...landed, kit: "refused" };

  // the kit's own row, if the vault holds one, and its parts' rows, in one read
  const rows = await kitPartRows(db, vaultId, [clean.normKey, ...refs.map((p) => p.normKey)]);
  const prior = rows.get(clean.normKey);
  if (prior && (await isSomeonesPart(db, prior.id))) return { ...landed, kit: "nested" };
  // the ceiling, for a kit row that doesn't exist yet — refused out loud, like a
  // hand add, since a press asked for it
  if (!prior && (await vaultItemCount(db, vaultId)) >= VAULT_ITEMS_MAX) return { ...landed, full: true, kit: "full" };
  // every named part a kit itself, or missing: not a kit after all
  const links = kitLinks(refs, (k) => rows.get(k), clean.normKey);
  if (!links.length) return { ...landed, kit: "refused" };

  const now = new Date();
  const [row] = await db
    .insert(vaultItems)
    .values({ ...rowValues(clean, vaultId, now), kind: "kit" })
    .onConflictDoUpdate({
      target: [vaultItems.vaultId, vaultItems.normKey],
      set: { ...captureSet(now, sql`excluded.weight_mg`), kind: sql`'kit'`, weightPinned: false },
    })
    .returning();
  if (!row) return { ...landed, kit: "refused" };
  await linkKitParts(db, vaultId, row.id, links);
  if (row.removedAt) return { ...landed, kit: "removed" };
  return { ...landed, keys: [...landed.keys, gearKeyOf(row)], kit: "saved" };
}

// ---------------------------------------------------------------------------
// import: putting a file's worth of gear back
// ---------------------------------------------------------------------------

/** The pin booleans a row arrives with. A weight of zero pins NOTHING, the same
 *  guard cleanVaultPatch applies: pinning "not weighed yet" would lock the row out
 *  of ever learning its weight from a list. */
function pinFlags(row: VaultImportRow): Record<string, boolean> {
  const held = new Set(row.pinned ?? []);
  const out: Record<string, boolean> = {};
  for (const [token, col] of PIN_COLUMN) out[col] = held.has(token);
  if (row.weightMg <= 0) out.weightPinned = false;
  return out;
}

/**
 * Put a file's worth of gear into the vault.
 *
 * ADDS WHAT'S MISSING AND TOUCHES NOTHING ELSE — `onConflictDoNothing`, not an
 * upsert. A restore is usually into an empty vault, where every rule behaves the
 * same; the rule only matters in the case that can do harm, which is a stale backup
 * dropped on a vault you have since curated. Overwriting there would undo months of
 * corrections in one press with no way back, so the conflict is a skip and the count
 * comes back so the dialog can say how many.
 *
 * The skip also means a TOMBSTONE holds: the unique index doesn't care that a row is
 * removed, so gear you took out stays out rather than being resurrected by a file.
 * That is the same answer capture gives, and for the same reason — putting a piece
 * back is a deliberate act with its own control on /gear.
 *
 * Pins ride in from our own JSON and nowhere else (see VaultImportRow). Everything
 * else goes through sanitize, so a hand-edited backup is bounded exactly like a
 * direct POST: the identity is re-derived from the spelling and every field re-clamped.
 */
export async function importVaultItems(
  db: Db,
  vaultId: number,
  rows: VaultImportRow[],
): Promise<{ added: number; skipped: number }> {
  // Sanitized ONE AT A TIME so each row's pins stay with it — sanitize dedupes by a
  // key it derives itself, and pairing that key back to a source row afterwards
  // would mean re-deriving it here with the same tidying, in a second place.
  const byKey = new Map<string, { cap: VaultCapture; pins: Record<string, boolean>; kit?: VaultImportRow["kit"]; row: VaultImportRow }>();
  for (const row of rows.slice(0, VAULT_IMPORT_MAX)) {
    const cap = sanitizeOne(row);
    if (!cap) continue;
    // a kit from our own JSON names its parts by identity; nothing else states one
    const parts = row.kit && Number.isFinite(row.kit.ownWeightMg) ? cleanPartRefs(row.kit.parts) : [];
    const kit = parts.length ? { ownWeightMg: clampUnitWeightMg(row.kit!.ownWeightMg), parts } : undefined;
    byKey.set(cap.normKey, { cap, pins: pinFlags(row), kit, row }); // last wins, like sanitize's own dedupe
  }
  if (!byKey.size) return { added: 0, skipped: 0 };

  // The ceiling (underCeiling). Rows past it are skipped rather than refused: an
  // import that lands most of a backup and says so beats one that lands none. A row
  // the vault already holds is never past it, since it adds nothing; it is skipped
  // below as the gear you already have.
  const all = [...byKey.values()];
  const { fit } = await underCeiling(db, vaultId, all, (r) => r.cap.normKey);
  if (!fit.length) return { added: 0, skipped: all.length };

  // Kit or piece, settled BEFORE the insert. A kit lands as one — at its own weight,
  // since the file's weightMg is the derived total and as a piece's weight would
  // count its parts twice — when a part it names can be linked: a piece the vault
  // holds, or one of the file's own pieces landing beside it (a name the vault
  // holds is the vault's row, since the file's is skipped). A kit with none is the
  // piece the file also describes, at the total it states for it.
  const held = await kitPartRows(db, vaultId, fit.flatMap((r) => r.kit?.parts.map((p) => p.normKey) ?? []));
  const fromFile = new Set(fit.filter((r) => !r.kit).map((r) => r.cap.normKey));
  const landing = fit.map((r) =>
    r.kit && !kitLinks(r.kit.parts, (k) => held.get(k) ?? (fromFile.has(k) ? { kind: "piece" } : undefined)).length
      ? { ...r, kit: undefined }
      : r,
  );

  const now = new Date();
  const done = await db
    .insert(vaultItems)
    .values(
      // the content columns and the new-row stamps are rowValues' (times_seen stays
      // at 1: it counts the lists that reached for a piece of gear, and a file is not
      // a list — a restored vault's ranking rebuilds itself the next time you pack);
      // the pins ride on top, which is what sets an import apart from a capture
      landing.map(({ cap, pins, kit, row }) => ({
        ...rowValues(kit ? { ...cap, weightMg: kit.ownWeightMg } : cap, vaultId, now),
        kind: kit ? "kit" : "piece",
        ...pins,
        // a kit's weight is nobody's to pin (see setKitParts)
        ...(kit ? { weightPinned: false } : {}),
        // what only /gear writes, so no capture carries it: a backup's count, picked
        // icon and unit, each checked the way an edit checks it
        owned: ownedOf(row.owned) ?? null,
        icon: isGearGlyph(row.icon) ? row.icon : null,
        entryUnit: unitOf(row.entryUnit) ?? null,
      })),
    )
    // no target: the identity index (vault_id, norm_key) is the only conflict a
    // row can have, and every one of them means "you already have this"
    .onConflictDoNothing()
    .returning();
  // The kits that landed get their parts, resolved as above: the file's own pieces,
  // just added, or pieces the vault already had. A kit the vault already held was
  // skipped and keeps the parts it has: a stale backup must not rewrite a set you
  // have since changed, which is this function's rule.
  const added = new Map(done.map((r) => [r.normKey, r]));
  for (const { cap, kit } of landing) {
    const row = kit && added.get(cap.normKey);
    if (!row) continue;
    await linkKitParts(db, vaultId, row.id, kitLinks(kit.parts, (k) => held.get(k) ?? (fromFile.has(k) ? added.get(k) : undefined)));
  }
  return { added: done.length, skipped: all.length - done.length };
}

