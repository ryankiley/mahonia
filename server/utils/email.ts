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

/** How long to wait on Resend before giving up.
 *
 *  Every message here rides an interactive request — somebody is watching a button
 *  say "sending". Without a deadline a provider that accepts the connection and
 *  then stalls holds the serverless function until the PLATFORM's timeout kills it,
 *  which is both far longer and a worse failure: the caller gets nothing to act on.
 *  Matches the ceiling the other outbound calls use (trailFavicon, import, feedback). */
const SEND_TIMEOUT_MS = 10_000;

/** The one POST both messages make. Single-sourced so the deadline and the
 *  error handling can't be right in one message and missing in the other —
 *  which is exactly how the timeout came to be absent from both. */
async function postToResend(payload: Record<string, unknown>, apiKey: string): Promise<void> {
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  if (!res.ok) {
    // Read the provider's message for the server log — never for the response
    // body, which must not vary with the address that was submitted.
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend responded ${res.status}: ${detail.slice(0, 500)}`);
  }
}

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
   * Why this message exists. "signin" is someone asking to get in.
   *
   * "welcome" follows a passkey signup, where the account ALREADY exists and the
   * person is already signed in — so it isn't a sign-in link, it's a notice that
   * an account now exists against this address. It has TWO readers and has to
   * serve both: the person who just signed up, and the person whose address
   * someone else typed in. For the second, this message is the only warning they
   * get and the link is how they take the account back.
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
  // A sign-in message IS the link. A welcome message is a NOTICE, and the link in
  // it is an undo — see the block above `closing`. Same machinery, two different
  // things happening, and the welcome copy has to work for two different readers.
  const lead = welcome
    ? "A Mahonia account was created with this address, and a passkey was set up on it. If that was you, there's nothing to do. This address is how you get back in if you lose the device holding that passkey."
    : "Here's your sign-in link for Mahonia.";
  // The welcome CTA says what the link DOES, because for one of its two readers
  // clicking is the wrong move: it would remove the passkey they just enrolled.
  // "Sign in from this device too", which this used to say, invited exactly that.
  const cta = welcome ? "Sign in and remove that passkey" : "Sign in to Mahonia";
  // THE WELCOME COPY IS A SECURITY CONTROL, not a pleasantry. Anyone can start a
  // passkey signup with anyone's address, so this message is also what a person
  // gets when a stranger has enrolled a passkey against theirs — and it is the
  // only warning they will ever get. Telling them to ignore it, which this used to
  // ("nothing here is yours"), was false under exactly that case and talked them
  // out of the one action that undoes it. So it names what happened and what
  // clicking does: see claimUnverifiedAccount in authSession.ts, which is the
  // promise these sentences are making.
  const closing = welcome
    ? "If it wasn't you, someone else set up a passkey with your address. Use the link above. Signing in removes their passkey, signs them out, and leaves the account yours."
    : "If you didn't ask to sign in, you can ignore this — nothing has changed on your account.";
  return {
    // Says what happened rather than congratulating anyone: the subject line is
    // what decides whether the person under attack opens this at all.
    subject: welcome ? "A Mahonia account was created with this address" : "Your Mahonia sign-in link",
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

  await postToResend({
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
  }, apiKey);
}

/**
 * Tell someone a passkey was added to their account.
 *
 * The only security-relevant change an account can undergo that the owner might
 * not have made. A passkey can only be added from inside a live session, so this
 * doesn't stop an attacker who already has one — it's the thing that lets the
 * OWNER find out, which is the difference between a bad afternoon and never
 * knowing. Deliberately has no "undo" link: the safe action is to go and look at
 * the passkey list yourself, not to click something in an email you didn't expect.
 *
 * Best-effort by contract — the caller must never let this fail the request it
 * rode in on. Adding a passkey succeeding and the notice failing is fine; the
 * reverse is not.
 */
export async function sendPasskeyAddedNotice(to: string, label: string | null): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const which = label ? `“${label}”` : "A new passkey";
  const lead = `${which} was added to your Mahonia account.`;
  const closing =
    "If that was you, there's nothing to do. If it wasn't, open your account page and remove it — and remove any passkey you don't recognise while you're there.";
  const text = [lead, "", closing].join("\n");

  if (!apiKey) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("RESEND_API_KEY is not set — cannot send the passkey notice");
    }
    console.info(`\n[auth] Passkey notice for ${to} (no RESEND_API_KEY, printed instead):\n${lead}\n`);
    return;
  }

  await postToResend({
    from: fromAddress(),
    to: [to],
    subject: "A passkey was added to your Mahonia account",
    html: [`<p>${esc(lead)}</p>`, `<p>${esc(closing)}</p>`].join("\n"),
    text,
    headers: { "X-Entity-Ref-ID": randomSecret() },
  }, apiKey);
}
