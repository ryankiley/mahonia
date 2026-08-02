import { createError, defineEventHandler, setHeader } from "h3";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import {
  RP_NAME,
  newAccountHandle,
  requirePasskeys,
  rpIdFor,
  startChallenge,
} from "../../../utils/passkeys";
import { emailTaken, normalizeEmail } from "../../../utils/authSession";
import { useAccountDb } from "../../../utils/db";
import { readJsonBodyCapped } from "../../../utils/http";
import { rateLimit } from "../../../utils/rateLimit";

// Step 1 of creating an account with nothing but a passkey.
//
// The sibling of register-options, and the difference is the whole point: that one
// requires a session, because you add a key to an account you're already in. This
// one CANNOT, because the account doesn't exist yet. Email stops being the way in
// and becomes the way back — see signup-verify for where the row is actually made.
//
// AN ADDRESS IS REQUIRED, and this is where it's checked. Not because it
// identifies you — the passkey does that — but because it's the only way back in
// if every authenticator is lost, and a gear vault is precisely the thing you
// can't rebuild from memory. Collecting it here rather than after keeps the
// account from ever existing in an unrecoverable state.
//
// It is NOT verified before the account is made. That would put the inbox
// round-trip back in the middle of signup, which is the step this route exists to
// remove. A confirmation link goes out afterwards.
//
// Nothing is created here. This hands out a challenge and an opaque handle; the
// account appears only if a real authenticator signs that challenge.
//
// Rate-limited on its own tighter bucket, not the shared "passkey" one: every other
// passkey route needs a session first, so they're already gated by having an
// account. This route is reachable by anyone, and the thing on the far side of it
// is a row in `users`.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "passkey-signup");

  requirePasskeys();

  const body = await readJsonBodyCapped<{ email?: unknown }>(event, 2_000);
  const email = normalizeEmail(body?.email);
  if (!email) {
    throw createError({ statusCode: 400, statusMessage: "That doesn't look like an email address" });
  }

  // Checked before the ceremony so the failure lands on the form rather than after
  // someone has touched their sensor. Racy by nature — two signups for one address
  // could both pass here — but the unique index is the real guard and signup-verify
  // handles losing that race.
  const db = await useAccountDb();
  if (await emailTaken(db, email, -1)) {
    throw createError({ statusCode: 409, statusMessage: "That address already has an account" });
  }

  // The user handle the authenticator stores. Random and opaque rather than a row
  // id, because there IS no row id yet — and nothing ever looks an account up by it
  // (sign-in resolves the credential id instead), so it only has to be stable for
  // the length of the ceremony.
  const handle = newAccountHandle();

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpIdFor(event),
    // What the OS prompt shows, and what names this passkey in a password manager
    // forever after. The address is the right thing here — it's the one string a
    // person will recognise months later — and being able to use it is a second
    // reason to collect it up front rather than after.
    userName: email,
    userDisplayName: email,
    userID: new TextEncoder().encode(handle),
    attestationType: "none",
    authenticatorSelection: {
      // REQUIRED, not preferred. Sign-in sends no email and no user id, so the
      // browser has to be able to offer the credential unprompted. A non-
      // discoverable key here would create an account that nothing can ever sign
      // back into — the failure would be silent and permanent.
      residentKey: "required",
      userVerification: "preferred",
    },
  });

  return { flowId: await startChallenge(options.challenge, undefined, email), options };
});
