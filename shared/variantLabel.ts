/**
 * A variant as a person reads it. The catalog stores S/M/L-family sizes as letters
 * ("M", "Men's M", "Women's XS": the 2026-09-05 style rule, so the catalog reads like a
 * spec sheet and one product's sizes sort), but on a row "M" is a letter where "Medium"
 * is a word (Ryan, 2026-09-12: "M should be Medium"). This spells the letter out
 * wherever the variant is SHOWN; what is stored, matched, exported and keyed in My Gear
 * stays the letter.
 *
 * Only a size standing on its own as a word: "Men's M" → "Men's Medium", "M, JP 3" →
 * "Medium, JP 3". A range ("S/M") and a size the maker spells otherwise ("2XL", "US 9")
 * are left as written, and so is anything that isn't a bare letter size ("Long",
 * "Silpoly", "20F").
 */
const SIZE_WORD: Record<string, string> = {
  XXS: "XX-Small",
  XS: "X-Small",
  S: "Small",
  M: "Medium",
  L: "Large",
  XL: "X-Large",
  XXL: "XX-Large",
};

export function displayVariant(variant: string | null | undefined): string {
  if (!variant) return "";
  return variant.replace(/(^|[\s,(])(XXS|XS|S|M|L|XL|XXL)(?=$|[\s,)])/g, (_m, lead: string, size: string) => lead + SIZE_WORD[size]!);
}
