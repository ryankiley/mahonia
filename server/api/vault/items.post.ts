import { defineEventHandler } from "h3";
import { readJsonBodyCapped, setNoIndex, setPrivate } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { requireVault, resolveOrMintVault } from "../../utils/vaultAuth";
import { applyVaultItemOp, type VaultItemOp } from "../../utils/vaultRepo";

// Add a piece of gear by hand, or correct one in place — both through ONE route
// taking an op, the same shape /api/vault/folders takes and for the same reason.
//
// Separate from the folders route rather than a seventh verb on it, because these
// two write the ITEM table and resolve their vault differently (below), and folding
// them in would make that fork a branch inside a switch nobody reads twice.
//
// Every op is scoped by vaultId at the repo layer, so an id belonging to another
// vault matches nothing and comes back `{ ok: false }` — the same answer as an id
// that never existed. No 403, no existence oracle. The two REFUSALS are reported,
// because "you already have this" and "your vault is full" are facts about YOUR
// vault and tell a stranger nothing.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "vault-write");

  // Read BEFORE resolving, unlike the folders route: an add may need to MINT the
  // vault and an edit must not, so which resolver runs depends on the op. Both still
  // 401 a signed-out caller, so nothing about the gate is weaker — only the order
  // moves, and it moves behind a rate limit and a 4 KB cap.
  const body = await readJsonBodyCapped<{ op?: unknown }>(event, 4_000);
  const op = body?.op as VaultItemOp | undefined;
  if (!op || typeof op !== "object") return { ok: false };
  if (op.t !== "add" && op.t !== "edit") return { ok: false };

  // Checked before the mint, mirroring capture.post.ts: an empty add must never
  // bring a vault into existence, the way an open-but-empty editor doesn't.
  if (op.t === "add" && !(typeof op.name === "string" && op.name.trim())) return { ok: false };

  // /gear is where signing in lands you, and vaults are minted lazily on first
  // capture — so an account that has never opened an editor has no vault row, and
  // "type your first piece of gear" has to work anyway. That makes add the second
  // endpoint that can mint (see the note on the budgets in utils/rateLimit.ts). An
  // edit needs a row to act on, so it takes the strict resolver.
  const { db, vaultId } =
    op.t === "add" ? await resolveOrMintVault(event) : await requireVault(event);

  const res = await applyVaultItemOp(db, vaultId, op);
  if (!res) return { ok: false };
  if ("refused" in res) return { ok: false, reason: res.refused };
  return { ok: true, item: res.item };
});
