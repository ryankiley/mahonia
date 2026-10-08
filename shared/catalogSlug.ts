// The address of a catalog product: /catalog/<brand>/<product>. One rule, in shared/,
// so the build (which writes it into every row and fails on a collision), the seeder
// (which stores it), the pages and the editor's "Pack this" link all spell it the
// same way — a slug made in one place and matched in another would be a 404 nobody
// could explain.
//
// The rule is the search fold (shared/searchText.ts: NFD, strip diacritics,
// lowercase, non-alphanumerics to one separator) with three additions the fold
// doesn't need and an address does:
//   • an apostrophe or a degree sign vanishes rather than splitting — "Men's" is
//     `mens`, not `men-s`, and "Flex 15°F" is `flex-15f`;
//   • "+" is spelled out, because the fold erases it and the catalog holds seven
//     pairs that differ by nothing else (X-Mid Pro 2 and 2+, Lone Peak 9 and 9+,
//     Hydrapak's Flux/Flux+, PackFlask/PackFlask+, Seeker/Seeker+);
//   • a minus before a digit is spelled out for the same reason (Mountain Hardwear's
//     Bishop Pass -15F beside its 15F).
// Anything else that folds to nothing (a name entirely in a script with no Latin
// decomposition) yields an empty segment, which the build refuses.

/** One address segment: lowercase ASCII words joined by single hyphens. */
export const CATALOG_SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugifyCatalog(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/['‘’ʼ`´°º]/g, "")
    .replace(/\+/g, " plus ")
    // a "-" that opens a token and is followed by a digit is a sign, not a separator
    .replace(/(^|[^a-z0-9])-(?=\d)/g, "$1minus ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The product's address under /catalog: `<brand>/<product>`. Shared by every
 *  variant of the product, since the page shows them together. */
export function productSlug(brand: string | null | undefined, name: string): string {
  return `${slugifyCatalog(brand ?? "")}/${slugifyCatalog(name)}`;
}

/** Both halves of a product slug are well-formed segments (a URL to look up, not
 *  one to store — the build guarantees the stored ones). */
export function isProductSlug(slug: string): boolean {
  const parts = slug.split("/");
  return parts.length === 2 && parts.every((p) => CATALOG_SLUG_SEGMENT.test(p));
}
