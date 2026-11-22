import { defineEventHandler } from "h3";
import { requireAccount } from "../../../utils/authSession";
import { cleanPasskeyLabel, existingCredentialIds, removePasskeyBeyondCap, savePasskey } from "../../../utils/credentialRepo";
import { canSendEmail, sendPasskeyAddedNotice } from "../../../utils/email";
import { readJsonBodyCapped } from "../../../utils/http";
import { requirePasskeyRoom, takeChallenge, tooManyPasskeys, verifyPasskeyRegistration } from "../../../utils/passkeys";

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
  const stored = await takeChallenge(body?.flowId);
  // a challenge that isn't ours, has expired, or belongs to a different account
  if (!stored || stored.userId !== user.id) return { ok: false as const, reason: "expired" as const };

  const verified = await verifyPasskeyRegistration(
    event,
    body?.response,
    stored.challenge,
    "[passkey register]",
  );
  if (!verified) return { ok: false as const, reason: "invalid" as const };

  // The cap again, counted now: register-options checked it when this ceremony was
  // opened, and others opened beside it may have been saved since.
  requirePasskeyRoom((await existingCredentialIds(db, user.id)).length);

  // Cleaned HERE, once, for both readers. The stored copy was always cut to 60,
  // but the notice below mailed the label as it arrived: up to the whole 32 KB
  // body, line breaks and all, to an address nobody need have proved they hold.
  const label = typeof body?.label === "string" ? cleanPasskeyLabel(body.label) || null : null;
  let saved: number;
  try {
    const { syncable, ...credential } = verified;
    // stamped from the session as it was checked above, so a claim landing during the
    // ceremony leaves this key worthless (claimUnverifiedAccount)
    saved = await savePasskey(db, { userId: user.id, ...credential, discoverable: syncable, label, unproven: user.unproven });
  } catch {
    // the unique index on credential_id — this key is already registered, which is
    // a no-op rather than an error worth showing
    return { ok: true as const, duplicate: true };
  }
  // And the cap a last time, now the key is in: verifies that arrive together each
  // counted before any of them saved, so the count above let them all through. A key
  // saved past the cap comes back out, and its ceremony gets the refusal it would
  // have had a moment later.
  // The check failing is not the save failing: the key is in, so the owner still hears
  // of it below. The cap is housekeeping; the notice is the security signal.
  if (await removePasskeyBeyondCap(db, user.id, saved).catch(() => false)) throw tooManyPasskeys();

  // Tell the owner. Best-effort and never allowed to fail the registration it rode
  // in on: a passkey that saved but whose notice didn't send is a strictly better
  // outcome than the reverse.
  if (canSendEmail()) {
    await sendPasskeyAddedNotice(user.email, label).catch((e) => console.error("[passkey notice]", e));
  }

  return { ok: true as const };
});
