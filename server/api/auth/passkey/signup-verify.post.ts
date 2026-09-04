import { defineEventHandler } from "h3";
import {
  MAGIC_LINK_TTL_MS,
  createAccount,
  deleteAccountRow,
  issueMagicToken,
  startSession,
} from "../../../utils/authSession";
import { canSendEmail, sendMagicLink } from "../../../utils/email";
import { savePasskey } from "../../../utils/credentialRepo";
import { useAccountDb } from "../../../utils/db";
import { readJsonBodyCapped, setNoIndex, setPrivate } from "../../../utils/http";
import { trustedOrigin } from "../../../utils/origin";
import { requirePasskeysConfigured, takeChallenge, verifyPasskeyRegistration } from "../../../utils/passkeys";
import { rateLimit } from "../../../utils/rateLimit";

// Step 2 of creating an account with nothing but a passkey: check what the
// authenticator produced, and only then make the account.
//
// ORDER IS THE SECURITY PROPERTY. The challenge is redeemed and destroyed first,
// the signature is verified second, and the `users` row is written third — so an
// unverified request cannot leave anything behind, and a replayed one has no
// challenge left to match. Origin and RP ID are re-derived from THIS request
// rather than read from the body (verifyPasskeyRegistration): they're the binding
// that makes a passkey unphishable, so they can never come from the caller.
//
// The account is created WITH the address that signup-options checked — read back
// from the challenge, not from this request, so the client can't swap it between
// the two halves of the ceremony.
//
// A confirmation link goes out afterwards and is deliberately not awaited by the
// signup's success: the account is usable the moment the passkey verifies, and a
// mail provider having a bad minute must not cost someone their signup.
//
// THE LINK IS ALSO THE UNDO. The address here is unverified — anyone can type
// anyone's — so the account is created unverified, and redeeming this link is what
// settles who the address belongs to: it removes every passkey and session older
// than itself (claimUnverifiedAccount). For the person who just signed up that
// would take away the key they just made, so the mail says so plainly and doesn't
// ask them to click; for someone whose address a stranger typed in, it's the whole
// remedy. See the welcome copy in email.ts.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "passkey-signup");

  requirePasskeysConfigured();

  const body = await readJsonBodyCapped<{ flowId?: unknown; response?: unknown }>(event, 32_000);
  const flowId = typeof body?.flowId === "string" ? body.flowId : "";
  const stored = await takeChallenge(flowId);
  // A signup challenge carries an email and no userId. One with a userId came from
  // register-options (adding a key to an existing account) and must not mint a
  // second account here.
  if (!stored || stored.userId != null || !stored.email) {
    return { ok: false as const, reason: "expired" as const };
  }

  const verified = await verifyPasskeyRegistration(
    event,
    body?.response,
    stored.challenge,
    "[passkey signup]",
  );
  if (!verified) return { ok: false as const, reason: "invalid" as const };

  const db = await useAccountDb();
  let user;
  try {
    user = await createAccount(db, stored.email);
  } catch {
    // lost the race on the unique index — someone else signed up with this address
    // between options and verify
    return { ok: false as const, reason: "taken" as const };
  }
  try {
    const { syncable: _syncable, ...credential } = verified;
    await savePasskey(db, {
      userId: user.id,
      ...credential,
      discoverable: true, // residentKey: "required" — see signup-options
      label: null,
    });
  } catch (e) {
    // The unique index on credential_id. Unlike register-verify, this is NOT a
    // benign duplicate: the account row was created a line ago and now has no
    // credential, so nothing could ever sign into it. Roll it back rather than
    // leaving an unreachable row behind — the write is one statement and there is
    // nothing else pointing at the account yet, so the delete is always safe.
    console.error("[passkey signup] credential already registered", e);
    await deleteAccountRow(db, user.id).catch((err) =>
      console.error("[passkey signup] could not roll back orphaned account", err),
    );
    return { ok: false as const, reason: "invalid" as const };
  }

  await startSession(event, db, user.id);

  // Best-effort, and never allowed to fail the signup it rode in on.
  if (canSendEmail()) {
    try {
      const token = await issueMagicToken(db, user.id);
      // trustedOrigin, not the request's — this link is the UNDO for a signup
      // against an address the signer may not hold, so it is the one thing in
      // that message that must land on Mahonia. See server/utils/origin.ts.
      const url = new URL("/auth/callback", trustedOrigin(event));
      url.searchParams.set("t", token);
      await sendMagicLink({
        to: stored.email,
        url: url.toString(),
        expiresIn: `${Math.round(MAGIC_LINK_TTL_MS / 60_000)} minutes`,
        // not a sign-in link — they're already signed in, and this is the address
        // confirmation. See MagicLinkEmail.purpose.
        purpose: "welcome",
      });
    } catch (e) {
      console.error("[passkey signup] confirmation email failed", e);
    }
  }

  return { ok: true as const, email: stored.email };
});
