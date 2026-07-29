import { defineEventHandler, setHeader } from "h3";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { requireVault } from "../../utils/vaultAuth";
import { applyVaultFolderOp, type VaultFolderOp } from "../../utils/vaultRepo";

// Every folder mutation on a vault, through ONE route taking an op — the same
// shape /api/edit/mutate takes for a list, and for the same reason: rename,
// delete, reorder, re-sort and move-an-item are five verbs on one small structure,
// and five endpoints would be five copies of the auth + rate-limit + vault-scoping
// preamble with five chances for one of them to scope a query wrong.
//
// Every op is scoped by vaultId at the repo layer, so an id belonging to another
// vault matches nothing and comes back `{ ok: false }` — the same answer as an id
// that never existed. No 403, no existence oracle.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "vault-write");
  const { db, vaultId } = await requireVault(event);

  const body = await readJsonBodyCapped<{ op?: unknown }>(event, 4_000);
  const op = body?.op as VaultFolderOp | undefined;
  if (!op || typeof op !== "object" || typeof (op as { t?: unknown }).t !== "string") {
    return { ok: false };
  }
  return { ok: await applyVaultFolderOp(db, vaultId, op) };
});
