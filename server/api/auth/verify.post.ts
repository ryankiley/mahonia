import { defineEventHandler } from "h3";
import {
  askingBrowserHash,
  claimUnverifiedAccount,
  forgetAskingBrowser,
  redeemMagicLink,
  startSession,
} from "../../utils/authSession";
import { useAccountDb } from "../../utils/db";
import { readJsonBodyCapped, setNoIndex } from "../../utils/http";
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
// WHO GETS SIGNED IN WITHOUT BEING ASKED: only the browser that asked for the
// link. Anywhere else the answer is `confirm` with the account's address, the
// link stays unspent, and the page sends it again once the person has said yes
// (see redeemMagicLink for the link a stranger sends you). And only our own page
// may post here at all (server/middleware/sameOrigin.ts): a form on another site
// could otherwise skip the question.
// A yes signs the person in and nothing more; whether this browser's lists go to
// the account too is asked separately (`sweep` in the answer, and startSession).
//
// Every failure is one indistinguishable answer, a 200 carrying
// `{ ok: false, reason: "invalid" }`: expired, already-redeemed, and never-existed
// read the same, so the endpoint can't be used to learn anything about tokens it
// wasn't given.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  await rateLimit(event, "auth-verify");

  const body = await readJsonBodyCapped<{ token?: unknown; confirmed?: unknown }>(event, 2_000);
  const token = typeof body?.token === "string" ? body.token.trim().slice(0, 200) : "";

  const db = await useAccountDb();
  const redeemed = await redeemMagicLink(db, token, {
    browserHash: askingBrowserHash(event),
    confirmed: body?.confirmed === true,
  });
  if (redeemed.kind === "confirm") {
    const { email, asked, evicts } = redeemed;
    return { ok: false as const, reason: "confirm" as const, email, asked, evicts };
  }
  if (redeemed.kind === "invalid") {
    // An ordinary answer, not a 401: the request is malformed or stale, and a 401
    // here would be indistinguishable to the client from "your session expired".
    return { ok: false as const, reason: "invalid" as const };
  }
  const { user, sameBrowser } = redeemed;

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

  // A sign-in this browser asked for brings its lists with it. One a person
  // confirmed here signs them in and leaves the lists for the page to ask about:
  // see startSession.
  await startSession(event, db, user.id, { sweep: sameBrowser });
  forgetAskingBrowser(event);
  return { ok: true as const, user: { email: user.email }, sweep: sameBrowser };
});
