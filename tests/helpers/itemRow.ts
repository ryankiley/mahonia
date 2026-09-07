// The injected context every <ItemRow> suite has to provide before the component will
// mount, and which six of them each carried a copy of.
//
// `gearListStub` (helpers/gearList) already did this for the controller; this is the
// other half. ItemRow reads both keys through `inject(...)!` with a non-null assertion,
// because in the app they always come from GearEditor — so a suite that forgets one gets
// a runtime throw rather than a type error, which is exactly the shape of thing worth
// having in one place.
//
// NOT the mount itself. The suites' `mountRow`s look alike but are not: some drive a
// reactive snapshot so a commit re-renders the row, one hands over a static list, and
// only two pass children. Folding those into one signature would mean a parameter per
// difference and a helper nobody could read. The costly duplication is this object,
// whose keys are symbols exported from the component under test.
import { isRef, ref, type Ref } from "vue";
import { CHILDREN_BY_PARENT, PEOPLE_CTX } from "../../app/components/ItemRow.vue";
import type { Item, Person } from "../../shared/types";

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
 */
export const rowProvides = (
  children: Map<string, Item[]> | Ref<Map<string, Item[]>> = new Map(),
  people: PeopleCtx = noPeople(),
) => ({
  [CHILDREN_BY_PARENT as symbol]: isRef(children) ? children : ref(children),
  [PEOPLE_CTX as symbol]: people,
});
