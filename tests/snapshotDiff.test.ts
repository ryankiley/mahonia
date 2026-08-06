import { describe, it, expect } from "vitest";
import { diffListState, applyListDiff, stateToFullSnap, fullSnapToState, reconstructChainAt, type FullSnap, type ListDiff } from "../shared/snapshotDiff";
import type { Folder, Item, ListState } from "../shared/types";

// content-only, order-insensitive equality (storage array order isn't load-bearing —
// render sorts by sortOrder). Reconstruction must reproduce the target by id + fields.
function byId<T extends { id: string }>(arr: T[]) {
  return [...arr].sort((a, b) => a.id.localeCompare(b.id));
}
function expectSameState(got: ListState, want: ListState) {
  expect(got.title).toBe(want.title);
  expect(got.description ?? "").toBe(want.description ?? "");
  expect(got.displayUnit).toBe(want.displayUnit);
  expect(byId(got.folders)).toEqual(byId(want.folders));
  expect(byId(got.items)).toEqual(byId(want.items));
}
const roundTrips = (base: ListState, target: ListState) =>
  expectSameState(applyListDiff(base, diffListState(base, target)), target);

const folder = (id: string, over: Partial<Folder> = {}): Folder => ({
  id, name: "F" + id, colorKey: "shelter", defaultClassification: "base", sortOrder: 0, ...over,
});
const item = (id: string, over: Partial<Item> = {}): Item => ({
  id, folderId: null, name: "I" + id, unitWeightMg: 100, weightOverridden: false, qty: 1,
  classification: null, sortOrder: 0, ...over,
});
const state = (over: Partial<ListState> = {}): ListState => ({
  title: "Untitled list", description: "", displayUnit: "g", folders: [], items: [], version: 1, ...over,
});

describe("snapshot diff/apply round-trips", () => {
  it("empty diff for identical states", () => {
    const s = state({ folders: [folder("a")], items: [item("x", { folderId: "a" })] });
    expect(diffListState(s, structuredClone(s))).toEqual({});
    roundTrips(s, structuredClone(s));
  });

  it("add / remove / change items", () => {
    const base = state({ items: [item("x"), item("y")] });
    roundTrips(base, state({ items: [item("x"), item("z")] })); // remove y, add z
    roundTrips(base, state({ items: [item("x", { name: "renamed", qty: 4 }), item("y")] })); // change x
    roundTrips(base, state({ items: [] })); // remove all
  });

  it("add / remove / change folders (folder removal drops nothing it shouldn't)", () => {
    const base = state({ folders: [folder("a"), folder("b")], items: [item("x", { folderId: "a" })] });
    roundTrips(base, state({ folders: [folder("a")], items: [item("x", { folderId: "a" })] })); // del folder b
    roundTrips(base, state({ folders: [folder("a", { name: "Shelter!" }), folder("b")], items: [item("x", { folderId: "a" })] }));
  });

  it("clears optional fields losslessly (the op-reducer can't, the entity diff can)", () => {
    const base = state({ items: [item("x", { description: "note", brand: "Zpacks", catalogItemId: 7 })] });
    const target = state({ items: [item("x")] }); // brand/description/catalogItemId all gone
    roundTrips(base, target);
    // the reconstructed item must NOT carry the stale fields
    const got = applyListDiff(base, diffListState(base, target));
    expect(got.items[0].brand).toBeUndefined();
    expect(got.items[0].description).toBeUndefined();
    expect(got.items[0].catalogItemId).toBeUndefined();
  });

  it("meta changes", () => {
    const base = state({ title: "Trip", description: "d", displayUnit: "g" });
    roundTrips(base, state({ title: "New", description: "d", displayUnit: "lb" }));
    roundTrips(base, state({ title: "Trip", description: "", displayUnit: "g" })); // clear description
  });

  it("the diff is genuinely smaller when few entities changed", () => {
    const items = Array.from({ length: 50 }, (_, i) => item("i" + i, { name: "Item " + i }));
    const base = state({ items });
    const target = state({ items: items.map((it, i) => (i === 3 ? { ...it, qty: 9 } : it)) });
    const diff = diffListState(base, target);
    expect(diff.itemsUpsert?.length).toBe(1); // only the one changed item
    expect(JSON.stringify(diff).length).toBeLessThan(JSON.stringify(target).length / 5);
    roundTrips(base, target);
  });

  it("randomized round-trips", () => {
    const rnd = (seed: number) => { let s = seed; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };
    const r = rnd(42);
    for (let n = 0; n < 200; n++) {
      const mk = () => {
        const fs = Array.from({ length: Math.floor(r() * 4) }, (_, i) => folder("f" + Math.floor(r() * 5), { name: "n" + Math.floor(r() * 9), sortOrder: Math.floor(r() * 5) }));
        const fids = [...new Set(fs.map((f) => f.id))];
        const folders = fids.map((id) => fs.find((f) => f.id === id)!);
        const items = Array.from({ length: Math.floor(r() * 8) }, () => {
          const id = "it" + Math.floor(r() * 10);
          const o: Partial<Item> = { name: "x" + Math.floor(r() * 9), qty: Math.floor(r() * 5) + 1, unitWeightMg: Math.floor(r() * 9000), sortOrder: Math.floor(r() * 9) };
          if (r() > 0.6) o.folderId = folders.length ? folders[Math.floor(r() * folders.length)].id : null;
          if (r() > 0.7) o.description = "d" + Math.floor(r() * 5);
          if (r() > 0.8) o.brand = "b" + Math.floor(r() * 5);
          return item(id, o);
        });
        const iids = [...new Set(items.map((i) => i.id))];
        return state({ title: "t" + Math.floor(r() * 5), description: r() > 0.5 ? "d" + Math.floor(r() * 5) : "", displayUnit: (["g", "kg", "oz", "lb"] as const)[Math.floor(r() * 4)], folders, items: iids.map((id) => items.find((i) => i.id === id)!) });
      };
      roundTrips(mk(), mk());
    }
  });
});

describe("reverse-delta chain (capture + reconstruct + prune)", () => {
  type Row = { kind: "base" | "diff"; snapshot: FullSnap | ListDiff; _ref: ListState };
  // simulate captureSnapshot's reverse chain: newest is full, prev-newest is converted
  // to a reverse-delta against the new state. Returns chain NEWEST→OLDEST.
  function buildChain(states: ListState[]): Row[] {
    const chain: Row[] = [];
    for (const s of states) {
      if (chain.length && chain[0].kind === "base") {
        const prev = fullSnapToState(chain[0].snapshot as FullSnap);
        chain[0] = { kind: "diff", snapshot: diffListState(s, prev), _ref: prev };
      }
      chain.unshift({ kind: "base", snapshot: stateToFullSnap(s), _ref: s });
    }
    return chain;
  }
  function expectSame(got: ListState | null, want: ListState) {
    expect(got).not.toBeNull();
    expect(got!.title).toBe(want.title);
    expect(got!.displayUnit).toBe(want.displayUnit);
    expect([...got!.folders].sort((a,b)=>a.id.localeCompare(b.id))).toEqual([...want.folders].sort((a,b)=>a.id.localeCompare(b.id)));
    expect([...got!.items].sort((a,b)=>a.id.localeCompare(b.id))).toEqual([...want.items].sort((a,b)=>a.id.localeCompare(b.id)));
  }
  const f = (id: string, o: Partial<Folder> = {}): Folder => ({ id, name: "F"+id, colorKey: "shelter", defaultClassification: "base", sortOrder: 0, ...o });
  const i = (id: string, o: Partial<Item> = {}): Item => ({ id, folderId: null, name: "I"+id, unitWeightMg: 1, weightOverridden: false, qty: 1, classification: null, sortOrder: 0, ...o });
  const st = (o: Partial<ListState> = {}): ListState => ({ title: "t", description: "", displayUnit: "g", folders: [], items: [], version: 1, ...o });

  it("every snapshot in the chain reconstructs to its original state", () => {
    const states = [
      st({ folders: [f("a")], items: [i("x", { folderId: "a" })] }),
      st({ folders: [f("a")], items: [i("x", { folderId: "a", qty: 3 }), i("y")] }),
      st({ title: "renamed", folders: [f("a"), f("b")], items: [i("x", { folderId: "b" }), i("y", { name: "Y!" })] }),
      st({ folders: [f("b")], items: [i("y")], displayUnit: "lb" }), // dropped folder a + item x
    ];
    const chain = buildChain(states);
    expect(chain[0].kind).toBe("base"); // newest is always the full anchor
    expect(chain.filter(r => r.kind === "base").length).toBe(1); // exactly one full
    for (let k = 0; k < chain.length; k++) expectSame(reconstructChainAt(chain, k), chain[k]._ref);
  });

  it("still reconstructs every retained point after pruning to a cap", () => {
    const states = Array.from({ length: 9 }, (_, n) => st({ title: "v"+n, items: Array.from({ length: n+1 }, (_, j) => i("it"+j, { qty: n+1 })) }));
    const chain = buildChain(states).slice(0, 5); // prune: keep 5 newest
    expect(chain[0].kind).toBe("base");
    for (let k = 0; k < chain.length; k++) expectSame(reconstructChainAt(chain, k), chain[k]._ref);
  });

  // captureSnapshot's two writes (insert new base, demote old base → diff) are not
  // in a transaction, so a capture can be interrupted between them. It inserts
  // FIRST precisely so the half-applied state is an extra base rather than none —
  // this pins that the extra base is genuinely harmless.
  it("reconstructs every point when an interrupted capture left a stray extra base", () => {
    const states = [
      st({ folders: [f("a")], items: [i("x", { folderId: "a" })] }),
      st({ folders: [f("a")], items: [i("x", { folderId: "a", qty: 3 }), i("y")] }),
      st({ title: "renamed", folders: [f("a"), f("b")], items: [i("y", { name: "Y!" })] }),
      st({ folders: [f("b")], items: [i("y"), i("z")], displayUnit: "lb" }),
    ];
    // build normally up to the last step, then append the newest WITHOUT demoting
    // the previous anchor — exactly what a crash between the insert and the update
    // leaves behind.
    const chain = buildChain(states.slice(0, 3));
    chain.unshift({ kind: "base", snapshot: stateToFullSnap(states[3]!), _ref: states[3]! });

    expect(chain.filter((r) => r.kind === "base").length).toBe(2); // the stray
    // a base resets the fold, so every retained point — including the ones behind
    // the un-demoted anchor — still reconstructs to exactly its original state
    for (let k = 0; k < chain.length; k++) expectSame(reconstructChainAt(chain, k), chain[k]._ref);
  });

  // The failure mode the insert-first ordering exists to prevent: demote-then-insert,
  // interrupted, leaves a chain whose newest row is a diff with no anchor.
  it("returns null (never wrong state) for an anchorless chain", () => {
    const chain = buildChain([st({ items: [i("x")] }), st({ items: [i("x"), i("y")] })]);
    chain.shift(); // drop the base — what a failed insert after a demote would leave
    expect(chain[0]!.kind).toBe("diff");
    expect(reconstructChainAt(chain, 0)).toBeNull();
  });
});

describe("the route's shape survives the snapshot chain", () => {
  // Regression, and the same one the dates had a year of tests for: the chain carried
  // only the trail's URL/label/distance, so restoring ANY recovery point reconstructed a
  // state with no profile — and the restore write then put NULL over the live columns.
  //
  // Worse than the dates, because a GPX profile is the one field on a list the owner
  // cannot retype. Losing it means finding the original file again, and the "before
  // restore" snapshot can't help: it has the identical hole.
  const gpx = { trailProfile: "1000,1200,1100,1400", trailAscentM: 500, trailDescentM: 400 };

  it("round-trips through the full-snapshot form", () => {
    const back = fullSnapToState(stateToFullSnap(state(gpx)));
    expect(back.trailProfile).toBe("1000,1200,1100,1400");
    expect(back.trailAscentM).toBe(500);
    expect(back.trailDescentM).toBe(400);
  });

  it("leaves a list with no GPX alone (undefined, never an empty string or a zero)", () => {
    const back = fullSnapToState(stateToFullSnap(state()));
    expect(back.trailProfile).toBeUndefined();
    expect(back.trailAscentM).toBeUndefined();
    expect(back.trailDescentM).toBeUndefined();
  });

  it("records a GPX that was ADDED between base and target", () => {
    const diff = diffListState(state(), state(gpx));
    expect(diff.meta?.trailProfile).toBe("1000,1200,1100,1400");
    expect(diff.meta?.trailAscentM).toBe(500);
    expect(applyListDiff(state(), diff).trailProfile).toBe("1000,1200,1100,1400");
  });

  it("records a GPX that was REMOVED, rather than resurrecting it", () => {
    // the falsy sentinels: "" for the profile, 0 for the heights
    const diff = diffListState(state(gpx), state());
    expect(diff.meta?.trailProfile).toBe("");
    expect(diff.meta?.trailAscentM).toBe(0);
    const out = applyListDiff(state(gpx), diff);
    expect("trailProfile" in out).toBe(false);
    expect("trailAscentM" in out).toBe(false);
  });
});

describe("trip dates survive the snapshot chain", () => {
  // Regression: the chain carried only title/description/displayUnit/trail*, so
  // restoring ANY recovery point reconstructed a state with no dates — and the
  // restore write then put NULL over the live columns. Silent, unrecoverable loss
  // of a field the user had set.
  it("round-trips through the full-snapshot form", () => {
    const s = state({ startDate: "2026-08-04", endDate: "2026-08-10" });
    const back = fullSnapToState(stateToFullSnap(s));
    expect(back.startDate).toBe("2026-08-04");
    expect(back.endDate).toBe("2026-08-10");
  });

  it("leaves a dateless list dateless (undefined, never an empty string)", () => {
    const back = fullSnapToState(stateToFullSnap(state()));
    expect(back.startDate).toBeUndefined();
    expect(back.endDate).toBeUndefined();
  });

  it("records a date that was ADDED between base and target", () => {
    const diff = diffListState(state(), state({ startDate: "2026-08-04" }));
    expect(diff.meta?.startDate).toBe("2026-08-04");
    expect(applyListDiff(state(), diff).startDate).toBe("2026-08-04");
  });

  it("records a date that was REMOVED, so a restore can't resurrect it", () => {
    const diff = diffListState(state({ startDate: "2026-08-04" }), state());
    expect(diff.meta?.startDate).toBe(""); // the clear sentinel
    const applied = applyListDiff(state({ startDate: "2026-08-04" }), diff);
    expect(applied.startDate).toBeUndefined(); // the KEY is dropped, not blanked
  });

  it("says nothing about dates that didn't change", () => {
    const a = state({ startDate: "2026-08-04", endDate: "2026-08-10" });
    const diff = diffListState(a, state({ startDate: "2026-08-04", endDate: "2026-08-10", title: "Renamed" }));
    expect(diff.meta?.startDate).toBeUndefined();
    expect(diff.meta?.endDate).toBeUndefined();
    expect(diff.meta?.title).toBe("Renamed");
  });
});
