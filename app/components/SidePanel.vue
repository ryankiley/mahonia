<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon, Cancel01Icon, PanelLeftIcon } from "@hugeicons/core-free-icons";
import { editLinkPath } from "~~/shared/links";
import type { MyListEntry } from "~~/shared/types";

// The editor's one side panel: your lists and your gear vault, as two tabs of the
// same surface. They were two floating cards on opposite edges of the screen, which
// meant opening both left the list they flank about 600px on a 1280px laptop — two
// panels competing for the width of the thing they're both about. One panel, one
// edge, one width.
//
// ELEVATION IS THE OPEN STATE. Closed, this is nothing but its two buttons — no
// ground, no shadow, no edge, flush to the window's gutter so they line up with the
// toolbar's text above them, and only as tall as they are. Opening lifts it into the
// .popover surface the autocomplete and the menus wear, inset from the viewport as a
// floating card.
//
// THE VAULT TAB'S BODY IS LAZY and this shell is not, which is the whole reason
// they're separate components: the panel is on screen at first paint for anyone with
// a saved list, so folding VaultBrowser in would put the vault — and shared/vault
// behind it — on the editor's first load for everyone, including the majority who
// have no account.
//
// Classes are `sp__`, not `panel__`. `.panel` is already a shipped ATOM (a bordered
// --paper-2 card, atoms/controls.scss) and this component's root wearing that name
// silently inherited its border and ground — which is what put a card behind the
// collapsed strip that was supposed to have no surface at all.
const { open, tab, currentShareCode } = defineProps<{
  open: boolean;
  tab: "lists" | "vault";
  // The share code of the list being edited, so its row can mark itself. Comes from
  // the SNAPSHOT rather than the route: a draft minted this session has its URL
  // rewritten with replaceState and never routes, so route.hash is empty while the
  // list is very much saved and in the registry.
  currentShareCode: string | null;
}>();

const emit = defineEmits<{
  toggle: [];
  "new-list": [];
  "select-tab": [tab: "lists" | "vault"];
  added: [name: string];
}>();

// Width, owned by the editor (which insets its own column by it) and dragged from
// the divider below. Desktop only — on a phone this is a bottom sheet spanning the
// gutters and there is no width to negotiate.
const width = defineModel<number>("width", { required: true });

// Once loaded, the vault body STAYS mounted and is hidden with v-show rather than
// torn down: it fetches on mount, and remounting it per tab switch would re-request
// the whole vault every time you glanced back at your lists.
const vaultEverShown = ref(tab === "vault");
watch(
  () => tab,
  (t) => t === "vault" && (vaultEverShown.value = true),
);

// ---- resize ---------------------------------------------------------------
// A pointer drag on the divider. Deliberately NOT the shared createPointerDrag
// scaffold: that one exists to resolve a drop TARGET among the list's rows and
// commits on release. This has no target and no commit — it just tracks x — so
// borrowing it would mean stubbing out most of what it does (and paying for its
// elementFromPoint hit on every move).
//
// The width lands on an INHERITED custom property on the editor root, so each write
// restyles the whole editor subtree and reflows it. One write per frame is all that
// can be seen, so the moves coalesce through rAF instead of writing per event.
//
// The panel sits on the LEFT, so its width is the pointer's distance from the card's
// own left edge. Both figures are read ONCE, at grab time:
//
//  • `left` from the rendered card, not from the --space-4 token, so the sum can't go
//    stale if that inset is ever retuned.
//  • `grab` is how far the pointer was from the card's right edge when you took hold.
//    The handle rides in the GUTTER now, a few px clear of the panel, so without this
//    the edge would jump to sit under the cursor on the first move. Carrying the
//    offset means the card's edge keeps exactly the distance from your pointer that
//    it had when you grabbed it, wherever in the handle you grabbed.
// The width is ANIMATED, because collapsing and expanding should travel — but a drag
// is direct manipulation, and the same 200ms easing there means the edge is always
// easing toward where the cursor was rather than sitting under it. It reads as the
// panel lagging your hand. This flag turns the transition off for the length of the
// drag and hands it back on release, so the collapse keeps its motion and the resize
// keeps its grip.
const resizing = ref(false);

let endResize = () => {};
function startResize(ev: PointerEvent) {
  ev.preventDefault();
  (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
  resizing.value = true;
  const left = panelEl.value?.getBoundingClientRect().left ?? 16;
  const grab = ev.clientX - (left + width.value);
  let frame = 0;
  let pendingX = ev.clientX;
  const onMove = (e: PointerEvent) => {
    pendingX = e.clientX;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      width.value = clampPanelWidth(pendingX - left - grab);
    });
  };
  // named, so removeEventListener gets the SAME reference that was registered
  const stop = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    document.body.style.userSelect = "";
    resizing.value = false;
    endResize = () => {};
  };
  endResize = stop;
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}
// the divider is a real separator, so the arrow keys have to move it — a pointer
// drag can't be the only way to size a panel
function onResizeKey(ev: KeyboardEvent) {
  const step = ev.shiftKey ? 64 : 16;
  if (ev.key === "ArrowRight") width.value = clampPanelWidth(width.value + step);
  else if (ev.key === "ArrowLeft") width.value = clampPanelWidth(width.value - step);
  else return;
  ev.preventDefault();
}

// ---- the sheet answers the scroll that lands on it ------------------------
//
// On a phone this is a bottom sheet floating over the list, and a fixed box's scroll
// chain runs straight to the viewport — so a swipe that didn't reach a scroller fell
// THROUGH the sheet and scrolled the page instead. Swiping the header, the search
// row, or a list too short to scroll moved the list behind the panel, which reads as
// a hole in the page rather than a surface on it.
//
// `overscroll-behavior: contain` on the rows can't cover this on its own. It stops
// the chain at a scroller's ENDS — which is why swiping past the last row already
// stays put — but a gesture that never reached a scroller at all is not its
// business: the chrome above the rows, and a row list with nothing to scroll because
// the vault is empty or the filter left two matches.
//
// So the sheet decides for itself. A one-finger drag goes to the rows while they can
// still travel that way, and is swallowed otherwise; the page keeps its scroll
// position until you put a finger OUTSIDE the sheet, which is the half of it that
// already worked. Two fingers are left alone, so pinch-zoom over the sheet still
// zooms.
//
// The scroller is found by attribute rather than by ref: it belongs to whichever tab
// is showing, and one of those tabs is a lazily-loaded child.
const panelEl = useTemplateRef<HTMLElement>("panelEl");
let touchStartY = 0;

function onSheetTouchStart(ev: TouchEvent) {
  touchStartY = ev.touches[0]?.clientY ?? 0;
}

function onSheetTouchMove(ev: TouchEvent) {
  if (ev.touches.length !== 1) return; // a pinch, not a scroll
  const list = panelEl.value?.querySelector<HTMLElement>("[data-panel-scroller]");
  // Touch events retarget to wherever the gesture STARTED for its whole life, so
  // this stays true of a drag that has since wandered off the rows — which is what
  // a row being dragged out to a folder is.
  if (list && ev.target instanceof Node && list.contains(ev.target)) {
    // travel left in the direction the finger is going: up the screen (dy < 0)
    // scrolls toward the end of the list, down scrolls back toward its top
    const dy = (ev.touches[0]?.clientY ?? 0) - touchStartY;
    const room = dy < 0 ? list.scrollHeight - list.clientHeight - list.scrollTop : list.scrollTop;
    if (room > 0.5) return; // the rows can take it — leave the scroll to the browser
  }
  // Once the browser has committed to a scroll the move stops being cancellable.
  // The FIRST move of a gesture always is, and that's the one that decides.
  if (ev.cancelable) ev.preventDefault();
}

// the panel can go away mid-drag (a drop can land the editor in a state the parent
// tears down), so the resize loop is stopped here rather than only on its own
// pointerup — otherwise its window listeners outlive the component
onBeforeUnmount(() => endResize());

// Escape belongs to the VAULT tab, which is the floating layer the gesture is a
// convention for — and on a phone this panel IS that layer and nothing else.
// Deliberately not extended to the lists tab: collapsing the nav you're navigating
// with is not what Escape means.
onKeyStroke("Escape", () => {
  if (open && tab === "vault") emit("toggle");
});

// ---- your lists -----------------------------------------------------------
const my = useMyLists();
// BY NAME, and deliberately not by most-recently-opened the way /mine sorts.
//
// Recency ordering here had a nasty tell: the controller touches an entry's
// lastOpened on its first sync, so clicking the fourth row navigated and then, a
// beat later, hoisted that row to the top — the list reshuffling under the cursor at
// the moment you committed to a click. A switcher whose rows move is one you stop
// trusting, and you end up reading every row every time instead of reaching.
//
// The two surfaces sort differently because they do different jobs. /mine is a
// management view that SHOWS you "2 hours ago", so recency there is data you can see
// and act on, and you leave the page rather than clicking within it. This is a
// switcher, where a row's position is muscle memory and stability is worth more than
// freshness. Alphabetical gets that without inventing hidden state — no frozen
// ordering to explain, nothing that can disagree with the registry.
//
// Numeric collation so "Trip 2" comes before "Trip 10" rather than after it.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const lists = computed(() =>
  [...my.entries.value].sort((a, b) => collator.compare(savedListTitle(a.title), savedListTitle(b.title))),
);

const editPath = (e: MyListEntry) => editLinkPath(e.shareCode, e.editToken);
// Guarded on the prop being set, not just equal: an unsaved draft has no share code
// and neither does a legacy entry, and "" === "" would light up a row at random.
const isCurrent = (e: MyListEntry) => !!currentShareCode && e.shareCode === currentShareCode;

const TABS = [
  { key: "lists", label: "Your lists" },
  { key: "vault", label: "Gear vault" },
] as const;
</script>

<template>
  <!-- touchmove takes NO .passive modifier: preventDefault is the whole point of it
       (see onSheetTouchMove), and the passive-by-default intervention covers only
       window/document/body, so a bare listener here can still cancel.
       `popover` is bound, not fixed — the card's surface belongs to the open state
       only (see the styles). -->
  <aside
    ref="panelEl"
    class="sp"
    :class="{ popover: open, 'sp--open': open, 'is-resizing': resizing }"
    :aria-label="open ? undefined : 'Your lists'"
    @touchstart.passive="onSheetTouchStart"
    @touchmove="onSheetTouchMove"
  >
    <!-- the split divider. Desktop + open only (CSS); on a phone the sheet spans the
         gutters and there is nothing to drag. -->
    <div
      v-if="open"
      class="sp__resize"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      aria-label="Resize the panel"
      :aria-valuenow="width"
      :aria-valuemin="288"
      :aria-valuemax="720"
      title="Drag to resize"
      @pointerdown="startResize"
      @keydown="onResizeKey"
    />

    <div class="sp__head">
      <!-- Two tabs, and deliberately NOT the filled chip the vault's own
           Items/Categories pair wears: these switch what the panel IS, that pair
           filters what's inside it, and giving both the same treatment made the two
           rows read as one flat set of four. Type carries this one. -->
      <div v-if="open" class="sp__tabs" role="tablist" aria-label="Side panel">
        <button
          v-for="t in TABS"
          :key="t.key"
          type="button"
          role="tab"
          class="sp__tab"
          :class="{ 'is-active': tab === t.key }"
          :aria-selected="tab === t.key"
          @click="emit('select-tab', t.key)"
        >{{ t.label }}</button>
      </div>
      <!-- the phone's sheet shows the vault and nothing else, so it gets a plain
           title where the tabs would be, and a close where the collapse is -->
      <h2 v-if="open" class="t-label sp__title">Gear vault</h2>

      <!-- makes a LIST, so it's shown with the lists. In the collapsed strip it
           stays: that strip is the nav at rest, and starting a list is what you'd
           reach into it for. -->
      <!-- Beside the button when the panel is a strip, under it when the panel is
           open. Collapsed, the two buttons are STACKED in a 48px column, so a tooltip
           below the top one lands on the one under it and reads as describing that
           instead. Open, the head is a normal horizontal row and below is right. -->
      <Tooltip
        v-if="!open || tab === 'lists'"
        text="New list"
        :preferred-placement="open ? 'bottom' : 'right'"
        class="sp__tip"
      >
        <button
          type="button"
          class="btn btn--icon btn--ghost sp__btn"
          aria-label="New list"
          @click="emit('new-list')"
        >
          <HugeiconsIcon :icon="Add01Icon" :size="16" :stroke-width="2" />
        </button>
      </Tooltip>
      <!-- the ordering class goes on the TOOLTIP, not the button: <Tooltip> wraps its
           slot in an inline-flex trigger, so that wrapper — not the control inside it
           — is what the head lays out. -->
      <Tooltip
        :text="open ? 'Hide the panel' : 'Your lists'"
        :preferred-placement="open ? 'bottom' : 'right'"
        class="sp__tip sp__toggletip"
      >
        <button
          type="button"
          class="btn btn--icon btn--ghost sp__btn"
          :aria-label="open ? 'Hide the panel' : 'Show your lists'"
          :aria-expanded="open"
          @click="emit('toggle')"
        >
          <HugeiconsIcon :icon="PanelLeftIcon" :size="16" :stroke-width="2" />
        </button>
      </Tooltip>
      <!-- phone only: the sheet's dismiss -->
      <button
        type="button"
        class="btn btn--icon btn--ghost sp__close"
        aria-label="Close the gear vault"
        title="Close"
        @click="emit('toggle')"
      >
        <HugeiconsIcon :icon="Cancel01Icon" :size="16" :stroke-width="2" />
      </button>
    </div>

    <template v-if="open">
      <!-- YOUR LISTS. Desktop only — a phone opens this panel for the vault and has
           /mine for its lists, laid out for the width it actually has.
           No delete or remove here either: /mine owns the destructive pair, where a
           confirm dialog has room to explain the difference between forgetting a
           list and deleting it for everyone. -->
      <div v-show="tab === 'lists'" class="sp__lists">
        <ul v-if="lists.length" data-panel-scroller class="sp__list">
          <li v-for="e in lists" :key="e.editToken">
            <!-- Just the name — the weight lives on the list itself, and beside a
                 name it competed with the one thing you scan a nav for.
                 The native title, not the site's <Tooltip>: this exists to
                 un-truncate a clipped name, which is the one job the browser's own
                 does well, and forty rows would mean forty tooltip triggers, each
                 with listeners and a teleport, describing text already on screen. -->
            <NuxtLink
              :to="editPath(e)"
              class="sp__row"
              :class="{ 'is-current': isCurrent(e) }"
              :aria-current="isCurrent(e) ? 'page' : undefined"
              :title="savedListTitle(e.title)"
            >{{ savedListTitle(e.title) }}</NuxtLink>
          </li>
        </ul>
        <p v-else class="t-sm sp__empty">Lists you make on this device are kept here.</p>
      </div>

      <!-- THE GEAR VAULT. Mounted on the first visit to its tab and kept mounted
           after (v-show), so switching back to your lists doesn't throw the loaded
           vault away and re-fetch it on the next glance. -->
      <LazyVaultBrowser
        v-if="vaultEverShown"
        v-show="tab === 'vault'"
        @added="(name: string) => emit('added', name)"
      />
    </template>
  </aside>
</template>

<style scoped lang="scss">
/* Closed: flush to the window's left gutter and un-elevated, so its two buttons sit
   on the same 16px the toolbar's text above them does — the panel at rest is a pair
   of controls on the page, not a surface.
   Open: the .popover card (lifted ground, --radius-4, soft shadow, forced-colors
   edge), inset from the viewport. --popover-item-radius and --popover-hover come
   with it and are inherited by the rows here AND by the vault body's rows, which is
   what keeps the two tabs looking like one panel. */
.sp {
  position: fixed;
  /* Clear of the editor's sticky topbar, which MEASURES 61px (space-3 padding-block
     either side of a 28px mode toggle, plus its hairline) — 48px overlapped it by
     13. Expressed as grid steps rather than a magic 72px so it stays on the same
     4/8 rhythm as everything else. */
  top: calc(var(--space-7) + var(--space-5));
  left: 0;
  width: var(--panel-w-min);
  z-index: var(--z-float);
  display: flex;
  flex-direction: column;
  /* Inline padding only in the open card — the vertical breathing room lives inside
     the scroller, so the last row travels all the way to the card's edge instead of
     stopping short at a padding ledge and reading as cut off. Collapsed, the block
     padding is what centres the buttons in the strip. */
  padding: var(--space-2);
  /* clip the full-bleed rows (and the scrollbar's extremes) to the radius */
  overflow: hidden;
  /* The panel travels, the page doesn't: the editor's inset SNAPS between its two
     widths while this animates across. Animating the shell's padding instead would
     relayout every row in the list for the duration. The surface properties ride
     along on the same curve, so the card doesn't appear in one frame under a panel
     that's still growing. */
  transition:
    width var(--dur) var(--ease),
    left var(--dur) var(--ease),
    background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease),
    border-radius var(--dur) var(--ease);
}
.sp--open {
  left: var(--space-4);
  bottom: var(--space-4);
  width: var(--panel-w);
}
/* Mid-drag the width must land in the SAME frame the pointer moved — see `resizing`
   in the script. Easing here is right for the collapse and wrong for direct
   manipulation, where it reads as the edge lagging your hand. */
.sp.is-resizing {
  transition: none;
}
/* The divider sits in the GUTTER, between the card and the page — it resizes the
   space the two share, so it belongs to the seam rather than to either side. It was
   on the panel's own right edge, which put it inside the card's `overflow: hidden`
   and clipped half the hit area away.
   `fixed`, not `absolute`, is what gets it out of that clip: the card is a stacking
   context but NOT a containing block for fixed positioning (no transform, filter or
   contain on it), so a fixed child escapes the overflow while still being able to sit
   against the card's edge. Its left tracks --panel-w, so it follows a drag it is
   itself driving.
   It INKS on hover/focus rather than sitting there as a visible bar — a permanent
   handle would be chrome in a gutter that's otherwise empty. */
.sp__resize {
  position: fixed;
  top: calc(var(--space-7) + var(--space-5));
  bottom: var(--space-4);
  /* centred in the --space-4 gutter: past the card's own inset and its width, then
     half a gutter more */
  left: calc(var(--space-4) + var(--panel-w) + var(--space-2));
  width: 9px;
  transform: translateX(-50%);
  cursor: col-resize;
  touch-action: none;
  background: transparent;
}
/* A short pill at the vertical middle rather than a full-height rule: this marks the
   one spot you grab and nothing else. */
.sp__resize::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 3px;
  height: 28px;
  transform: translate(-50%, -50%);
  border-radius: var(--radius-pill);
  background: var(--ink-3);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.sp__resize:hover::after,
.sp__resize:focus-visible::after {
  opacity: 1;
}
.sp__resize:focus-visible {
  outline: none;
}

.sp__head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
}
/* Collapsed: the same buttons, stacked, with the toggle lifted above the + — it's
   the control you're reaching for in this state. */
.sp:not(.sp--open) .sp__head {
  flex-direction: column;
  align-items: stretch;
  margin-bottom: 0;
}
.sp:not(.sp--open) .sp__toggletip {
  order: -1;
}
.sp__tabs {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: var(--space-3);
  /* the rows carry their own --space-2 inline padding; the tabs take the same inset
     so the labels sit on the same left edge as the names under them */
  padding-inline: var(--space-2);
}
.sp__tab {
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--ink-3);
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.sp__tab:hover {
  color: var(--ink-2);
}
.sp__tab.is-active {
  color: var(--ink);
}
.sp__btn {
  flex: none;
  color: var(--ink-2);
}
.sp__tip {
  flex: none;
}
/* the phone-only pieces of the head, off on desktop */
.sp__title,
.sp__close {
  display: none;
}

.sp__lists {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1 1 auto;
}
.sp__list {
  list-style: none;
  /* its own scroller, so forty lists don't outgrow the card and the page behind
     keeps its scroll position while you look for one */
  flex: 1 1 auto;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* One line of type, and nothing else — so the eye runs down a column of names. A
   block (not a flex row): text-overflow needs a block box to clip in, and with one
   line there's nothing to lay out. */
.sp__row {
  display: block;
  padding: var(--space-1) var(--space-2);
  /* the concentric corner the .popover surface hands down, so a row's curve is
     pinned to the card holding it rather than picked independently */
  border-radius: var(--popover-item-radius);
  line-height: var(--leading-normal);
  color: var(--ink-2);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
/* --popover-hover, not a flat grey: on the card's lifted --surface-float ground that
   barely registered, and this is the tint every other row on a popover surface (the
   vault's, the menus') already uses */
.sp__row:hover {
  background: var(--popover-hover);
  color: var(--ink);
}
/* The list you're in: full ink on the quiet grey ground the vault's own tabs and the
   row toggles use, so "this is the selected one" reads the same everywhere in the
   app. No accent — the chrome is monochrome; only the data viz carries colour. */
.sp__row.is-current {
  background: var(--paper-3);
  color: var(--ink);
}
.sp__empty {
  padding-inline: var(--space-2);
  color: var(--ink-3);
}
/* A touch laptop or an iPad in landscape is wide enough to take this panel, and the
   rows are the smallest thing in it. Padding rather than a min-height, so the single
   line stays optically centred: --space-3 either side of a 24px line is 48px, clear
   of the --tap floor. (The icon buttons grow themselves — .btn--icon has its own
   coarse rule — which is what --panel-w-min widens for.) */
@media (pointer: coarse) {
  .sp__row {
    padding-block: var(--space-3);
  }
  /* a coarse pointer on a wide screen needs the panel lower — the topbar's own
     controls grow to --tap there, so the bar itself is taller. The divider is
     positioned against the viewport, not the card, so it has to follow by hand. */
  .sp,
  .sp__resize {
    top: calc(var(--space-7) + var(--space-6));
  }
}

/* Phone: a bottom sheet instead of a side column — a 23rem panel floating over a
   375px screen would cover the list it's meant to sit beside. Capped at half the
   viewport so the rows you're adding to stay visible above it.
   There is no collapsed state here and no lists tab: the sheet is the gear vault,
   opened from the toolbar and dismissed with its close button, and /mine is the
   phone's answer to "my lists". */
@media (max-width: $bp-full) {
  .sp {
    /* The sheet's height, declared ONCE and used twice: as this panel's ceiling,
       and — inherited — as VaultBrowser's floor on its own body. Between them they
       pin the height exactly, so typing into the search can't resize the surface
       under your thumb, while the short signed-out explainer still sizes to itself
       (it never takes the floor, so only the ceiling applies). */
    --sheet-h: min(27.5rem, 55dvh);

    top: auto;
    right: var(--space-3);
    bottom: var(--space-3);
    left: var(--space-3);
    width: auto;
    max-height: var(--sheet-h);
    transition: none;
  }
  /* closed means GONE on a phone — there's no strip to leave behind */
  .sp:not(.sp--open) {
    display: none;
  }
  .sp__resize,
  .sp__tabs,
  .sp__lists,
  .sp__tip {
    display: none;
  }
  .sp__title {
    display: block;
    flex: 1;
    min-width: 0;
    color: var(--ink);
    padding-inline: var(--space-2);
  }
  .sp__close {
    display: inline-flex;
    flex: none;
    color: var(--ink-2);
  }
}
</style>
