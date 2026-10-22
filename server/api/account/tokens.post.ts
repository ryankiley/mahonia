import { defineEventHandler } from "h3";
import { createAccessToken, isAccessScope } from "../../utils/accessTokens";
import { requireAccount } from "../../utils/authSession";
import { readJsonBodyCapped } from "../../utils/http";

// Make an assistant token: the credential an MCP client sends to reach My Gear.
// The raw value is in this response and nowhere else, ever — the page shows it once.
// A scope that isn't "write" is "read", so a malformed request grants less, not more.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "account");
  const body = await readJsonBodyCapped<{ label?: unknown; scope?: unknown }>(event, 2_000);
  const scope = isAccessScope(body?.scope) ? body.scope : "read";
  const label = typeof body?.label === "string" ? body.label : null;
  const made = await createAccessToken(db, user.id, { label, scope });
  if (!made) return { ok: false as const, reason: "full" as const };
  return { ok: true as const, id: made.id, token: made.token, scope };
});
