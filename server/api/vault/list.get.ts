import { defineEventHandler, setHeader } from "h3";
import { rateLimit } from "../../utils/rateLimit";
import { requireVault } from "../../utils/vaultAuth";
import { listVaultItems } from "../../utils/vaultRepo";

// The /vault page's read: every live row, most-recently-used first.
// `private, no-store` — this is one person's gear; nothing between us and them
// may keep a copy.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "vault-read");
  const { db, vaultId } = await requireVault(event);
  return { items: await listVaultItems(db, vaultId) };
});
