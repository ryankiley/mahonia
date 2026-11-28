import { defineEventHandler } from "h3";
import { openPrivate } from "../../utils/authSession";
import { readJsonBodyCapped } from "../../utils/http";
import { requireVault } from "../../utils/vaultAuth";
import { setVaultShare } from "../../utils/vaultShare";

// Turn the read-only link to my gear on ({ on: true }) or off ({ on: false }). Off is
// for good: the link stops working at once, and turning it on again makes a new one.
export default defineEventHandler(async (event) => {
  await openPrivate(event, "vault-write");
  const body = await readJsonBodyCapped<{ on?: unknown }>(event, 200);
  if (typeof body?.on !== "boolean") return { ok: false };
  const { db, vaultId } = await requireVault(event);
  return { ok: true, code: await setVaultShare(db, vaultId, body.on) };
});
