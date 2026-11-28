import { normalizeShareCode } from "~~/shared/links";
import type { ListSnapshot } from "~~/shared/types";

// THIS DEVICE'S COPY OF A SHARED LIST: what a share link (/s/{code}) shows when the
// server can't be reached, kept from the last time it could.
//
// Kept by the page, in the browser's Cache Storage, under the address the list is
// served from (/api/s/{code}). Each entry is the answer that address gave, whole, dated
// with when it was kept. That answer is the public read (the server strips the owner's
// ticks, prices and route before it leaves), and it is the only thing that goes in: no
// editor state, nothing from an account.
//
// By the page and not the service worker, because the worker never sees a shared list.
// The page is server-rendered with the list inside its HTML, so the browser doesn't
// ask for it. A worker-kept copy would take a second request on every view just to have
// something to keep; the page couldn't tell that copy from a live answer, or date it;
// and a 404 wouldn't evict it. Cache Storage and not localStorage because a list
// carries a route profile and a favicon, and fifty of them would not fit beside the
// rest of what the app keeps there.

const COPIES = "mahonia-shared-lists";
/** Kept by recency of opening. A copy has no age limit: it says how old it is. */
const MAX_COPIES = 50;

export interface SharedListCopy {
  snapshot: ListSnapshot;
  /** when this device kept it, epoch ms */
  keptAt: number;
}

const addressOf = (code: string) => {
  const c = normalizeShareCode(code);
  return c && `/api/s/${c}`;
};

// Every call below can throw where there is no Cache Storage to open (an insecure
// origin, some private windows) or no room left. Each then keeps, reads or drops
// nothing, which is all that can be done about it.

/** Keep the list a share link was just answered with, as the newest copy. */
export async function keepSharedList(snapshot: ListSnapshot, now: number = Date.now()): Promise<void> {
  const address = addressOf(snapshot.shareCode);
  if (!address) return;
  try {
    const cache = await caches.open(COPIES);
    // dropped first, so a list opened again goes to the back of the line: a browser
    // lists a cache's entries in the order they were added
    await cache.delete(address);
    await cache.put(
      address,
      new Response(JSON.stringify({ snapshot }), {
        headers: { "content-type": "application/json", date: new Date(now).toUTCString() },
      }),
    );
    const entries = await cache.keys();
    await Promise.all(entries.slice(0, Math.max(0, entries.length - MAX_COPIES)).map((e) => cache.delete(e)));
  } catch {
    // nothing kept
  }
}

/** The copy this device holds of a share link's list, or null. */
export async function readSharedList(code: string): Promise<SharedListCopy | null> {
  const address = addressOf(code);
  if (!address) return null;
  try {
    const kept = await (await caches.open(COPIES)).match(address);
    if (!kept) return null;
    const keptAt = Date.parse(kept.headers.get("date") ?? "");
    const { snapshot } = (await kept.json()) as { snapshot?: ListSnapshot };
    return snapshot?.shareCode && Number.isFinite(keptAt) ? { snapshot, keptAt } : null;
  } catch {
    return null;
  }
}

/** Forget a list the server says is gone. */
export async function dropSharedList(code: string): Promise<void> {
  const address = addressOf(code);
  if (!address) return;
  try {
    await (await caches.open(COPIES)).delete(address);
  } catch {
    // nothing was kept
  }
}
