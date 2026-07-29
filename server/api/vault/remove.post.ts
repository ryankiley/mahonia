import { defineEventHandler, setHeader } from "h3";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { requireVault } from "../../utils/vaultAuth";
import { removeVaultItem, restoreVaultItem } from "../../utils/vaultRepo";

// Remove a piece of gear from the vault, or put it back (`restore: true` — the
// undo behind the remove action).
//
// Removal is a TOMBSTONE, not a delete: capture runs automatically, so a hard
// delete would be undone by the next list that still contains the item. See
// server/utils/vaultRepo.ts for why the tombstone survives capture.
//
// An id belonging to another vault matches nothing and returns `{ ok: false }` —
// the same answer as an id that doesn't exist, so the endpoint never confirms that
// another vault's row is real.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "vault-write");
  const { db, vaultId } = await requireVault(event);

  const body = await readJsonBodyCapped<{ id?: unknown; restore?: unknown }>(event, 2_000);
  const id = Number.isInteger(body?.id) ? (body.id as number) : null;
  if (id == null) return { ok: false };

  const ok = body?.restore === true
    ? await restoreVaultItem(db, vaultId, id)
    : await removeVaultItem(db, vaultId, id);
  return { ok };
});
