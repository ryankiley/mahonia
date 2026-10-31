// What every <ItemRow> suite needs before the component will mount: the injected
// context GearEditor provides to every row, and the mount itself over a reactive
// snapshot.
//
// `gearListStub` (helpers/gearList) already did this for the controller; `rowProvides`
// is the other half. ItemRow reads its keys through `inject(...)!` with a non-null
// assertion, because in the app they always come from GearEditor — so a suite that
// forgets one gets a runtime throw rather than a type error, which is exactly the
// shape of thing worth having in one place.
//
// `mountRowOver` is the mount. An earlier version of this header argued AGAINST
// folding the suites' `mountRow`s together — they looked alike but differed in what
// they passed. They have since converged: twelve files held the same fourteen lines
// (set the snapshot, mount with getter props that read it back, provide, attach to
// body), differing only in the items, the provides and the odd list field — three
// arguments. The one that still differs in kind, itemPaste's mount over the LIVE
// controller's snapshot, keeps its own.
import { isRef, ref, type Ref } from "vue";
import { mount } from "@vue/test-utils";
import ItemRow, { CHILDREN_BY_PARENT, PEOPLE_CTX, VARIANT_SHOWN } from "../../app/components/ItemRow.vue";
import { useEditorMode } from "../../app/composables/useEditorMode";
import type { Item, ListSnapshot, Person } from "../../shared/types";
import { blankList } from "./list";

/** What ItemRow injects for the people table: the sorted list, and each id's colour slot. */
export type PeopleCtx = { sorted: unknown; slotById: unknown };

/** Nobody on the list — the state five of the six suites want, since they are not about
 *  carriers and a row with no people renders no assignment control at all. */
export const noPeople = (): PeopleCtx => ({ sorted: ref<Person[]>([]), slotById: ref(new Map<string, number>()) });

/**
 * `provide` for a mounted ItemRow. Pass the row's children when the suite is about a
 * group; the default empty map is what a leaf row's suite wants. Pass `people` only when
 * the suite is ABOUT carriers — personAssign hands over a live table whose people it
 * mutates between cases, which is the one thing here that cannot be a constant.
 *
 * `children` takes a REF as readily as a plain Map, because the two kinds of suite here
 * genuinely differ: most hand over a fixed set of children and want the wrapping done
 * for them, while a suite whose rows change under the reducer (itemPacking ticks a child
 * and expects its parent's box to follow) has to pass the same live computed GearEditor
 * provides, or the row reads a snapshot of children the reducer never touches.
 *
 * `variantShown` is the third table GearEditor provides (the rows whose variant sits
 * beside the name, shared/variantShown); empty by default, since only the suite about
 * variants cares which rows are in it.
 */
export const rowProvides = (
  children: Map<string, Item[]> | Ref<Map<string, Item[]>> = new Map(),
  people: PeopleCtx = noPeople(),
  variantShown: ReadonlySet<string> | Ref<ReadonlySet<string>> = new Set<string>(),
) => ({
  [CHILDREN_BY_PARENT as symbol]: isRef(children) ? children : ref(children),
  [PEOPLE_CTX as symbol]: people,
  [VARIANT_SHOWN as symbol]: isRef(variantShown) ? variantShown : ref(variantShown),
});

/**
 * Mount the row at `items[0]` over the suite's reactive snapshot. The snapshot is
 * REPLACED with a blank list holding `items` (plus whatever `over` adds — a people
 * table, a pounds display unit), and both props are getters into it, so a commit the
 * stub controller runs through the reducer re-renders the row the way the live editor
 * would. Attached to document.body, because focus and popovers need a document.
 *
 * `items` is taken as given: a suite that must not let the reducer touch its fixture
 * passes a copy (`[{ ...row }]`), exactly as it did when it held this mount itself.
 */
export function mountRowOver(
  snapshot: Ref<ListSnapshot>,
  items: Item[],
  provides: ReturnType<typeof rowProvides> = rowProvides(),
  over: Partial<ListSnapshot> = {},
) {
  snapshot.value = blankList({ ...over, items });
  return mount(ItemRow, {
    props: {
      get list() {
        return snapshot.value;
      },
      get item() {
        return snapshot.value.items[0]!;
      },
    },
    global: { provide: provides },
    attachTo: document.body,
  });
}

/** Enter packing mode and latch the checklist face in: ItemRow mounts that face only
 *  once packing has ever been entered (useEditorMode), and the mode itself is set so
 *  the row's handlers see packing too. */
export function showChecklistFace(): void {
  const em = useEditorMode();
  em.mode.value = "pack";
  em.everPacked.value = true;
}
