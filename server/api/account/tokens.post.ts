import { defineEventHandler } from "h3";
import { isAccessScope, mintAccessToken } from "../../utils/accessTokens";
import { requireAccount } from "../../utils/authSession";
import { readJsonBodyCapped } from "../../utils/http";

// Mint an assistant token. This response is the one time the raw value exists
// outside the client that will hold it; the page shows it once and forgets it.
//
// The scope is read unless the body says "write" exactly. A body that is malformed
// or missing therefore mints the weaker token, never the stronger one.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "account");
  const body = await readJsonBodyCapped<{ label?: unknown; scope?: unknown }>(event, 2_000);
  const scope = isAccessScope(body?.scope) ? body.scope : "read";
  const minted = await mintAccessToken(db, user.id, {
    label: typeof body?.label === "string" ? body.label : null,
    scope,
  });
  if (!minted) return { ok: false as const, reason: "limit" as const };
  return { ok: true as const, id: minted.id, token: minted.token, scope };
});
