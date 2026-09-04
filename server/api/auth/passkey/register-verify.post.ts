import { defineEventHandler } from "h3";
import { requireUser } from "../../../utils/authSession";
import { savePasskey } from "../../../utils/credentialRepo";
import { canSendEmail, sendPasskeyAddedNotice } from "../../../utils/email";
import { useAccountDb } from "../../../utils/db";
import { readJsonBodyCapped, setNoIndex, setPrivate } from "../../../utils/http";
import { credentialFromInfo, takeChallenge, verifyRegistration } from "../../../utils/passkeys";
import { rateLimit } from "../../../utils/rateLimit";

// Step 2 of adding a passkey: verify what the authenticator produced and store
// the public key.
//
// The challenge is redeemed (and destroyed) before verification, so a replayed
// response has nothing to match against. Origin and RP ID are re-derived from THIS
// request rather than trusted from the body (verifyRegistration) — they're the
// binding that makes a passkey unphishable, so they can't come from the caller.
export default defineEventHandler(async (event) => {
  setNoIndex(event);
  setPrivate(event);
  await rateLimit(event, "passkey");
  const user = await requireUser(event);

  const body = await readJsonBodyCapped<{ flowId?: unknown; response?: unknown; label?: unknown }>(
    event,
    32_000,
  );
  const stored = await takeChallenge(body?.flowId);
  // a challenge that isn't ours, has expired, or belongs to a different account
  if (!stored || stored.userId !== user.id) return { ok: false as const, reason: "expired" as const };

  const info = await verifyRegistration(event, body?.response, stored.challenge, "passkey register");
  if (!info) return { ok: false as const, reason: "invalid" as const };

  const db = await useAccountDb();
  const label = typeof body?.label === "string" ? body.label : null;
  try {
    await savePasskey(db, {
      userId: user.id,
      ...credentialFromInfo(info),
      discoverable: Boolean(info.credentialDeviceType === "multiDevice" || info.credentialBackedUp),
      label,
    });
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
