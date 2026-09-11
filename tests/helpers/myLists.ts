// One device-registry row, for the suites that seed useMyLists. The field list lives
// here and nowhere else, so a column added to MyListEntry reaches every test through
// one default instead of a literal per file — four files had each grown a factory of
// their own, with four different signatures, before it lived here. A suite whose
// subject needs different defaults layers them in a one-line wrapper.

import type { MyListEntry } from "../../shared/types";

/** A registry row this browser made; `editToken` is the one field every test picks. */
export function listEntry(over: Partial<MyListEntry> & { editToken: string }): MyListEntry {
  return {
    origin: "created",
    shareCode: "C0DE00000001",
    slug: "trip-aa11bb",
    title: "Trip",
    totalMg: 0,
    version: 1,
    lastOpened: 1,
    displayUnit: "g",
    ...over,
  };
}
