import { defineEventHandler } from "h3";
import { requireAccount } from "../../../utils/authSession";
import { deletePasskey } from "../../../utils/credentialRepo";
import { readJsonBodyCapped } from "../../../utils/http";

// Revoke a passkey — a lost laptop, a retired hardware key.
//
// Removing the last one is allowed and is NOT a lockout: the magic link is always
// available, which is exactly why it stays as the account's root of trust.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "passkey");
  const body = await readJsonBodyCapped<{ id?: unknown }>(event, 2_000);
  const id = Number.isInteger(body?.id) ? (body.id as number) : null;
  if (id == null) return { ok: false };
  return { ok: await deletePasskey(db, user.id, id) };
});
