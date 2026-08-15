// @vitest-environment nuxt
//
// The sign-in sweep — what the browser sends the claim endpoint, and when it
// bothers sending anything at all.
//
// The split matters: rows this browser made go in `editTokens` and are claimed
// outright, rows that arrived through someone else's link go in `openedTokens`
// and are only ever claimed under the server's narrower rule (a list from before
// origin tracking, whose mark was never recorded — see server/utils/claimRepo).
// Sending the second bucket is what lets a pre-accounts list that got stamped by a
// reopen reach the account without anyone pressing anything; NOT claiming on the
// strength of it is what keeps a shared list out of your account.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { readBody } from "h3";
import type { MyListEntry } from "~~/shared/types";

const signedIn = ref(true);
mockNuxtImport("useSession", () => () => ({ signedIn }));

const entries = ref<MyListEntry[]>([]);
mockNuxtImport("useMyLists", () => () => ({ entries }));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
});

// The real request, intercepted at the endpoint — `$fetch` is resolved by the
// auto-import at call time, so stubbing the global doesn't catch it (the live one
// runs, fails, and disappears into the composable's catch, which reads as "sent
// nothing" and passes the wrong tests).
interface ClaimBody {
  editTokens: string[];
  openedTokens: string[];
}
const posted: ClaimBody[] = [];
registerEndpoint("/api/lists/claim", {
  method: "POST",
  handler: async (event) => {
    const body = await readBody<ClaimBody>(event);
    posted.push({ editTokens: body.editTokens ?? [], openedTokens: body.openedTokens ?? [] });
    return { claimed: 0, lists: [] };
  },
});
registerEndpoint("/api/lists/claimed", () => ({ lists: [] }));

const entry = (over: Partial<MyListEntry> & { editToken: string }): MyListEntry => ({
  shareCode: "CODE00000001",
  slug: "trip-aa11bb",
  title: "Trip",
  totalMg: 0,
  version: 1,
  lastOpened: 0,
  displayUnit: "g",
  ...over,
});

beforeEach(() => {
  signedIn.value = true;
  entries.value = [];
  storage.clear();
  posted.length = 0;
});

describe("claimDeviceLists — what goes to the server", () => {
  it("splits the registry into owned and opened buckets", async () => {
    entries.value = [
      entry({ editToken: "mine", origin: "created" }),
      entry({ editToken: "legacy" }), // predates the field
      entry({ editToken: "theirs", origin: "opened", shareCode: "CODE00000002" }),
    ];

    await useClaimedLists().claimDeviceLists();

    expect(posted).toHaveLength(1);
    // an absent origin is still treated as yours — the guess this app has always made
    expect([...posted[0]!.editTokens].sort()).toEqual(["legacy", "mine"]);
    // sent, but the server decides; being in this array claims nothing by itself
    expect(posted[0]!.openedTokens).toEqual(["theirs"]);
  });

  it("sends a registry that is nothing BUT opened rows", async () => {
    // the stranded case: the only list on this device got stamped by a reopen. The
    // old sweep sent an empty array here and the account never heard of it.
    entries.value = [entry({ editToken: "stamped", origin: "opened" })];

    await useClaimedLists().claimDeviceLists();

    expect(posted).toEqual([{ editTokens: [], openedTokens: ["stamped"] }]);
  });

  it("re-runs when only an opened row changes", async () => {
    entries.value = [entry({ editToken: "mine", origin: "created" })];
    await useClaimedLists().claimDeviceLists();
    expect(posted).toHaveLength(1);

    // a fingerprint over one bucket would call this "no change" and skip it
    entries.value = [...entries.value, entry({ editToken: "opened-one", origin: "opened" })];
    await useClaimedLists().claimDeviceLists();

    expect(posted).toHaveLength(2);
    expect(posted[1]!.openedTokens).toEqual(["opened-one"]);
  });

  it("skips the request when the whole registry is unchanged", async () => {
    entries.value = [
      entry({ editToken: "mine", origin: "created" }),
      entry({ editToken: "theirs", origin: "opened" }),
    ];
    await useClaimedLists().claimDeviceLists();
    expect(posted).toHaveLength(1); // the mark is only written by a real send
    posted.length = 0;

    await useClaimedLists().claimDeviceLists();

    expect(posted).toEqual([]);
  });

  it("does nothing at all signed out", async () => {
    signedIn.value = false;
    entries.value = [entry({ editToken: "mine", origin: "created" })];

    await useClaimedLists().claimDeviceLists();

    expect(posted).toEqual([]);
  });
});
