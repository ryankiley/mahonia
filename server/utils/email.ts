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

import { randomSecret } from "./tokens";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Fallback From, for LOCAL DEV ONLY. Resend rejects a domain you haven't
 *  verified, and a production API key is typically scoped to your own domain — so
 *  falling back to this in production doesn't send from the wrong address, it
 *  fails the send outright, and the endpoint's catch swallows it into a cheerful
 *  "check your email" about a message that never left. Production throws instead;
 *  see fromAddress(). */
const DEFAULT_FROM = "Mahonia <onboarding@resend.dev>";

/** The From header, or a loud failure. Mirrors the RESEND_API_KEY rule: a
 *  misconfigured production deploy should say so, not go quiet. */
function fromAddress(): string {
  const from = process.env.AUTH_EMAIL_FROM;
  if (from) return from;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_EMAIL_FROM is not set — refusing to send from an unverified sender");
  }
  return DEFAULT_FROM;
}

export interface MagicLinkEmail {
  to: string;
  url: string;
  /** How long the link stays valid, already phrased for a human ("15 minutes"). */
  expiresIn: string;
  /**
   * Why this message exists. "signin" is someone asking to get in; "welcome" is
   * the confirmation after a passkey signup, where the account ALREADY exists and
   * the person is already signed in — telling them "here's your sign-in link"
   * describes something they didn't ask for and have no need of yet.
   */
  purpose?: "signin" | "welcome";
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
function body(
  url: string,
  expiresIn: string,
  purpose: "signin" | "welcome",
): { html: string; text: string; subject: string } {
  const safe = esc(url);
  const welcome = purpose === "welcome";
  // A welcome message confirms the address and offers the link as a spare. A
  // sign-in message IS the link. Same machinery, different thing happening.
  const lead = welcome
    ? "Your Mahonia account is ready, and this address is how you get back in if you ever lose the devices holding your passkey."
    : "Here's your sign-in link for Mahonia.";
  const cta = welcome ? "Sign in from this device too" : "Sign in to Mahonia";
  const closing = welcome
    ? "If you didn't create a Mahonia account, you can ignore this — the link expires on its own and nothing here is yours."
    : "If you didn't ask to sign in, you can ignore this — nothing has changed on your account.";
  return {
    subject: welcome ? "Your Mahonia account" : "Your Mahonia sign-in link",
    html: [
      `<p>${esc(lead)}</p>`,
      `<p><a href="${safe}">${esc(cta)}</a></p>`,
      `<p>It works once and expires in ${esc(expiresIn)}.</p>`,
      `<p>${esc(closing)}</p>`,
      `<p style="color:#666">If the link doesn't work, paste this into your browser:<br>${safe}</p>`,
    ].join("\n"),
    text: [
      lead,
      "",
      url,
      "",
      `It works once and expires in ${expiresIn}.`,
      "",
      closing,
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
export async function sendMagicLink({
  to,
  url,
  expiresIn,
  purpose = "signin",
}: MagicLinkEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const { html, text, subject } = body(url, expiresIn, purpose);

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
      from: fromAddress(),
      to: [to],
      subject,
      html,
      text,
      // BREAK THE THREAD. Without a distinct Message-ID, Gmail groups messages
      // with the same subject from the same sender into one conversation and
      // collapses the older ones — so the visible link is often a PREVIOUS one,
      // which is single-use and by then dead. The failure looks like "your links
      // don't work" and is invisible from the server. A per-message id keeps each
      // link its own conversation.
      headers: { "X-Entity-Ref-ID": randomSecret() },
    }),
  });

  if (!res.ok) {
    // Read the provider's message for the server log — never for the response
    // body, which must not vary with the address that was submitted.
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend responded ${res.status}: ${detail.slice(0, 500)}`);
  }
}
