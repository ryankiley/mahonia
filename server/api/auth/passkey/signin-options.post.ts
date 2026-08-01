import { createError, defineEventHandler, setHeader } from "h3";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { passkeysConfigured, rpIdFor, startChallenge } from "../../../utils/passkeys";
import { rateLimit } from "../../../utils/rateLimit";

// Step 1 of signing in with a passkey: issue a challenge.
//
// No email, no session, and no `allowCredentials` list — the browser offers
// whichever discoverable passkey it holds for this site, and the credential itself
// tells us who the user is. That's what makes this one tap with nothing typed.
//
// It also means this endpoint reveals nothing: it takes no input and its response
// is the same for a visitor with fifty passkeys and one with none.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "passkey");
  // A shared challenge store is a hard requirement, not a nicety — see
  // passkeysConfigured(). Refuse up front rather than failing at verify with
  // nothing to explain it.
  if (!passkeysConfigured()) {
    console.error("[passkey] no shared KV configured (KV_REST_API_URL / KV_REST_API_TOKEN) — passkeys are unavailable");
    throw createError({ statusCode: 503, statusMessage: "Passkeys unavailable" });
  }

  const options = await generateAuthenticationOptions({
    rpID: rpIdFor(event),
    userVerification: "preferred",
  });

  return { flowId: await startChallenge(options.challenge), options };
});
