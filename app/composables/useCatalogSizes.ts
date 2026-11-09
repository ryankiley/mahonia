import type { Ref } from "vue";
import type { CatalogSize } from "~~/shared/catalogSizes";

// A linked row's other sizes (shared/catalogSizes), fetched when a person starts
// editing the row and not before: a list of 150 linked rows mounts no requests. One
// fetch per product for the page, shared by every row linked to any of its sizes, so a
// list holding the quilt twice asks once. A failed fetch (offline) is forgotten, so
// the next edit can ask again; until then the row offers no picker and a typed size
// unlinks, which is true either way.

const byId = new Map<number, Promise<CatalogSize[] | null>>();
const loaded = shallowReactive(new Map<number, CatalogSize[]>());

/** The product's sizes for a catalog row id, or null when they can't be had. */
export function loadCatalogSizes(id: number): Promise<CatalogSize[] | null> {
  let p = byId.get(id);
  if (!p) {
    p = $fetch<{ sizes: CatalogSize[] }>("/api/catalog/sizes", { query: { id } }).then(
      ({ sizes }) => {
        // every size answers for the product, so a relink to a sibling is already known
        for (const s of sizes) {
          byId.set(s.id, Promise.resolve(sizes));
          loaded.set(s.id, sizes);
        }
        loaded.set(id, sizes);
        return sizes;
      },
      () => {
        byId.delete(id);
        return null;
      },
    );
    byId.set(id, p);
  }
  return p;
}

/** The sizes to offer on a row: its product's, once `wanted` turns true while it is
 *  linked; empty for a product sold in one size, so the picker never offers just one. */
export function useCatalogSizes(id: Readonly<Ref<number | undefined>>, wanted: Readonly<Ref<boolean>>) {
  watch(
    [id, wanted],
    ([i, w]) => {
      if (w && i != null) void loadCatalogSizes(i);
    },
    { immediate: true },
  );
  return computed<CatalogSize[]>(() => {
    const sizes = id.value == null ? undefined : loaded.get(id.value);
    return sizes && sizes.length > 1 ? sizes : [];
  });
}
