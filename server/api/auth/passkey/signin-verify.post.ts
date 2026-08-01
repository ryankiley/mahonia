import { defineEventHandler, setHeader } from "h3";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import { startSession } from "../../../utils/authSession";
import { findCredential, touchCredential } from "../../../utils/credentialRepo";
import { useAccountDb } from "../../../utils/db";
import { users } from "../../../db/schema";
import { readJsonBodyCapped } from "../../../utils/http";
import { originFor, rpIdFor, takeChallenge } from "../../../utils/passkeys";
import { rateLimit } from "../../../utils/rateLimit";

// Step 2 of signing in with a passkey: verify the signature and start a session.
//
// The credential id in the response identifies the account — nobody typed an
// email. That's safe precisely because the signature is checked against the stored
// public key, over a challenge we issued and destroyed on redemption, bound to
// this origin. Possession of the authenticator is the whole proof.
//
// Every failure returns the same `{ ok: false }`: an unknown credential, a bad
// signature and an expired challenge are indistinguishable, so this can't be used
// to test whether a given credential id exists.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  setHeader(event, "Cache-Control", "private, no-store");
  await rateLimit(event, "passkey");

  const body = await readJsonBodyCapped<{ flowId?: unknown; response?: unknown }>(event, 32_000);
  const flowId = typeof body?.flowId === "string" ? body.flowId : "";
  const stored = await takeChallenge(flowId);
  if (!stored) return { ok: false as const };

  const response = body?.response as { id?: string } | undefined;
  const credentialId = typeof response?.id === "string" ? response.id : "";
  if (!credentialId) return { ok: false as const };

  const db = await useAccountDb();
  const cred = await findCredential(db, credentialId);
  if (!cred) return { ok: false as const };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body?.response as never,
      expectedChallenge: stored.challenge,
      expectedOrigin: originFor(event),
      expectedRPID: rpIdFor(event),
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, "base64url")),
        counter: Number(cred.counter),
        transports: cred.transports ? (JSON.parse(cred.transports) as never) : undefined,
      },
      requireUserVerification: false,
    });
  } catch (e) {
    // includes the cloned-authenticator case: a signature counter that went
    // backwards throws here, and we decline rather than sign anyone in
    console.error("[passkey signin]", e);
    return { ok: false as const };
  }

  if (!verification.verified) return { ok: false as const };

  await touchCredential(db, cred.id, verification.authenticationInfo.newCounter);
  await startSession(event, db, cred.userId);

  const row = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, cred.userId))
    .limit(1);
  // null, not "" — an account made with a passkey genuinely has no address, and
  // the client distinguishes "none yet" from "" nowhere else
  return { ok: true as const, user: { email: row[0]?.email ?? null } };
});
