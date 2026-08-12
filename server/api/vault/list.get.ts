import { defineEventHandler } from "h3";
import { rateLimit } from "../../utils/rateLimit";
import { resolveVaultForRead } from "../../utils/vaultAuth";
import { listRemovedVaultItems, listVaultFolders, listVaultItems } from "../../utils/vaultRepo";
import { setNoIndex, setPrivate } from "../../utils/http";

// The /vault page's read: every live row, most-recently-used first.
// `private, no-store` — this is one person's gear; nothing between us and them
// may keep a copy.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "vault-read");
  // a fresh account has no vault row until its first capture — that's the empty
  // vault, not an error (see resolveVaultForRead)
  const resolved = await resolveVaultForRead(event);
  if (!resolved) return { items: [], removed: [], folders: [] };
  const { db, vaultId } = resolved;
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
