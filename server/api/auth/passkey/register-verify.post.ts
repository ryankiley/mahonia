import { defineEventHandler } from "h3";
import { requireAccount } from "../../../utils/authSession";
import { savePasskey } from "../../../utils/credentialRepo";
import { canSendEmail, sendPasskeyAddedNotice } from "../../../utils/email";
import { readJsonBodyCapped } from "../../../utils/http";
import { takeChallenge, verifyPasskeyRegistration } from "../../../utils/passkeys";

// Step 2 of adding a passkey: verify what the authenticator produced and store
// the public key.
//
// The challenge is redeemed (and destroyed) before verification, so a replayed
// response has nothing to match against. Origin and RP ID are re-derived from THIS
// request rather than trusted from the body (verifyPasskeyRegistration) — they're
// the binding that makes a passkey unphishable, so they can't come from the caller.
export default defineEventHandler(async (event) => {
  const { user, db } = await requireAccount(event, "passkey");

  const body = await readJsonBodyCapped<{ flowId?: unknown; response?: unknown; label?: unknown }>(
    event,
    32_000,
  );
  const flowId = typeof body?.flowId === "string" ? body.flowId : "";
  const stored = await takeChallenge(flowId);
  // a challenge that isn't ours, has expired, or belongs to a different account
  if (!stored || stored.userId !== user.id) return { ok: false as const, reason: "expired" as const };

  const verified = await verifyPasskeyRegistration(
    event,
    body?.response,
    stored.challenge,
    "[passkey register]",
  );
  if (!verified) return { ok: false as const, reason: "invalid" as const };

  const label = typeof body?.label === "string" ? body.label : null;
  try {
    const { syncable, ...credential } = verified;
    await savePasskey(db, { userId: user.id, ...credential, discoverable: syncable, label });
  } catch {
    // the unique index on credential_id — this key is already registered, which is
    // a no-op rather than an error worth showing
    return { ok: true as const, duplicate: true };
  }

  // Tell the owner. Best-effort and never allowed to fail the registration it rode
  // in on: a passkey that saved but whose notice didn't send is a strictly better
  // outcome than the reverse.
  if (user.email && canSendEmail()) {
    await sendPasskeyAddedNotice(user.email, label).catch((e) => console.error("[passkey notice]", e));
  }

  return { ok: true as const };
});
