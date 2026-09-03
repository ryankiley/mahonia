// Which person the editor is narrowed to — lifted out of GearEditor the way
// useEditorMode is, and for the same reason: the rows must be able to IGNORE it.
// The filter reaches them only as CSS (a data-filter-person attribute on the
// editor body matched against each row's own data-person; see atoms/item.scss),
// so flipping it re-renders none of the ~150 ItemRows. Only the top-level
// surfaces that genuinely change with it — the headline, the totals bar, the
// pack progress — subscribe to this ref.
//
// NOT persisted, unlike the mode: a filter is a way of looking at the list this
// sitting ("what's Sam carrying?"), not a standing preference — and the mode
// key is device-level, which would be the wrong scope anyway (the same person
// filter applied to a different list is meaningless). If per-list persistence
// is ever wanted it must be keyed by the list, not the device.
//
// Module singleton: one editor, one filter.

import type { Person } from "~~/shared/types";
import { UNASSIGNED, type PersonSelection } from "~~/shared/people";

let singleton: ReturnType<typeof create> | undefined;

function create() {
  // null = everyone (the default view); UNASSIGNED; or a person's id
  const selected = ref<PersonSelection>(null);

  const clear = () => (selected.value = null);

  /**
   * The person a NEW row should be stamped with so it appears inside the active
   * filter instead of materializing hidden: the selection, but only when it
   * names a real person in `people`. Everyone and Unassigned stamp nothing (a
   * plain add is unassigned, which is exactly what the Unassigned view shows),
   * and a stale id — the person was removed while filtered — stamps nothing
   * rather than something the reducer would immediately heal away.
   */
  const assignTarget = (people?: Person[]): string | undefined => {
    const s = selected.value;
    if (!s || s === UNASSIGNED) return undefined;
    return people?.some((p) => p.id === s) ? s : undefined;
  };

  return { selected, clear, assignTarget };
}

export function usePersonFilter() {
  return (singleton ??= create());
}
