<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ArrowUpRight01Icon, Cancel01Icon, CheckIcon, ChevronDownIcon } from "@hugeicons/core-free-icons";
import type { VaultEntry, VaultFolder } from "~~/shared/vault";
import { vaultNormKey } from "~~/shared/vault";
import { rankVaultRows } from "~~/shared/vaultSearch";
import { groupVaultRows } from "~~/shared/vaultView";
import { highlightParts } from "~~/shared/catalogSearch";
import { formatWeight, itemDisplayName } from "~~/shared/weights";
import { foldApostrophes } from "~~/shared/tidyText";

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
const emit = defineEmits<{ close: []; added: [string] }>();

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
// Mark the editor as being SIZED, so its inset stops easing for the length of the
// gesture. The editor animates padding-right between the two column widths (see
// .editor--sizing there) — right for a pane opening or closing, wrong for a drag,
// where --vault-w changes every frame and an eased column would trail the divider
// by a fifth of a second. Idle-cleared rather than paired with an explicit end,
// because the two callers stop differently: a pointer drag has a release to hang it
// on, an arrow-key step has only the last keypress. 120ms is longer than a frame and
// shorter than a held key's repeat, so a run of steps stays one rigid gesture.
let sizingTimer: ReturnType<typeof setTimeout> | undefined;
function markSizing(editorEl: HTMLElement | null) {
  editorEl?.classList.add("editor--sizing");
  clearTimeout(sizingTimer);
  sizingTimer = setTimeout(() => editorEl?.classList.remove("editor--sizing"), 120);
}
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
  // on every move
  const vw = window.innerWidth;
  let frame = 0;
  let pendingX = ev.clientX;
  let moved = false;
  const onMove = (e: PointerEvent) => {
    pendingX = e.clientX;
    moved = true;
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      const w = clampVaultWidth(vw - pendingX);
      markSizing(editorEl);
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
    document.body.style.userSelect = "";
    endResize = () => {};
    // commit once — a press that never moved must not nudge the width by the
    // divider-center offset (the old per-frame flow only wrote after a move too)
    if (moved) width.value = clampVaultWidth(vw - pendingX);
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
  // same rigidity the drag gets: a held arrow repeats faster than the inset's ease
  markSizing((ev.currentTarget as HTMLElement).closest(".editor"));
  ev.preventDefault();
}

const c = useGearList();
const dnd = useItemDnd();
const { hasVault, vaultFetch } = useVaultAccess();

const items = ref<VaultEntry[]>([]);
// The vault's own folders — gear is filed into them by the NAME of the list folder
// it was captured from, so they are already the categories you build with. The pane
// used to drop them on the floor and show one flat list; the Categories tab below is
// what gets a whole "Cook kit" back out in one go.
const vaultFolders = ref<VaultFolder[]>([]);
const tab = ref<"items" | "categories">("items");
const loading = ref(true);
const loadError = ref("");
// one query ref per tab: switching back to a tab you were searching shouldn't hand
// you its results filtered by a term you typed for the other one
const queries = ref<{ items: string; categories: string }>({ items: "", categories: "" });
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
    const res = await vaultFetch<{ items: VaultEntry[]; folders?: VaultFolder[] }>("/api/vault/list");
    items.value = res.items || [];
    vaultFolders.value = res.folders || [];
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

// ---- categories ----
// A vault folder plus the gear filed under it. Built from the SAME loaded rows the
// Items tab shows, so nothing is fetched twice and the two tabs can never disagree
// about what the vault holds. The grouping is /gear's own (shared/vaultView), so a
// category here holds exactly what the folder shows there, in the folder's own order.
const categories = computed(() =>
  // keepEmpty: false — an empty vault folder is a filing artefact, not a template
  // worth offering; and no unfiled section, since unfiled gear lives on the Items tab
  groupVaultRows(items.value, vaultFolders.value, { keepEmpty: false })
    .filter((s) => s.folder)
    .map((s) => ({
      id: s.folder!.id,
      name: s.folder!.name,
      entries: s.entries,
      weightMg: s.weightMg,
      // every piece of it is already on the list — the same rule the item rows
      // use, resolved for the whole set so the button can say so
      allInList: s.entries.length > 0 && s.entries.every((e) => inList.value.has(e.normKey)),
    })),
);

// name-only match: a category has no brand/variant to fuzzy-rank, and the set is
// small enough to scan
const filteredCategories = computed(() => {
  // folded both sides — category names come from folder names, which are stored tidied
  const q = foldApostrophes(query.value.trim().toLowerCase());
  if (!q) return categories.value;
  return categories.value.filter((c) => foldApostrophes(c.name.toLowerCase()).includes(q));
});

function addCategory(cat: { name: string; entries: VaultEntry[] }) {
  const id = c.addVaultFolder(cat.name, cat.entries);
  if (id) emit("added", cat.name);
}

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
// has 100+ entries and scrolling it must stay the default reading of a swipe.

// the entry whose press turned into a drag, so the click that follows pointerup is
// swallowed instead of adding the thing a second time
let draggedEntryId: number | null = null;

const rowPress = createPressArm<VaultEntry>({
  threshold: 5,
  touchHoldMs: 250,
  onDrag(entry, ev) {
    draggedEntryId = entry.id;
    // the pane owns what a drop MEANS — it creates the row and enforces its own
    // one-per-list rule; the gesture only resolves where the pointer let go
    dnd.startInsert((folderId, beforeId) => {
      if (isInList(entry)) return;
      const id = c.addVaultItem(entry, folderId);
      if (id && beforeId) c.moveItem(id, folderId, beforeId, null);
    }, ev);
  },
});

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
  c.addVaultItem(entry, targetFolderId.value);
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
const listEl = useTemplateRef<HTMLElement>("listEl");
let touchStartY = 0;

function onSheetTouchStart(ev: TouchEvent) {
  touchStartY = ev.touches[0]?.clientY ?? 0;
}

function onSheetTouchMove(ev: TouchEvent) {
  if (ev.touches.length !== 1) return; // a pinch, not a scroll
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

// The pane can unmount mid-gesture — Escape closes it, and a drop can land it in a
// state the parent tears down — so both pointer loops are stopped here rather than
// only on their own pointerup. Otherwise their window listeners outlive the
// component and keep its whole setup scope (the full vault array) reachable.
onBeforeUnmount(() => {
  rowPress.end();
  endResize();
});

onKeyStroke("Escape", () => emit("close"));

// Sign in without losing the vault behind it — the account opens over this page.
const { open: openAccount } = useAccountModal();
// folder ids are STRINGS in the editor (the vault page's are numeric rows) — no cast
const targetOptions = computed(() => folders.value.map((f) => ({ key: f.id, label: f.name })));
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
      <NuxtLink v-if="hasVault" to="/gear" class="btn btn--quiet vp__open" title="Open My Gear as a full page">
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
      <p class="t-sm t-muted">
        Your gear is one pick away on every list, but it needs an account.
      </p>
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
          v-for="t in (['items', 'categories'] as const)"
          :key="t"
          type="button"
          role="tab"
          class="vp__tab"
          :class="{ 'is-active': tab === t }"
          :aria-selected="tab === t"
          @click="tab = t"
        >
          {{ t === "items" ? "Items" : "Categories" }}
          <span class="vp__tabcount t-num">{{ t === "items" ? items.length : categories.length }}</span>
        </button>
      </div>

      <div class="vp__controls">
        <!-- the field and its own clear — SearchField, the same control /gear draws -->
        <SearchField
          ref="searchEl"
          v-model="query"
          :placeholder="tab === 'items' ? 'Search gear…' : 'Search categories…'"
          :label="tab === 'items' ? 'Search gear' : 'Search categories'"
        />
        <!-- the destination picker is meaningless on Categories — a cloned category
             brings its own folder with it -->
        <div v-if="folders.length && tab === 'items'" class="vp__target">
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

      <!-- CATEGORIES: a whole set, added in one go. No drag here — a category brings
           its own folder, so there is no destination to aim at, and the click is the
           entire interaction. -->
      <ul v-else-if="tab === 'categories' && filteredCategories.length" class="vp__list">
        <li v-for="cat in filteredCategories" :key="cat.id">
          <button
            type="button"
            class="vp__add"
            :disabled="cat.allInList"
            :aria-label="
              cat.allInList
                ? `Every item in ${cat.name} is already in this list`
                : `Add the ${cat.name} category to the list`
            "
            @click="addCategory(cat)"
          >
            <span class="gear__main">
              <span class="gear__name t-clip">{{ cat.name }}</span>
              <span class="t-sm vp__inlist">
                {{ cat.allInList ? "Already added" : `${cat.entries.length} item${cat.entries.length === 1 ? "" : "s"}` }}
              </span>
            </span>
            <span class="t-num t-sm vp__w">{{ formatWeight(cat.weightMg, unit, { withUnit: false }) }}<span class="t-muted"> {{ unit }}</span></span>
            <!-- A check when it's IN the list, and nothing when it isn't. The "+" that
                 used to sit here was the same glyph on every row of a panel whose one
                 job is adding — it said what the panel already says, forty times. The
                 column stays reserved so a row gaining its check shifts nothing. -->
            <span class="vp__icon" aria-hidden="true">
              <HugeiconsIcon :icon="CheckIcon" v-if="cat.allInList" :size="16" :stroke-width="2" class="vp__added" />
            </span>
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
            :disabled="isInList(entry)"
            :aria-label="
              isInList(entry)
                ? `${itemDisplayName(entry.brand, entry.name, entry.variant)} is already in this list`
                : `Add ${itemDisplayName(entry.brand, entry.name, entry.variant)} to the list`
            "
            @pointerdown="onRowPointerDown(entry, $event)"
            @click="onRowClick(entry)"
          >
            <span class="gear__main">
              <span class="gear__name t-clip">
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
                   nobody can act on. -->
              <span v-if="isInList(entry)" class="t-sm vp__inlist">Already added</span>
            </span>
            <span class="t-num t-sm vp__w">{{ formatWeight(entry.weightMg, unit, { withUnit: false }) }}<span class="t-muted"> {{ unit }}</span></span>
            <span class="vp__icon" aria-hidden="true">
              <HugeiconsIcon :icon="CheckIcon" v-if="isInList(entry)"
                :size="16"
                :stroke-width="2"
                class="vp__added" />
            </span>
          </button>
        </li>
      </ul>

      <p v-else-if="query" class="t-sm t-muted vp__note">Nothing here matches “{{ query }}”.</p>
      <!-- the two tabs fail differently: an empty vault has no gear yet, an empty
           Categories tab has gear that was never filed into one -->
      <div v-else-if="tab === 'categories'" class="vp__empty">
        <p class="t-sm t-muted">
          No categories yet. Gear files itself under the folder you add it to, so build a
          list with folders and they’ll show up here to reuse.
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
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border-radius: var(--popover-item-radius);
  font-size: var(--text-base);
  color: var(--ink-3);
  cursor: pointer;
  transition:
    background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.vp__tab:hover {
  color: var(--ink);
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
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.vp__open:hover,
.vp__open:focus-visible {
  color: var(--ink);
}
.vp__controls {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
/* the search field, its clear and their touch target are SearchField's own */
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
     The bottom is deeper than the top and reaches for the safe area, because below
     $bp-full this panel is a BOTTOM SHEET: 12px left the sign-in button sitting on the
     sheet's own edge, and on a phone that edge is where the home indicator lives. The
     max() keeps the desktop panel at a normal step, since env() resolves to 0 there. */
  padding-block: var(--space-2) max(var(--space-5), env(safe-area-inset-bottom));
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
   viewport so the rows you're adding to stay visible above it. */
@media (max-width: $bp-full) {
  .vp {
    top: auto;
    right: var(--space-3);
    bottom: var(--space-3);
    left: var(--space-3);
    width: auto;
    max-height: min(27.5rem, 55dvh);
  }
  /* A FIXED height, not a max, once there's gear to browse. As a max, the sheet
     shrank to fit whatever the filter left — so typing into the search resized the
     surface under your thumb, and clearing it snapped it back. The rows move; the
     thing holding them shouldn't. (Desktop needs no equivalent: the column is
     pinned top and bottom, so it's already a fixed height.)
     27.5rem = 440px, on the 8px grid. The dvh clamp still wins on a short phone —
     the sheet must not eat the list it sits beside — so the height is fixed per
     device rather than always literally 440. */
  .vp--sized {
    height: min(27.5rem, 55dvh);
  }
  /* nothing to resize when the sheet spans the gutters */
  .vp__resize {
    display: none;
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
   Entrance leads with opacity on the quicker --dur while the travel settles on the
   spring; the exit stays quicker than the entrance, the same asymmetry .menu and
   .toast use. (The global prefers-reduced-motion rule in main.scss flattens both.)

   The EXIT is not the menus' exit, though, and shouldn't be. A menu is a small
   object popping off a control, so it leaves flat and in 120ms. This is a
   full-height column, 23rem wide before anyone drags the divider, and at that size
   the same treatment read as the panel being deleted rather than dismissed — 8px of
   travel is invisible on a surface that wide, so all you saw was a large rectangle
   blinking off. It leaves the way
   it arrived instead: back out to the edge it lives on, far enough to read as
   travel (--space-4, the entrance's distance and then some), on --ease-in — the
   token that exists for exactly this, floating chrome ACCELERATING away rather
   than easing into a stop that isn't there. Opacity runs slightly ahead of the
   move so it's spent before the offset lands and never clips at the end.
   Still well short of the entrance: --dur out against --dur-slow in.

   The LIST moves with it. GearEditor eases its own inset over the same durations
   (see .editor--split there), so the column gives up the space as the pane arrives
   and flows back into it as the pane goes — one movement, not a panel animating
   over a page that already jumped. */
.vaultpane-enter-active {
  transition:
    opacity var(--dur) var(--ease),
    transform var(--dur-slow) var(--ease-spring);
}
.vaultpane-leave-active {
  transition:
    opacity calc(var(--dur) * 0.8) var(--ease-in),
    transform var(--dur) var(--ease-in);
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
