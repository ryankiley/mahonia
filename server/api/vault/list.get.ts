import { defineEventHandler } from "h3";
import { openPrivate } from "../../utils/authSession";
import { resolveVaultForRead } from "../../utils/vaultAuth";
import { listVaultItems } from "../../utils/vaultRepo";

// The /vault page's read: every live row, most-recently-used first.
// `private, no-store` — this is one person's gear; nothing between us and them
// may keep a copy.
export default defineEventHandler(async (event) => {
  await openPrivate(event, "vault-read");
  // a fresh account has no vault row until its first capture — that's the empty
  // vault, not an error (see resolveVaultForRead)
  const resolved = await resolveVaultForRead(event);
  if (!resolved) return { items: [] };
  const { db, vaultId } = resolved;
  // Live rows only: what "Remove" put away isn't shown anywhere now; undo, or adding
  // the piece again, brings it back (addVaultItems lifts the tombstone).
  return { items: await listVaultItems(db, vaultId) };
});
