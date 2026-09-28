// A catalog page's "Pack this": /e?add=<brand/product>[&variant=…] becomes a linked
// row in the open draft. Loaded on demand by GearEditor (a dynamic import) — the
// editor's first load is measured to the kilobyte and this runs for one visitor in
// many — and given the controller rather than reaching for the singleton, so a test
// can drive it against a fresh one.
//
// The page that sent us was built from the CSV and never knew the catalog's ids, so
// the product endpoint resolves the slug to rows first; the pick then lands through
// addCatalogItem with an autocomplete pick's semantics. Nothing here creates a list:
// the row's arrival trips the draft rule (hasRealContent → createFromDraft), the same
// way a first typed row does.
import type { CatalogPick } from "~/composables/useGearList";
import { itemDisplayName } from "~~/shared/weights";

type Controller = Pick<ReturnType<typeof useGearList>, "snapshot" | "draftSettled" | "addFolder" | "addCatalogItem">;

interface ProductAnswer {
  product: {
    brand: string | null;
    name: string;
    commonName: string | null;
    categoryHint: string | null;
    variants: { id: number; variant: string | null; weightMg: number; kcal: number | null }[];
  };
}

// The catalog's category → the folder that holds it: the starter folders' own keys,
// and for the rest the name colorKeyForName already recognises (shared/categories),
// so a folder made here is coloured like one the visitor would have typed.
const FOLDER_FOR: Record<string, { colorKey: string; name: string }> = {
  shelter: { colorKey: "shelter", name: "Shelter" },
  sleep: { colorKey: "sleep", name: "Sleep" },
  pack: { colorKey: "pack", name: "Pack" },
  cook: { colorKey: "kitchen", name: "Kitchen" },
  water: { colorKey: "water", name: "Water" },
  clothing: { colorKey: "clothing", name: "Clothing" },
  electronics: { colorKey: "electronics", name: "Electronics" },
  firstaid: { colorKey: "firstaid", name: "First aid" },
  consumable: { colorKey: "consumable", name: "Food & Fuel" },
};

/** Why nothing was added: the catalog answered and holds no such product or variant
 *  ("missing" — a row renamed since the page was built, or a database the seeder
 *  hasn't reached yet), or it gave no answer at all ("unreachable"). The editor's
 *  toast says which; a visitor offline and a visitor on a stale page are owed
 *  different words. */
export type PackOutcome = { ok: true; name: string } | { ok: false; reason: "missing" | "unreachable" };

export async function packFromCatalog(c: Controller, slug: string, variant?: string): Promise<PackOutcome> {
  let answer: ProductAnswer;
  try {
    answer = await $fetch<ProductAnswer>("/api/catalog/product", { query: { slug } });
  } catch (e) {
    const err = e as { status?: number; statusCode?: number }; // ofetch's FetchError, either spelling
    return { ok: false, reason: (err.status ?? err.statusCode) === 404 ? "missing" : "unreachable" };
  }
  const { product } = answer;
  // The variant the page's row named, exactly — never a different size under the
  // name the visitor pressed: the toast would say "Regular" for a moment and the
  // list would carry the wrong weight for good. No variant named means the page had
  // one row, and the product's first variant is that row.
  const row = variant ? product.variants.find((v) => v.variant === variant) : product.variants[0];
  if (!row) return { ok: false, reason: "missing" };

  // the restored draft, if one was waiting in IndexedDB, replaces the starter
  // snapshot asynchronously: land the row after that, never before
  await c.draftSettled();
  if (!c.snapshot.value) return { ok: false, reason: "unreachable" };

  const home = FOLDER_FOR[product.categoryHint ?? ""];
  let folderId: string | null = null;
  if (home) {
    folderId = c.snapshot.value.folders.find((f) => f.colorKey === home.colorKey)?.id ?? c.addFolder(home.name);
  }
  const pick: CatalogPick = {
    id: row.id,
    brand: product.brand,
    name: product.name,
    variant: row.variant,
    weightMg: row.weightMg,
    commonName: product.commonName,
    categoryHint: product.categoryHint,
    kcal: row.kcal,
  };
  c.addCatalogItem(pick, folderId);
  // self-improving ranking, as after an autocomplete pick (ItemInput) — fire and forget
  $fetch("/api/catalog/use", { method: "POST", body: { ids: [row.id] } }).catch(() => {});
  return { ok: true, name: itemDisplayName(product.brand, product.name, row.variant) };
}
