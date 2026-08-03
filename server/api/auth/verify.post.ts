import { defineEventHandler, setHeader } from "h3";
import { claimUnverifiedAccount, consumeMagicToken, startSession } from "../../utils/authSession";
import { useAccountDb } from "../../utils/db";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit } from "../../utils/rateLimit";

// Redeem a sign-in link and start a session.
//
// WHY POST, WHEN THE LINK IN THE EMAIL IS A GET: corporate mail gateways, link
// scanners, and inbox previewers fetch every URL in a message before the human
// ever sees it. A single-use token redeemed by GET is therefore routinely spent
// before it arrives, and the user gets "this link has already been used" for a
// link they never clicked. So the emailed URL lands on a PAGE (/auth/callback)
// that carries the token and posts it here — a step scanners don't take.
//
// Every failure is one indistinguishable 400: expired, already-redeemed, and
// never-existed are the same answer, so the endpoint can't be used to learn
// anything about tokens it wasn't given.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "auth-verify");

  const body = await readJsonBodyCapped<{ token?: unknown }>(event, 2_000);
  const token = typeof body?.token === "string" ? body.token.trim().slice(0, 200) : "";

  const db = await useAccountDb();
  const user = token ? await consumeMagicToken(db, token) : null;
  if (!user) {
    // 400, not 401: the request is malformed/stale, and a 401 here would be
    // indistinguishable to the client from "your session expired".
    return { ok: false as const, reason: "invalid" as const };
  }

  // THIS is where an address stops being a claim. If nobody had proved they hold
  // it before now, every passkey and session on the account was put there by
  // someone who hadn't — including, in the case this exists for, a stranger who
  // signed up with an address that was never theirs. They go, and they go BEFORE
  // the new session is started so there is no window where both are live.
  //
  // Deliberately not caught: the token is spent either way, and asking for a
  // fresh link is a far better outcome than signing someone into an account we
  // just failed to clear out from under them. The flag stays false on a failure,
  // so the next link tries again.
  if (!user.emailVerified) await claimUnverifiedAccount(db, user.id);

  await startSession(event, db, user.id);
  return { ok: true as const, user: { email: user.email } };
});
