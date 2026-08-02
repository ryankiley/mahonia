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

export function usePasskeys() {
  const { refresh } = useSession();

  /** Add a passkey to the account you're already signed in to. */
  async function register(label?: string): Promise<PasskeyResult> {
    if (!passkeysSupported()) return "unsupported";
    let flowId: string;
    let options: Record<string, unknown>;
    try {
      const res = await $fetch<{ flowId: string; options: Record<string, unknown> }>(
        "/api/auth/passkey/register-options",
        { method: "POST" },
      );
      flowId = res.flowId;
      options = res.options;
    } catch {
      return "failed";
    }

    let cred: PublicKeyCredential | null;
    try {
      cred = (await navigator.credentials.create({
        publicKey: toCreateOptions(options),
      })) as PublicKeyCredential | null;
    } catch {
      // The user dismissed the OS prompt, or the authenticator refused. Not an
      // error to shout about — they simply chose not to.
      return "cancelled";
    }
    if (!cred) return "cancelled";

    try {
      const res = await $fetch<{ ok: boolean }>("/api/auth/passkey/register-verify", {
        method: "POST",
        body: { flowId, response: fromCredential(cred), label },
      });
      return res.ok ? "ok" : "failed";
    } catch {
      return "failed";
    }
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
    let flowId: string;
    let options: Record<string, unknown>;
    try {
      const res = await $fetch<{ flowId: string; options: Record<string, unknown> }>(
        "/api/auth/passkey/signup-options",
        { method: "POST", body: { email } },
      );
      flowId = res.flowId;
      options = res.options;
    } catch (e) {
      const status = (e as { statusCode?: number })?.statusCode;
      if (status === 409) return "taken";
      if (status === 400) return "bad-email";
      return "failed";
    }

    let cred: PublicKeyCredential | null;
    try {
      cred = (await navigator.credentials.create({
        publicKey: toCreateOptions(options),
      })) as PublicKeyCredential | null;
    } catch {
      return "cancelled";
    }
    if (!cred) return "cancelled";

    try {
      const res = await $fetch<{ ok: boolean; reason?: string }>(
        "/api/auth/passkey/signup-verify",
        { method: "POST", body: { flowId, response: fromCredential(cred) } },
      );
      if (!res.ok) return res.reason === "taken" ? "taken" : "failed";
      // the session cookie is already set — this pulls the user into app state so
      // the vault and the "add a way back in" prompt both light up without a reload
      await refresh();
      return "ok";
    } catch {
      return "failed";
    }
  }

  /** Sign in with a passkey — no email typed. The browser offers whichever
   *  discoverable key it holds for this site, and the credential identifies the
   *  account. */
  async function signIn(): Promise<PasskeyResult> {
    if (!passkeysSupported()) return "unsupported";
    let flowId: string;
    let options: Record<string, unknown>;
    try {
      const res = await $fetch<{ flowId: string; options: Record<string, unknown> }>(
        "/api/auth/passkey/signin-options",
        { method: "POST" },
      );
      flowId = res.flowId;
      options = res.options;
    } catch {
      return "failed";
    }

    let cred: PublicKeyCredential | null;
    try {
      cred = (await navigator.credentials.get({
        publicKey: toRequestOptions(options),
      })) as PublicKeyCredential | null;
    } catch {
      return "cancelled";
    }
    if (!cred) return "cancelled";

    try {
      const res = await $fetch<{ ok: boolean }>("/api/auth/passkey/signin-verify", {
        method: "POST",
        body: { flowId, response: fromCredential(cred) },
      });
      if (!res.ok) return "failed";
      await refresh(true); // adopt the new session app-wide
      return "ok";
    } catch {
      return "failed";
    }
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
