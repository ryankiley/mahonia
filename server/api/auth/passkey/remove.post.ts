import { defineEventHandler } from "h3";
import { requireAccount } from "../../../utils/authSession";
import { deletePasskey } from "../../../utils/credentialRepo";
import { readJsonBodyCapped } from "../../../utils/http";
import { isSerialId } from "../../../../shared/ops";

// Revoke a passkey — a lost laptop, a retired hardware key.
//
// Removing the last one is allowed and is NOT a lockout: the magic link is always
// available, which is exactly why it stays as the account's root of trust.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "passkey");
  const body = await readJsonBodyCapped<{ id?: unknown }>(event, 2_000);
  // ranged, not just an integer: past 2^31 - 1 Postgres answers the lookup with an
  // overflow error, which would surface as a 500 for what is a bad request
  const id = body?.id;
  if (!isSerialId(id)) return { ok: false };
  return { ok: await deletePasskey(db, user.id, id) };
});
