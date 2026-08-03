// Passkeys, browser side.
//
// NO @simplewebauthn/browser: that package exists to marshal ArrayBuffers to and
// from base64url around `navigator.credentials`, which is the twenty lines below.
// The server half genuinely needs a library (COSE keys, CBOR, signature
// verification — not code to hand-roll), but shipping one to every visitor to do
// base64 would be a poor trade against this repo's bundle budget.

export interface PasskeySummary {
  id: number;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

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

/** The server sends WebAuthn options as JSON; the browser API wants real binary
 *  in three of the fields. This is the entire reason a "WebAuthn browser library"
 *  usually exists. */
function toCreateOptions(o: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const opts = { ...o } as Record<string, unknown>;
  opts.challenge = b64urlToBytes(o.challenge as string);
  opts.user = { ...(o.user as Record<string, unknown>), id: b64urlToBytes((o.user as { id: string }).id) };
  if (Array.isArray(o.excludeCredentials)) {
    opts.excludeCredentials = (o.excludeCredentials as { id: string }[]).map((c) => ({
      ...c,
      id: b64urlToBytes(c.id),
    }));
  }
  return opts as unknown as PublicKeyCredentialCreationOptions;
}

function toRequestOptions(o: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  const opts = { ...o } as Record<string, unknown>;
  opts.challenge = b64urlToBytes(o.challenge as string);
  if (Array.isArray(o.allowCredentials)) {
    opts.allowCredentials = (o.allowCredentials as { id: string }[]).map((c) => ({
      ...c,
      id: b64urlToBytes(c.id),
    }));
  }
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

export type PasskeyResult = "ok" | "cancelled" | "unsupported" | "failed";

/** Where a ceremony stopped, so each flow can map it to its own vocabulary. */
type CeremonyEnd =
  | { at: "options"; error: unknown } // the *-options request failed
  | { at: "authenticator" } // the OS prompt was dismissed, or the authenticator refused
  | { at: "verify" } // the *-verify request failed
  | { at: "done"; res: { ok: boolean; reason?: string } }; // the server's verdict, unmapped

/**
 * The ceremony every flow shares: fetch challenge options from the server, hand
 * them (as real binary) to the authenticator, POST the signed result back.
 * Register, sign-up and sign-in used to spell this skeleton out in full three
 * times, drifting only in endpoints and error vocabulary. What stays per-flow is
 * exactly that — which routes, create vs get, and what each failure is CALLED
 * (sign-up's "taken", the session refresh on success) — mapped by each caller
 * from the stop-point this returns.
 *
 * The verify response is typed concretely, not as a generic: the three routes
 * share one shape (`reason` is only ever set by signup-verify), and a generic
 * here makes nitro's typed $fetch defer its route-match conditional, which blows
 * TS's comparison stack in whatever file the checker visits next.
 */
async function ceremony(flow: {
  options: string;
  /** sent with the options request (sign-up's email); no body at all when absent */
  body?: Record<string, unknown>;
  /** create mints a new credential (register, sign-up); get asserts one (sign-in) */
  kind: "create" | "get";
  verify: string;
  /** merged into the verify body (register's label) */
  extra?: Record<string, unknown>;
}): Promise<CeremonyEnd> {
  let flowId: string;
  let options: Record<string, unknown>;
  try {
    const res = await $fetch<{ flowId: string; options: Record<string, unknown> }>(flow.options, {
      method: "POST",
      body: flow.body, // undefined = no body at all — ofetch skips a falsy body
    });
    flowId = res.flowId;
    options = res.options;
  } catch (e) {
    return { at: "options", error: e };
  }

  let cred: PublicKeyCredential | null;
  try {
    cred = (await (flow.kind === "create"
      ? navigator.credentials.create({ publicKey: toCreateOptions(options) })
      : navigator.credentials.get({ publicKey: toRequestOptions(options) }))) as PublicKeyCredential | null;
  } catch {
    // The user dismissed the OS prompt, or the authenticator refused. Not an
    // error to shout about — they simply chose not to.
    return { at: "authenticator" };
  }
  if (!cred) return { at: "authenticator" };

  try {
    const res = await $fetch<{ ok: boolean; reason?: string }>(flow.verify, {
      method: "POST",
      body: { flowId, response: fromCredential(cred), ...flow.extra },
    });
    return { at: "done", res };
  } catch {
    return { at: "verify" };
  }
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
   * Create an account with nothing but a passkey — no email, no inbox round-trip.
   *
   * The same two-step ceremony as register(), against the unauthenticated signup
   * routes: there's no session yet, because the account this is making doesn't
   * exist until the authenticator signs the challenge. On success the server has
   * already started the session, so this refreshes to pick it up.
   *
   * The address is required and is checked BEFORE the ceremony, so a taken or
   * malformed one fails on the form rather than after someone has touched their
   * sensor. It's the way back in if every authenticator is lost — see
   * signup-options for why it's collected up front rather than after.
   */
  async function signUp(email: string): Promise<PasskeyResult | "taken" | "bad-email"> {
    if (!passkeysSupported()) return "unsupported";
    const end = await ceremony({
      options: "/api/auth/passkey/signup-options",
      body: { email },
      kind: "create",
      verify: "/api/auth/passkey/signup-verify",
    });
    if (end.at === "options") {
      const status = (end.error as { statusCode?: number })?.statusCode;
      if (status === 409) return "taken";
      if (status === 400) return "bad-email";
      return "failed";
    }
    if (end.at === "authenticator") return "cancelled";
    if (end.at !== "done") return "failed";
    if (!end.res.ok) return end.res.reason === "taken" ? "taken" : "failed";
    // the session cookie is already set — this pulls the user into app state so
    // the vault and the "add a way back in" prompt both light up without a reload
    await refresh();
    return "ok";
  }

  /** Sign in with a passkey — no email typed. The browser offers whichever
   *  discoverable key it holds for this site, and the credential identifies the
   *  account. */
  async function signIn(): Promise<PasskeyResult> {
    if (!passkeysSupported()) return "unsupported";
    const end = await ceremony({
      options: "/api/auth/passkey/signin-options",
      kind: "get",
      verify: "/api/auth/passkey/signin-verify",
    });
    if (end.at === "authenticator") return "cancelled";
    if (end.at !== "done" || !end.res.ok) return "failed";
    await refresh(true); // adopt the new session app-wide
    return "ok";
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

  return { register, signUp, signIn, list, remove };
}
