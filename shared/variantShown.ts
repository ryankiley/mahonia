// Which rows' variant EARNS its place on the row.
//
// A catalog row is one per variant ("Long, 18F", "Men's Medium"), and every row used
// to print its variant as a dimmed suffix on the name. Once the gear is yours the size
// is known, and "Men's Medium" beside the brand and product you know it by is noise.
// On a list, the variant tells a reader something in exactly one place: where the list
// holds the same product in MORE THAN ONE variant, because there it is the only thing
// telling two rows apart. There it shows on the sub-line under the name (the checklist
// and share rows), which is where the editor keeps it on every row; everywhere else it
// stays in the quiet places (the catalog picker, that editor sub-line) or off the row.
// The name line itself is brand + product on every face.
//
// Two things deliberately keep it regardless. The vault's identity (vaultNormKey): a
// medium and a large remain two things in My Gear. And the exports, because a file
// is read without the context the row has.

import type { Item } from "./types";
import { vaultNormKey } from "./vault";

type Named = Pick<Item, "id" | "name" | "brand" | "variant">;

/**
 * The ids of the rows whose variant shows on the row's sub-line: every row carrying a
 * variant, of a product the list holds in two or more variants.
 *
 * A product is the folded brand + name, the vault's own key minus the variant, so
 * "Zpacks Duplex" and "zpacks  duplex" are one product and a typed brand matches a
 * picked one. "No variant" counts as one of the variants: a "Regular" beside an
 * unsized twin of the same product still says "Regular", since that is the one row
 * the reader can't tell from the other. Nested rows count like any other; a group
 * whose children are the same quilt in two lengths is exactly the case.
 */
export function variantShownIds(items: readonly Named[]): ReadonlySet<string> {
  const byProduct = new Map<string, { variants: Set<string>; ids: string[] }>();
  for (const it of items) {
    const product = vaultNormKey(it.brand, it.name, null);
    if (!product) continue; // a nameless row is not a product
    const entry = byProduct.get(product) ?? { variants: new Set<string>(), ids: [] };
    entry.variants.add(vaultNormKey(it.brand, it.name, it.variant));
    if (it.variant) entry.ids.push(it.id);
    byProduct.set(product, entry);
  }
  const shown = new Set<string>();
  for (const { variants, ids } of byProduct.values()) {
    if (variants.size < 2) continue;
    for (const id of ids) shown.add(id);
  }
  return shown;
}
