// @vitest-environment nuxt
//
// THE GROUP TICK in packing mode: a group's box is its children's, and a tick on it
// is theirs too (shared/packing). Driven through the real <ItemRow> because every
// claim here is about the mounted row's contract with those rules: that the box takes
// the native `indeterminate` property (a DOM property Vue has to bind as one, not an
// attribute), that a tick on the group dispatches one op per child through the
// reducer and the row re-renders from the result, and that the person-filter
// singleton the row otherwise ignores decides which children a tick may reach.
//
// The rules themselves are pure functions with their own plain-TS suite
// (packing.test.ts); this file mounts the wiring.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockNuxtImport, registerEndpoint } from "@nuxt/test-utils/runtime";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import ItemRow from "~/components/ItemRow.vue";
import { rowProvides } from "./helpers/itemRow";
import { groupItemsByParent } from "~~/shared/weights";
import { applyOps, type ItemPatch } from "~~/shared/ops";
import { sortedPeople } from "~~/shared/people";
import type { Item, ListSnapshot, Person } from "~~/shared/types";
import { blankList } from "./helpers/list";
import { gearListStub } from "./helpers/gearList";

registerEndpoint("/api/catalog/search", () => ({ results: [] }));

mockNuxtImport("useVaultAccess", () => () => ({
  hasVault: ref(false),
  vaultKnown: ref(true),
  vaultFetch: <T,>() => Promise.resolve({} as T),
}));

// The list as the editor holds it: a reactive snapshot the stub controller mutates
// through the REAL reducer, so a cascade re-renders the row from the state the app
// would actually have.
const snapshot = ref<ListSnapshot>(blankList());
// `dropWrites` stands in for the one way a press can leave the model unmoved: a
// collaborator removes a child between this row's render and the click, and applyOps
// no-ops on an id that is gone. Vue patches a prop only when its value CHANGES, so
// that is exactly the case where the browser's own write to the element is left
// standing — see the re-assert at the end of ItemRow's onTick.
let dropWrites = false;
mockNuxtImport("useGearList", () => () => gearListStub({
  snapshot,
  updateItem: (id: string, patch: ItemPatch) => {
    if (dropWrites) return;
    snapshot.value = applyOps(snapshot.value, [{ t: "updateItem", id, patch }]) as ListSnapshot;
  },
}));

const sam: Person = { id: "sam", name: "Sam", colorKey: "shelter", sortOrder: 0 };
const alex: Person = { id: "alex", name: "Alex", colorKey: "sleep", sortOrder: 1 };

const item = (over: Partial<Item> & { id: string }): Item => ({
  folderId: "f1",
  parentId: null,
  name: "",
  unitWeightMg: 0,
  qty: 1,
  classification: null,
  sortOrder: 0,
  ...over,
});
// Factories, not constants: a case writes `packed` onto the snapshot's items, and the
// snapshot holds these very objects, so a shared constant would carry one case's
// ticks into the next.
const bag = (over: Partial<Item> = {}) => item({ id: "bag", name: "Toiletry bag", ...over });
const paste = (over: Partial<Item> = {}) => item({ id: "paste", name: "Toothpaste", parentId: "bag", sortOrder: 0, ...over });
const brush = (over: Partial<Item> = {}) => item({ id: "brush", name: "Toothbrush", parentId: "bag", sortOrder: 1, ...over });
const towel = (over: Partial<Item> = {}) => item({ id: "towel", name: "Towel", parentId: "bag", sortOrder: 2, ...over });

// What GearEditor provides: the children map and the people tables, DERIVED from the
// live snapshot so the row reads its children through the same reactive objects the
// reducer writes. A map built from the fixtures' plain objects would leave the row
// reading flags the reducer never touched.
const childrenByParent = computed(() => groupItemsByParent(snapshot.value.items));
const peopleSorted = computed(() => sortedPeople(snapshot.value.people));
const peopleCtx = {
  sorted: peopleSorted,
  slotById: computed(() => new Map(peopleSorted.value.map((p, i) => [p.id, i]))),
};

function mountRow(items: Item[]) {
  snapshot.value = blankList({ people: [sam, alex], items });
  return mount(ItemRow, {
    props: {
      get list() {
        return snapshot.value;
      },
      get item() {
        return snapshot.value.items[0]!;
      },
    },
    global: { provide: rowProvides(childrenByParent, peopleCtx) },
    attachTo: document.body,
  });
}

type W = ReturnType<typeof mountRow>;
// The checklist faces in DOM order: the group's own label first, then one per child
// inside its nested block. Scoped by class because the edit face is mounted too; the
// latch below decides only which faces exist, and the mode CSS (absent here) which
// one shows.
const boxOf = (w: W, i: number) =>
  w.findAll(".item--check")[i]!.get("input.item__box").element as HTMLInputElement;
const groupBox = (w: W) => boxOf(w, 0);
const packed = (...ids: string[]) =>
  ids.map((id) => !!snapshot.value.items.find((i) => i.id === id)?.packed);

// Teardown that runs even when an assertion fails. Written as a trailing
// `w.unmount()` per case, a failure left the row attached to document.body and still
// subscribed to the shared `snapshot` ref — so the next case's mountRow re-rendered
// the orphan against ITS fixtures (the prop is a getter into `snapshot`), turning one
// real failure into a cascade of unrelated ones.
enableAutoUnmount(afterEach);

beforeEach(() => {
  // Mount the checklist face by setting the latch directly (personAssign does the
  // same); the mode itself so the row's handlers see packing too.
  const em = useEditorMode();
  em.mode.value = "pack";
  em.everPacked.value = true;
  usePersonFilter().clear();
  dropWrites = false;
});

describe("a group's box in packing mode", () => {
  it("reads its children, never its own flag: clear, then mixed, then checked", async () => {
    // the reported state: the group ticked on its own, everything under it still out
    const w = mountRow([bag({ packed: true }), paste(), brush(), towel()]);
    await nextTick();
    expect(groupBox(w).checked).toBe(false);
    expect(groupBox(w).indeterminate).toBe(false);
    expect(w.get(".item--check").classes()).not.toContain("item--done");

    snapshot.value.items[1]!.packed = true;
    await nextTick();
    expect(groupBox(w).checked).toBe(false);
    expect(groupBox(w).indeterminate).toBe(true);
    expect(w.get(".item--check").classes()).not.toContain("item--done");

    snapshot.value.items[2]!.packed = true;
    snapshot.value.items[3]!.packed = true;
    await nextTick();
    expect(groupBox(w).checked).toBe(true);
    expect(groupBox(w).indeterminate).toBe(false);
    expect(w.get(".item--check").classes()).toContain("item--done");
  });

  it("ticking it packs every child, and unticking it clears them", async () => {
    const w = mountRow([bag(), paste(), brush(), towel()]);
    await nextTick();
    await w.get(".item--check input.item__box").setValue(true);
    expect(packed("paste", "brush", "towel")).toEqual([true, true, true]);
    // the children's flags, not the group's own, which nothing on screen draws
    expect(snapshot.value.items[0]!.packed).toBeUndefined();
    expect(groupBox(w).checked).toBe(true);
    expect(groupBox(w).indeterminate).toBe(false);

    await w.get(".item--check input.item__box").setValue(false);
    expect(packed("paste", "brush", "towel")).toEqual([false, false, false]);
    expect(snapshot.value.items[0]!.packed).toBeUndefined();
    expect(groupBox(w).checked).toBe(false);
  });

  it("a mixed box ticks the rest, and a child's own box is still only its own", async () => {
    const w = mountRow([bag(), paste({ packed: true }), brush(), towel()]);
    await nextTick();
    expect(groupBox(w).indeterminate).toBe(true);
    await w.get(".item--check input.item__box").setValue(true);
    expect(packed("paste", "brush", "towel")).toEqual([true, true, true]);

    // untick one child through ITS box: the group goes back to mixed, the rest stay
    await w.findAll(".item--check")[2]!.get("input.item__box").setValue(false);
    expect(packed("paste", "brush", "towel")).toEqual([true, false, true]);
    expect(groupBox(w).checked).toBe(false);
    expect(groupBox(w).indeterminate).toBe(true);
  });
});

describe("under a person filter", () => {
  it("counts and writes only the children the filter shows, and re-reads on a flip", async () => {
    // Sam's group: the towel inherits him, the brush is Alex's own
    const w = mountRow([
      bag({ personId: "sam" }),
      paste({ personId: "sam" }),
      brush({ personId: "alex" }),
      towel(),
    ]);
    usePersonFilter().selected.value = "sam";
    await nextTick();
    await w.get(".item--check input.item__box").setValue(true);
    // Alex's brush is not on Sam's screen, so a tick on the group never reaches it
    expect(packed("paste", "brush", "towel")).toEqual([true, false, true]);
    // ...and the box reads checked: every row it stands for, in this view, is packed
    expect(groupBox(w).checked).toBe(true);
    expect(groupBox(w).indeterminate).toBe(false);

    // widen to everyone: the same group is now two of three, and the box says so
    usePersonFilter().clear();
    await nextTick();
    expect(groupBox(w).checked).toBe(false);
    expect(groupBox(w).indeterminate).toBe(true);
  });

  // A container the filter leaves holding nothing has no row to stand for, so its box
  // is disabled rather than falling back to its own flag. Written as a mounted case
  // because the whole failure was invisible in the data: the press wrote a flag that
  // looked fine until the filter widened and the tick was simply gone.
  it("disables a container's box when the filter hides every child, and writes nothing", async () => {
    const w = mountRow([
      bag({ personId: "sam" }),
      paste({ personId: "alex" }),
      brush({ personId: "alex" }),
    ]);
    usePersonFilter().selected.value = "sam";
    await nextTick();
    expect(groupBox(w).disabled).toBe(true);
    expect(groupBox(w).checked).toBe(false);
    expect(groupBox(w).indeterminate).toBe(false);

    // `disabled` is the guarantee: the browser fires no change from a press here, so
    // nothing is written — least of all the group's own flag, which no view would ever
    // draw again. Widened, the box comes back live over the two rows it now stands for.
    usePersonFilter().clear();
    await nextTick();
    expect(groupBox(w).disabled).toBe(false);
    expect(groupBox(w).checked).toBe(false);
    expect(snapshot.value.items[0]!.packed).toBeUndefined();
    expect(packed("paste", "brush")).toEqual([false, false]);
  });

  // The element and the model cannot drift apart. A press writes `checked` in the DOM
  // before the handler runs; if the model then doesn't move, Vue patches nothing, and
  // without the re-assert the box would sit there painting a full tick over a group
  // that is still half packed.
  it("puts the box back in step when the press writes nothing", async () => {
    const w = mountRow([bag(), paste({ packed: true }), brush()]);
    await nextTick();
    expect(groupBox(w).indeterminate).toBe(true);

    dropWrites = true;
    await w.get(".item--check input.item__box").setValue(true);
    expect(packed("paste", "brush")).toEqual([true, false]); // the write went nowhere
    expect(groupBox(w).checked).toBe(false); // ...and the box still says so
    expect(groupBox(w).indeterminate).toBe(true);
  });

  // ...whereas a group carrying gear of its own always has that line to stand for, so
  // it stays live under the same filter and its tick survives the widening.
  it("keeps a carrying group's own box live when its children are hidden", async () => {
    const w = mountRow([
      bag({ personId: "sam", unitWeightMg: 31_000 }),
      paste({ personId: "alex" }),
    ]);
    usePersonFilter().selected.value = "sam";
    await nextTick();
    expect(groupBox(w).disabled).toBe(false);
    await w.get(".item--check input.item__box").setValue(true);
    expect(snapshot.value.items[0]!.packed).toBe(true);

    // widened, the same tick reads as a partial one rather than disappearing
    usePersonFilter().clear();
    await nextTick();
    expect(groupBox(w).indeterminate).toBe(true);
  });
});
