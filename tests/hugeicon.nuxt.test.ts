// @vitest-environment nuxt
//
// The local <HugeiconsIcon> (app/utils/hugeicon.ts) exists only to render what
// @hugeicons/vue renders, cheaply. That makes "identical markup" its entire contract,
// and a contract worth pinning: the swap touches every icon on every surface, so a
// silent drift — an attribute dropped, a stroke width resolved differently, a class
// landing somewhere new — would show up as a visual regression across the whole app
// rather than as a failing feature.
//
// So this asserts the strong form: for EVERY icon the app imports, at EVERY size and
// stroke-width combination it uses, the two components produce the same HTML string —
// attribute order included. Not a spot check.
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { HugeiconsIcon as Upstream } from "@hugeicons/vue";
import {
  Add01Icon, ArrowExpand02Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowShrink02Icon,
  ArrowUpRight01Icon, Backpack02Icon, CalculateIcon, Calendar03Icon,
  Cancel01Icon, CheckIcon, CheckmarkSquare02Icon, ChevronDownIcon, CircleEllipsisIcon, CommandIcon,
  CircleXIcon, CookieIcon, Copy01Icon, Delete02Icon, DropletIcon, Edit02Icon,
  EllipsisIcon, FileExportIcon, FileImportIcon, Fire02Icon, FolderIcon, GlobeIcon,
  GripVerticalIcon, HelpCircleIcon, Message01Icon, RemoveCircleIcon,
  Key01Icon, LayerAddIcon, ListIndentDecreaseIcon, ListIndentIncreaseIcon, ListPlusIcon, Location01Icon,
  NodeAddIcon, NoteAddIcon, RacingFlagIcon, Refresh01Icon, Route02Icon, RouteIcon,
  SafeBoxIcon, Share08Icon, ShirtIcon, SortingAZ01Icon, SortingNineOneIcon,
  SortingOneNineIcon, SquareIcon, Stairs01Icon, TentIcon, Undo02Icon, UserCircleIcon,
  UserLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon as Local } from "~/utils/hugeicon";

// Every icon the app imports. Named rather than globbed off the package: the free set
// runs to thousands of glyphs, and mounting all of them twice per combination exhausts
// the worker's heap. Keep this in step with the app's imports — `grep -rho
// 'from "@hugeicons/core-free-icons"' -B..` or just the import lists in app/.
const ALL_ICONS = Object.entries({
  Add01Icon, ArrowExpand02Icon, ArrowLeft01Icon, ArrowRight01Icon, ArrowShrink02Icon,
  ArrowUpRight01Icon, Backpack02Icon, CalculateIcon, Calendar03Icon,
  Cancel01Icon, CheckIcon, CheckmarkSquare02Icon, ChevronDownIcon, CircleEllipsisIcon, CommandIcon,
  CircleXIcon, CookieIcon, Copy01Icon, Delete02Icon, DropletIcon, Edit02Icon,
  EllipsisIcon, FileExportIcon, FileImportIcon, Fire02Icon, FolderIcon, GlobeIcon,
  GripVerticalIcon, HelpCircleIcon, Message01Icon, RemoveCircleIcon,
  Key01Icon, LayerAddIcon, ListIndentDecreaseIcon, ListIndentIncreaseIcon, ListPlusIcon, Location01Icon,
  NodeAddIcon, NoteAddIcon, RacingFlagIcon, Refresh01Icon, Route02Icon, RouteIcon,
  SafeBoxIcon, Share08Icon, ShirtIcon, SortingAZ01Icon, SortingNineOneIcon,
  SortingOneNineIcon, SquareIcon, Stairs01Icon, TentIcon, Undo02Icon, UserCircleIcon,
  UserLock01Icon,
}) as [string, never][];

// The prop combinations the app actually draws with (see the call sites), plus the
// bare-defaults case and the absolute-stroke-width variant the checkbox glyphs use.
const COMBOS: Record<string, unknown>[] = [
  {},
  { size: 12, strokeWidth: 2 },
  { size: 14, strokeWidth: 2 },
  { size: 14, strokeWidth: 1.75 },
  { size: 14, strokeWidth: 2.25 },
  { size: 16, strokeWidth: 2 },
  { size: 16, strokeWidth: 1.5 },
  { size: 16, strokeWidth: 2.25 },
  { size: 20, strokeWidth: 2 },
  { size: 20, strokeWidth: 1.33, absoluteStrokeWidth: true },
  { size: "16", strokeWidth: 2 },
];

describe("local HugeiconsIcon renders identically to @hugeicons/vue", () => {
  it("covers a meaningful number of icons", () => {
    expect(ALL_ICONS.length).toBeGreaterThan(40);
  });

  for (const combo of COMBOS) {
    it(`matches upstream for every icon at ${JSON.stringify(combo)}`, () => {
      const mismatches: string[] = [];
      for (const [name, icon] of ALL_ICONS) {
        const props = { icon, ...combo };
        const a = mount(Upstream, { props }).html();
        const b = mount(Local, { props }).html();
        if (a !== b) mismatches.push(`${name}\n  upstream: ${a}\n  local:    ${b}`);
      }
      expect(mismatches.join("\n\n")).toBe("");
    });
  }

  // Fall-through attrs land on the <svg> rather than being dropped or wrapped — the
  // app leans on this for `class`, `aria-hidden` and the scoped-style marker.
  it("passes class and aria-hidden through to the svg the same way", () => {
    const props = { icon: SquareIcon as never, size: 16, strokeWidth: 2 };
    const attrs = { class: "item__boxicon is-on", "aria-hidden": "true", "data-x": "1" };
    expect(mount(Local, { props, attrs }).html()).toBe(
      mount(Upstream, { props, attrs }).html(),
    );
  });

  // altIcon/showAlt are unused today but part of the surface being replaced; a future
  // call site reaching for them must not silently get the wrong glyph.
  it("honours altIcon/showAlt like upstream", () => {
    const base = { icon: SquareIcon as never, altIcon: TentIcon as never, size: 16, strokeWidth: 2 };
    for (const showAlt of [false, true]) {
      const props = { ...base, showAlt };
      expect(mount(Local, { props }).html()).toBe(mount(Upstream, { props }).html());
    }
  });

  // The cache is keyed on (icon, resolved stroke width); two sizes of one icon must not
  // collide, and a repeat render must not be served a mutated object.
  it("keeps distinct stroke widths and repeat renders independent", () => {
    const icon = Delete02Icon as never;
    const first = mount(Local, { props: { icon, size: 16, strokeWidth: 2 } }).html();
    const other = mount(Local, { props: { icon, size: 16, strokeWidth: 1.5 } }).html();
    const again = mount(Local, { props: { icon, size: 16, strokeWidth: 2 } }).html();
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(other).toBe(mount(Upstream, { props: { icon, size: 16, strokeWidth: 1.5 } }).html());
  });
});
