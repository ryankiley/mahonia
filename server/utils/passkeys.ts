// Passkeys (WebAuthn) — the phishing-proof way into an account, and the one that
// doesn't need an inbox.
//
// HOW THE TWO SIGN-IN METHODS RELATE: the magic link is how you first prove the
// address is yours and how you recover if every device is lost; a passkey is how
// you sign in afterwards. Neither replaces the other, and an account can have any
// number of passkeys or none at all.
//
// WHAT'S STORED: a credential id and a PUBLIC key. The private half never leaves
// the authenticator (Touch ID, Windows Hello, a YubiKey, a phone), so this table
// is less sensitive than a password hash — there is nothing in it to crack.
//
// RP ID comes from the REQUEST HOST, not configuration. Passkeys are bound to a
// domain, so a hardcoded value would mean keys registered on a Vercel preview
// silently failing on production (and vice versa). Deriving it means every
// deployment — localhost, preview, production — just works, each with its own
// keys, which is exactly the isolation WebAuthn intends.

import type { H3Event } from "h3";
import { createError, getRequestHost, getRequestProtocol } from "h3";
import { randomSecret, sha256Hex } from "./tokens";
import { useKv } from "./rateLimit";

/** How long a registration/sign-in ceremony may stay open. The user has to touch
 *  a sensor; a couple of minutes is generous and bounds the challenge store. */
export const PASSKEY_CHALLENGE_TTL_MS = 3 * 60_000;

/** The Relying Party ID — the registrable domain a passkey is bound to. Derived
 *  from the request host with the port stripped (WebAuthn's rpId is a domain, and
 *  `localhost:3000` is not one; bare `localhost` is explicitly allowed). */
export function rpIdFor(event: H3Event): string {
  return (getRequestHost(event) || "localhost").split(":")[0]!;
}

/** The exact origin the browser will report, which must match byte-for-byte. */
export function originFor(event: H3Event): string {
  const host = getRequestHost(event) || "localhost:3000";
  const proto = getRequestProtocol(event) || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** An opaque handle for an account that doesn't exist yet — the WebAuthn userID
 *  for a passkey signup. Never used to look an account up (sign-in resolves the
 *  credential id), so it only has to be unguessable and unique enough that two
 *  accounts on one device don't render identically in a password manager. */
export function newAccountHandle(): string {
  return randomSecret();
}

/** What the site calls itself in the OS passkey prompt. */
export const RP_NAME = "Mahonia";

/**
 * Can this deployment run a passkey ceremony at all?
 *
 * A ceremony is TWO requests — options (which writes the challenge) then verify
 * (which reads it) — so the challenge store must be shared across instances. In
 * production the KV binding falls back to an in-memory driver when Upstash isn't
 * configured (see nuxt.config), and on Vercel the two requests routinely land on
 * different serverless instances: verify would find nothing and every sign-in
 * would fail, with nothing in the response to say why.
 *
 * Rate limiting tolerates that fallback — it degrades to per-instance counting and
 * the app keeps serving. Passkeys don't degrade, they break. So this is checked up
 * front and reported as a misconfiguration instead of a mysterious failed sign-in.
 * Same env vars nuxt.config tests, so the two can't disagree.
 */
export function passkeysConfigured(): boolean {
  if (process.env.NODE_ENV !== "production") return true; // dev's in-memory KV is one process
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

/** The refusal every passkey endpoint opens with: fail up front, loudly, rather
 *  than at verify with nothing to explain it. One message to maintain. */
export function requirePasskeysConfigured(): void {
  if (passkeysConfigured()) return;
  console.error(
    "[passkey] no shared KV configured (KV_REST_API_URL / KV_REST_API_TOKEN) — passkeys are unavailable",
  );
  throw createError({ statusCode: 503, statusMessage: "Passkeys unavailable" });
}

interface StoredChallenge {
  challenge: string;
  /** set for registration (we already know who's adding a key); absent for
   *  sign-in, where the whole point is that the user hasn't identified themselves */
  userId?: number;
  /** set for SIGNUP: the address the new account will be created with. Parked here
   *  rather than re-sent with the verify step so the client can't swap it between
   *  the two halves of the ceremony — the address that was checked for uniqueness
   *  is the address that gets written. */
  email?: string;
}

/**
 * Park a ceremony's challenge server-side and hand back an opaque flow id.
 *
 * WHY A FLOW ID RATHER THAN A COOKIE: sign-in has to work in a browser with no
 * session cookie at all, and a second cookie just for the ceremony would be one
 * more thing to set, scope and clear. The flow id is not a secret — a challenge is
 * an anti-replay nonce, not a credential — and what actually provides the security
 * is that the signature must be over the challenge WE issued, and that the entry
 * is deleted the first time it's redeemed.
 *
 * Stored in the same short-TTL KV the rate limiter uses, so an abandoned ceremony
 * expires on its own.
 */
export async function startChallenge(
  challenge: string,
  userId?: number,
  email?: string,
): Promise<string> {
  const flowId = randomSecret();
  await useKv().setItem<StoredChallenge>(
    `wa:${sha256Hex(flowId)}`,
    { challenge, userId, email },
    { ttl: Math.ceil(PASSKEY_CHALLENGE_TTL_MS / 1000) },
  );
  return flowId;
}

/**
 * Redeem a flow id, returning its challenge exactly once.
 *
 * Single-use: the entry is cleared before the caller verifies anything, so a
 * replayed response finds nothing and fails, whatever else happens downstream.
 */
export async function takeChallenge(flowId: string): Promise<StoredChallenge | null> {
  if (!flowId || typeof flowId !== "string" || flowId.length > 200) return null;
  const key = `wa:${sha256Hex(flowId)}`;
  const kv = useKv();
  const found = await kv.getItem<StoredChallenge>(key);
  if (!found) return null;
  // burn it immediately — a 1-second TTL is how this KV surface expresses a delete
  await kv.setItem(key, null, { ttl: 1 });
  return found;
}
