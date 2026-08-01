// Transactional email — one message, the sign-in link.
//
// NO SDK: Resend's REST API is a single POST with a JSON body, so a plain fetch
// does the whole job. That keeps the dependency list (nine runtime packages) as it
// was, and swapping provider means editing the URL and body shape here rather than
// changing a dependency.
//
// WITH NO API KEY THE APP STILL WORKS LOCALLY. `npm run dev` against a fresh
// checkout has no RESEND_API_KEY, and the README's promise is that the app runs
// fully on your machine with no environment variables — so in development the link
// is printed to the server console instead of emailed, and sign-in works offline.
// In production a missing key is a real misconfiguration and throws, because
// silently swallowing it would leave users staring at "check your email" forever.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Fallback From. Resend rejects a domain you haven't verified, so a real deploy
 *  must set AUTH_EMAIL_FROM; onboarding@resend.dev works for a first smoke test. */
const DEFAULT_FROM = "Mahonia <onboarding@resend.dev>";

export interface MagicLinkEmail {
  to: string;
  url: string;
  /** How long the link stays valid, already phrased for a human ("15 minutes"). */
  expiresIn: string;
}

/** Escape interpolated text for the HTML part. The address and the URL are the
 *  only interpolations and both are validated upstream, but an email body is
 *  still an HTML document rendered by someone else's client — belt and braces. */
function esc(s: string): string {
  return s.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Plain, unstyled, single-purpose — the message says what it is, shows the link,
 *  and says what to do if it wasn't you. Matches the site's plain-prose voice. */
function body(url: string, expiresIn: string): { html: string; text: string } {
  const safe = esc(url);
  return {
    html: [
      `<p>Here's your sign-in link for Mahonia.</p>`,
      `<p><a href="${safe}">Sign in to Mahonia</a></p>`,
      `<p>It works once and expires in ${esc(expiresIn)}.</p>`,
      `<p>If you didn't ask to sign in, you can ignore this — nothing has changed on your account.</p>`,
      `<p style="color:#666">If the link doesn't work, paste this into your browser:<br>${safe}</p>`,
    ].join("\n"),
    text: [
      "Here's your sign-in link for Mahonia.",
      "",
      url,
      "",
      `It works once and expires in ${expiresIn}.`,
      "",
      "If you didn't ask to sign in, you can ignore this — nothing has changed on your account.",
    ].join("\n"),
  };
}

/**
 * Can this deployment send mail at all?
 *
 * Distinct from "did this particular send succeed", and the difference matters:
 * the answer here is the same for every address, so a caller may surface it
 * without leaking whether an account exists — whereas a per-address failure must
 * never change the response. Lets the sign-in endpoint fail loudly on a
 * misconfigured deploy (no API key) instead of cheerfully saying "check your
 * email" about a message that was never going to be sent.
 */
export function canSendEmail(): boolean {
  return Boolean(process.env.RESEND_API_KEY) || process.env.NODE_ENV !== "production";
}

/**
 * Send the sign-in link. Throws on a delivery failure so the endpoint can tell the
 * user honestly that the mail didn't go out; the caller is responsible for not
 * letting that answer differ between a known and an unknown address.
 */
export async function sendMagicLink({ to, url, expiresIn }: MagicLinkEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const { html, text } = body(url, expiresIn);

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY is not set — cannot send the sign-in email");
    }
    // Dev convenience: the whole point is that a fresh checkout can sign in with
    // zero configuration. Loud and unmissable in the terminal.
    console.info(
      `\n[auth] Sign-in link for ${to} (no RESEND_API_KEY set, so it's printed instead of emailed):\n${url}\n`,
    );
    return;
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.AUTH_EMAIL_FROM || DEFAULT_FROM,
      to: [to],
      subject: "Your Mahonia sign-in link",
      html,
      text,
    }),
  });

  if (!res.ok) {
    // Read the provider's message for the server log — never for the response
    // body, which must not vary with the address that was submitted.
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend responded ${res.status}: ${detail.slice(0, 500)}`);
  }
}
