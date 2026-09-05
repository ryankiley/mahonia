import { defineEventHandler } from "h3";
import { readJsonBodyCapped, setNoIndex, setPrivate } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";
import { resolveVaultForRead } from "../../utils/vaultAuth";
import { vaultGearAmong } from "../../utils/vaultRepo";
import { VAULT_CAPTURE_MAX } from "../../../shared/vault";

// Which of THESE pieces of gear the vault already holds, and at what weight.
//
// The editor asks when a list opens, so a row can tell "My Gear already has this"
// from "this has never been banked" — the one thing the row's save button could
// never find out for itself, and the reason it kept offering to save gear that
// was saved years ago.
//
// Scoped to the list that asked. The first version of this was a GET returning
// the WHOLE vault, which the client then cached for the life of the page: it
// shipped up to a thousand rows to answer a question about forty, and every
// lifetime concern that cache then needed — whose account is this, is the answer
// stale, did a sign-in invalidate it — was a bug waiting to be written. An answer
// about one list can just die with the list.
//
// A POST for a read, because the question is a list of keys: forty folded
// spellings do not belong in a query string, and this one is `private, no-store`
// anyway — it is one person's gear, and nothing between us and them may keep a
// copy.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "vault-read");

  // The same bound a capture takes, for the same reason: a list past it is
  // pathological, and the cap keeps one request's IN (...) bounded regardless.
  const body = await readJsonBodyCapped<{ normKeys?: unknown }>(event, 64_000);
  const normKeys = Array.isArray(body?.normKeys)
    ? body.normKeys.filter((k): k is string => typeof k === "string" && !!k).slice(0, VAULT_CAPTURE_MAX)
    : [];
  if (!normKeys.length) return { keys: [] };

  // a fresh account has no vault row until its first capture — an empty vault,
  // not an error (see resolveVaultForRead)
  const resolved = await resolveVaultForRead(event);
  if (!resolved) return { keys: [] };
  return { keys: await vaultGearAmong(resolved.db, resolved.vaultId, normKeys) };
});
