// A passkey sign-up ends with the server having started a session. The page has to
// pick it up there and then: the form only shows to a session already resolved as
// signed out, so a refresh that trusts that resolution never asks the server, and a
// new account sat signed out until a reload.
import { beforeEach, describe, expect, it } from "vitest";
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { stubLocalStorage } from "./helpers/storage";
import { usePasskeys } from "~/composables/usePasskeys";

stubLocalStorage();

let signedUp = false;
registerEndpoint("/api/auth/me", () =>
  signedUp ? { user: { owner: "1", email: "ryan@example.com", displayName: null } } : { user: null },
);
registerEndpoint("/api/auth/passkey/signup-options", {
  method: "POST",
  handler: () => ({
    flowId: "flow",
    options: { challenge: "AAAA", user: { id: "AAAA", name: "ryan@example.com", displayName: "" }, rp: { name: "Mahonia" } },
  }),
});
registerEndpoint("/api/auth/passkey/signup-verify", {
  method: "POST",
  handler: () => {
    // what the real route does: start the session, and with it the hint cookie
    signedUp = true;
    document.cookie = "mh_signed_in=1; path=/";
    return { ok: true };
  },
});

// an authenticator that always agrees
const bytes = () => new Uint8Array([1, 2, 3]).buffer;
Object.defineProperty(window, "PublicKeyCredential", { value: function PublicKeyCredential() {}, configurable: true });
Object.defineProperty(navigator, "credentials", {
  configurable: true,
  value: {
    create: async () => ({
      id: "cred",
      rawId: bytes(),
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({}),
      response: { clientDataJSON: bytes(), attestationObject: bytes(), getTransports: () => ["internal"] },
    }),
  },
});

beforeEach(() => {
  signedUp = false;
  document.cookie = "mh_signed_in=; path=/; max-age=0";
  useState<unknown>("session").value = { state: "unresolved" };
  useState<boolean>("session-pending").value = false;
});

describe("creating an account with a passkey", () => {
  it("is signed in the moment it's made, without a reload", async () => {
    // the page the form lives on: resolved, signed out (no hint, so no request)
    await useSession().refresh();
    expect(useSession().loaded.value).toBe(true);
    expect(useSession().signedIn.value).toBe(false);

    expect(await usePasskeys().signUp("ryan@example.com")).toBe("ok");

    expect(useSession().signedIn.value).toBe(true);
  });
});
