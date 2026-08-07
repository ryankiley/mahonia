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

export type EditorMode = "edit" | "pack" | "plan";
export const MODE_ORDER: EditorMode[] = ["edit", "pack", "plan"];
// Unlike the other gear.*.v1 preferences this one is genuinely new behaviour: mode used
// to reset on reload. Planning is somewhere you WORK across sittings, so it stays put.
const MODE_KEY = "gear.mode.v1";

// How long the entering row's fade needs to have finished by — comfortably past the
// animation's calc(var(--dur) * 0.9); see `switching` below.
const SWITCH_ANIM_MS = 250;

let singleton: ReturnType<typeof create> | undefined;

function create() {
  const stored = (): EditorMode => {
    try {
      const m = localStorage.getItem(MODE_KEY) as EditorMode | null;
      return m && MODE_ORDER.includes(m) ? m : "edit";
    } catch {
      return "edit"; // private mode / no storage
    }
  };
  const mode = ref<EditorMode>(import.meta.client ? stored() : "edit");
  watch(mode, (m) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* a write can throw on quota or in private mode; the preference just doesn't stick */
    }
  });

  // Mount latches. Each row face mounts the first time its mode is entered and then
  // STAYS mounted, hidden by CSS in the other modes — so a switch stops tearing down
  // and rebuilding 150 subtrees, and a list opened straight into packing mode never
  // builds edit rows it hasn't shown. false → true exactly once, never back.
  const everEdit = ref(mode.value === "edit");
  const everPacked = ref(mode.value === "pack");

  // True for a beat after each switch. The CSS fade (atoms/item.scss) is gated on this
  // so it plays exactly when the old <Transition> enter played — on a mode switch — and
  // not when a row APPEARS for any other reason (a newly added item, the latch's
  // first mount on initial load).
  const switching = ref(false);
  let switchTimer: ReturnType<typeof setTimeout> | undefined;

  watch(mode, (m) => {
    if (m === "edit") everEdit.value = true;
    else if (m === "pack") everPacked.value = true;
    switching.value = true;
    clearTimeout(switchTimer);
    switchTimer = setTimeout(() => (switching.value = false), SWITCH_ANIM_MS);
  });

  return { mode, everEdit, everPacked, switching };
}

export function useEditorMode() {
  return (singleton ??= create());
}
