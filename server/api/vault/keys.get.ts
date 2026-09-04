import { defineEventHandler } from "h3";
import { rateLimit } from "../../utils/rateLimit";
import { resolveVaultForRead } from "../../utils/vaultAuth";
import { listVaultKeys } from "../../utils/vaultRepo";
import { setNoIndex, setPrivate } from "../../utils/http";

// What gear this vault already holds, as identity keys and nothing else.
//
// The editor asks, so a list row can tell "My Gear already has this" from "this
// has never been banked" — the one thing the row's save button could never find
// out for itself, and the reason it kept offering to save gear that was saved
// years ago. It could have read /api/vault/list, but that answer carries every
// row's brand, weight, folder and tombstone to a page that renders none of them;
// this is one column.
//
// `private, no-store` like the rest of the vault reads: the keys are folded
// spellings of one person's gear, so nothing between us and them may keep a copy.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "vault-read");
  // a fresh account has no vault row until its first capture — an empty vault,
  // not an error (see resolveVaultForRead)
  const resolved = await resolveVaultForRead(event);
  if (!resolved) return { keys: [] };
  return { keys: await listVaultKeys(resolved.db, resolved.vaultId) };
});
