import { IconBubbleQuestion, IconCircleInfo, IconLaw } from "../icons/central";
import type { IconNode } from "./icon";

// The three pages about the SITE, for a surface that has no footer to carry them: the
// editor's ⋯ menu and My Gear's. One table, so the two menus can't name or order them
// differently; the pages that keep a footer read SiteFooter's own row.
//
// Help is a question in a BUBBLE, not in a circle: About's mark is the "i" in a circle,
// and two ringed glyphs one row apart read as the same icon twice. Neighbouring rows
// take different outlines so the shape tells them apart before the character inside does.
export const SITE_LINKS: readonly { to: string; label: string; icon: IconNode }[] = [
  { to: "/help", label: "Help", icon: IconBubbleQuestion },
  { to: "/about", label: "About", icon: IconCircleInfo },
  { to: "/legal", label: "Legal", icon: IconLaw },
];
