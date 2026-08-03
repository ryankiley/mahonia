// The editor side panel's width bounds. They live here, not in SidePanel.vue,
// because two sides need them: the EDITOR owns and persists the value (it also
// insets its own column by it), and the panel's divider drags it.
//
// Keep this file IMPORT-FREE (see app/utils/site.ts).

/** Starting width, in px. 368 = 23rem. */
export const PANEL_W_DEFAULT = 368;
const PANEL_W_MIN = 288;
const PANEL_W_MAX = 720;

/**
 * Hold a width inside the panel's usable range. Applied on the way IN as well as on
 * the way out of the divider drag, so a stale or hand-edited stored value can't
 * wedge the panel off-screen or squeeze it below a legible row.
 */
export function clampPanelWidth(n: number): number {
  return Math.min(PANEL_W_MAX, Math.max(PANEL_W_MIN, Math.round(n) || PANEL_W_DEFAULT));
}
