// What this browser keeps for an account in localStorage, and how it lets go: by
// the one list of it (OWNED), all together on the way out of an account, and for
// good when a session was replaced with nobody here to see it leave.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubLocalStorage } from "./helpers/storage";
import { OWNED, forgetOwned, ownedKey, sweepOwned, sweepStaleOwned } from "~/utils/sessionOwner";

const storage = stubLocalStorage();
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";
const everyKeyFor = (owner: string) => Object.values(OWNED).map((base) => ownedKey(base, owner)!);

// Not an account's, though it lives beside them: the lists this browser holds the
// edit links for. Losing it is losing the lists.
// Every key of this kind the app writes is here by name, the nearest neighbours of
// the owned ones first: a base that grows a sibling later should fail HERE.
const UNOWNED = [
  "gear.mylists.v1",
  "gear.account.initial.v1", // beside gear.account.v1.<owner>
  "gear.vault.for.bF_UPp16unMFT6l7cJMylrxe1", // keyed by an edit token, beside gear.vault.copy.v1
  "gear.vault.not.bF_UPp16unMFT6l7cJMylrxe1",
  "gear.vault.for.deadbeefdeadbeef", // an edit token that happens to be all hex
  "gear.vault.width.v1",
  "gear.vault.tab.v1",
  "gear.claimed.v1", // the legacy, unowned generation of the three claimed keys
  "gear.claimed.rows.v1",
  "gear.claimed.opens.v1",
  "gear.mode.v1",
  "gear.intro.dismissed.v1",
];

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
      `${OWNED.claimedRows}.${B}.x`, // an owned key with something after its marker
      `${OWNED.account}.initial.v1`, // what a sibling of an owned base looks like
    ];
    for (const key of lookalikes) storage.set(key, "kept");

    sweepOwned(A);
    sweepOwned(null);

    for (const key of [...UNOWNED, ...lookalikes]) expect(storage.has(key)).toBe(true);
  });
});

// The one decision the startup sweep makes, and the one that could cost a signed-in
// person their offline data if it were ever simplified: whose turn is it?
describe("sweepStaleOwned — only when it is certain whose turn it is", () => {
  const setOwner = (value: string | null) =>
    (document.cookie = value === null ? "mh_session_owner=; Max-Age=0; path=/" : `mh_session_owner=${value}; path=/`);
  afterEach(() => setOwner(null));

  it("keeps the current session's memos and drops everyone else's", () => {
    setOwner(A);
    sweepStaleOwned(true);

    // what an offline start reads next: the account's lists and its copy of My Gear
    for (const key of everyKeyFor(A)) expect(storage.has(key)).toBe(true);
    for (const key of everyKeyFor(B)) expect(storage.has(key)).toBe(false);
  });

  it("drops them all when there is no session", () => {
    setOwner(null);
    sweepStaleOwned(false);
    expect([...storage.keys()].sort()).toEqual([...UNOWNED].sort());
  });

  it("touches nothing for a session whose marker isn't here right now", () => {
    // signed in (the hint says so) with no marker cookie: the server is about to
    // hand the same marker back, and A's memos are then that person's again
    setOwner(null);
    sweepStaleOwned(true);
    for (const key of [...everyKeyFor(A), ...everyKeyFor(B), ...UNOWNED]) expect(storage.has(key)).toBe(true);
  });

  it("does not take a marker that isn't one for an owner", () => {
    // a cookie anyone can edit: not marker-shaped means not an owner, and with the
    // hint present that is the case above, not "nobody is signed in"
    setOwner("NOT-A-MARKER");
    sweepStaleOwned(true);
    for (const key of [...everyKeyFor(A), ...everyKeyFor(B)]) expect(storage.has(key)).toBe(true);
  });
});

describe("with storage blocked", () => {
  it("sweeps and forgets nothing, and says nothing", () => {
    const blocked = () => {
      throw new DOMException("denied", "SecurityError");
    };
    vi.stubGlobal("localStorage", { key: blocked, removeItem: blocked, getItem: blocked, setItem: blocked, get length() { return blocked(); } });
    try {
      expect(() => sweepOwned(A)).not.toThrow();
      expect(() => sweepOwned(null)).not.toThrow();
      expect(() => forgetOwned(A)).not.toThrow();
    } finally {
      stubLocalStorage();
    }
  });
});
