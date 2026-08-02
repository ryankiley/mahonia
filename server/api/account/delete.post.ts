import { defineEventHandler, setHeader } from "h3";
import { endSession, requireUser } from "../../utils/authSession";
import { deleteAccount } from "../../utils/accountRepo";
import { useAccountDb, useVaultDb } from "../../utils/db";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";

// Close your account. The rules — what goes, what stays, and why the lists are opt
// in — live in accountRepo.deleteAccount, where they can be tested against a real
// database instead of only through a booted server.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "account");
  const user = await requireUser(event);

  const body = await readJsonBodyCapped<{ deleteLists?: unknown }>(event, 1_000);

  const db = await useAccountDb();
  await useVaultDb(); // vault tables are ensured separately — see db.ts

  const result = await deleteAccount(db, user.id, { deleteLists: body?.deleteLists === true });

  // Last: a failure above leaves the account still reachable, rather than signing
  // someone out of something half-deleted.
  await endSession(event);

  return { ok: true as const, ...result };
});
