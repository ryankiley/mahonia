// The vault pane's split-pane width bounds. They live here, not in VaultPane.vue,
// because two sides need them and only one of them may import the pane: the EDITOR
// owns and persists the value (it also insets its own column by it), while the pane
// is lazy — GearEditor importing it for a constant would pull the whole pane, and
// shared/vault behind it, into the editor's first-load chunk.
//
// Keep this file IMPORT-FREE for the same reason (see app/utils/site.ts).

/** Starting width, in px. 368 = 23rem. */
const VAULT_W_DEFAULT = 368;
const VAULT_W_MIN = 288;
const VAULT_W_MAX = 720;

/**
 * Hold a width inside the pane's usable range. Applied on the way IN as well as on
 * the way out of the divider drag, so a stale or hand-edited stored value can't
 * wedge the panel off-screen or squeeze it below a legible row.
 */
export function clampVaultWidth(n: number): number {
  return Math.min(VAULT_W_MAX, Math.max(VAULT_W_MIN, Math.round(n) || VAULT_W_DEFAULT));
}
