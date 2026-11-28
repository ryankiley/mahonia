import { defineEventHandler } from "h3";
import { openPrivate } from "../../utils/authSession";
import { resolveVaultForRead } from "../../utils/vaultAuth";
import { vaultShareCode } from "../../utils/vaultShare";

// The owner's own question: is my gear's read-only link on, and what is it?
export default defineEventHandler(async (event) => {
  await openPrivate(event, "vault-read");
  const resolved = await resolveVaultForRead(event);
  return { code: resolved ? await vaultShareCode(resolved.db, resolved.vaultId) : null };
});
