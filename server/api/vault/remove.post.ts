import { defineEventHandler } from "h3";
import { openPrivate } from "../../utils/authSession";
import { readJsonBodyCapped } from "../../utils/http";
import { requireVault } from "../../utils/vaultAuth";
import { removeVaultItem, restoreVaultItem } from "../../utils/vaultRepo";
import { isSerialId } from "../../../shared/ops";

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
  await openPrivate(event, "vault-write");
  const { db, vaultId } = await requireVault(event);

  const body = await readJsonBodyCapped<{ id?: unknown; restore?: unknown }>(event, 2_000);
  // the id range the repo itself filters by: anything else matches no row
  const id = body?.id;
  if (!isSerialId(id)) return { ok: false };

  const ok = body?.restore === true
    ? await restoreVaultItem(db, vaultId, id)
    : await removeVaultItem(db, vaultId, id);
  return { ok };
});
