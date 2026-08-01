import { createError, defineEventHandler, setHeader } from "h3";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { requireUser } from "../../../utils/authSession";
import { countPasskeys, existingCredentialIds, MAX_PASSKEYS_PER_USER } from "../../../utils/credentialRepo";
import { useAccountDb } from "../../../utils/db";
import { RP_NAME, passkeysConfigured, rpIdFor, startChallenge } from "../../../utils/passkeys";
import { rateLimit } from "../../../utils/rateLimit";

// Step 1 of adding a passkey: hand the browser the challenge and parameters for
// the ceremony. Requires a session — you add a passkey to an account you're
// already in, which is what makes the magic link the root of trust and the passkey
// a faster door to the same room.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "passkey");
  const user = await requireUser(event);
  // A shared challenge store is a hard requirement, not a nicety — see
  // passkeysConfigured(). Refuse up front rather than failing at verify with
  // nothing to explain it.
  if (!passkeysConfigured()) {
    console.error("[passkey] no shared KV configured (KV_REST_API_URL / KV_REST_API_TOKEN) — passkeys are unavailable");
    throw createError({ statusCode: 503, statusMessage: "Passkeys unavailable" });
  }

  const db = await useAccountDb();

  if ((await countPasskeys(db, user.id)) >= MAX_PASSKEYS_PER_USER) {
    throw createError({ statusCode: 409, statusMessage: "Too many passkeys" });
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpIdFor(event),
    // The account handle the authenticator stores. The email is what the OS prompt
    // shows, so the user can tell their accounts apart; userID is opaque and
    // stable, deliberately NOT the email (the handle shouldn't have to change if an
    // address ever does).
    //
    // An account made with a passkey may have no address yet, so fall back to the
    // same shape signup-options uses — the site name plus a short tail off the
    // stable id. Ugly next to a real address, which is the point: it's another
    // quiet argument for attaching one.
    userName: user.email ?? `Mahonia (#${user.id})`,
    userDisplayName: user.email ?? "Mahonia gear vault",
    userID: new TextEncoder().encode(String(user.id)),
    attestationType: "none", // we don't need to know which make of key it is
    // don't offer to create a second key on an authenticator that already holds
    // one for this account
    excludeCredentials: (await existingCredentialIds(db, user.id)).map((id) => ({ id })),
    authenticatorSelection: {
      // a DISCOVERABLE credential is what lets "sign in with a passkey" work with
      // no email typed first — the whole appeal, so ask for it
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });

  const flowId = await startChallenge(options.challenge, user.id);
  return { flowId, options };
});
