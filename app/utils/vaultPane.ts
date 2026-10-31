// The vault pane's split-pane width bounds. They live here, not in VaultPane.vue,
// because two sides need them and only one of them may import the pane: the EDITOR
// owns and persists the value (it also insets its own column by it), while the pane
// is lazy — GearEditor importing it for a constant would pull the whole pane, and
// shared/vault behind it, into the editor's first-load chunk.
//
// Keep this file IMPORT-FREE for the same reason (see app/utils/site.ts).

/**
 * The one sentence that stands where My Gear would be for someone without an account —
 * the pane's empty state and the /gear page both ask it, and answering the same question
 * in two voices is how a product starts sounding like two products. The "but" does the
 * work: it names the trade-off without a second sentence, and the Sign in button under
 * it says what to do about it.
 */
export const VAULT_ASK = "Your gear is one pick away on every list, but it needs an account.";

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
