import { defineEventHandler } from "h3";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { requirePasskeysConfigured, rpIdFor, startChallenge } from "../../../utils/passkeys";
import { rateLimit } from "../../../utils/rateLimit";
import { setNoIndex, setPrivate } from "../../../utils/http";

// Step 1 of signing in with a passkey: issue a challenge.
//
// No email, no session, and no `allowCredentials` list — the browser offers
// whichever discoverable passkey it holds for this site, and the credential itself
// tells us who the user is. That's what makes this one tap with nothing typed.
//
// It also means this endpoint reveals nothing: it takes no input and its response
// is the same for a visitor with fifty passkeys and one with none.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "passkey");
  requirePasskeysConfigured();

  const options = await generateAuthenticationOptions({
    rpID: rpIdFor(event),
    userVerification: "preferred",
  });

  return { flowId: await startChallenge(options.challenge), options };
});
