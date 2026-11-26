/**
 * The one rule for what an email address is, for the server that stores it and the form
 * that takes it.
 *
 * Canonical form of an address, or null if it isn't one. Lowercased because email is the
 * identity (`Alex@Example.com` and `alex@example.com` are one account), so it runs on
 * every read and write path, never just at signup.
 *
 * Validation is deliberately loose (one @, something either side, a dot in the domain, no
 * whitespace): the real proof that an address is valid and reachable is that a link sent
 * to it comes back, and that check happens for free in this design. A stricter regex
 * would only reject deliverable addresses.
 *
 * SHARED WITH THE FORM because the endpoint answers a malformed address exactly as it
 * answers a good one (it must not say which addresses it knows), so only the form can
 * tell someone that `sam@gmail` went nowhere. It read the server's ok as "sent" and told
 * them to check their email.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  // Nothing invisible: the address is shown back to whoever opens its sign-in link
  // ("Sign in as ...?"), and a zero-width or direction-override character would let
  // one address be dressed as another there. No deliverable address has one.
  if (/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]/.test(email)) return null;
  return email;
}
