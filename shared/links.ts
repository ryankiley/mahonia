import type { Item } from "./types";
import { itemDisplayName } from "./weights";

// Build a Google web-search URL for a free-text query. Used by the read-only
// share views to let a viewer look up (and maybe buy) a gear item by name.
export function webSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// The query for "look up this gear": brand + model only. The variant (a
// size/config qualifier like "Regular, quilt + Fast Sheet" or "2P") is dropped —
// it's noise that hurts search recall, and the buyer refines size/config on the
// retailer's page anyway. A free-renamed item already has no brand/variant, so
// this is just its name.
export function itemSearchName(item: Pick<Item, "brand" | "name">): string {
  return itemDisplayName(item.brand, item.name).trim();
}

// The search URL for a read-only item name, or null when a search makes no sense:
// water rows ("Water" — its amount is a volume, not a product) and unnamed rows.
export function itemSearchUrl(item: Pick<Item, "brand" | "name">): string | null {
  const query = itemSearchName(item);
  if (!query || /^water$/i.test(item.name.trim())) return null;
  return webSearchUrl(query);
}

// The editor URL path for a list. When the list's PUBLIC share code is known we
// embed it in the PATH — /e/{shareCode}#{token} — so a link-preview bot fetching
// the link can resolve the list's name server-side (see app/pages/e/[code].vue) and
// show it instead of the generic site card. The secret edit token ALWAYS stays in
// the URL fragment, which browsers never send to the server. A draft that has no
// share code yet falls back to the bare /e#{token}.
export function editLinkPath(shareCode: string | null | undefined, token: string): string {
  return shareCode ? `/e/${shareCode}#${token}` : `/e#${token}`;
}
