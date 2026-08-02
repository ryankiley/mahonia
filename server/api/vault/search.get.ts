import { defineEventHandler, setHeader } from "h3";
import { readQueryString } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { requireVault } from "../../utils/vaultAuth";
import { searchVaultItems } from "../../utils/vaultRepo";

// Autocomplete against your own gear — the "pull from the vault" half of the
// feature, consumed alongside /api/catalog/search by the item input.
//
// Session-scoped: requireVault 401s a signed-out caller. That never lands on the
// editor's every-keystroke path, because the client asks only once it knows a
// vault exists (useVaultSearch short-circuits on hasVault) — a visitor without
// one costs no request and no console noise.
//
// No shared cache, unlike the catalog search: results belong to one vault, so
// `s-maxage` would let one person's gear be served to the next.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "vault-search");

  const { db, vaultId } = await requireVault(event);

  const q = readQueryString(event, "q", 100);

  return { results: await searchVaultItems(db, vaultId, q) };
});
