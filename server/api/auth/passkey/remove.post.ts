import { defineEventHandler } from "h3";
import { requireUser } from "../../../utils/authSession";
import { deletePasskey } from "../../../utils/credentialRepo";
import { useAccountDb } from "../../../utils/db";
import { readJsonBodyCapped, setNoIndex } from "../../../utils/http";
import { rateLimit } from "../../../utils/rateLimit";

// Revoke a passkey — a lost laptop, a retired hardware key.
//
// Removing the last one is allowed and is NOT a lockout: the magic link is always
// available, which is exactly why it stays as the account's root of trust.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "passkey");
  const user = await requireUser(event);
  const body = await readJsonBodyCapped<{ id?: unknown }>(event, 2_000);
  const id = Number.isInteger(body?.id) ? (body.id as number) : null;
  if (id == null) return { ok: false };
  const db = await useAccountDb();
  return { ok: await deletePasskey(db, user.id, id) };
});
