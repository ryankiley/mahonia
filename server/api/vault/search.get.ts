import { defineEventHandler, getHeader, getQuery, setHeader } from "h3";
import { rateLimit } from "../../utils/rateLimit";
import { requireVault } from "../../utils/vaultAuth";
import { searchVaultItems } from "../../utils/vaultRepo";

// Autocomplete against your own gear — the "pull from the vault" half of the
// feature, consumed alongside /api/catalog/search by the item input.
//
// No token returns an empty list rather than 401: the editor calls this on every
// keystroke for everyone, and someone with no vault yet typing an item name is
// doing nothing wrong. An error there would be console noise and a failed request
// on the app's hottest path. A token that IS sent but doesn't resolve still 401s —
// that's a real mismatch worth surfacing, not a visitor without a vault.
//
// No shared cache, unlike the catalog search: results belong to one vault, so
// `s-maxage` would let one person's gear be served to the next.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "vault-search");

  if (!(getHeader(event, "authorization") || "").startsWith("Bearer ")) return { results: [] };
  const { db, vaultId } = await requireVault(event);

  const raw = getQuery(event).q;
  const q = (Array.isArray(raw) ? raw[0] : raw ?? "").toString().slice(0, 100);

  return { results: await searchVaultItems(db, vaultId, q) };
});
