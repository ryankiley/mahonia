// Canonical category color keys (map to `--cat-*` tokens in SCSS) and the
// starter folder set a brand-new list begins with. Folders are user-named and
// fully editable — these are just sensible defaults.

import type { Classification } from "./types";

const CATEGORY_KEYS = [
  "shelter",
  "sleep",
  "pack",
  "kitchen",
  "water",
  "clothing",
  "electronics",
  "firstaid",
  "worn",
  "consumable",
  "other",
] as const;

type CategoryKey = (typeof CATEGORY_KEYS)[number];

interface FolderPreset {
  name: string;
  colorKey: CategoryKey;
  defaultClassification: Classification;
}

// A calm, minimal starter set — just the Big 3 so a new list isn't empty but
// isn't a wall of folders either. Everything's user-named + editable; "+ Add
// folder" covers the rest (On Body → worn, Food & Fuel → consumable, etc.).
export const STARTER_FOLDERS: FolderPreset[] = [
  { name: "Shelter", colorKey: "shelter", defaultClassification: "base" },
  { name: "Sleep", colorKey: "sleep", defaultClassification: "base" },
  { name: "Pack", colorKey: "pack", defaultClassification: "base" },
];

// Assignable hues, ordered so consecutive picks sit far apart on the colour wheel
// (green→pink→blue→orange→…) — adjacent folders read as clearly distinct. Grey
// "other" is the neutral fallback, never auto-assigned.
const FOLDER_PALETTE = [
  "shelter", // green 132
  "sleep", // pink 350
  "water", // blue 232
  "pack", // orange 50
  "clothing", // violet 300
  "consumable", // teal 175
  "firstaid", // red 22
  "electronics", // indigo 266
  "worn", // yellow 95
  "kitchen", // magenta 328
] as const satisfies readonly CategoryKey[];

// The hue angle (OKLCH) behind each named token — used both to space out the
// procedural overflow colours and to render them. Keep in sync with the
// `--cat-*` tokens in tokens.scss.
const CATEGORY_HUE: Record<CategoryKey, number> = {
  shelter: 132,
  sleep: 350,
  water: 232,
  pack: 50,
  clothing: 300,
  consumable: 175,
  firstaid: 22,
  electronics: 266,
  worn: 95,
  kitchen: 328,
  other: 250,
};

// A procedural overflow key looks like "h247" — a bare OKLCH hue angle. These are
// minted once the curated palette is exhausted, so a list can hold any number of
// folders and still get a distinct colour for each.
const HUE_KEY = /^h(\d{1,3})$/;

function hueOf(colorKey: string): number | null {
  if (colorKey in CATEGORY_HUE) return CATEGORY_HUE[colorKey as CategoryKey];
  const m = HUE_KEY.exec(colorKey);
  return m ? Number(m[1]) % 360 : null;
}

// Pick a colour for a new folder that contrasts with the ones already in the list:
// the first curated hue not yet used, or — once all ten are taken — a fresh hue
// dropped into the widest empty arc of the colour wheel, so colours stay distinct
// no matter how many folders the list grows to (never repeating, never going grey).
export function nextFolderColor(used: readonly string[]): string {
  const unused = FOLDER_PALETTE.find((k) => !used.includes(k));
  if (unused) return unused;
  const hues = used
    .map(hueOf)
    .filter((h): h is number => h !== null)
    .sort((a, b) => a - b);
  if (!hues.length) return FOLDER_PALETTE[0];
  // find the largest gap between consecutive used hues (wrapping past 360) and
  // place the new hue at its midpoint
  let bestGap = -1;
  let bestHue = (hues[0]! + 180) % 360;
  for (let i = 0; i < hues.length; i++) {
    const a = hues[i]!;
    const b = i + 1 < hues.length ? hues[i + 1]! : hues[0]! + 360;
    const gap = b - a;
    if (gap > bestGap) {
      bestGap = gap;
      bestHue = (a + gap / 2) % 360;
    }
  }
  return `h${Math.round(bestHue)}`;
}

// Resolve a folder's stored colorKey to a CSS colour for the data-viz. Named keys
// use their curated, theme-aware token; procedural "h<deg>" overflow keys render a
// generated OKLCH hue (light/dark tuned to match the token palette's feel);
// anything unrecognised falls back to the neutral grey.
export function categoryColor(colorKey: string): string {
  const m = HUE_KEY.exec(colorKey);
  if (m) {
    const h = Number(m[1]) % 360;
    return `light-dark(oklch(0.6 0.19 ${h}), oklch(0.74 0.21 ${h}))`;
  }
  // Anything else is interpolated into a CSS value, so gate it to a safe charset:
  // an unrestricted key (e.g. `x,url(//evil)`) would smuggle a real CSS token
  // (an outbound `url()` fetch = a viewer-tracking beacon) into a shared list.
  // Belt-and-suspenders with the colorKey clamp in shared/ops — this also guards
  // any value already persisted before that clamp existed.
  return /^[a-z0-9-]+$/.test(colorKey) ? `var(--cat-${colorKey}, var(--cat-other))` : "var(--cat-other)";
}
