// Canonical category color keys (map to `--cat-*` tokens in SCSS) and the
// starter folder set a brand-new list begins with. Folders are user-named and
// fully editable — these are just sensible defaults.

import type { Classification } from "./types";

export const CATEGORY_KEYS = [
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

export type CategoryKey = (typeof CATEGORY_KEYS)[number];

export interface FolderPreset {
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

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  base: "Base",
  worn: "Worn",
  consumable: "Consumable",
};
