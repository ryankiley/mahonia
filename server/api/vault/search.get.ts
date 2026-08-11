import { defineEventHandler, getQuery } from "h3";
import { rateLimit } from "../../utils/rateLimit";
import { resolveVaultForRead } from "../../utils/vaultAuth";
import { searchVaultItems } from "../../utils/vaultRepo";
import { setNoIndex, setPrivate } from "../../utils/http";

// Autocomplete against your own gear — the "pull from the vault" half of the
// feature, consumed alongside /api/catalog/search by the item input.
//
// No vault yet returns an empty list rather than 401: the editor calls this on
// every settled keystroke for anyone signed in, and a fresh account typing an
// item name before its first capture is doing nothing wrong. An error there
// would be console noise and a failed request on the app's hottest path.
//
// No shared cache, unlike the catalog search: results belong to one vault, so
// `s-maxage` would let one person's gear be served to the next.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "vault-search");

  const resolved = await resolveVaultForRead(event);
  if (!resolved) return { results: [] };
  const { db, vaultId } = resolved;

  const raw = getQuery(event).q;
  const q = (Array.isArray(raw) ? raw[0] : raw ?? "").toString().slice(0, 100);

  return { results: await searchVaultItems(db, vaultId, q) };
});
