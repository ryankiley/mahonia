// Which of a list's three views you're in — lifted out of GearEditor so the row
// components can reach it WITHOUT it being a prop.
//
// That distinction is the whole point of this file. As a prop (`packed`), every mode
// switch re-rendered all ~150 ItemRows — each one diffing an ~80-node subtree to change,
// in the end, one thing: which of its two row faces is displayed. The switch is now
// CSS-driven (a data-mode attribute on the editor body; see atoms/item.scss), and the
// rows subscribe to nothing that changes per switch:
//
//   · event handlers (a blur guard, say) read `mode.value` at call time — handler reads
//     don't register reactive dependencies, so no row re-renders when mode flips;
//   · the two latches below are read in row templates, and each flips at most ONCE per
//     page life, so they cost one re-render ever, not one per switch.
//
// Module singleton, like useItemDnd and for the same reason: one editor, one mode.
// Client-only by nature (GearEditor is a .client component); the storage read is
// guarded anyway so importing this in a server context stays inert.

import { recall, remember } from "../utils/remember";
import { motionIsInstant } from "../plugins/inputModality.client";

export type EditorMode = "edit" | "pack" | "plan";
export const MODE_ORDER: EditorMode[] = ["edit", "pack", "plan"];
// Unlike the other gear.*.v1 preferences this one is genuinely new behaviour: mode used
// to reset on reload. Planning is somewhere you WORK across sittings, so it stays put.
const MODE_KEY = "gear.mode.v1";

// How long the switch's motion needs to have finished by: the whole sequence is fitted
// inside 300ms (atoms/modeswitch.scss — the arrivals land at 300, the slots settle at
// --mode-end, the entering row face fades on the fade token, which is shorter), plus a
// frame's grace. The clips, starting styles and row fades it gates belong to a switch
// in progress and nothing else.
const SWITCH_ANIM_MS = 320;

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const stored = (): EditorMode => {
    const m = recall(MODE_KEY) as EditorMode | null; // null in private mode / no storage
    return m && MODE_ORDER.includes(m) ? m : "edit";
  };
  const mode = ref<EditorMode>(import.meta.client ? stored() : "edit");
  watch(mode, (m) => remember(MODE_KEY, m));

  // Mount latches. Each row face mounts the first time its mode is entered and then
  // STAYS mounted, hidden by CSS in the other modes — so a switch stops tearing down
  // and rebuilding 150 subtrees, and a list opened straight into packing mode never
  // builds edit rows it hasn't shown. false → true exactly once, never back.
  // everPlan does the same for the whole plan panel: entering planning mounts it once
  // (keeping the panel lazy for the visits that never plan), and every later switch is
  // a CSS reveal — which is also what lets the route map keep its pan and zoom across
  // switches instead of being rebuilt from scratch each time.
  const everEdit = ref(mode.value === "edit");
  const everPacked = ref(mode.value === "pack");
  const everPlan = ref(mode.value === "plan");

  // True for a beat after each switch. The CSS fade (atoms/item.scss) is gated on this
  // so it plays exactly when the old <Transition> enter played — on a mode switch — and
  // not when a row APPEARS for any other reason (a newly added item, the latch's
  // first mount on initial load). switchedFrom is the mode being LEFT, for the same
  // beat: which faces fade depends on where the switch came from (Gear ↔ Packing
  // fades the rows; into or out of Trip the whole view crossfades and the rows don't).
  // A switch with no motion to run — made from the keyboard, or with reduced motion
  // on — raises no beat at all: nothing would play inside it, and the starting styles
  // it gates would only be there to undo.
  const switching = ref(false);
  const switchedFrom = ref<EditorMode | null>(null);
  let switchTimer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    switching.value = false;
    switchedFrom.value = null;
  };

  watch(mode, (m, prev) => {
    if (m === "edit") everEdit.value = true;
    else if (m === "pack") {
      everPacked.value = true;
      tally("packing_opened");
    } else if (m === "plan") {
      everPlan.value = true;
      tally("trip_opened");
    }
    clearTimeout(switchTimer);
    if (motionIsInstant()) return settle();
    switching.value = true;
    switchedFrom.value = prev;
    switchTimer = setTimeout(settle, SWITCH_ANIM_MS);
  });

  return { mode, everEdit, everPacked, everPlan, switching, switchedFrom };
}

export function useEditorMode() {
  // Built in a DETACHED scope: `watch` binds to whichever component is in setup at
  // the time, and the first caller is the editor of whatever list the page opened
  // on. Reopening another list (or a draft becoming a saved list, /e → /e/{code})
  // unmounts that editor and would take the latch watchers with it — the singleton
  // lived on with `mode` still moving but everPacked/switching frozen, so packing
  // mode showed "0 of N packed" over a folder with no rows in it.
  return (singleton ??= effectScope(true).run(create)!);
}
