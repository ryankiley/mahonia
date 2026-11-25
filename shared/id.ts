// Client-generated unique id. Folders, items, and CSV-imported rows mint their
// own ids so optimistic edits need no server round-trip. Prefers crypto.randomUUID
// (every modern browser + Node); the Math.random fallback only matters in
// ancient/non-crypto environments. Single source — keep all callers on this.

export const uid = (): string =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
