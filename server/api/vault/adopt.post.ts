import { defineEventHandler, setHeader } from "h3";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { findVaultByToken, requireVault } from "../../utils/vaultAuth";
import { mergeVaults } from "../../utils/vaultRepo";

// Opening a transfer link on a device that already has a vault: fold this device's
// gear into the linked one before the browser swaps over, so nothing is stranded.
// See mergeVaults() for the direction and the merge rules.
//
// TWO capabilities, and it needs both. The header carries the token of the vault
// being merged INTO (the link you just opened) and is checked by requireVault like
// every other vault write; the body names the source, which the caller must equally
// hold, since it's the token sitting in their own localStorage. Holding a token
// already grants a full read of that vault, so copying its rows into another vault
// the same caller holds discloses nothing new.
//
// A source token that no longer resolves comes back `{ merged: 0 }`, not an error:
// this runs automatically on arrival, and a device whose old vault was already
// merged (or forgotten) has nothing to do rather than something to explain.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "vault-write");
  const { db, vaultId } = await requireVault(event);

  const body = await readJsonBodyCapped<{ fromToken?: unknown }>(event, 4_000);
  const fromToken = typeof body?.fromToken === "string" ? body.fromToken : "";
  const sourceVaultId = await findVaultByToken(db, fromToken);
  if (sourceVaultId == null) return { merged: 0 };

  return { merged: await mergeVaults(db, vaultId, sourceVaultId) };
});
