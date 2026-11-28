// The list the list-header suites mount ListHead over: Timberline, with a share code
// and slug set, and whatever a suite is about layered through `over`.

import type { ListSnapshot } from "../../shared/types";
import { snapshotFor } from "./list";

export const headSnapshot = (over: Partial<ListSnapshot> = {}): ListSnapshot => ({
  ...snapshotFor({ shareCode: "SNAPCODE0001", slug: "test-list-aaa111", title: "Timberline" }),
  ...over,
});
