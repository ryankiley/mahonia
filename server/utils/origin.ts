// WHICH ORIGIN THIS DEPLOYMENT SPEAKS AS.
//
// One function, because there was one bug, and it had two mouths.
//
// A sign-in link and a passkey ceremony are both statements about a HOST: "click
// here and you'll be at Mahonia", "sign this, and only mahonia.app may consume
// it". Both used to derive that host from `getRequestURL(event)` / the raw
// `Host` header — which is not a fact about the deployment, it's a claim by the
// caller. h3's `getRequestHost` returns `req.headers.host` verbatim unless
// `xForwardedHost` is passed, so any value that reaches the handler is the value
// that gets used.
//
// THE ATTACK THAT MADE THIS URGENT: POST /api/auth/request with a victim's
// address and `Host: evil.example`. The endpoint answers `{ ok: true }` (it
// always does — that's deliberate, so it can't be used as an
// account-existence oracle), mints a real token, and mails the victim a genuine
// Mahonia sign-in message whose link points at the attacker's domain. One click
// and a live single-use credential for that account is in the attacker's logs.
// That is account takeover from an unauthenticated POST.
//
// WHY IT WASN'T ALREADY BEING EXPLOITED, and why that isn't a defence: Vercel
// routes by Host/SNI, so a request carrying a host nobody assigned to the
// project is refused at the edge and never reaches a function. That is a
// property of the platform, not of this app — and nuxt.config.ts pre-compresses
// static assets specifically so the site stays fast OFF Vercel. Behind nginx,
// Caddy, or a bare node-server, the same code is exploitable on the first
// request. An application-level guarantee shouldn't be on loan from the host.
//
// THE RULE, in three lines, in this order:
//
//   1. MAHONIA_ORIGIN, if set. The explicit answer — a fork, a self-hosted
//      deploy, or a custom domain says what it is and this file stops guessing.
//   2. Anything that isn't production: the request's own origin, exactly as
//      before. `npm run dev` mails itself a working localhost link with no
//      configuration, and a Vercel preview mails itself its own deploy URL —
//      both of which the README's "runs with no environment variables" promise
//      depends on, and neither of which is worth hardening, because a preview
//      runs against an isolated database branch (see databaseUrl() in db.ts).
//   3. Production: CANONICAL_ORIGIN. Pinned, unforgeable, ignores the request.
//
// Note what is NOT here: an allowlist of hosts to accept from the request. A
// list of "hosts we'd also be happy with" is still a decision made from a header
// — it just narrows the target — and every entry on it is a host somebody has to
// remember to remove later.

import type { H3Event } from "h3";
import { getRequestURL } from "h3";
import { CANONICAL_ORIGIN } from "../../shared/site";

/** Whether this process is serving real users. Vercel's own VERCEL_ENV is
 *  checked first because it distinguishes `preview` from `production`, which
 *  NODE_ENV cannot — both are "production" builds. */
function isProduction(): boolean {
  const vercel = process.env.VERCEL_ENV;
  if (vercel) return vercel === "production";
  return process.env.NODE_ENV === "production";
}

/** `https://host[:port]` with any trailing slash and stray whitespace removed,
 *  or null if the value isn't a usable absolute http(s) origin. A malformed
 *  MAHONIA_ORIGIN must fall through to the pinned default rather than produce
 *  links to "undefined". */
function normalizeOrigin(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The origin this deployment may put in a link, sign a ceremony against, or
 * otherwise hand to somebody as "this is us".
 *
 * Use this ANYWHERE a value derived from it leaves the request it came from — an
 * email, a stored record, a WebAuthn binding. Routes that only describe the
 * current request to the current caller (robots.txt, sitemap.xml, llms.txt) can
 * keep using `getRequestURL`: a forged host there produces a self-referential
 * answer that goes nowhere and reaches nobody else.
 */
export function trustedOrigin(event: H3Event): string {
  const configured = normalizeOrigin(process.env.MAHONIA_ORIGIN);
  if (configured) return configured;
  if (!isProduction()) return getRequestURL(event).origin;
  return CANONICAL_ORIGIN;
}

/** The trusted origin's host, port and all — what a browser reports as the
 *  authority half of its origin. */
export function trustedHost(event: H3Event): string {
  return new URL(trustedOrigin(event)).host;
}
