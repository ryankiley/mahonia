import { defineEventHandler, setHeader } from "h3";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import {
  createAccount,
  deleteAccountRow,
  issueMagicToken,
  magicLinkFor,
  startSession,
} from "../../../utils/authSession";
import { canSendEmail, sendMagicLink } from "../../../utils/email";
import { savePasskey } from "../../../utils/credentialRepo";
import { useAccountDb } from "../../../utils/db";
import { readJsonBodyCapped } from "../../../utils/http";
import { originFor, requirePasskeys, rpIdFor, takeChallenge } from "../../../utils/passkeys";
import { rateLimit } from "../../../utils/rateLimit";

// Step 2 of creating an account with nothing but a passkey: check what the
// authenticator produced, and only then make the account.
//
// ORDER IS THE SECURITY PROPERTY. The challenge is redeemed and destroyed first,
// the signature is verified second, and the `users` row is written third — so an
// unverified request cannot leave anything behind, and a replayed one has no
// challenge left to match. Origin and RP ID are re-derived from THIS request
// rather than read from the body: they're the binding that makes a passkey
// unphishable, so they can never come from the caller.
//
// The account is created WITH the address that signup-options checked — read back
// from the challenge, not from this request, so the client can't swap it between
// the two halves of the ceremony.
//
// A confirmation link goes out afterwards and is deliberately not awaited by the
// signup's success: the account is usable the moment the passkey verifies, and a
// mail provider having a bad minute must not cost someone their signup. The link's
// job is to prove the inbox is reachable, which matters later, not now.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "passkey-signup");

  requirePasskeys();

  const body = await readJsonBodyCapped<{ flowId?: unknown; response?: unknown }>(event, 32_000);
  const flowId = typeof body?.flowId === "string" ? body.flowId : "";
  const stored = await takeChallenge(flowId);
  // A signup challenge carries an email and no userId. One with a userId came from
  // register-options (adding a key to an existing account) and must not be
  // redeemable here, where it would mint a second account for someone already
  // signed in.
  if (!stored || stored.userId != null || !stored.email) {
    return { ok: false as const, reason: "expired" as const };
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body?.response as never,
      expectedChallenge: stored.challenge,
      expectedOrigin: originFor(event),
      expectedRPID: rpIdFor(event),
      requireUserVerification: false,
    });
  } catch (e) {
    console.error("[passkey signup]", e);
    return { ok: false as const, reason: "invalid" as const };
  }

  const info = verification.registrationInfo;
  if (!verification.verified || !info) return { ok: false as const, reason: "invalid" as const };

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
    await savePasskey(db, {
      userId: user.id,
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
      counter: info.credential.counter,
      transports: info.credential.transports ?? null,
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
      await sendMagicLink({
        to: stored.email,
        ...magicLinkFor(event, token),
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
