import { createError, defineEventHandler } from "h3";
import { requireAccount } from "../../../utils/authSession";
import { existingCredentialIds, MAX_PASSKEYS_PER_USER } from "../../../utils/credentialRepo";
import { registrationOptions, requirePasskeysConfigured, startChallenge } from "../../../utils/passkeys";

// Step 1 of adding a passkey: hand the browser the challenge and parameters for
// the ceremony. Requires a session — you add a passkey to an account you're
// already in, which is what makes the magic link the root of trust and the passkey
// a faster door to the same room.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "passkey");
  requirePasskeysConfigured();

  // one credential read serves both the cap check and excludeCredentials below
  const existing = await existingCredentialIds(db, user.id);
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    throw createError({ statusCode: 409, statusMessage: "Too many passkeys" });
  }

  // The account handle the authenticator stores. The email is what the OS prompt
  // shows, so the user can tell their accounts apart; the handle is opaque and
  // stable, deliberately NOT the email (it shouldn't have to change if an address
  // ever does). Every account has an address (users.email is NOT NULL on both
  // signup paths), so there is nothing to fall back to.
  // The keys to exclude: don't offer to create a second key on an authenticator
  // that already holds one for this account. Everything else (the RP, the
  // algorithms, the required resident key) is registrationOptions' and shared
  // with signup.
  const options = await registrationOptions(
    event,
    { name: user.email, displayName: user.email, handle: String(user.id) },
    existing,
  );

  const flowId = await startChallenge(options.challenge, user.id);
  return { flowId, options };
});
