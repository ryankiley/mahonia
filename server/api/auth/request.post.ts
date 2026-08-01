import { createError, defineEventHandler, getRequestURL, setHeader } from "h3";
import {
  MAGIC_LINK_TTL_MS,
  findOrCreateUser,
  issueMagicToken,
  normalizeEmail,
  sweepExpiredAuth,
} from "../../utils/authSession";
import { useAccountDb } from "../../utils/db";
import { canSendEmail, sendMagicLink } from "../../utils/email";
import { readJsonBodyCapped } from "../../utils/http";
import { rateLimit, rateLimitSubject } from "../../utils/rateLimit";

// Ask for a sign-in link.
//
// THE RESPONSE NEVER VARIES. A malformed address, an unknown one, a known one and
// a provider hiccup all return the same `{ ok: true }`, because a response that
// differed would turn this endpoint into a "does this person use Mahonia?" oracle
// — and since requesting a link for an unknown address also CREATES the account,
// that oracle would be exact. The user learns whether it worked from their inbox,
// which is the only place that can tell them safely. Real failures are logged
// server-side, not returned.
//
// Two rate limits, deliberately: per-IP stops one machine spraying addresses,
// per-EMAIL stops a distributed pool mailbombing one person's inbox. Neither
// alone is sufficient.
export default defineEventHandler(async (event) => {
  setHeader(event, "X-Robots-Tag", "noindex");
  await rateLimit(event, "auth-request");

  // A deploy with no mail credentials can't sign anyone in, and the cheerful
  // `{ ok: true }` below would leave them waiting on a message that was never
  // going to be sent (exactly what a preview deployment without the key does).
  // Safe to answer honestly: it's the same answer for every address, so it says
  // nothing about whether an account exists. Checked before the account lookup,
  // so a misconfigured deploy doesn't quietly create users either.
  if (!canSendEmail()) {
    console.error("[auth request] RESEND_API_KEY is not set — sign-in is unavailable");
    throw createError({ statusCode: 503, statusMessage: "Sign-in is unavailable" });
  }

  const body = await readJsonBodyCapped<{ email?: unknown }>(event, 2_000);
  const email = normalizeEmail(body?.email);
  // Bail AFTER the per-IP limit has already been consumed, so scanning for the
  // validity rule costs the scanner the same budget as a real request.
  if (!email) return { ok: true };

  await rateLimitSubject("auth-request", email);

  try {
    const db = await useAccountDb();
    const user = await findOrCreateUser(db, email);
    const token = await issueMagicToken(db, user.id);
    // The link points back at the origin that served this request, so previews and
    // local dev mail themselves working links without configuration — the same
    // request-derived-origin approach the sitemap uses.
    const url = new URL("/auth/callback", getRequestURL(event).origin);
    url.searchParams.set("t", token);
    await sendMagicLink({
      to: email,
      url: url.toString(),
      expiresIn: `${Math.round(MAGIC_LINK_TTL_MS / 60_000)} minutes`,
    });
    // Opportunistic housekeeping on a rare, tightly-limited path: keeps expired
    // sessions and spent links from accumulating without needing a cron of their
    // own. Never allowed to fail the sign-in it rode in on.
    await sweepExpiredAuth(db).catch(() => {});
  } catch (e) {
    console.error("[auth request]", e);
  }

  return { ok: true };
});
