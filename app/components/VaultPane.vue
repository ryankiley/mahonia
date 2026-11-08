<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ArrowUpRight01Icon, Cancel01Icon, ChevronDownIcon, FolderIcon, Layers01Icon } from "@hugeicons/core-free-icons";
import type { VaultEntry } from "~~/shared/vault";
import { listNormKeys } from "~~/shared/vault";
import { rankVaultRows } from "~~/shared/vaultSearch";
import { highlightParts } from "~~/shared/searchText";
import { formatWeight, itemDisplayName } from "~~/shared/weights";
import { counted } from "~~/shared/tidyText";
import { addVaultKit } from "~/composables/useVaultUnfold";

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
// The per-frame write is IMPERATIVE — straight onto the editor root's style, plus
// the divider's aria-valuenow — because only CSS (and AT) consume it mid-drag.
// Routing it through the `width` model instead re-rendered this whole pane AND the
// editor every frame just to deliver a number to a style attribute. The model commits
// once, on release, which is also when the editor persists it.
let endResize = () => {};
// (A drag never eases: the inset is a plain var read, and the editor's open/close is a
// Web Animation it starts itself — setVault there — not a transition on the inset.)
function startResize(ev: PointerEvent) {
  ev.preventDefault();
  const divider = ev.currentTarget as HTMLElement;
  try {
    divider.setPointerCapture?.(ev.pointerId);
  } catch {
    /* pointer already gone (or synthetic) — plain window listeners still track it */
  }
  // the pane lives inside the editor root that owns --vault-w
  const editorEl = divider.closest(".editor") as HTMLElement | null;
  // the viewport can't change mid-drag, so read it once rather than forcing layout
  // on every move. clientWidth, not innerWidth: the pane's right edge sits in the
  // LAYOUT viewport, and innerWidth also counts a classic scrollbar's column (Windows,
  // Linux), which put the divider 15px right of the pointer there.
  const vw = document.documentElement.clientWidth;
  let frame = 0;
  let pendingX = ev.clientX;
  let moved = false;
  const onMove = (e: PointerEvent) => {
    pendingX = e.clientX;
    moved = true;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      const w = clampVaultWidth(vw - pendingX);
      editorEl?.style.setProperty("--vault-w", `${w}px`);
      divider.setAttribute("aria-valuenow", String(w));
    });
  };
  // named, so removeEventListener gets the SAME reference that was registered
  const stop = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    lockTextSelection(false);
    endResize = () => {};
    // commit once — a press that never moved must not nudge the width by the
    // divider-center offset (the old per-frame flow only wrote after a move too)
    if (moved) width.value = clampVaultWidth(vw - pendingX);
  };
  endResize = stop;
  // both spellings — Safari only reads the prefixed one (see lockTextSelection)
  lockTextSelection(true);
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
const { hasVault, vaultFetch } = useVaultAccess();

const items = ref<VaultEntry[]>([]);
// Items, or just your kits: the sets you add in one go. (This was Categories, your
// My Gear folders; My Gear has no folders now, and a kit is the set you reuse.)
const tab = ref<"items" | "kits">("items");
const loading = ref(true);
const loadError = ref("");
// one query ref per tab: switching back to a tab you were searching shouldn't hand
// you its results filtered by a term you typed for the other one
const queries = ref<{ items: string; kits: string }>({ items: "", kits: "" });
const query = computed({
  get: () => queries.value[tab.value],
  set: (v: string) => (queries.value[tab.value] = v),
});
const searchEl = useTemplateRef<{ focus: () => void }>("searchEl");

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
    loadError.value = "Couldn’t load your gear.";
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

// The SAME fuzzy ranker the item autocomplete uses on this gear (shared/vaultSearch),
// run over the already-loaded set — no request per keystroke.
//
// It used to be a literal substring filter, on the argument that you're scanning a
// list you can see and a reshuffle under your eyes is disorienting. The reshuffle
// part still holds; "literal" didn't. A vault is a hundred-odd rows, so you type
// rather than scan, and a substring match answers a typo with an empty panel —
// "katabatik" finding nothing while the autocomplete two inches away finds it is
// the vault being harder to search than the catalog.
//
// No limit: the ranker caps at VAULT_SEARCH_LIMIT for a menu that must not push the
// catalog off-screen, but this panel IS the list — showing six of a hundred matches
// would hide gear you own.
const filtered = computed(() => {
  const q = query.value.trim();
  if (!q) return items.value;
  return rankVaultRows(items.value, q, Number.POSITIVE_INFINITY);
});
// bold the characters that overlap what's been typed — the same helper, and so the
// same emphasis, as the autocomplete's rows
const hl = (text: string) => highlightParts(text, query.value);

// ---- kits ----
// A kit is offered among the gear, marked as one, and it does not go onto the list
// as one row: it unfolds into a group — the kit's row as the parent, each live part
// a row under it (useVaultUnfold.addVaultKit). "Already added" reads off the parent's
// identity, the same way a piece's does; the parts the list already holds are
// skipped as it unfolds, which is the pane's one-row-per-piece rule for each of them.
const isKit = (entry: VaultEntry) => entry.kind === "kit";
// what it holds, counting each item as many times as the kit has it (as /gear counts)
const itemCount = (entry: VaultEntry) => (entry.parts ?? []).reduce((n, p) => (p.removed ? n : n + p.qty), 0);
// A kit lands as a group further down the list than the pane you clicked in, so it
// says so in the editor's undo bar — "Added Cook kit · Undo" — and Undo takes the
// group back off, its rows with it. A single piece answers for itself in place
// ("Already added"). Ryan: "clicking a category item doesn't allow undo on the toast".
function addEntry(entry: VaultEntry, folderId: string | null): string {
  if (!isKit(entry)) return c.addVaultItem(entry, folderId);
  const parentId = addVaultKit(c, entry, folderId, items.value);
  if (parentId) c.offerUndoAdd(itemDisplayName(entry.brand, entry.name, entry.variant), parentId);
  return parentId;
}
const kits = computed(() => items.value.filter(isKit));

// the kits tab searches the way the items tab does, over the kits alone
const filteredKits = computed(() => {
  const q = query.value.trim();
  if (!q) return kits.value;
  return rankVaultRows(kits.value, q, Number.POSITIVE_INFINITY);
});

// The gear the open list already holds, keyed by the SAME identity rule the vault
// uses — so "Zpacks Duplex" in the list matches the vault row whatever the spacing
// or case. Recomputed from the live snapshot, so it updates the moment something is
// added (here or by typing).
const inList = computed(() => listNormKeys(c.snapshot.value?.items ?? []));
// Gear the list already holds can't be added again — the row goes to an "Already
// added" state instead. Wanting two of something is a QUANTITY, which the list row
// owns (its "1 ×" field); a second identical row would split one thing's weight
// across two lines and read as an oversight.
const isInList = (entry: VaultEntry) => inList.value.has(entry.normKey);

// Grab a row ANYWHERE to drag it into a folder — no handle. The row is also a click
// target (quick-add to the "Add to" folder), so the two gestures have to be told
// apart, and the shared press-arm scaffold tells them apart differently by input
// type:
//
//  • mouse/pen — by DISTANCE. A press that travels past a few pixels was a drag; one
//    that doesn't was a click. There's nothing else a horizontal mouse press means.
//  • touch — by TIME first (the touchHoldMs arming). A finger that moves is almost
//    always scrolling this list, so distance alone would hijack every swipe. A short
//    hold arms the drag; a swipe that starts before the hold elapses is left to the
//    browser as a scroll (which then cancels the press outright).
//
// Deliberately not `touch-action: none` on the rows for the same reason: the list
// has 100+ entries and scrolling it must stay the default reading of a swipe. What
// keeps a held row's drag from turning into a scroll anyway is the sheet's touch
// guard (onSheetTouchMove), which stops handing moves to the browser the moment the
// hold arms.
//
// The hold SAYS when it has taken: the row lifts (`liftedId`, the .is-lifted ground)
// and the phone ticks, where the hardware offers one — the same tick a map pin gives
// when its hold registers (RouteMap's beginLift). Without it a quarter-second hold is a
// guess: lift too soon and you scroll, lift too late and you've waited for nothing.
// It stays lifted while the drag it became is live, and comes down when that ends.

// the entry whose press turned into a drag, so the click that follows pointerup is
// swallowed instead of adding the thing a second time
let draggedEntryId: number | null = null;
const liftedId = ref<number | null>(null);

const rowPress = createPressArm<VaultEntry>({
  threshold: 5,
  touchHoldMs: 250,
  onArm(entry) {
    liftedId.value = entry.id;
    navigator.vibrate?.(10);
  },
  onDisarm() {
    liftedId.value = null;
  },
  onDrag(entry, ev) {
    draggedEntryId = entry.id;
    // the pane owns what a drop MEANS — it creates the row and enforces its own
    // one-per-list rule; the gesture only resolves where the pointer let go
    dnd.startInsert((folderId, beforeId) => {
      if (isInList(entry)) return;
      // a kit's parent row is what moves into the slot; its children render under it
      // wherever it lands, since they order among themselves
      const id = addEntry(entry, folderId);
      if (id && beforeId) c.moveItem(id, folderId, beforeId, null);
    }, ev);
  },
});

// the drag a held row became has ended — dropped, cancelled or escaped — so the row it
// came from sets back down
watch(
  () => dnd.dragId.value,
  (id) => {
    if (!id) liftedId.value = null;
  },
);

function onRowPointerDown(entry: VaultEntry, ev: PointerEvent) {
  if (isInList(entry)) return;
  rowPress.start(entry, ev);
}

function onRowClick(entry: VaultEntry) {
  // the click that trails a drag's pointerup would otherwise add it all over again
  if (draggedEntryId === entry.id) {
    draggedEntryId = null;
    return;
  }
  if (isInList(entry)) return;
  addEntry(entry, targetFolderId.value);
}

// ---- the sheet answers the scroll that lands on it ------------------------
//
// On a phone the pane is a bottom sheet floating over the list, and a fixed box's
// scroll chain runs straight to the viewport — so a swipe that didn't reach a
// scroller fell THROUGH the sheet and scrolled the page instead. Swiping the
// header, the search row, or a list too short to scroll moved the list behind the
// panel, which reads as a hole in the page rather than a surface on it.
//
// `overscroll-behavior: contain` on the rows can't cover this on its own. It stops
// the chain at a scroller's ENDS — which is why swiping past the last row already
// stays put — but a gesture that never reached a scroller at all is not its
// business: the chrome above the rows, and a row list with nothing to scroll
// because the vault is empty or the filter left two matches.
//
// So the sheet decides for itself. A one-finger drag goes to the rows while they
// can still travel that way, and is swallowed otherwise; the page keeps its scroll
// position until you put a finger OUTSIDE the sheet, which is the half of it that
// already worked. Two fingers are left alone, so pinch-zoom over the sheet still
// zooms.
//
// And a finger that is CARRYING A ROW is never a scroll, whatever room the list has.
// Once a row's hold has armed (rowPress.armed) or the drag it became is live
// (dnd.dragId), every move is swallowed. Before this the guard handed the first move to
// the browser whenever the rows could still scroll that way, and a touch scroll steals
// the pointer — pointercancel — so dragging a row out of the sheet died on its first
// move unless the list happened to be at its end.
const listEl = useTemplateRef<HTMLElement>("listEl");
let touchStartY = 0;

function onSheetTouchStart(ev: TouchEvent) {
  touchStartY = ev.touches[0]?.clientY ?? 0;
}

function onSheetTouchMove(ev: TouchEvent) {
  if (ev.touches.length !== 1) return; // a pinch, not a scroll
  if (rowPress.armed(ev.timeStamp) || dnd.dragId.value) {
    if (ev.cancelable) ev.preventDefault();
    return;
  }
  const list = listEl.value;
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

// ---- the sheet rides above the keyboard ------------------------------------
//
// The phone sheet is pinned to the bottom of the screen, and it opens by focusing its
// own search — which raises the keyboard straight over it. iOS keeps the LAYOUT
// viewport full height under the keyboard and only shrinks the visual one, so a box
// pinned to the bottom stays exactly where the keyboard now is: you opened My Gear to
// search it and got a keyboard over an invisible panel.
//
// So while it's open the sheet watches the visual viewport, lifts itself by the strip
// the keyboard covers (--kb) and caps its height to what's left between the topbar and
// the keyboard (--sheet-room), so a short phone doesn't push its header, close button
// and all, up under the bar. The arithmetic is app/utils/viewportRoom; the CSS that
// spends both is the phone block below. Android, told to resize the layout for the
// keyboard (interactive-widget=resizes-content, nuxt.config.ts), reads 0 here: its
// layout viewport is already above the keyboard, and the sheet with it.
const kb = ref(0);
const sheetRoom = ref<number | null>(null);
function measureViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  kb.value = keyboardInset(window.innerHeight, vv.height, vv.offsetTop);
  const band = visibleBand();
  sheetRoom.value = Math.round(band.bottom - band.top);
}
// once per frame at most: iOS fires a burst of these while the keyboard settles
let viewportFrame = 0;
function onViewport() {
  viewportFrame ||= requestAnimationFrame(() => {
    viewportFrame = 0;
    measureViewport();
  });
}
onMounted(() => {
  measureViewport();
  window.visualViewport?.addEventListener("resize", onViewport);
  window.visualViewport?.addEventListener("scroll", onViewport);
});
const sheetVars = computed(() => ({
  "--kb": `${kb.value}px`,
  ...(sheetRoom.value != null ? { "--sheet-room": `${sheetRoom.value}px` } : {}),
}));

// The pane can unmount mid-gesture — Escape closes it, and a drop can land it in a
// state the parent tears down — so both pointer loops are stopped here rather than
// only on their own pointerup. Otherwise their window listeners outlive the
// component and keep its whole setup scope (the full vault array) reachable. The
// viewport watch above goes with them.
onBeforeUnmount(() => {
  rowPress.end();
  endResize();
  window.visualViewport?.removeEventListener("resize", onViewport);
  window.visualViewport?.removeEventListener("scroll", onViewport);
  cancelAnimationFrame(viewportFrame);
});

onKeyStroke("Escape", () => emit("close"));

// Sign in without losing the vault behind it — the account opens over this page.
const { open: openAccount } = useAccountModal();
// folder ids are STRINGS in the editor (the vault page's are numeric rows) — no cast
const targetOptions = computed(() => folders.value.map((f) => ({ key: f.id, label: f.name, icon: FolderIcon })));
</script>

<template>
  <!-- vp--sized once there's a vault to browse: that's the state whose height has
       to hold still while you filter it. The signed-out explainer is a short block
       of prose and sizes to itself. -->
  <!-- touchmove takes NO .passive modifier: preventDefault is the whole point of it
       (see onSheetTouchMove), and the passive-by-default intervention covers only
       window/document/body, so a bare listener here can still cancel. -->
  <aside
    class="popover vp"
    :class="{ 'vp--sized': hasVault }"
    data-vault-pane
    role="dialog"
    aria-label="My Gear"
    :style="sheetVars"
    @touchstart.passive="onSheetTouchStart"
    @touchmove="onSheetTouchMove"
  >
    <!-- the split divider. Desktop only (CSS); on a phone the sheet spans the
         gutters and there is nothing to drag. -->
    <div
      class="vp__resize"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      aria-label="Resize the My Gear panel"
      :aria-valuenow="width"
      :aria-valuemin="288"
      :aria-valuemax="720"
      title="Drag to resize"
      @pointerdown="startResize"
      @keydown="onResizeKey"
    />
    <header class="panel__head vp__head">
      <h2 class="t-label panel__title vp__title">My Gear</h2>
      <!-- The way out to the full page, and it lives HERE rather than on the toolbar
           glyph that opened this. That glyph is a one-press toggle you hit repeatedly
           while building a list; hanging a menu off it to offer this would tax the
           frequent action to reach the rare one. You have already asked for your gear
           by the time you can see this, so "all of it, with room to tidy" is one quiet
           link away at the moment you'd want it. -->
      <NuxtLink v-if="hasVault" to="/gear" class="btn btn--quiet vp__open ink-quiet" title="Open My Gear as a full page">
        Open
        <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
      </NuxtLink>
      <button
        type="button"
        class="btn btn--icon btn--ghost btn--flush-end"
        aria-label="Close My Gear"
        title="Close"
        @click="emit('close')"
      >
        <HugeiconsIcon :icon="Cancel01Icon" :size="16" :stroke-width="2" />
      </button>
    </header>

    <!-- Signed out, so this is a sign-in prompt and nothing else.
         It used to describe the vault in the present tense ("every piece of gear you
         add is kept here", "nothing to set up") while the reader had no vault and the
         button underneath was asking them to go and set one up. Both halves were
         false at the only moment anyone reads this.
         It also pointed at /vault, which signed out renders this same prompt again —
         two hops to reach one button. Same sentence and same action as that page now,
         because it is the same question being asked twice. -->
    <div v-if="!hasVault" class="vp__empty">
      <!-- One sentence: what it is, and the one thing it asks for that the rest of
           the app never does. The "but" is doing the work — it names the trade-off
           without a second sentence explaining it, and the button underneath says
           what to do about it.
           WORD FOR WORD the /vault page's prompt. It is the same question asked in
           two places, and answering it twice in two voices is how a product starts
           sounding like two products. Change one, change both. -->
      <p class="t-sm t-muted">{{ VAULT_ASK }}</p>
      <button type="button" class="btn btn--primary" @click="openAccount">Sign in</button>
    </div>

    <template v-else>
      <!-- Items / Categories. Both tabs read the SAME loaded rows — one is the gear,
           the other is the sets you've built out of it — so switching costs nothing
           and the two can't disagree. The search below belongs to whichever is open,
           which is what keeps the panel self-sufficient: finding gear never reaches
           out into the editor's chrome. -->
      <div class="vp__tabs" role="tablist" aria-label="My Gear view">
        <button
          v-for="t in (['items', 'kits'] as const)"
          :key="t"
          type="button"
          role="tab"
          class="vp__tab"
          :class="{ 'is-active': tab === t }"
          :aria-selected="tab === t"
          @click="tab = t"
        >
          {{ t === "items" ? "Items" : "Kits" }}
          <span class="vp__tabcount t-num">{{ t === "items" ? items.length : kits.length }}</span>
        </button>
      </div>

      <div class="vp__controls">
        <!-- the field and its own clear — SearchField, the same control /gear draws -->
        <SearchField
          ref="searchEl"
          v-model="query"
          :placeholder="tab === 'items' ? 'Search gear…' : 'Search kits…'"
          :label="tab === 'items' ? 'Search gear' : 'Search kits'"
        />
        <div v-if="folders.length" class="vp__target">
          <span class="t-sm t-muted">Add to</span>
          <!-- the last native dropdown in the app, converted with the rest: it wasn't
               the transparent-overlay pattern, just an ordinary <select>, which left it
               the one control that opened an OS list instead of ours -->
          <OptionMenu
            class="vp__select"
            :options="targetOptions"
            :current="targetFolderId ?? ''"
            label="Folder to add into"
            @pick="(k) => (targetFolderId = k)"
          >
            <template #trigger="{ active, open }">
              <span class="t-clip vp__targetname">{{ active?.label }}</span>
              <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2" aria-hidden="true" />
            </template>
          </OptionMenu>
        </div>
      </div>

      <p v-if="loadError" class="t-sm vp__error">{{ loadError }}</p>
      <p v-else-if="loading" class="t-sm t-muted vp__note">Loading your gear…</p>

      <!-- KITS: a whole set, added in one go into the "Add to" folder, as a group
           with its items under it. -->
      <ul v-else-if="tab === 'kits' && filteredKits.length" class="vp__list">
        <li v-for="kit in filteredKits" :key="kit.id">
          <button
            type="button"
            class="vp__add"
            :disabled="isInList(kit)"
            :aria-label="
              isInList(kit)
                ? `${itemDisplayName(kit.brand, kit.name, kit.variant)} is already in this list`
                : `Add the ${itemDisplayName(kit.brand, kit.name, kit.variant)} kit to the list, with its ${counted(itemCount(kit), 'item')} under it`
            "
            @click="addEntry(kit, targetFolderId)"
          >
            <span class="vp__kit" aria-hidden="true">
              <HugeiconsIcon :icon="Layers01Icon" :size="14" :stroke-width="2" />
            </span>
            <span class="gear__main">
              <span class="gear__name t-clip" :title="itemDisplayName(kit.brand, kit.name, kit.variant)">{{ itemDisplayName(kit.brand, kit.name, kit.variant) }}</span>
              <span class="t-sm vp__inlist">{{ isInList(kit) ? "Already added" : `Kit · ${counted(itemCount(kit), "item")}` }}</span>
            </span>
            <span class="t-num t-sm vp__w">{{ formatWeight(kit.weightMg, unit, { withUnit: false }) }}<span class="t-muted"> {{ unit }}</span></span>
          </button>
        </li>
      </ul>

      <ul v-else-if="tab === 'items' && filtered.length" ref="listEl" class="vp__list">
        <li v-for="entry in filtered" :key="entry.id">
          <!-- Click adds to the "Add to" folder; press and drag puts it in whichever
               folder you let go over. See onRowPointerDown for how the two are told
               apart. Keyboard users are not stranded — the select + click IS that path. -->
          <button
            type="button"
            class="vp__add"
            :class="{ 'is-lifted': liftedId === entry.id }"
            :disabled="isInList(entry)"
            :aria-label="
              isInList(entry)
                ? `${itemDisplayName(entry.brand, entry.name, entry.variant)} is already in this list`
                : isKit(entry)
                  ? `Add the ${itemDisplayName(entry.brand, entry.name, entry.variant)} kit to the list, with its ${counted(itemCount(entry), 'item')} under it`
                  : `Add ${itemDisplayName(entry.brand, entry.name, entry.variant)} to the list`
            "
            @pointerdown="onRowPointerDown(entry, $event)"
            @click="onRowClick(entry)"
          >
            <!-- a kit's mark, so a set reads as one before you read a word of it;
                 the same glyph /gear's row wears -->
            <span v-if="isKit(entry)" class="vp__kit" aria-hidden="true">
              <HugeiconsIcon :icon="Layers01Icon" :size="14" :stroke-width="2" />
            </span>
            <span class="gear__main">
              <!-- the full name on hover, for the rows the ellipsis cut short -->
              <span class="gear__name t-clip" :title="itemDisplayName(entry.brand, entry.name, entry.variant)">
                <span v-if="entry.brand" class="gear__brand"
                  ><span v-for="(p, pi) in hl(entry.brand)" :key="pi" :class="{ 'vp__hl': p.on }">{{ p.t }}</span></span
                >
                <span
                  ><span v-for="(p, pi) in hl(entry.name)" :key="pi" :class="{ 'vp__hl': p.on }">{{ p.t }}</span></span
                >
                <span v-if="entry.variant" class="gear__variant"><span class="sep">·</span> {{ entry.variant }}</span>
              </span>
              <!-- the row can't be added again, so it says so plainly. A COUNT was
                   the right label when a second copy was allowed; now that one row
                   per piece of gear is the rule, the number was answering a question
                   nobody can act on. A KIT's count is a different fact — how many
                   rows it unfolds into — and worth a line. -->
              <span v-if="isInList(entry)" class="t-sm vp__inlist">Already added</span>
              <span v-else-if="isKit(entry)" class="t-sm vp__inlist">Kit · {{ counted(itemCount(entry), "item") }}</span>
            </span>
            <span class="t-num t-sm vp__w">{{ formatWeight(entry.weightMg, unit, { withUnit: false }) }}<span class="t-muted"> {{ unit }}</span></span>
          </button>
        </li>
      </ul>

      <p v-else-if="query" class="t-sm t-muted vp__note">Nothing here matches “{{ query }}”.</p>
      <!-- the two tabs fail differently: an empty vault has no gear yet, an empty
           Kits tab has gear that hasn't been made into a set -->
      <div v-else-if="tab === 'kits'" class="vp__empty">
        <p class="t-sm t-muted">
          No kits yet. On My Gear, open a piece and make it a kit, or save a group on a
          list to My Gear as one.
        </p>
      </div>
      <div v-else class="vp__empty">
        <p class="t-sm t-muted">
          No gear saved yet. Add gear to this list and it’ll collect itself here.
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
  /* Under the TOPBAR's layer, which is what puts it under everything the bar opens
     — the bar's own z-index makes a stacking context, so its menus can only ever
     compete at the bar's number. See --z-pane, where the whole order is written
     down. This is a column the editor makes room for, not a float; the transient
     surfaces over it win. */
  z-index: var(--z-pane);
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
  transition: opacity var(--spring-fade-dur) var(--spring-fade);
}
.vp__resize:focus-visible::after {
  opacity: 1;
}
/* the hover twin is pointer-gated, as every hover that paints is (see .vp__add below) */
@media (hover: hover) and (pointer: fine) {
  .vp__resize:hover::after {
    opacity: 1;
  }
}
.vp__resize:focus-visible {
  outline: none;
}
/* the rows carry their own --space-2 inline padding, so the header and controls
   need the same inset to line up with them rather than hugging the card edge */
.vp__head,
.vp__tabs,
.vp__controls,
.vp__note,
.vp__error,
.vp__empty {
  padding-inline: var(--space-2);
}
/* Items / Categories — a segmented pair, not a link row: they switch what this panel
   IS looking at, so the active one takes a filled ground rather than an underline.
   Same quiet-grey chip the row toggles use, so "selected" reads the same everywhere. */
.vp__tabs {
  display: flex;
  gap: var(--space-1);
  margin-bottom: var(--space-2);
  /* The tab's LABEL lands on the panel's gutter, not its chip. Everything else down
     this edge — the title, "Add to", every row name — starts at the content edge; a
     tab carries its own --space-2 of chip padding on top of the shared inset, so
     "Items" alone sat 8px further in and the column read as bent. Pull the row back
     by exactly that padding: the text aligns and the active chip's ground overhangs
     into the panel's own padding, which is the --tap-pull idiom (grow the box, not
     the picture). */
  margin-inline-start: calc(-1 * var(--space-2));
}
.vp__tab {
  position: relative; /* the hit area below hangs off it */
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--popover-item-radius);
  font-size: var(--text-base);
  color: var(--ink-3);
  cursor: pointer;
  transition:
    background var(--spring-fade-dur) var(--spring-fade),
    color var(--spring-fade-dur) var(--spring-fade);
}
@media (hover: hover) and (pointer: fine) {
  .vp__tab:hover {
    color: var(--ink);
  }
}
/* A FINGER-SIZED TARGET for a chip drawn at text size. The tab is ~27px tall and sits
   between the header and the search field, a thumb's width from both; growing the chip
   to --tap would stand the row 17px taller on a sheet that is short of height already.
   So the box that answers the tap grows and the picture doesn't: an invisible --tap of
   height centred on the chip, the .switch::before trick (controls.scss). It reaches
   about as far as the 8px margins either side, so it doesn't steal taps meant for the
   header above or the search field below.
   Touch only — a mouse can hit the chip it can see. */
@media (pointer: coarse) {
  .vp__tab::before {
    content: "";
    position: absolute;
    inset-inline: 0;
    top: 50%;
    height: var(--tap);
    translate: 0 -50%;
  }
}
.vp__tab.is-active {
  background: var(--paper-3);
  color: var(--ink);
}
/* the count rides at --ink-3 even on the active tab: it's a quantity, not the label,
   and matching the label's weight made the two read as one long word */
.vp__tabcount {
  color: var(--ink-3);
}
/* THE PANEL HEADER is the .panel__head atom (controls.scss); only the offset onto
   this card's edge is its own. */
.vp__head {
  /* the card no longer carries block padding (see .vp) — the top of it lives here */
  padding-block-start: var(--space-2);
  margin-bottom: var(--space-2);
}
.vp__title {
  /* takes the slack so the two trailing controls sit together on the end rather than
     spreading across the header — space-between would otherwise put "Open" in the
     middle of it, reading as a third heading */
  margin-inline-end: auto;
}
/* quiet, and a link rather than a button: it navigates, and the glyph says so */
.vp__open {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.vp__controls {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
/* the search field, its clear and their touch target are SearchField's own */
/* The field's ground hangs into the panel's padding the way the active tab's chip does
   above it (and every row's hover ground below it), with its text pulled in by the same
   step, so the grounds share one edge and the words share another. Inset like the rest,
   the box started 8px inside the tab's chip and the edge read as a mistake. */
.vp__controls :deep(.sf) {
  margin-inline: calc(-1 * var(--space-2));
}
.vp__controls :deep(.sf__input) {
  padding-inline-start: var(--space-2);
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
/* .optmenu, so this outranks the atom's own `flex: none` (OptionMenu.vue) by class
   count rather than by which stylesheet happened to load last: this is the one trigger
   that wraps a name and must be allowed to ellipsize it. */
.vp__select.optmenu {
  flex: 0 1 auto;
  min-width: 0;
}
/* the target's mark is the shared .chev (atoms/controls.scss). Its copy here set the
   resting ink and nothing else — no .is-open rule at all — while the markup has always
   handed it `is-open`, so the one chevron that told you the picker was open never turned. */
.vp__note,
.vp__error {
  padding-block: var(--space-2);
}
/* The sheet holds its height while you filter (see .vp--sized), so a one-line
   "nothing matches" was left pinned to the top of a mostly-empty panel. Centre it
   in the space the rows would have occupied — flex:1 claims that space, and the
   note sits in the middle of it. */
.vp__note {
  flex: 1 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.vp__error {
  color: var(--ink);
}
.vp__list {
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
  /* The row is a control and a drag handle, so holding it must not do what holding
     text does on a phone: select the label, or raise iOS's callout. Both spellings —
     WebKit reads only the prefixed one. */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
/* HELD: the touch hold has armed (see liftedId), so the row is picked up and the next
   move carries it. The --paper-3 ground the active tab wears, a step past the hover
   tint, because this has to read as a different state from "under your finger" — it is
   the moment a scroll became a drag. No transition: it lands with the vibration tick,
   and feedback that a hold registered is instant or it isn't feedback. */
.vp__add.is-lifted {
  background: var(--paper-3);
}
/* Split from :hover, not merged with it: focus is not a pointer state and a keyboard
   driving a touch device still needs the highlight, while the hover twin paints only
   where hovering is real (see the note on .btn:hover, controls.scss). Worth the two
   duplicated lines here because the pane STAYS OPEN as you add — an ungated tint sat
   on the last row you tapped while you went on picking the next one. */
.vp__add:focus-visible {
  background: var(--popover-hover);
}
@media (hover: hover) and (pointer: fine) {
  .vp__add:hover:not(:disabled) {
    background: var(--popover-hover);
  }
}
/* Already in the list: the row recedes rather than disappearing — seeing that you
   already packed it is the useful part — but it stops offering itself. Dimmed as a
   whole (name, weight and tick together) so it reads as one inactive row instead of
   a live row with a greyed label; no hover tint and no grab cursor to match. */
.vp__add:disabled {
  cursor: default;
  opacity: 0.45;
}
/* the name cell (.gear__main / .gear__name / .gear__brand / .gear__variant) comes
   from atoms/gear.scss — shared with /vault's rows, which used to hand-mirror
   these rules. Only the typed-match emphasis is the pane's own: */
/* the characters that overlap what you've typed read bold — the same emphasis, from
   the same helper, as the autocomplete's rows (.ac__hl) */
.vp__hl {
  font-weight: 700;
  color: var(--ink);
}
.vp__inlist {
  color: var(--ink-3);
}
/* the kit's mark sits on the first line beside the name, like the row's check does
   on the trailing edge: a one-line-tall box centres the glyph on that line */
.vp__kit {
  flex: none;
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  height: 1lh;
  color: var(--ink-2);
}
.vp__w {
  flex: none;
  color: var(--ink-2);
}
/* CENTRED in the pane, both ways. These states have no rows to align to — they're
   a sentence about why the pane is empty — so left-aligning them at the top left
   them hanging off the corner of a tall card with nothing under them. */
.vp__empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-3);
  /* padding-BLOCK, not the shorthand: this block also matches the shared
     padding-inline rule above, and a `padding: x 0 y` shorthand silently zeroes the
     inline half of it — which left the empty state's text one full step to the left
     of the header above it and the rows below it.
     The bottom is deeper than the top: 12px left the sign-in button sitting on the
     sheet's own edge. It no longer reaches for the safe area itself — the SHEET clears
     the home indicator now (its bottom offset, the phone block below), and padding for
     it here as well lifted the button twice over. */
  padding-block: var(--space-2) var(--space-5);
}
/* balance, not the tooltip's pretty: pretty only protects the LAST line, and centred
   text makes a ragged edge read as a mistake. A short block can't strand a word. */
.vp__empty p {
  max-width: 30ch;
  text-wrap: balance;
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
   viewport so the rows you're adding to stay visible above it.

   THE BOTTOM EDGE clears two things the gutter alone didn't:
   - the home indicator. 12px put the installed app's sheet on top of it, so its
     floor is the safe-area inset where there is one (env() is 0 everywhere else, and
     the max() keeps the 12px gutter there).
   - the keyboard. The sheet focuses its search on open, and on iOS the keyboard then
     covers a sheet pinned to the bottom (see the viewport watch in the script). --kb is
     the strip the keyboard covers; the sheet lifts to sit a gutter above it — not a
     gutter plus the home indicator's inset, which the keyboard has already covered.
     A translate rather than a moving `bottom`, so the lift is a compositor move and can
     glide on the drawer curve as the keyboard settles instead of jumping when it has.
   The height cap gains --sheet-room, the strip left between the topbar and the
   keyboard, so a lifted sheet on a short phone shrinks rather than sliding its header
   (and its close button) up under the bar. Without a keyboard 55dvh is the smaller of
   the two everywhere, so nothing changes until one rises. */
@media (max-width: $bp-full) {
  .vp {
    top: auto;
    right: var(--space-3);
    bottom: max(var(--space-3), env(safe-area-inset-bottom, 0px));
    left: var(--space-3);
    width: auto;
    max-height: min(27.5rem, 55dvh, calc(var(--sheet-room, 100dvh) - 2 * var(--space-3)));
    translate: 0
      calc(-1 * max(0px, var(--kb, 0px) + var(--space-3) - max(var(--space-3), env(safe-area-inset-bottom, 0px))));
    transition: translate var(--spring-step-dur) var(--ease-drawer);
  }
  /* A FIXED height, not a max, once there's gear to browse. As a max, the sheet
     shrank to fit whatever the filter left — so typing into the search resized the
     surface under your thumb, and clearing it snapped it back. The rows move; the
     thing holding them shouldn't. (Desktop needs no equivalent: the column is
     pinned top and bottom, so it's already a fixed height.)
     27.5rem = 440px, on the 8px grid. The dvh clamp still wins on a short phone —
     the sheet must not eat the list it sits beside — so the height is fixed per
     device rather than always literally 440. The keyboard is the one thing that
     changes it (the --sheet-room cap above): it changes once as the keyboard rises,
     never as you type. */
  .vp--sized {
    height: min(27.5rem, 55dvh, calc(var(--sheet-room, 100dvh) - 2 * var(--space-3)));
  }
  /* nothing to resize when the sheet spans the gutters */
  .vp__resize {
    display: none;
  }
}
/* Between the stack point and the split point — a tablet, a narrow window — the
   sheet does NOT span the gutters: at 900px that was a 60rem card for a column of
   short names (Ryan, 2026-10-17: "this seems too wide"). It takes the width the
   desktop column opens at and sits where that column would, bottom-right, so a
   window widened past the split point turns it into the column without it moving
   across the screen. */
@media (min-width: $bp-stack + 1px) and (max-width: $bp-full) {
  .vp {
    left: auto;
    width: 23rem;
  }
}

/* ---- entrance ------------------------------------------------------------
   Pairs with <Transition name="vaultpane"> in GearEditor. The pane comes in from
   the edge it actually sits on — inward from the right as a desktop column, up
   from the bottom as a phone sheet — so the motion reads as the panel arriving
   from off-screen rather than as a card materialising in place.
   No scale: the menus and toasts scale because they're small objects popping out
   of a control, but a full-height panel scaling looks like the page zooming.
   Distance is deliberately short (--space-3). It's an orientation cue, not a
   reveal — the pane is opened on purpose, and anything longer gets in the way of
   the thing you opened it to do.
   Entrance leads with opacity on the fade spring while the travel settles on the
   pop spring; the exit stays quicker than the entrance, the same asymmetry .menu
   and .toast use. (The global prefers-reduced-motion rule in main.scss flattens
   both.)

   The EXIT is not the menus' exit, though, and shouldn't be. A menu is a small
   object popping off a control, so it leaves flat and in 120ms. This is a
   full-height column, 23rem wide before anyone drags the divider, and at that size
   the same treatment read as the panel being deleted rather than dismissed — 8px of
   travel is invisible on a surface that wide, so all you saw was a large rectangle
   blinking off. It leaves the way
   it arrived instead: back out to the edge it lives on, far enough to read as
   travel (--space-4, the entrance's distance and then some), on the step spring:
   a thing leaving gets no spring of its own to land on, so it takes the small
   move's and lets opacity run ahead, spent before the offset lands so nothing
   clips at the end. Still well short of the entrance: the step beat out against
   the pop beat in.

   The LIST moves with it. GearEditor springs its own inset on the travel spring
   (see .editor--split there), so the column gives up the space as the pane arrives
   and flows back into it as the pane goes — one movement, not a panel animating
   over a page that already jumped. */
/* `translate` rides along in both: it is the keyboard lift (the phone block above), and
   these replace that rule's own transition while they run — the keyboard rises during
   the entrance, since opening is what focuses the search. */
.vaultpane-enter-active {
  transition:
    opacity var(--spring-fade-dur) var(--spring-fade),
    transform var(--spring-pop-dur) var(--spring-pop),
    translate var(--spring-step-dur) var(--ease-drawer);
}
.vaultpane-leave-active {
  transition:
    opacity calc(var(--spring-fade-dur) * 0.8) var(--spring-fade),
    transform var(--spring-step-dur) var(--spring-step),
    translate var(--spring-step-dur) var(--ease-drawer);
}
.vaultpane-enter-from {
  opacity: 0;
  transform: translateX(var(--space-3));
}
.vaultpane-leave-to {
  opacity: 0;
  transform: translateX(var(--space-4));
}
@media (max-width: $bp-full) {
  /* the sheet's edge is the bottom one */
  .vaultpane-enter-from {
    transform: translateY(var(--space-3));
  }
  .vaultpane-leave-to {
    transform: translateY(var(--space-4));
  }
}
</style>
