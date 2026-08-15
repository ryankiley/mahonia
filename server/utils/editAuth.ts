// One gate, two ways through it.
//
// Every edit endpoint needs the same thing: the `edit_token_hash` of the list the
// caller is allowed to write to. There are now two ways to establish that, and
// this module is the only place that knows about both:
//
//   1. THE EDIT TOKEN — `Authorization: Bearer <token>`. The original capability,
//      unchanged: whoever holds the link can edit, no account, no sign-in.
//   2. A CLAIMED LIST — a session cookie plus `X-List-Code: <shareCode>` naming
//      which of that account's lists is meant. This is what lets a list open on a
//      device that has never seen its edit link.
//
// The second path hands back the SAME hash the first would, read fresh from the
// list row (see claimRepo.claimedEditHash) — so downstream code is identical
// either way, and nothing had to learn about accounts except this file. It also
// means no raw edit token is ever stored against an account: the claim proves the
// right to look the hash up, rather than being a copy of the capability itself.
//
// The token wins when both are present. It's the more specific claim ("this exact
// list"), it's what an /e link in the URL means, and it keeps a signed-in user's
// behaviour on a shared link identical to a signed-out user's.

import type { H3Event } from "h3";
import { createError, getHeader } from "h3";
import { LIST_CODE_HEADER } from "../../shared/links";
import { resolveSession } from "./authSession";
import { claimedEditHash } from "./claimRepo";
import { useVaultDb } from "./db";
import { bearerToken } from "./http";
import { sha256Hex } from "./tokens";

// The header naming which claimed list a session-authorised request means lives in
// shared/links (LIST_CODE_HEADER) — the client sends it, this file reads it, and a
// shared constant is what keeps the two spellings from drifting. Not a secret —
// the share code is the public read link — so it's safe in a header that proxies
// may log, unlike the edit token (which is why THAT one is a Bearer).

/**
 * Resolve the caller's write capability to a list, as an `edit_token_hash`.
 *
 * Throws 401 when neither path establishes one. As before, a hash that resolves to
 * no live list is left to the repo layer to turn into a 404 — this function proves
 * a capability was PRESENTED, not that its list exists, so no endpoint here becomes
 * an existence oracle.
 */
export async function requireEditHash(event: H3Event): Promise<string> {
  const token = bearerToken(event);
  if (token) return sha256Hex(token);

  const code = (getHeader(event, LIST_CODE_HEADER) || "").trim();
  if (code) {
    const user = await resolveSession(event);
    if (user) {
      const db = await useVaultDb();
      const hash = await claimedEditHash(db, user.id, code);
      // A code this account hasn't claimed falls through to the same 401 as no
      // credential at all — never a 403, which would confirm the list is real.
      if (hash) return hash;
    }
  }

  throw createError({ statusCode: 401, statusMessage: "Missing edit capability" });
}
