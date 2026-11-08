import { Backpack02Icon, CookieIcon, ShirtIcon } from "@hugeicons/core-free-icons";
import type { IconNode } from "./hugeicon";
import type { Classification } from "~~/shared/types";

// What each class wears where you CHOOSE one (My Gear's Show filter, the edit dialog's
// picker): the pack for base, and the two marks the rows already carry for the other
// two, the worn shirt and the consumable cookie.
//
// Its own module, not a line in itemMarks.ts: that one is the editor rows' and sits in
// the editor's first load, so a table exported from it rides along with every list
// opened, backpack and all, for two pickers that live on /gear.
export const CLASS_ICONS: Record<Classification, IconNode> = {
  base: Backpack02Icon,
  worn: ShirtIcon,
  consumable: CookieIcon,
};
