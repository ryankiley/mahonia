<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { Add01Icon, CheckIcon, CircleXIcon } from "@hugeicons/core-free-icons";
import type { VaultEntry, VaultFolder } from "~~/shared/vault";
import { vaultNormKey } from "~~/shared/vault";
import { rankVaultRows } from "~~/shared/vaultSearch";
import { highlightParts } from "~~/shared/catalogSearch";
import { formatWeight, itemDisplayName } from "~~/shared/weights";

// The vault's BODY — the gear you own, browsable and pickable, rendered inside the
// editor's side panel as its "Gear vault" tab. It used to be a whole pane (its own
// fixed positioning, head, close button, resize divider and bottom-sheet behaviour);
// that shell now belongs to SidePanel, which the lists nav shares, and only what's
// specific to browsing gear is left here.
//
// The `vp__` class prefix is kept from when this WAS the pane. It still reads as
// "the vault's own markup", and renaming forty selectors mid-restructure would have
// bought nothing but risk.
//
// Deliberately NON-MODAL, still: no backdrop, no focus trap, and the list stays
// fully interactive beside it. Packing is a back-and-forth (add a thing, look at
// what the total did, add another), and a modal would make you close and reopen for
// every glance.
//
// Rendered via <LazyVaultBrowser>, so this component AND the shared vault module it
// imports stay a separate chunk. That matters more now than it did as a pane: the
// panel around it is on screen at first paint, so if this rode along with it the
// vault would be on the editor's first load for everyone, including the majority who
// have no account.
const emit = defineEmits<{ added: [string] }>();

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
    const res = await vaultFetch<{ items: VaultEntry[]; folders?: VaultFolder[] }>("/api/vault/list");
    items.value = res.items || [];
    vaultFolders.value = res.folders || [];
  } catch {
    loadError.value = "Couldn’t load your gear vault.";
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

// clearing returns you to the field, not to nowhere — you cleared it to type again
function clearQuery() {
  query.value = "";
  searchEl.value?.focus();
}

// ---- categories ----
// A vault folder plus the gear filed under it. Built from the SAME loaded rows the
// Items tab shows, so nothing is fetched twice and the two tabs can never disagree
// about what the vault holds.
const categories = computed(() => {
  const byFolder = new Map<number, VaultEntry[]>();
  for (const e of items.value) {
    if (e.folderId == null) continue; // unfiled gear lives on the Items tab only
    const bucket = byFolder.get(e.folderId);
    if (bucket) bucket.push(e);
    else byFolder.set(e.folderId, [e]);
  }
  return vaultFolders.value
    .map((f) => {
      const entries = byFolder.get(f.id) ?? [];
      return {
        id: f.id,
        name: f.name,
        entries,
        weightMg: entries.reduce((sum, e) => sum + e.weightMg, 0),
        // every piece of it is already on the list — the same rule the item rows
        // use, resolved for the whole set so the button can say so
        allInList: entries.length > 0 && entries.every((e) => inList.value.has(e.normKey)),
      };
    })
    // an empty vault folder is a filing artefact, not a template worth offering
    .filter((c) => c.entries.length > 0);
});

// name-only match: a category has no brand/variant to fuzzy-rank, and the set is
// small enough to scan
const filteredCategories = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return categories.value;
  return categories.value.filter((c) => c.name.toLowerCase().includes(q));
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
  add(entry);
}

function add(entry: VaultEntry) {
  if (isInList(entry)) return;
  c.addVaultItem(entry, targetFolderId.value);
}

// The bottom sheet's touch guard lives in SidePanel now — it has to answer swipes
// on the panel's own chrome as well as on these rows, and that chrome is the shell's.
// The rows carry `data-panel-scroller` so the shell can find the scroller without
// reaching in for a ref.

// This can unmount mid-gesture — switching tabs, or a drop landing the editor in a
// state the parent tears down — so the press loop is stopped here rather than only
// on its own pointerup. Otherwise its window listeners outlive the component and
// keep the whole setup scope (the full vault array) reachable.
onBeforeUnmount(() => rowPress.end());
</script>

<template>
  <!-- vp--sized once there's a vault to browse: that's the state whose height has to
       hold still while you filter it (the shell's sheet is a fixed height on a phone,
       so this fills it). The signed-out explainer is a short block of prose and sizes
       to itself. -->
  <div class="vb" :class="{ 'vp--sized': hasVault }">
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
           what to do about it. (Was two full sentences, which is a wall in a 368px
           column and longer than the thing it describes.)
           WORD FOR WORD the /vault page's prompt. It is the same question asked in
           two places, and answering it twice in two voices is how a product starts
           sounding like two products. Change one, change both. -->
      <p class="t-sm t-muted">
        Your gear is one pick away on every list, but it needs an account.
      </p>
      <NuxtLink to="/account" class="btn btn--primary">Sign in</NuxtLink>
    </div>

    <template v-else>
      <!-- Items / Categories. Both tabs read the SAME loaded rows — one is the gear,
           the other is the sets you've built out of it — so switching costs nothing
           and the two can't disagree. The search below belongs to whichever is open,
           which is what keeps the panel self-sufficient: finding gear never reaches
           out into the editor's chrome. -->
      <div class="vp__tabs" role="tablist" aria-label="Vault view">
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
        <!-- our own clear, not the platform's: WebKit's cancel button is a filled
             blue circle-x, the only colour in the chrome (suppressed in
             atoms/controls.scss). This is the same glyph in the site's ink. -->
        <div class="vp__searchwrap">
          <input
            ref="searchEl"
            v-model="query"
            class="field well vp__search"
            type="search"
            :placeholder="tab === 'items' ? 'Search gear…' : 'Search categories…'"
            :aria-label="tab === 'items' ? 'Search gear' : 'Search categories'"
          />
          <button
            v-if="query"
            type="button"
            class="vp__clear"
            aria-label="Clear search"
            title="Clear search"
            @click="clearQuery"
          >
            <HugeiconsIcon :icon="CircleXIcon" :size="16" :stroke-width="2" />
          </button>
        </div>
        <!-- the destination picker is meaningless on Categories — a cloned category
             brings its own folder with it -->
        <label v-if="folders.length && tab === 'items'" class="vp__target">
          <span class="t-sm t-muted">Add to</span>
          <select v-model="targetFolderId" class="field vp__select" aria-label="Folder to add into">
            <option v-for="f in folders" :key="f.id" :value="f.id">{{ f.name }}</option>
          </select>
        </label>
      </div>

      <p v-if="loadError" class="t-sm vp__error">{{ loadError }}</p>
      <p v-else-if="loading" class="t-sm t-muted vp__note">Loading your gear…</p>

      <!-- CATEGORIES: a whole set, added in one go. No drag here — a category brings
           its own folder, so there is no destination to aim at, and the click is the
           entire interaction. -->
      <ul v-else-if="tab === 'categories' && filteredCategories.length" data-panel-scroller class="vp__list">
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
              <span class="gear__name">{{ cat.name }}</span>
              <span class="t-sm vp__inlist">
                {{ cat.allInList ? "Already added" : `${cat.entries.length} item${cat.entries.length === 1 ? "" : "s"}` }}
              </span>
            </span>
            <span class="t-num t-sm vp__w">{{ formatWeight(cat.weightMg, unit, { withUnit: false }) }}<span class="t-muted"> {{ unit }}</span></span>
            <span class="vp__icon" aria-hidden="true">
              <HugeiconsIcon :icon="CheckIcon" v-if="cat.allInList" :size="16" :stroke-width="2" class="vp__added" />
              <HugeiconsIcon :icon="Add01Icon" v-else :size="16" :stroke-width="2" />
            </span>
          </button>
        </li>
      </ul>

      <ul v-else-if="tab === 'items' && filtered.length" data-panel-scroller class="vp__list">
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
              <span class="gear__name">
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
              <HugeiconsIcon :icon="Add01Icon" v-else :size="16" :stroke-width="2" />
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
          Your gear vault is empty. Add gear to this list and it’ll collect itself here.
        </p>
      </div>
    </template>
  </div>
</template>

<style scoped lang="scss">
/* The body fills whatever the shell gives it and owns its own scroller, so the page
   behind keeps its scroll position while you work through the vault. Position, size,
   surface and elevation are all SidePanel's — this file is what's inside.
   The .popover custom properties the rows consume (--popover-item-radius,
   --popover-hover) are inherited from that shell, which wears the atom. */
.vb {
  display: flex;
  flex-direction: column;
  min-height: 0; /* a flex child that scrolls must be allowed to shrink past content */
  flex: 1 1 auto;
}
/* the rows carry their own --space-2 inline padding, so the controls need the same
   inset to line up with them rather than hugging the card edge */
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
}
.vp__tab {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-2);
  border: 0;
  border-radius: var(--popover-item-radius);
  background: transparent;
  font: inherit;
  font-size: var(--text-sm);
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
.vp__controls {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.vp__searchwrap {
  position: relative;
  display: flex;
  align-items: center;
}
/* the tint is the shared .well atom (controls.scss) — CONTAINED, not a hairline
   rule: search is the one control you reach for in this panel, and an underline
   reads as a caption with a line under it rather than a box you can type in. */
.vp__search {
  width: 100%;
  padding-inline: var(--space-3);
  /* room for the clear button, so a long query doesn't run under it */
  padding-right: var(--space-5);
}
/* Sits ON the field rather than beside it: the rule under the input is the field's
   whole visible boundary, and a sibling button would either break that line or push
   the input narrower whenever a query exists (a field that resizes as you type). */
.vp__clear {
  position: absolute;
  right: 0;
  display: inline-flex;
  align-items: center;
  padding: 0;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.vp__clear:hover,
.vp__clear:focus-visible {
  color: var(--ink);
}
/* touch: the clear meets the --tap minimum (controls.scss); it overlays the
   field's end, so the bigger box only widens its hit area, not the layout */
@media (pointer: coarse) {
  .vp__clear {
    justify-content: center;
    min-width: var(--tap);
    min-height: var(--tap);
  }
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
/* CENTRED in the panel, both ways. These states have no rows to align to — they're
   a sentence about why the panel is empty — so left-aligning them at the top left
   them hanging off the corner of a tall card with nothing under them. Taking the
   free height (flex: 1) and centring in it makes the message the content of the
   panel rather than a note at the top of an empty one.
   A measure, because a centred line that runs the panel's full width is hard to
   come back from at the start of each line. */
.vp__empty {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  /* padding-BLOCK, not the shorthand: this block also matches the shared
     padding-inline rule above, and a `padding: x 0 y` shorthand silently zeroes the
     inline half of it — which left the empty state's text one full step to the left
     of the header above it and the rows below it. */
  padding-block: var(--space-2) var(--space-3);
  text-align: center;
}
/* `balance`, not the tooltip's `pretty`: pretty only protects the LAST line, which
   still leaves the two above it ragged, and centred text makes a ragged edge read as
   a mistake. balance evens every line, so a short block can't end on a single stranded
   word — which is what "any device." was doing. It's capped at a handful of lines in
   every engine that implements it, and these blocks are two or three; unsupported
   engines just wrap normally. */
.vp__empty p {
  max-width: 30ch;
  text-wrap: balance;
}

/* A coarse pointer grows the mode toggle (28px → 40px), so the topbar grows with
   it — follow it down. Only reachable on a touch screen WIDER than $bp-full (the
   pane is a bottom sheet below that), i.e. a touch laptop. */
/* The sheet holds a FIXED height once there's gear to browse. As a bare max on the
   shell it shrank to fit whatever the filter left — so typing into the search
   resized the surface under your thumb, and clearing it snapped it back. The rows
   move; the thing holding them shouldn't.
   Expressed as a floor here and a ceiling on the shell (--sheet-h, which the shell
   also sets — so the pair can't drift), which between them pin the height exactly
   while still letting the SIGNED-OUT explainer size to its own two sentences: it
   never takes .vp--sized, so only the ceiling applies to it.
   Desktop needs no equivalent — the panel is pinned top and bottom there, so it's
   already a fixed height. */
@media (max-width: $bp-full) {
  .vp--sized {
    min-height: var(--sheet-h);
  }
}
</style>
