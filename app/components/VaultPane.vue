<script setup lang="ts">
import { Check, Plus, X } from "@lucide/vue";
import type { VaultEntry } from "~~/shared/vault";
import { vaultNormKey } from "~~/shared/vault";
import { formatWeight, itemDisplayName } from "~~/shared/weights";

// The vault, alongside the list you're building — a floating palette you keep open
// and pick from, rather than typing each item's name into the autocomplete one at a
// time. The autocomplete is still the fast path when you know what you want; this
// is for the "what do I own?" pass at the start of a list.
//
// Deliberately NON-MODAL: no backdrop, no focus trap, and the list stays fully
// interactive underneath. Packing is a back-and-forth (add a thing, look at what
// the total did, add another), and a modal would make you close and reopen for
// every glance. Escape closes it, since that's what a floating layer should honour.
//
// Rendered via <LazyVaultPane v-if>, so this component AND the shared vault module
// it imports are a separate chunk — someone who never opens the pane never
// downloads it, which is what keeps it off the editor's bundle budget.
const emit = defineEmits<{ close: [] }>();

// Split-pane width, owned by the editor (which also needs it, to inset the list out
// from under the pane) and adjusted from the divider below. Desktop only — on a
// phone the pane is a bottom sheet and there is no width to negotiate.
const width = defineModel<number>("width", { required: true });

// A pointer drag on the divider. Deliberately NOT the shared createPointerDrag
// scaffold: that one exists to resolve a drop TARGET among the list's rows and
// commits on release. This has no target and no commit — it just tracks x — so
// borrowing it would mean stubbing out most of what it does (and paying for its
// elementFromPoint hit on every move).
//
// The width lands on an INHERITED custom property on the editor root, so each write
// restyles the whole editor subtree and reflows it. One write per frame is all that
// can be seen, so the moves coalesce through rAF instead of writing per event.
let endResize = () => {};
function startResize(ev: PointerEvent) {
  ev.preventDefault();
  (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
  // the viewport can't change mid-drag, so read it once rather than forcing layout
  // on every move
  const vw = window.innerWidth;
  let frame = 0;
  let pendingX = ev.clientX;
  const onMove = (e: PointerEvent) => {
    pendingX = e.clientX;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      width.value = clampVaultWidth(vw - pendingX);
    });
  };
  // named, so removeEventListener gets the SAME reference that was registered
  const stop = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    document.body.style.userSelect = "";
    endResize = () => {};
  };
  endResize = stop;
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
}
// the divider is a real separator, so the arrow keys have to move it — a pointer
// drag can't be the only way to size a pane
function onResizeKey(ev: KeyboardEvent) {
  const step = ev.shiftKey ? 64 : 16;
  if (ev.key === "ArrowLeft") width.value = clampVaultWidth(width.value + step);
  else if (ev.key === "ArrowRight") width.value = clampVaultWidth(width.value - step);
  else return;
  ev.preventDefault();
}

const c = useGearList();
const dnd = useItemDnd();
const { hasVault, vaultFetch } = useVaultToken();

const items = ref<VaultEntry[]>([]);
const loading = ref(true);
const loadError = ref("");
const query = ref("");
const searchEl = useTemplateRef<HTMLInputElement>("searchEl");

// Where an added item lands. Defaults to the first folder and remembers your
// choice while the pane is open — adding six things to "Cook kit" shouldn't mean
// re-picking the folder six times.
const folders = computed(() => [...(c.snapshot.value?.folders ?? [])].sort((a, b) => a.sortOrder - b.sortOrder));
const targetFolderId = ref<string | null>(null);
watchEffect(() => {
  const list = folders.value;
  if (!list.length) {
    targetFolderId.value = null;
    return;
  }
  // keep the current pick if it still exists (a folder can be renamed or removed
  // underneath us while the pane is open)
  if (!list.some((f) => f.id === targetFolderId.value)) targetFolderId.value = list[0]!.id;
});

const unit = computed(() => c.snapshot.value?.displayUnit ?? "g");

async function load() {
  if (!hasVault.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  loadError.value = "";
  try {
    const res = await vaultFetch<{ items: VaultEntry[] }>("/api/vault/list");
    items.value = res.items || [];
  } catch {
    loadError.value = "Couldn’t load your vault.";
  }
  loading.value = false;
}
onMounted(() => {
  load();
  // focus the search: the pane is opened to find something, and the keyboard
  // should already be where you'd type. Non-modal, so this is the only focus move
  // it makes — tabbing out to the list is left alone.
  nextTick(() => searchEl.value?.focus());
});
watch(hasVault, () => load());

// Plain substring filter over the already-loaded set — no request per keystroke.
// Literal rather than fuzzy on purpose: you're scanning a list you can see, and a
// ranked reshuffle under your eyes is disorienting. Fuzzy belongs in the
// autocomplete, where the list isn't visible until you type.
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter((i) =>
    `${i.brand ?? ""} ${i.name} ${i.variant ?? ""} ${i.commonName ?? ""}`.toLowerCase().includes(q),
  );
});

// The gear the open list already holds, keyed by the SAME identity rule the vault
// uses — so "Zpacks Duplex" in the list matches the vault row whatever the spacing
// or case. Recomputed from the live snapshot, so it updates the moment something is
// added (here or by typing).
const inList = computed(() => {
  const keys = new Set<string>();
  for (const item of c.snapshot.value?.items ?? []) {
    const key = vaultNormKey(item.brand, item.name, item.variant);
    if (key) keys.add(key);
  }
  return keys;
});
// Gear the list already holds can't be added again — the row goes to an "Already
// added" state instead. Wanting two of something is a QUANTITY, which the list row
// owns (its "1 ×" field); a second identical row would split one thing's weight
// across two lines and read as an oversight.
const isInList = (entry: VaultEntry) => inList.value.has(entry.normKey);

// Grab a row ANYWHERE to drag it into a folder — no handle. The row is also a click
// target (quick-add to the "Add to" folder), so the two gestures have to be told
// apart, and they are told apart differently by input type:
//
//  • mouse/pen — by DISTANCE. A press that travels past a few pixels was a drag; one
//    that doesn't was a click. There's nothing else a horizontal mouse press means.
//  • touch — by TIME first. A finger that moves is almost always scrolling this list,
//    so distance alone would hijack every swipe. A short hold arms the drag; a swipe
//    that starts before the hold elapses is left to the browser as a scroll (which
//    then cancels the press outright).
//
// Deliberately not `touch-action: none` on the rows for the same reason: the list
// has 100+ entries and scrolling it must stay the default reading of a swipe.
const DRAG_THRESHOLD = 5;
const TOUCH_HOLD_MS = 250;
// One object for the gesture in flight. `armedAt` is the timestamp the drag becomes
// available from — 0 for a mouse (immediately), now + the hold for a finger — which
// is the whole hold rule as a comparison at move time, with no timer to run or clear.
let press: { x: number; y: number; pointerId: number; armedAt: number; entry: VaultEntry } | null = null;
// the entry whose press turned into a drag, so the click that follows pointerup is
// swallowed instead of adding the thing a second time
let draggedEntryId: number | null = null;

function endPress() {
  press = null;
  window.removeEventListener("pointermove", onPressMove);
  window.removeEventListener("pointerup", endPress);
  window.removeEventListener("pointercancel", endPress);
}

function onPressMove(ev: PointerEvent) {
  if (!press || ev.pointerId !== press.pointerId) return;
  if (Math.hypot(ev.clientX - press.x, ev.clientY - press.y) < DRAG_THRESHOLD) return;
  // moved before the hold elapsed → this is a scroll, not a drag; stand down
  if (ev.timeStamp < press.armedAt) return endPress();
  const entry = press.entry;
  endPress();
  draggedEntryId = entry.id;
  // the pane owns what a drop MEANS — it creates the row and enforces its own
  // one-per-list rule; the gesture only resolves where the pointer let go
  dnd.startInsert((folderId, beforeId) => {
    if (isInList(entry)) return;
    const id = c.addVaultItem(entry, folderId);
    if (id && beforeId) c.moveItem(id, folderId, beforeId, null);
  }, ev);
}

function onRowPointerDown(entry: VaultEntry, ev: PointerEvent) {
  if (ev.button !== 0 || isInList(entry)) return;
  endPress();
  press = {
    x: ev.clientX,
    y: ev.clientY,
    pointerId: ev.pointerId,
    armedAt: ev.pointerType === "touch" ? ev.timeStamp + TOUCH_HOLD_MS : 0,
    entry,
  };
  window.addEventListener("pointermove", onPressMove);
  window.addEventListener("pointerup", endPress);
  window.addEventListener("pointercancel", endPress);
}

function onRowClick(entry: VaultEntry) {
  // the click that trails a drag's pointerup would otherwise add it all over again
  if (draggedEntryId === entry.id) {
    draggedEntryId = null;
    return;
  }
  add(entry);
}

function add(entry: VaultEntry) {
  if (isInList(entry)) return;
  c.addVaultItem(entry, targetFolderId.value);
}

// The pane can unmount mid-gesture — Escape closes it, and a drop can land it in a
// state the parent tears down — so both pointer loops are stopped here rather than
// only on their own pointerup. Otherwise their window listeners outlive the
// component and keep its whole setup scope (the full vault array) reachable.
onBeforeUnmount(() => {
  endPress();
  endResize();
});

onKeyStroke("Escape", () => emit("close"));
</script>

<template>
  <aside class="popover vp" data-vault-pane role="dialog" aria-label="Your vault">
    <!-- the split divider. Desktop only (CSS); on a phone the sheet spans the
         gutters and there is nothing to drag. -->
    <div
      class="vp__resize"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      aria-label="Resize the vault pane"
      :aria-valuenow="width"
      :aria-valuemin="288"
      :aria-valuemax="720"
      title="Drag to resize"
      @pointerdown="startResize"
      @keydown="onResizeKey"
    />
    <header class="vp__head">
      <h2 class="t-label vp__title">Your vault</h2>
      <button
        type="button"
        class="btn btn--icon btn--ghost"
        aria-label="Close the vault"
        title="Close"
        @click="emit('close')"
      >
        <X :size="16" />
      </button>
    </header>

    <!-- signed out: the pane explains itself rather than sitting empty -->
    <div v-if="!hasVault" class="vp__empty">
      <p class="t-sm t-muted">
        Every piece of gear you add to a list is kept here, ready to drop into the next one.
        Nothing to set up — it fills itself as you build.
      </p>
      <NuxtLink to="/vault" class="btn btn--primary">Open your vault</NuxtLink>
    </div>

    <template v-else>
      <div class="vp__controls">
        <input
          ref="searchEl"
          v-model="query"
          class="field vp__search"
          type="search"
          placeholder="Search your gear…"
          aria-label="Search your gear"
        />
        <label v-if="folders.length" class="vp__target">
          <span class="t-sm t-muted">Add to</span>
          <select v-model="targetFolderId" class="field vp__select" aria-label="Folder to add into">
            <option v-for="f in folders" :key="f.id" :value="f.id">{{ f.name }}</option>
          </select>
        </label>
      </div>

      <p v-if="loadError" class="t-sm vp__error">{{ loadError }}</p>
      <p v-else-if="loading" class="t-sm t-muted vp__note">Loading your gear…</p>

      <ul v-else-if="filtered.length" class="vp__list">
        <li v-for="entry in filtered" :key="entry.id">
          <!-- Click adds to the "Add to" folder; press and drag puts it in whichever
               folder you let go over. See onRowPointerDown for how the two are told
               apart. Keyboard users are not stranded — the select + click IS that path. -->
          <button
            type="button"
            class="vp__add"
            :disabled="isInList(entry)"
            :aria-label="
              isInList(entry)
                ? `${itemDisplayName(entry.brand, entry.name, entry.variant)} is already in this list`
                : `Add ${itemDisplayName(entry.brand, entry.name, entry.variant)} to the list`
            "
            @pointerdown="onRowPointerDown(entry, $event)"
            @click="onRowClick(entry)"
          >
            <span class="vp__main">
              <span class="vp__name">
                <span v-if="entry.brand" class="vp__brand">{{ entry.brand }}</span>
                <span>{{ entry.name }}</span>
                <span v-if="entry.variant" class="vp__variant">· {{ entry.variant }}</span>
              </span>
              <!-- the row can't be added again, so it says so plainly. A COUNT was
                   the right label when a second copy was allowed; now that one row
                   per piece of gear is the rule, the number was answering a question
                   nobody can act on. -->
              <span v-if="isInList(entry)" class="t-sm vp__inlist">Already added</span>
            </span>
            <span class="t-num t-sm vp__w">{{ formatWeight(entry.weightMg, unit, { withUnit: false }) }}<span class="t-muted"> {{ unit }}</span></span>
            <span class="vp__icon" aria-hidden="true">
              <Check
                v-if="isInList(entry)"
                :size="15"
                :stroke-width="2.2"
                class="vp__added"
              />
              <Plus v-else :size="15" :stroke-width="2" />
            </span>
          </button>
        </li>
      </ul>

      <p v-else-if="query" class="t-sm t-muted vp__note">Nothing here matches “{{ query }}”.</p>
      <div v-else class="vp__empty">
        <p class="t-sm t-muted">
          Your vault is empty. Add gear to this list and it’ll collect itself here.
        </p>
      </div>
    </template>
  </aside>
</template>

<style scoped lang="scss">
/* Desktop: a floating column pinned to the right, clear of the sticky topbar and
   never taller than the viewport. Its own scroller, so the page behind keeps its
   own scroll position while you work through the vault. */
/* The SURFACE (lifted background, radius, soft shadow, forced-colors edge) comes
   from the shared .popover atom — the same one the autocomplete and kebab menus
   wear, so this panel can't drift from them. It also hands down
   --popover-item-radius and --popover-hover, which the rows below consume, so the
   concentric corner and the hover tint stay pinned to this surface's geometry.
   Everything here is position + size only.

   Desktop: a floating column pinned to the right, clear of the sticky topbar and
   never taller than the viewport. Its own scroller, so the page behind keeps its
   scroll position while you work through the vault. */
.vp {
  position: fixed;
  /* Clear of the editor's sticky topbar, which MEASURES 61px (space-3 padding-block
     either side of a 28px mode toggle, plus its hairline) — 48px overlapped it by
     13. Expressed as grid steps rather than a magic 72px so it stays on the same
     4/8 rhythm as everything else. */
  top: calc(var(--space-7) + var(--space-5));
  z-index: var(--z-float);
  display: flex;
  flex-direction: column;
  /* A split pane in LAYOUT — the editor insets its own column by this width (see
     .editor--split), so the two share the screen instead of one covering the other
     — but still a floating card in APPEARANCE: the .popover surface's radius and
     lift are kept, and it sits in from the viewport edges rather than flush against
     them. The width is the editor's --vault-w, which the divider drags. */
  right: var(--space-4);
  bottom: var(--space-4);
  width: var(--vault-w);
  /* Inline padding only — the same split .ac__menu makes. The VERTICAL breathing
     room lives inside the scroller below (where it scrolls with the content), so
     the last row travels all the way to the card's edge instead of stopping 8px
     short at a padding ledge and reading as cut off. */
  padding: 0 var(--space-2);
  /* clip the full-bleed rows (and the scrollbar's extremes) to the radius */
  overflow: hidden;
}
/* The divider: a hit area straddling the seam, wider than the 1px line it drags so
   it can actually be grabbed. It INKS on hover/focus rather than sitting there as a
   visible bar — the border already draws the seam, and a permanent handle would be
   chrome on a panel that's mostly list. */
.vp__resize {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 9px;
  transform: translateX(-50%);
  cursor: col-resize;
  touch-action: none;
  background: transparent;
}
/* A short pill at the vertical middle rather than a full-height rule: the seam is
   already drawn by the pane's border, and a second floor-to-ceiling line beside it
   read as a double edge. This marks the one spot you grab and nothing else. */
.vp__resize::after {
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
.vp__resize:hover::after,
.vp__resize:focus-visible::after {
  opacity: 1;
}
.vp__resize:focus-visible {
  outline: none;
}
/* the rows carry their own --space-2 inline padding, so the header and controls
   need the same inset to line up with them rather than hugging the card edge */
.vp__head,
.vp__controls,
.vp__note,
.vp__error,
.vp__empty {
  padding-inline: var(--space-2);
}
.vp__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  /* the card no longer carries block padding (see .vp) — the top of it lives here */
  padding-block-start: var(--space-2);
  margin-bottom: var(--space-2);
}
.vp__title {
  color: var(--ink);
}
.vp__controls {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
/* .field is borderless by design; inside a floating panel it needs an edge to read
   as an input at all — the same bottom rule the sign-in field uses */
.vp__search {
  width: 100%;
  border-bottom: 1px solid var(--line);
}
.vp__search:focus {
  border-bottom-color: var(--ink-2);
}
/* the hand stays on the select alone — "Add to" is the label naming it, not a
   thing you click, and pointing at prose invites a click that does nothing */
.vp__target {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
/* "Add to" is two words and was wrapping onto two lines next to the select,
   throwing the row's baseline out */
.vp__target > span {
  flex: none;
  white-space: nowrap;
}
/* Sized to the folder name, not stretched across the panel. Stretching parked the
   chevron against the far edge, so "Add to", the name and the arrow read as three
   separate things instead of one control you click. */
.vp__select {
  flex: 0 1 auto;
  min-width: 0;
  width: auto;
  cursor: pointer;
}
.vp__note,
.vp__error {
  padding-block: var(--space-2);
}
.vp__error {
  color: var(--ink);
}
.vp__list {
  list-style: none;
  margin: 0;
  /* the card's bottom breathing room, inside the scroller so it scrolls with the
     rows rather than sitting under them as a ledge that clips the last one */
  padding: 0 0 var(--space-2);
  overflow-y: auto;
  /* never a horizontal bar — the same rule .ac__menu carries: overflow-y alone
     computes overflow-x to auto, so with classic (always-shown) scrollbars the
     vertical bar narrows the rows and any sub-pixel x-overflow paints a horizontal
     track across the bottom, stealing height from the list. Width pressure is the
     names' ellipses' job, never a scrollbar's. */
  overflow-x: hidden;
  overscroll-behavior: contain; /* reaching the end must not scroll the list behind */
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}
/* the whole row is the button — a small "+" target would be a poor tap area on the
   one surface built for adding many things quickly, and the row is also the drag
   handle (see onRowPointerDown) */
.vp__add {
  width: 100%;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  /* matches .ac__opt — a row on a floating surface, not a page row (which sits on
     the roomier --space-4 rhythm; see .vault__row / .mine__row) */
  padding: var(--space-2);
  /* both pinned on .popover, so they track the surface rather than being guessed */
  border-radius: var(--popover-item-radius);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  color: inherit;
  font: inherit;
}
.vp__add:hover:not(:disabled),
.vp__add:focus-visible {
  background: var(--popover-hover);
}
/* Already in the list: the row recedes rather than disappearing — seeing that you
   already packed it is the useful part — but it stops offering itself. Dimmed as a
   whole (name, weight and tick together) so it reads as one inactive row instead of
   a live row with a greyed label; no hover tint and no grab cursor to match. */
.vp__add:disabled {
  cursor: default;
  opacity: 0.45;
}
.vp__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-px);
}
/* ONE ellipsized run, not three flex items each clipping itself.
   Shrinking them individually had two faults. A long row squeezed the brand down to
   a two-pixel sliver that still held its box and its 0.4ch gap, so that row's name
   started a few pixels in and sat out of line with the column; and the brand — the
   shortest, most identifying part, and the one you scan down the list for — was the
   first thing spent.
   Plain inline text can do neither: the line truncates once, at its end, so every
   row begins at exactly the same place and the brand always survives whole. It also
   yields in the right order for free — the variant goes first, then the tail of the
   model, which is where the redundancy is.
   (Not a middle elision — "Sm…l" — for the brand: that's JS-only in CSS, and a
   word with its middle removed is harder to recognise than one cut cleanly at the
   end. Keeping the brand intact and cutting elsewhere gets the same information for
   nothing.) */
.vp__name {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}
/* The gaps are margins, not the whitespace between the tags: Vue's compiler
   condenses a newline between elements away entirely, so relying on it ran the
   brand into the name ("SmartwoolHike Classic…"). Same 0.4ch the flex `gap` used. */
.vp__brand {
  margin-right: 0.4ch;
  color: var(--ink-2);
}
.vp__variant {
  margin-left: 0.4ch;
  font-style: italic;
  color: var(--ink-3);
}
.vp__inlist {
  color: var(--ink-3);
}
.vp__w {
  flex: none;
  color: var(--ink-2);
}
/* Pinned to the FIRST line, not centred on the row. An "Already added" row is two
   lines tall, and centring across both dropped the tick below the weight sitting on
   line one beside it. A one-line-tall box (1lh = the computed line-height, so it
   can't drift from the type) centres the glyph on that line instead, and the two
   agree whether or not the second line is there. */
.vp__icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  height: 1lh;
  color: var(--ink-3);
}
.vp__add:hover .vp__icon {
  color: var(--ink);
}
.vp__added {
  color: var(--ink);
}
.vp__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-2) 0 var(--space-3);
}

/* A coarse pointer grows the mode toggle (28px → 40px), so the topbar grows with
   it — follow it down. Only reachable on a touch screen WIDER than $bp-full (the
   pane is a bottom sheet below that), i.e. a touch laptop. */
@media (pointer: coarse) {
  .vp {
    top: calc(var(--space-7) + var(--space-6));
  }
}

/* Phone: a bottom sheet instead of a side column — a 23rem panel floating over a
   375px screen would cover the list it's meant to sit beside. Capped at half the
   viewport so the rows you're adding to stay visible above it. */
@media (max-width: $bp-full) {
  .vp {
    top: auto;
    right: var(--space-3);
    bottom: var(--space-3);
    left: var(--space-3);
    width: auto;
    max-height: min(28rem, 55dvh);
  }
  /* nothing to resize when the sheet spans the gutters */
  .vp__resize {
    display: none;
  }
}
</style>
