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

const c = useGearList();
const { hasVault, authHeaders } = useVaultToken();

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
    const res = await $fetch<{ items: VaultEntry[] }>("/api/vault/list", { headers: authHeaders() });
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

// How many of each piece of gear the open list already holds, keyed by the SAME
// identity rule the vault uses — so "Zpacks Duplex" in the list matches the vault
// row whatever the spacing or case. Recomputed from the live snapshot, so it
// updates the moment something is added (here or by typing).
const inListCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const item of c.snapshot.value?.items ?? []) {
    const key = vaultNormKey(item.brand, item.name, item.variant);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
});

// brief per-row acknowledgement, so adding several in a row is legible
const justAdded = ref<Set<number>>(new Set());
const addTimers = new Map<number, ReturnType<typeof setTimeout>>();
function add(entry: VaultEntry) {
  c.addVaultItem(entry, targetFolderId.value);
  justAdded.value = new Set(justAdded.value).add(entry.id);
  clearTimeout(addTimers.get(entry.id));
  addTimers.set(
    entry.id,
    setTimeout(() => {
      const next = new Set(justAdded.value);
      next.delete(entry.id);
      justAdded.value = next;
      addTimers.delete(entry.id);
    }, 1400),
  );
}
onBeforeUnmount(() => {
  for (const t of addTimers.values()) clearTimeout(t);
});

onKeyStroke("Escape", () => emit("close"));
</script>

<template>
  <aside class="popover vp" role="dialog" aria-label="Your vault">
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
        Sign in and every piece of gear you add to a list is kept here, ready to drop into the
        next one.
      </p>
      <NuxtLink to="/vault" class="btn btn--primary">Set up your vault</NuxtLink>
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
        <li v-for="entry in filtered" :key="entry.id" class="vp__row">
          <button
            type="button"
            class="vp__add"
            :aria-label="`Add ${itemDisplayName(entry.brand, entry.name, entry.variant)} to the list`"
            @click="add(entry)"
          >
            <span class="vp__main">
              <span class="vp__name">
                <span v-if="entry.brand" class="vp__brand">{{ entry.brand }}</span>
                <span class="vp__model">{{ entry.name }}</span>
                <span v-if="entry.variant" class="vp__variant">· {{ entry.variant }}</span>
              </span>
              <!-- a quiet count when the open list already holds this thing, so a
                   second pair of socks is a deliberate choice rather than a slip -->
              <span v-if="inListCounts.get(entry.normKey)" class="t-sm vp__inlist">
                {{ inListCounts.get(entry.normKey) }} in this list
              </span>
            </span>
            <span class="t-num t-sm vp__w">{{ formatWeight(entry.weightMg, unit, { withUnit: false }) }}<span class="t-muted"> {{ unit }}</span></span>
            <span class="vp__icon" aria-hidden="true">
              <Check v-if="justAdded.has(entry.id)" :size="15" :stroke-width="2.2" class="vp__added" />
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
  right: var(--space-4);
  z-index: var(--z-float);
  display: flex;
  flex-direction: column;
  width: min(23rem, calc(100vw - 2 * var(--space-4)));
  max-height: min(38rem, calc(100dvh - var(--space-7) - var(--space-5) - var(--space-4)));
  /* the popover edge inset — the same value .menu__list and .ac__menu use, so a
     row's hover tint sits at an identical margin from the card edge in all three */
  padding: var(--space-2);
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
.vp__select {
  flex: 1 1 auto;
  min-width: 0;
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
  padding: 0;
  overflow-y: auto;
  overscroll-behavior: contain; /* reaching the end must not scroll the list behind */
  scrollbar-width: thin;
  scrollbar-color: var(--line-2) transparent;
}
/* the whole row is the button — a small "+" target would be a poor tap area on the
   one surface built for adding many things quickly */
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
.vp__add:hover,
.vp__add:focus-visible {
  background: var(--popover-hover);
}
.vp__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-px);
}
.vp__name {
  display: flex;
  align-items: baseline;
  gap: 0.4ch;
  min-width: 0;
  color: var(--ink);
}
/* same shrink order as the autocomplete: variant yields first, then brand, and the
   model name (the distinguishing part) clings on longest */
.vp__name > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vp__brand {
  flex: 0 100 auto;
  color: var(--ink-2);
}
.vp__model {
  flex: 0 1 auto;
  min-width: 6ch;
}
.vp__variant {
  flex: 0 1000 auto;
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
.vp__icon {
  flex: none;
  display: inline-flex;
  align-self: center;
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
    max-height: min(38rem, calc(100dvh - var(--space-7) - var(--space-6) - var(--space-4)));
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
}
</style>
