// The vault's capability, held on this device.
//
// A vault is owned by a link, exactly like a list — so the client's whole job here
// is to keep one high-entropy token and send it. There is no session, no cookie,
// and nothing to sign in to.
//
// The token lives in localStorage (not IndexedDB) for the same reason the "Your
// lists" registry does: it's a few dozen bytes read synchronously at setup, and a
// `storage` event keeps two open tabs agreed on it. It is NEVER put in a URL by
// this module — /vault reads one out of the fragment when you arrive from a
// transfer link, and the fragment is not sent to the server.

const STORAGE_KEY = "gear.vault.v1";

function read(): string {
  if (!import.meta.client) return "";
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    // Safari private mode, or storage disabled entirely. A vault is a convenience;
    // losing it must never take the editor down with it.
    return "";
  }
}

// Module scope, so every consumer (the editor's capture, the item autocomplete,
// the /vault page) reads one value and a mint in any of them is seen by the rest.
// SSR starts empty and the client seeds it at setup — the same shape useMyLists
// uses, and for the same hydration reason.
const token = ref("");
let seeded = false;

export function useVaultToken() {
  if (import.meta.client && !seeded) {
    seeded = true;
    token.value = read();
    // another tab minted, transferred, or forgot a vault — follow it
    useWindowEvent("storage", (e) => {
      if (e.key === STORAGE_KEY) token.value = read();
    });
  }

  /** True once this device holds a vault. Drives every "is there gear to offer"
   *  branch, the way `signedIn` would in an account-shaped design. */
  const hasVault = computed(() => token.value !== "");

  function setToken(next: string): void {
    token.value = next;
    if (!import.meta.client) return;
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // unwritable storage — the token still works for this page's lifetime
    }
  }

  /** Forget the vault ON THIS DEVICE. Deliberately not a delete: the vault itself
   *  lives on, and anyone still holding the link keeps it — same semantics as
   *  "Remove from device" for a list. */
  function forget(): void {
    setToken("");
  }

  /** Authorization header, or nothing. Empty rather than a `Bearer ` with no token
   *  so an endpoint that treats "no header" as "no vault yet" (search, capture)
   *  sees exactly that. */
  function authHeaders(): Record<string, string> {
    return token.value ? { Authorization: `Bearer ${token.value}` } : {};
  }

  return { token: readonly(token), hasVault, setToken, forget, authHeaders };
}
