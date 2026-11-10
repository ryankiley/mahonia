// What this browser keeps for an account in localStorage, and how it lets go: by
// the one list of it (OWNED), all together on the way out of an account, and for
// good when a session was replaced with nobody here to see it leave.
import { beforeEach, describe, expect, it } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { OWNED, forgetOwned, ownedKey, sweepOwned } from "~/utils/sessionOwner";

const storage = stubLocalStorage();
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const everyKeyFor = (owner: string) => Object.values(OWNED).map((base) => ownedKey(base, owner)!);

// Not an account's, though it lives beside them: the lists this browser holds the
// edit links for. Losing it is losing the lists.
const UNOWNED = ["gear.mylists.v1", "gear.mode.v1", "gear.vault.tab.v1", "gear.intro.dismissed.v1"];

beforeEach(() => {
  storage.clear();
  for (const key of [...everyKeyFor(A), ...everyKeyFor(B), ...UNOWNED]) storage.set(key, "kept");
});

describe("forgetOwned — the way out of an account", () => {
  it("drops everything kept for that account and nothing else", () => {
    forgetOwned(A);

    for (const key of everyKeyFor(A)) expect(storage.has(key)).toBe(false);
    for (const key of [...everyKeyFor(B), ...UNOWNED]) expect(storage.has(key)).toBe(true);
  });

  it("covers every memo on the list, so a new one is forgotten without being named", () => {
    // the property the list exists for: nothing registered survives
    forgetOwned(A);
    forgetOwned(B);
    expect([...storage.keys()].sort()).toEqual([...UNOWNED].sort());
  });

  it("does nothing with no owner to forget", () => {
    forgetOwned(null);
    expect(storage.size).toBe(everyKeyFor(A).length * 2 + UNOWNED.length);
  });
});

describe("sweepOwned — what an earlier session left behind", () => {
  it("drops every other session's memos and keeps the current one's", () => {
    sweepOwned(A);

    for (const key of everyKeyFor(A)) expect(storage.has(key)).toBe(true);
    for (const key of everyKeyFor(B)) expect(storage.has(key)).toBe(false);
  });

  it("drops them all with nobody signed in", () => {
    sweepOwned(null);
    expect([...storage.keys()].sort()).toEqual([...UNOWNED].sort());
  });

  it("never touches a key that isn't an account's, however alike it looks", () => {
    // the registry of edit links, and near misses on the shape of an owned key
    const lookalikes = [
      `${OWNED.claimedMark}`, // the bare base
      `${OWNED.claimedMark}.NOT-A-MARKER`, // not shaped like a marker
      `${OWNED.claimedMark}x.${B}`, // another base that merely starts the same
      `gear.mylists.v1.${B}`, // marker-shaped tail on something unregistered
    ];
    for (const key of lookalikes) storage.set(key, "kept");

    sweepOwned(A);
    sweepOwned(null);

    for (const key of [...UNOWNED, ...lookalikes]) expect(storage.has(key)).toBe(true);
  });
});
