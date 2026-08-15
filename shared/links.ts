import type { Item } from "./types";
import { isWaterName } from "./water";
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
  if (!query || isWaterName(item.name)) return null;
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

// The editor path for a CLAIMED list — one attached to the signed-in account, on a
// device that holds no edit token for it. No fragment: the session cookie plus the
// code in the path are the whole way in (see server/utils/editAuth). Never a
// capability, so it's safe anywhere the read link is.
export function claimedEditPath(shareCode: string): string {
  return `/e/${shareCode}`;
}

/** The header a session-authorised edit request uses to NAME which claimed list it
 *  means. Shared because the client sends it and the server reads it — one string,
 *  or the two halves drift. Not a secret (it's the public read code), unlike the
 *  edit token, which is why that one travels as a Bearer and this one doesn't. */
export const LIST_CODE_HEADER = "x-list-code";

// Share codes are Crockford base32, advertised as case-insensitive with the usual
// confusable folds (I/L→1, O→0). The server normalizes on its side; this is the
// client's copy of the SAME fold, so a hand-typed /e/{code} URL keys local storage
// and the request header consistently. Returns "" for anything that can't be a
// code, which callers treat as "no code here".
export function normalizeShareCode(raw: string | null | undefined): string {
  const c = (raw || "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/.test(c) ? c : "";
}

// Is this a path we're willing to send someone to after signing in?
//
// The SECURITY BOUNDARY for the return-to-where-you-were redirect (app/composables/
// useReturnTo.ts). Lives here, beside editLinkPath, because it's pure and because the
// two are the same subject: what a link in this app is allowed to be.
//
// Same-origin RELATIVE paths only. "//evil.com" is the one that catches people — a
// browser reads a protocol-relative URL as absolute, so a leading-slash test alone
// waves it straight through to another origin. Backslashes are rejected outright
// because some engines normalise them to forward slashes, which turns "/\evil.com"
// into the same attack.
//
// Applied on the way OUT of storage, not just on the way in: the value round-trips
// through localStorage, where anything on the device could have edited it.
export function isSafeReturnPath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.startsWith("/") &&
    !p.startsWith("//") &&
    !p.includes("\\")
  );
}
