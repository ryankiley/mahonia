// A PASSKEY FROM THE EMAIL FIELD'S AUTOFILL. Signed out, the browser is asked to offer a
// passkey in the address field's own list ("conditional mediation") rather than from a
// button. The request waits, unseen, until the person picks one: so it has to say it is
// conditional, carry a signal that can withdraw it, and be renewed before its challenge
// (three minutes on the server) runs out.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { stubLocalStorage } from "./helpers/storage";
import { passkeyAutofillSupported, usePasskeys } from "~/composables/usePasskeys";

stubLocalStorage();

let signedIn = false;
let optionsAsked = 0;
registerEndpoint("/api/auth/me", () =>
  signedIn ? { user: { owner: "1", email: "ryan@example.com", displayName: null } } : { user: null },
);
registerEndpoint("/api/auth/passkey/signin-options", {
  method: "POST",
  handler: () => ({ flowId: `flow${++optionsAsked}`, options: { challenge: "AAAA", rpId: "localhost" } }),
});
registerEndpoint("/api/auth/passkey/signin-verify", {
  method: "POST",
  handler: () => {
    signedIn = true;
    document.cookie = "mh_signed_in=1; path=/";
    return { ok: true };
  },
});

const bytes = () => new Uint8Array([1, 2, 3]).buffer;
const credential = {
  id: "cred",
  rawId: bytes(),
  type: "public-key",
  authenticatorAttachment: "platform",
  getClientExtensionResults: () => ({}),
  response: { clientDataJSON: bytes(), authenticatorData: bytes(), signature: bytes() },
};
// what each credentials.get was asked for, and a way to settle the one that is waiting
type Asked = { mediation?: string; signal?: AbortSignal };
const asked: Asked[] = [];
let pick: ((c: unknown) => void) | null = null;
const conditional = { available: true };
function installBrowser() {
  const PKC = function PublicKeyCredential() {} as unknown as { isConditionalMediationAvailable: () => Promise<boolean> };
  PKC.isConditionalMediationAvailable = async () => conditional.available;
  Object.defineProperty(window, "PublicKeyCredential", { value: PKC, configurable: true });
  Object.defineProperty(navigator, "credentials", {
    configurable: true,
    value: {
      create: async () => null,
      get: (o: Asked) =>
        new Promise((resolve, reject) => {
          asked.push(o);
          pick = resolve;
          // as a browser does: an aborted request rejects
          o.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    },
  });
}
// let the options request land and the waiting get() be issued
const settle = async () => {
  for (let i = 0; i < 20 && asked.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
};

beforeEach(async () => {
  signedIn = false;
  optionsAsked = 0;
  asked.length = 0;
  pick = null;
  conditional.available = true;
  installBrowser();
  document.cookie = "mh_signed_in=; path=/; max-age=0";
  useState<unknown>("session").value = { state: "unresolved" };
  useState<boolean>("session-pending").value = false;
  await useSession().refresh();
});
afterEach(() => vi.useRealTimers());

describe("offering a passkey from the email field", () => {
  it("asks the browser for a conditional request it can withdraw", async () => {
    const stop = new AbortController();
    const done = usePasskeys().signInFromAutofill(stop.signal);
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.mediation).toBe("conditional");
    expect(asked[0]!.signal).toBeInstanceOf(AbortSignal);
    stop.abort();
    expect(await done).toBe("cancelled");
  });

  it("signs in when a passkey is picked from the list, without a reload", async () => {
    const done = usePasskeys().signInFromAutofill(new AbortController().signal);
    await settle();
    pick!(credential);
    expect(await done).toBe("ok");
    expect(useSession().signedIn.value).toBe(true);
  });

  it("is withdrawn, not failed, when the form goes away", async () => {
    const stop = new AbortController();
    const done = usePasskeys().signInFromAutofill(stop.signal);
    await settle();
    stop.abort();
    expect(await done).toBe("cancelled");
    expect(asked[0]!.signal!.aborted).toBe(true);
    expect(useSession().signedIn.value).toBe(false);
  });

  it("asks nothing of a browser with no such list", async () => {
    conditional.available = false;
    expect(await passkeyAutofillSupported()).toBe(false);
    expect(await usePasskeys().signInFromAutofill(new AbortController().signal)).toBe("unsupported");
    expect(optionsAsked).toBe(0);
    expect(asked).toHaveLength(0);
  });

  it("renews the offer with a fresh challenge before the old one runs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = new AbortController();
    const done = usePasskeys().signInFromAutofill(stop.signal);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    // the server keeps a challenge three minutes; the offer turns over before that
    await vi.advanceTimersByTimeAsync(150_000);
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[0]!.signal!.aborted).toBe(true);
    expect(asked[1]!.signal!.aborted).toBe(false);
    expect(optionsAsked).toBe(2);
    stop.abort();
    expect(await done).toBe("cancelled");
  });
});
