// Passkeys, browser side.
//
// NO @simplewebauthn/browser: that package exists to marshal ArrayBuffers to and
// from base64url around `navigator.credentials`, which is the twenty lines below.
// The server half genuinely needs a library (COSE keys, CBOR, signature
// verification — not code to hand-roll), but shipping one to every visitor to do
// base64 would be a poor trade against this repo's bundle budget.


import type { PasskeySummary } from "~~/shared/types";

const b64urlToBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const bytesToB64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** Whether this browser can do passkeys at all. Everything passkey-shaped in the
 *  UI hangs off this, so an older browser simply sees the emailed link and no
 *  broken buttons. */
export function passkeysSupported(): boolean {
  return (
    import.meta.client &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator.credentials?.create === "function"
  );
}

/** Whether this browser can offer a passkey from a field's autofill list ("conditional
 *  mediation"). A separate question from passkeysSupported: an older browser can run the
 *  ceremony from a button and still have no such list. */
export async function passkeyAutofillSupported(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    return (await window.PublicKeyCredential.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

/** How long one autofill offer stands before it is renewed. The server's challenge
 *  lasts three minutes (PASSKEY_CHALLENGE_TTL_MS, server/utils/passkeys.ts); an offer
 *  left waiting past that would hand the person a passkey prompt that can only fail. */
const AUTOFILL_RENEW_MS = 150_000;

/** A credential list as the browser API wants it: each id as bytes. */
const withBinaryIds = (list: unknown[]) =>
  (list as { id: string }[]).map((c) => ({ ...c, id: b64urlToBytes(c.id) }));

/** The server sends WebAuthn options as JSON; the browser API wants real binary
 *  in three of the fields. This is the entire reason a "WebAuthn browser library"
 *  usually exists. */
function toCreateOptions(o: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const opts = { ...o } as Record<string, unknown>;
  opts.challenge = b64urlToBytes(o.challenge as string);
  opts.user = { ...(o.user as Record<string, unknown>), id: b64urlToBytes((o.user as { id: string }).id) };
  if (Array.isArray(o.excludeCredentials)) opts.excludeCredentials = withBinaryIds(o.excludeCredentials);
  return opts as unknown as PublicKeyCredentialCreationOptions;
}

function toRequestOptions(o: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const opts = { ...o } as Record<string, unknown>;
  opts.challenge = b64urlToBytes(o.challenge as string);
  if (Array.isArray(o.allowCredentials)) opts.allowCredentials = withBinaryIds(o.allowCredentials);
  return opts as unknown as PublicKeyCredentialRequestOptions;
}

/** Serialise a registration result back to the JSON shape the server verifies. */
function fromCredential(cred: PublicKeyCredential): Record<string, unknown> {
  const res = cred.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  const out: Record<string, unknown> = {
    id: cred.id,
    rawId: bytesToB64url(cred.rawId),
    type: cred.type,
    clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
    response: {} as Record<string, unknown>,
  };
  const r = out.response as Record<string, unknown>;
  r.clientDataJSON = bytesToB64url(res.clientDataJSON);
  if (res.attestationObject) {
    r.attestationObject = bytesToB64url(res.attestationObject);
    r.transports = res.getTransports?.() ?? [];
  }
  if (res.authenticatorData) r.authenticatorData = bytesToB64url(res.authenticatorData);
  if (res.signature) r.signature = bytesToB64url(res.signature);
  if (res.userHandle) r.userHandle = bytesToB64url(res.userHandle);
  return out;
}

type PasskeyResult = "ok" | "cancelled" | "unsupported" | "failed";

/** Where a ceremony stopped, so each flow can map it to its own vocabulary. */
type CeremonyEnd =
  | { at: "options" } // the *-options request failed
  | { at: "authenticator" } // the OS prompt was dismissed, or the authenticator refused
  | { at: "verify" } // the *-verify request failed
  | { at: "done"; res: { ok: boolean } }; // the server's verdict, unmapped

/**
 * The ceremony every flow shares: fetch challenge options from the server, hand
 * them (as real binary) to the authenticator, POST the signed result back.
 * Register and sign-in used to spell this skeleton out in full each, drifting only
 * in endpoints and error vocabulary. What stays per-flow is exactly that — which
 * routes, create vs get, and the session refresh on success — mapped by each caller
 * from the stop-point this returns. (Signing UP with a passkey had a flow here too,
 * until the signed-out form became one door: an emailed link makes the account, and a
 * passkey is added to it afterwards. The signup routes stay for the iOS app.)
 *
 * The verify response is typed concretely, not as a generic: the routes share one
 * shape, and a generic here makes nitro's typed $fetch defer its route-match
 * conditional, which blows TS's comparison stack in whatever file the checker
 * visits next.
 */
async function ceremony(flow: {
  options: string;
  /** create mints a new credential (register); get asserts one (sign-in) */
  kind: "create" | "get";
  /** sign-in's get waits in a field's autofill list instead of raising the OS prompt;
   *  this is the signal that withdraws it (signInFromAutofill) */
  autofill?: AbortSignal;
  verify: string;
  /** merged into the verify body (register's label) */
  extra?: Record<string, unknown>;
}): Promise<CeremonyEnd> {
  let flowId: string;
  let options: Record<string, unknown>;
  try {
    const res = await $fetch<{ flowId: string; options: Record<string, unknown> }>(flow.options, {
      method: "POST",
    });
    flowId = res.flowId;
    options = res.options;
  } catch {
    return { at: "options" };
  }

  let cred: PublicKeyCredential | null;
  try {
    cred = (await (flow.kind === "create"
      ? navigator.credentials.create({ publicKey: toCreateOptions(options) })
      : // a sign-in is only ever offered from the address field (there is no button), so
        // it is always the waiting, conditional kind
        navigator.credentials.get({
          publicKey: toRequestOptions(options),
          mediation: "conditional" as const,
          signal: flow.autofill,
        }))) as PublicKeyCredential | null;
  } catch {
    // The user dismissed the OS prompt, or the authenticator refused. Not an
    // error to shout about — they simply chose not to.
    return { at: "authenticator" };
  }
  if (!cred) return { at: "authenticator" };

  try {
    // the verify is what starts a session: after any session check, never beside it
    await sessionSettled();
    const res = await $fetch<{ ok: boolean }>(flow.verify, {
      method: "POST",
      body: { flowId, response: fromCredential(cred), ...flow.extra },
    });
    return { at: "done", res };
  } catch {
    return { at: "verify" };
  }
}

/** Resolves after `ms`, or at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Resolves once the tab is the one being looked at (at once if it is), or when
 *  `signal` aborts. */
function untilVisible(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const settled = () => document.visibilityState === "visible" || signal.aborted;
    if (settled()) return resolve();
    const check = () => {
      if (!settled()) return;
      document.removeEventListener("visibilitychange", check);
      signal.removeEventListener("abort", check);
      resolve();
    };
    document.addEventListener("visibilitychange", check);
    signal.addEventListener("abort", check);
  });
}

export function usePasskeys() {
  const { refresh } = useSession();

  /** Add a passkey to the account you're already signed in to. */
  async function register(label?: string): Promise<PasskeyResult> {
    if (!passkeysSupported()) return "unsupported";
    const end = await ceremony({
      options: "/api/auth/passkey/register-options",
      kind: "create",
      verify: "/api/auth/passkey/register-verify",
      extra: { label },
    });
    if (end.at === "authenticator") return "cancelled";
    if (end.at !== "done") return "failed";
    return end.res.ok ? "ok" : "failed";
  }

  /**
   * Sign in with a passkey, offered from the email field's autofill list for as long as
   * `signal` stays unaborted. No email typed and no button: nothing is shown until the
   * person focuses a field marked autocomplete="... webauthn", the browser lists
   * whichever discoverable key it holds for this site, and the credential identifies the
   * account ("ok"). Aborting it (the form went away) is "cancelled".
   *
   * The offer is renewed on a timer, each time with a fresh challenge, because it can
   * wait far longer than a challenge lives.
   */
  async function signInFromAutofill(signal: AbortSignal): Promise<PasskeyResult> {
    if (!(await passkeyAutofillSupported())) return "unsupported";
    while (!signal.aborted) {
      // Never from a hidden tab (the rule useRetryWhile keeps, dom.ts): a form left
      // open in the background asked the server for a fresh challenge every renewal,
      // two dozen an hour, for an offer nobody could see. The next one waits for the
      // tab to come back.
      await untilVisible(signal);
      if (signal.aborted) break;
      // one offer: withdrawn by the caller, or by the timer so the next can replace it
      const offer = new AbortController();
      let renewing = false;
      const withdraw = () => offer.abort();
      signal.addEventListener("abort", withdraw, { once: true });
      const timer = setTimeout(() => {
        renewing = true;
        offer.abort();
      }, AUTOFILL_RENEW_MS);
      const end = await ceremony({
        options: "/api/auth/passkey/signin-options",
        kind: "get",
        verify: "/api/auth/passkey/signin-verify",
        autofill: offer.signal,
      });
      clearTimeout(timer);
      signal.removeEventListener("abort", withdraw);
      if (end.at === "authenticator") {
        if (renewing && !signal.aborted) continue;
        return "cancelled";
      }
      // The offer itself could not be made (offline, or asked too often): nobody picked
      // anything, so nothing failed. Reported as a failure it told someone who had only
      // opened the dialog that their passkey "didn't sign you in". A missed renewal,
      // then: wait one out and offer again, where returning here ended the offer for as
      // long as the form stayed open over a single blip.
      if (end.at === "options") {
        await pause(AUTOFILL_RENEW_MS, signal);
        continue;
      }
      if (end.at !== "done" || !end.res.ok) return "failed";
      await refresh(true); // adopt the new session app-wide
      return "ok";
    }
    return "cancelled";
  }

  async function list(): Promise<PasskeySummary[]> {
    try {
      const res = await $fetch<{ passkeys: PasskeySummary[] }>("/api/auth/passkey/list");
      return res.passkeys || [];
    } catch {
      return [];
    }
  }

  async function remove(id: number): Promise<boolean> {
    try {
      const res = await $fetch<{ ok: boolean }>("/api/auth/passkey/remove", {
        method: "POST",
        body: { id },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  return { register, signInFromAutofill, list, remove };
}
