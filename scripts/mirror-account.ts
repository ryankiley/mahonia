// A LOCAL account that mirrors a real one: its lists and its gear, so a change to
// /gear or the editor can be tried against a closet of a hundred-odd real rows and
// seven real packs instead of three rows typed in a hurry.
//
// Reads seed/_mirror/mirror.json (gitignored — it names an account):
//
//   {
//     "email": "you@example.com",            // the local account to make or fill
//     "lists": ["ABCD2345EFGH", "..."],       // share codes, fetched from the public read
//     "gear": "gear.json"                     // optional: a file beside it, see below
//   }
//
// Lists come from the public share endpoint (a share link is permission to read, so
// nothing here needs a session or a token). Gear comes from a file in one of two
// shapes: /gear's own "Download JSON" export, or the connector's get_my_gear answer —
// both carry the folder names, the weights, the classes and the catalog links.
//
// Writes go to the local PGlite only. The script refuses to run with DATABASE_URL
// set, because "mirror a real account" must never mean "write into production".
//
// PGlite is one process at a time: stop the dev server first, then
//
//   npm run seed      # once, so the catalog is there for the links to point at
//   npm run mirror
//
// then start the dev server and open the sign-in link the script printed (it is the
// same magic link the sign-in form would mail, minted here instead; good for fifteen
// minutes, or ask the form for another — with no mail key the server prints it).
//
// A SNAPSHOT, one way. Nothing here flows back, and nothing keeps it current:
// re-running adds lists the account doesn't hold yet (by title) and gear rows the
// file has that the vault lacks, and changes nothing that is already there. To
// catch up with the real account, rebuild:
//
//   npm run mirror -- --fresh
//
// which puts away the mirror's lists and empties its gear before importing again.
// The lists are read live from the public endpoint, so they are current on every
// run; the gear file is only as fresh as its last export (/gear's ⋯ menu →
// Download JSON, or the connector's get_my_gear, saved beside the config).
//
// Catalog links are RE-RESOLVED BY TEXT. A production catalog id means nothing in a
// local database seeded in a different order, so every linked row is matched to the
// local catalog by brand + name + variant, and a row with no local match loses its
// link rather than pointing at a stranger.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, isNull } from "drizzle-orm";
import { catalogItems, listClaims, lists, vaultFolders, vaultItems } from "../server/db/schema";
import { findOrCreateUser, issueMagicToken, normalizeEmail } from "../server/utils/authSession";
import { claimLists, listClaimedLists } from "../server/utils/claimRepo";
import { useVaultDb, type Db } from "../server/utils/db";
import { createList } from "../server/utils/listRepo";
import { mintVault } from "../server/utils/vaultAuth";
import { importVaultItems } from "../server/utils/vaultRepo";
import type { Classification, Item, ListData, ListMeta, ListSnapshot } from "../shared/types";
import { isRecord } from "../shared/record";
import { vaultNormKey } from "../shared/vault";
import { vaultImportFromJson, type VaultImportRow } from "../shared/vaultImport";
import { ROOT } from "./paths";

const MIRROR_DIR = join(ROOT, "seed", "_mirror");
const CONFIG = join(MIRROR_DIR, "mirror.json");
/** Where the share codes are read from. Overridable so a preview deployment can be
 *  mirrored too. */
const ORIGIN = process.env.MAHONIA_ORIGIN || "https://mahonia.app";

interface MirrorConfig {
  email: string;
  lists?: string[];
  gear?: string;
}

function readConfig(): MirrorConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch (e) {
    throw new Error(`Could not read ${CONFIG}: ${(e as Error).message}`);
  }
  if (!isRecord(raw) || typeof raw.email !== "string") throw new Error(`${CONFIG} needs an "email"`);
  const lists = Array.isArray(raw.lists) ? raw.lists.filter((c): c is string => typeof c === "string") : [];
  const gear = typeof raw.gear === "string" ? raw.gear : undefined;
  return { email: raw.email, lists, gear };
}

/**
 * The local catalog as a text index, so a production id can be swapped for the local
 * row that describes the same product. Retired rows (merged_into_id set) are left
 * out: a link should land on the live row, the way the app's own respell does.
 */
async function catalogIndex(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ id: catalogItems.id, brand: catalogItems.brand, name: catalogItems.name, variant: catalogItems.variant })
    .from(catalogItems)
    .where(isNull(catalogItems.mergedIntoId));
  const index = new Map<string, number>();
  for (const r of rows) {
    const key = vaultNormKey(r.brand, r.name, r.variant);
    if (key && !index.has(key)) index.set(key, r.id);
  }
  return index;
}

type Resolve = (brand: string | null | undefined, name: string, variant: string | null | undefined) => number | undefined;

/** The share code's public snapshot — the read view's own data. */
async function fetchSnapshot(code: string): Promise<ListSnapshot> {
  const res = await fetch(`${ORIGIN}/api/s/${encodeURIComponent(code)}`, {
    headers: { accept: "application/json", "user-agent": "Mahonia mirror-account/1.0" },
  });
  if (!res.ok) throw new Error(`${code}: ${res.status} from ${ORIGIN}`);
  const body = (await res.json()) as { snapshot?: ListSnapshot };
  if (!body.snapshot) throw new Error(`${code}: no snapshot in the response`);
  return body.snapshot;
}

/**
 * A snapshot as createList takes it: the meta that is a fact about the trip, and the
 * data with every catalog link re-pointed at the local catalog. Ids stay as they
 * are — normalizeListData keeps a well-formed string id, and nothing else in the
 * local database has ever seen these.
 */
function listInit(snap: ListSnapshot, resolve: Resolve): Partial<ListMeta> & { data: ListData } {
  const items: Item[] = (snap.items ?? []).map((it) => {
    if (it.catalogItemId == null) return it;
    const local = resolve(it.brand, it.name, it.variant);
    // the link's companion goes with it: a "catalog changed" nudge against a weight
    // from another database would be a lie about this one
    if (local == null) return { ...it, catalogItemId: undefined, catalogWeightMgAtLink: undefined };
    return { ...it, catalogItemId: local };
  });
  return {
    title: snap.title,
    description: snap.description,
    displayUnit: snap.displayUnit,
    trailUrl: snap.trailUrl,
    trailLabel: snap.trailLabel,
    trailDistanceM: snap.trailDistanceM,
    trailDistanceUnit: snap.trailDistanceUnit,
    trailProfile: snap.trailProfile,
    trailAscentM: snap.trailAscentM,
    trailDescentM: snap.trailDescentM,
    startDate: snap.startDate,
    endDate: snap.endDate,
    data: {
      folders: snap.folders ?? [],
      items,
      days: snap.days ?? [],
      people: snap.people ?? [],
    },
  };
}

/** The connector's get_my_gear answer, one piece. Grams and major-unit prices there;
 *  milligrams and cents here. */
interface ConnectorGear {
  brand?: string | null;
  name: string;
  variant?: string | null;
  gear_type?: string | null;
  weight_g?: number | null;
  classification?: Classification | null;
  kcal?: number | null;
  note?: string | null;
  price?: number | null;
  currency?: string | null;
  product_url?: string | null;
  folder?: string | null;
}

function isClassification(v: unknown): v is Classification {
  return v === "base" || v === "worn" || v === "consumable";
}

/** Gear rows from either file shape, with catalog links resolved locally. */
function gearRows(text: string, resolve: Resolve): VaultImportRow[] {
  const own = vaultImportFromJson(text);
  let rows: VaultImportRow[];
  if (own) {
    rows = own.rows;
  } else {
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || !Array.isArray(raw.gear)) {
      throw new Error("gear file is neither /gear's JSON export nor a get_my_gear answer");
    }
    rows = (raw.gear as ConnectorGear[]).flatMap((g): VaultImportRow[] => {
      if (!isRecord(g) || typeof g.name !== "string" || !g.name.trim()) return [];
      const brand = g.brand ?? undefined;
      const variant = g.variant ?? undefined;
      return [
        {
          normKey: vaultNormKey(brand, g.name, variant),
          brand,
          name: g.name,
          variant,
          commonName: g.gear_type ?? undefined,
          weightMg: Math.max(0, Math.round((g.weight_g ?? 0) * 1000)),
          classification: isClassification(g.classification) ? g.classification : undefined,
          kcal: g.kcal ?? undefined,
          priceCents: g.price != null ? Math.round(g.price * 100) : undefined,
          currency: g.currency ?? undefined,
          productUrl: g.product_url ?? undefined,
          folder: g.folder ?? undefined,
        },
      ];
    });
  }
  return rows.map((r) => ({
    ...r,
    catalogItemId: resolve(r.brand, r.name, r.variant),
    // the text IS the local catalog's spelling when it matched, and the respell
    // would only restate it; leave the flag off so a row keeps the spelling it came with
    catalogSpelling: undefined,
  }));
}

/**
 * --fresh: put away every list the mirror account holds and empty its gear, so the
 * run that follows rebuilds the account from today's lists and file. Lists are
 * soft-deleted the way the app's own Delete does (deletedAt), so the reaper's grace
 * window still applies; the gear is simply removed — it is a copy, and the file has it.
 */
async function wipe(db: Db, userId: number, vaultId: number): Promise<void> {
  const claimed = await db.select({ listId: listClaims.listId }).from(listClaims).where(eq(listClaims.userId, userId));
  const ids = claimed.map((c) => c.listId);
  if (ids.length) {
    await db.update(lists).set({ deletedAt: new Date() }).where(inArray(lists.id, ids));
    await db.delete(listClaims).where(eq(listClaims.userId, userId));
  }
  await db.delete(vaultItems).where(eq(vaultItems.vaultId, vaultId));
  await db.delete(vaultFolders).where(eq(vaultFolders.vaultId, vaultId));
  console.log(`  Fresh start: ${ids.length} lists put away, gear emptied.`);
}

async function main() {
  const fresh = process.argv.slice(2).includes("--fresh");
  if (process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is set. The mirror writes to the local PGlite only; unset it and run again.");
  }
  const config = readConfig();
  const email = normalizeEmail(config.email);
  if (!email) throw new Error(`"${config.email}" is not an address the sign-in form would take`);

  const db = await useVaultDb();
  const user = await findOrCreateUser(db, email);
  const vaultId = await mintVault(db, user.id);
  console.log(`Account ${email} (user ${user.id}, vault ${vaultId}).`);
  if (fresh) await wipe(db, user.id, vaultId);

  const index = await catalogIndex(db);
  if (!index.size) {
    console.warn("The local catalog is empty, so every catalog link will be dropped. Run `npm run seed` first to keep them.");
  }
  let linked = 0;
  let unlinked = 0;
  const resolve: Resolve = (brand, name, variant) => {
    const id = index.get(vaultNormKey(brand, name, variant));
    if (id == null) unlinked++;
    else linked++;
    return id;
  };

  // Lists first: they are what the gear was captured from, and seeing them in the
  // switcher is the first sign the mirror worked.
  const held = new Set((await listClaimedLists(db, user.id)).map((l) => l.title));
  for (const code of config.lists ?? []) {
    const snap = await fetchSnapshot(code);
    if (held.has(snap.title)) {
      console.log(`  ${snap.title}: already held, skipped`);
      continue;
    }
    const { editToken, snapshot } = await createList({ ...listInit(snap, resolve), authorUserId: user.id });
    await claimLists(db, user.id, [editToken]);
    held.add(snap.title);
    console.log(`  ${snap.title}: ${snapshot.items.length} rows in ${snapshot.folders.length} folders → /e/${snapshot.shareCode}`);
  }

  if (config.gear) {
    const text = readFileSync(join(MIRROR_DIR, config.gear), "utf8");
    const rows = gearRows(text, resolve);
    const { added, skipped } = await importVaultItems(db, vaultId, rows);
    console.log(`  My Gear: ${added} added, ${skipped} already there, of ${rows.length} in the file.`);
  }

  console.log(`Catalog links: ${linked} matched the local catalog, ${unlinked} dropped.`);

  // The way in, ready to click: the same token the sign-in form would mail. Minted
  // last, because issuing one consumes any earlier pending link for the account.
  const token = await issueMagicToken(db, user.id);
  const origin = process.env.MIRROR_ORIGIN || "http://localhost:3000";
  console.log(`\nStart the dev server, then sign in as ${email}:\n  ${origin}/auth/callback?t=${token}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Mirror failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
