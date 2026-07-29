import { defineEventHandler, setHeader } from "h3";
import { rateLimit } from "../../utils/rateLimit";
import { requireVault } from "../../utils/vaultAuth";
import { listRemovedVaultItems, listVaultFolders, listVaultItems } from "../../utils/vaultRepo";

// The /vault page's read: every live row, most-recently-used first.
// `private, no-store` — this is one person's gear; nothing between us and them
// may keep a copy.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "vault-read");
  const { db, vaultId } = await requireVault(event);
  // Both sets in one round trip. `removed` is what "Remove" put away — /vault shows
  // it behind a disclosure so a removal has a way back; the editor's pane reads
  // `items` and ignores it. One endpoint rather than a second auth + rate-limit
  // path for a list that is almost always empty.
  const [items, removed, folders] = await Promise.all([
    listVaultItems(db, vaultId),
    listRemovedVaultItems(db, vaultId),
    listVaultFolders(db, vaultId),
  ]);
  return { items, removed, folders };
});
