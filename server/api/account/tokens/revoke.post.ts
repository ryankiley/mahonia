import { defineEventHandler } from "h3";
import { revokeAccessToken } from "../../../utils/accessTokens";
import { requireAccount } from "../../../utils/authSession";
import { readJsonBodyCapped } from "../../../utils/http";
import { isSerialId } from "../../../../shared/ops";

// Revoke one assistant token by id. Takes effect on the next call that carries it:
// there is no cache in front of the lookup, so there is nothing to wait out.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "account");
  const body = await readJsonBodyCapped<{ id?: unknown }>(event, 2_000);
  if (!isSerialId(body?.id)) return { ok: false as const };
  return { ok: await revokeAccessToken(db, user.id, body.id) };
});
