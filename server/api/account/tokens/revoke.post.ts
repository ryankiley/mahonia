import { defineEventHandler } from "h3";
import { revokeAccessToken } from "../../../utils/accessTokens";
import { requireAccount } from "../../../utils/authSession";
import { readJsonBodyCapped } from "../../../utils/http";
import { isSerialId } from "../../../../shared/ops";

// Revoke an assistant token. The next call that carries it reaches no gear.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "account");
  const body = await readJsonBodyCapped<{ id?: unknown }>(event, 2_000);
  const id = body?.id;
  if (!isSerialId(id)) return { ok: false };
  return { ok: await revokeAccessToken(db, user.id, id) };
});
