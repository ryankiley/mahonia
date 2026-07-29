<script setup lang="ts">
import { ChevronDown, CircleX, Trash2, Undo2 } from "@lucide/vue";
import type { Unit } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import { formatWeightAuto, itemDisplayName } from "~~/shared/weights";

// The vault — every piece of gear you've put in a list, in one place, so building
// the next list is picking rather than retyping.
//
// Owned by a LINK, like everything else here: no account, no sign-in. This page is
// also where that link is handed to you, since it's the one thing you have to keep
// to carry the vault to another device.
//
// noindex: it's one person's possessions and there is nothing here for a crawler.
useHead({
  title: "Your vault — Mahonia",
  meta: [{ name: "robots", content: "noindex" }],
});

const { token, hasVault, setToken, forget, vaultFetch } = useVaultToken();

// ---- arriving from a transfer link ---------------------------------------
// /vault#<token> is how a vault reaches a second device. The token rides in the
// FRAGMENT, which browsers never send to the server — the same reason a list's
// edit token lives there. Adopt it, then strip it from the address bar so it isn't
// left sitting in history or in a screenshot of the URL.
onMounted(() => {
  const fromLink = location.hash.replace(/^#/, "").trim();
  if (!fromLink) return;
  if (fromLink !== token.value) {
    setToken(fromLink);
    resetVaultCapture(); // don't inherit the previous vault's "already sent"
  }
  history.replaceState(null, "", location.pathname + location.search);
});

// ---- handing the link to another device ----------------------------------
const transferUrl = computed(() =>
  token.value && import.meta.client ? `${location.origin}/vault#${token.value}` : "",
);
const showTransfer = ref(false);
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

async function copyTransfer() {
  if (!(await copyText(transferUrl.value))) return;
  copied.value = true;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => (copied.value = false), 2000);
}
onBeforeUnmount(() => clearTimeout(copyTimer));

const { confirm: askConfirm } = useDialogs();
async function forgetVault() {
  if (
    !(await askConfirm({
      title: "Forget this vault here?",
      message:
        "Your gear stays where it is, and the link still opens it. This browser just stops holding it — so keep the link if you want it back.",
      confirmLabel: "Forget",
    }))
  )
    return;
  forget();
  items.value = [];
  resetVaultCapture();
}

// ---- the gear ------------------------------------------------------------
const items = ref<VaultEntry[]>([]);
const loading = ref(false);
const loadError = ref("");
const query = ref("");
const searchEl = useTemplateRef<HTMLInputElement>("searchEl");
// clearing returns you to the field, not to nowhere — you cleared it to type again
function clearQuery() {
  query.value = "";
  searchEl.value?.focus();
}

async function loadVault() {
  if (!hasVault.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    const res = await vaultFetch<{ items: VaultEntry[] }>("/api/vault/list");
    items.value = res.items || [];
  } catch {
    loadError.value = "Couldn’t load your vault. Check your connection and try again.";
  }
  loading.value = false;
}
// load once we know whether this device holds a vault, and again if that changes
// (a transfer link adopted above, or another tab minting one)
watch(hasVault, (v) => (v ? loadVault() : (items.value = [])), { immediate: true });

// Plain substring filter, not the trigram ranker: this is a list you're LOOKING
// at, so narrowing it should be literal and predictable. Fuzzy matching belongs in
// the autocomplete, where you're typing a name you can't quite remember.
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return items.value;
  return items.value.filter((i) =>
    `${i.brand ?? ""} ${i.name} ${i.variant ?? ""} ${i.commonName ?? ""}`.toLowerCase().includes(q),
  );
});

const totalMg = computed(() => filtered.value.reduce((sum, i) => sum + i.weightMg, 0));

// ---- units ---------------------------------------------------------------
// The vault has no list to inherit a unit from, so it takes its default from the
// most recent list on this device (whatever system you already work in) and
// remembers an explicit choice from there.
const UNIT_KEY = "gear.vault.system.v1";
const system = ref<"metric" | "imperial">("metric");
onMounted(() => {
  const saved = localStorage.getItem(UNIT_KEY);
  if (saved === "metric" || saved === "imperial") {
    system.value = saved;
    return;
  }
  const recent = [...useMyLists().entries.value].sort((a, b) => b.lastOpened - a.lastOpened)[0];
  system.value = unitSystem(recent?.displayUnit);
});
function unitSystem(u?: Unit): "metric" | "imperial" {
  return u === "oz" || u === "lb" ? "imperial" : "metric";
}
function setSystem(next: "metric" | "imperial") {
  system.value = next;
  try {
    localStorage.setItem(UNIT_KEY, next);
  } catch {
    // storage blocked — the choice still holds for this visit
  }
}
const weightLabel = (mg: number) => formatWeightAuto(mg, { system: system.value });

// ---- remove + undo -------------------------------------------------------
// No confirm dialog: removing gear is small, reversible, and something you'd do
// several times in a row while tidying. An immediate removal with an undo beats a
// modal per row. (Deleting a whole LIST keeps its dialog — that one isn't
// reversible.)
const removing = ref<number | null>(null);
const undoable = ref<VaultEntry | null>(null);
let undoTimer: ReturnType<typeof setTimeout> | undefined;

async function remove(entry: VaultEntry) {
  removing.value = entry.id;
  loadError.value = "";
  try {
    await vaultFetch("/api/vault/remove", { method: "POST", body: { id: entry.id } });
    items.value = items.value.filter((i) => i.id !== entry.id);
    undoable.value = entry;
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => (undoable.value = null), 10_000);
  } catch {
    loadError.value = "Couldn’t remove that. Check your connection and try again.";
  }
  removing.value = null;
}

async function undoRemove() {
  const entry = undoable.value;
  if (!entry) return;
  undoable.value = null;
  clearTimeout(undoTimer);
  try {
    await vaultFetch("/api/vault/remove", { method: "POST", body: { id: entry.id, restore: true } });
    await loadVault();
  } catch {
    loadError.value = "Couldn’t put that back. Check your connection and try again.";
  }
}
onBeforeUnmount(() => clearTimeout(undoTimer));

</script>

<template>
  <div>
    <SiteTopbar>
      <NuxtLink to="/e" class="btn btn--link">Create a list</NuxtLink>
    </SiteTopbar>

    <main id="main-content" tabindex="-1" class="wrap page">
      <div class="vault__head">
        <h1 class="t-title">Your vault</h1>
        <p class="t-sm t-muted vault__sub">Every piece of gear you’ve put in a list, in one place.</p>
      </div>

      <ClientOnly>
        <!-- no vault yet: nothing to sign up for, just an explanation -->
        <div v-if="!hasVault" class="vault__auth">
          <p class="vault__sentline">Your vault fills itself.</p>
          <p class="t-sm t-muted">
            Add gear to a list and it lands here — weights, brands and all — ready to pull into
            the next list without retyping. There’s nothing to sign up for.
          </p>
          <NuxtLink to="/e" class="btn btn--primary">Start a list</NuxtLink>
        </div>

        <!-- the gear -->
        <div v-else>
          <div class="vault__bar">
            <div class="vault__searchwrap">
              <input
                ref="searchEl"
                v-model="query"
                class="field vault__search"
                type="search"
                placeholder="Search gear…"
                aria-label="Search gear"
              />
              <!-- our own clear, in the site's ink — WebKit's native one is a filled
                   blue circle-x (suppressed in atoms/controls.scss) -->
              <button
                v-if="query"
                type="button"
                class="vault__clear"
                aria-label="Clear search"
                title="Clear search"
                @click="clearQuery"
              >
                <CircleX :size="15" :stroke-width="2" />
              </button>
            </div>
          </div>

          <p v-if="loadError" class="t-sm vault__error">{{ loadError }}</p>

          <p v-if="loading" class="t-muted vault__empty">Loading your gear…</p>

          <template v-else-if="filtered.length">
            <p class="t-sm t-muted vault__count">
              {{ filtered.length }} {{ filtered.length === 1 ? "item" : "items" }} ·
              <!-- The total IS the unit control, the same object the editor's
                   TotalsBar puts up: figure, chevron, and a transparent native
                   select laid over the pair. A separate g/oz toggle sat off in the
                   search bar, away from the only number it governed. -->
              <span class="vault__total">
                {{ weightLabel(totalMg) }}
                <ChevronDown class="vault__chev" :size="14" :stroke-width="2.25" aria-hidden="true" />
                <select
                  class="vault__unitsel"
                  title="Change unit"
                  aria-label="Weight unit"
                  :value="system"
                  @change="setSystem(($event.target as HTMLSelectElement).value as 'metric' | 'imperial')"
                >
                  <option value="metric">g</option>
                  <option value="imperial">oz</option>
                </select>
              </span>
            </p>
            <ul class="vault__list">
              <li v-for="entry in filtered" :key="entry.id" class="vault__row">
                <div class="vault__main">
                  <p class="vault__name">
                    <span v-if="entry.brand" class="vault__brand">{{ entry.brand }}</span>
                    <span>{{ entry.name }}</span>
                    <span v-if="entry.variant" class="vault__variant">· {{ entry.variant }}</span>
                  </p>
                  <p v-if="entry.commonName" class="t-sm t-muted vault__meta">{{ entry.commonName }}</p>
                </div>
                <span class="t-num vault__weight">{{ weightLabel(entry.weightMg) }}</span>
                <button
                  type="button"
                  class="btn btn--quiet vault__remove"
                  :disabled="removing === entry.id"
                  :aria-label="`Remove ${itemDisplayName(entry.brand, entry.name, entry.variant)} from your vault`"
                  @click="remove(entry)"
                >
                  <Trash2 :size="14" aria-hidden="true" /> Remove
                </button>
              </li>
            </ul>
          </template>

          <div v-else-if="query" class="vault__empty">
            <p class="t-muted">Nothing here matches “{{ query }}”.</p>
          </div>

          <div v-else class="vault__empty">
            <p class="t-muted">
              Your vault is empty. Add gear to a list and it’ll show up here on its own.
            </p>
            <NuxtLink to="/e" class="btn btn--primary">Create a list</NuxtLink>
          </div>

          <!-- The link IS the vault. This is the only place it's shown, and it's
               behind a disclosure rather than on screen by default: it's a
               capability, so it shouldn't be sitting in a screenshot or over
               someone's shoulder while they browse their own gear. -->
          <div class="vault__transfer">
            <button
              type="button"
              class="btn btn--quiet vault__disclose"
              :aria-expanded="showTransfer"
              @click="showTransfer = !showTransfer"
            >
              {{ showTransfer ? "Hide the link" : "Open this vault on another device" }}
            </button>
            <div v-if="showTransfer" class="vault__transferbody">
              <p class="t-sm t-muted">
                This link <em>is</em> your vault — anyone with it can see and change your gear, so
                send it only to yourself. Open it on another device and that device holds the
                vault too.
              </p>
              <div class="vault__linkrow">
                <input
                  class="field vault__linkfield"
                  :value="transferUrl"
                  readonly
                  aria-label="Link to this vault"
                  @focus="($event.target as HTMLInputElement).select()"
                />
                <button type="button" class="btn" @click="copyTransfer">
                  {{ copied ? "Copied" : "Copy" }}
                </button>
              </div>
              <p class="t-sm t-muted">
                Keep it somewhere you'll find it. There's no account and no email, so a lost link
                can't be recovered — though a fresh vault refills itself as you open your lists
                again.
              </p>
              <button type="button" class="btn btn--quiet vault__forget" @click="forgetVault">
                Forget this vault on this device
              </button>
            </div>
          </div>
        </div>

        <!-- No third branch: with accounts there was a "still resolving the
             session" state to sit in, but the vault token is read from
             localStorage synchronously at setup, so on the client we always know
             which of the two above applies. The #fallback below covers SSR. -->
        <template #fallback>
          <p class="t-muted vault__empty">Loading…</p>
        </template>
      </ClientOnly>
    </main>

    <!-- Removal lands as the site's undo toast, the same object the editor puts up
         when you remove an item — same surface, same "Removed <thing> · Undo"
         shape, same place on screen. It was an inline line in the content flow,
         which pushed the list down as it appeared and read as a status message
         rather than as an action you still have. The 10s window is unchanged; it
         just lives somewhere you don't have to be scrolled to the top to see. -->
    <Transition name="toast">
      <div v-if="undoable" class="toast undobar">
        <span class="t-sm">
          Removed <strong>{{ itemDisplayName(undoable.brand, undoable.name, undoable.variant) }}</strong>
        </span>
        <button class="undobar__btn t-sm" @click="undoRemove">
          <Undo2 :size="14" /> Undo
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
.page {
  padding-block: var(--space-5) var(--space-9);
}
.vault__head {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-bottom: var(--space-6);
}
.vault__sub {
  max-width: 56ch;
}
.vault__auth {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 44ch;
}
/* the shared .field is deliberately borderless (it sits inside list rows, where a
   box would be noise). On a standalone sign-in form there's nothing to show where
   to click, so give it the same bottom rule the editor's title field carries —
/* the passkey path, as a sentence rather than a second black button — it inherits
   the surrounding muted prose and only deepens on hover, like every other inline
/* same treatment for the gear search, which is the other standalone field here */
.vault__search {
  border-bottom: 1px solid var(--line);
}
.vault__search:focus {
  border-bottom-color: var(--ink-2);
}
.vault__sentline {
  color: var(--ink);
}
.vault__error {
  color: var(--ink);
}

/* --- the gear --- */
.vault__bar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}
.vault__searchwrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  max-width: 32ch;
}
.vault__search {
  width: 100%;
  /* room for the clear button, so a long query doesn't run under it */
  padding-right: var(--space-5);
}
/* on the field, not beside it — see .vp__clear */
.vault__clear {
  position: absolute;
  right: 0;
  display: inline-flex;
  align-items: center;
  padding: 0;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.vault__clear:hover,
.vault__clear:focus-visible {
  color: var(--ink);
}
/* The total, doubling as the unit control — the editor's .totals__amount recipe at
   this page's smaller type: a relative box holding the figure and its chevron, with
   an invisible native select stretched over both. The select is what's actually
   operated (so it keeps the platform's own picker and its keyboard behaviour); the
   figure and chevron are only what you see. */
.vault__total {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: var(--space-px);
  color: var(--ink-2);
}
.vault__chev {
  flex: none;
  color: var(--ink-3);
  transition: color var(--dur) var(--ease);
}
.vault__total:hover {
  color: var(--ink);
}
/* :has, not a sibling combinator — the select is laid over the pair and comes
   AFTER the chevron in the DOM, so `+` would never match it. The editor's version
   has no focus cue at all; keyboard users deserve the same hint the pointer gets. */
.vault__total:hover .vault__chev,
.vault__total:has(.vault__unitsel:focus-visible) .vault__chev {
  color: var(--ink);
}
.vault__unitsel {
  position: absolute;
  inset: 0;
  width: 100%;
  border: 0;
  opacity: 0; /* invisible — the figure + chevron are the visible affordance */
  cursor: pointer;
}
.vault__count {
  margin-bottom: var(--space-2);
}
/* de-outlined rows, separated by hairlines — matches "Your lists" */
.vault__list {
  list-style: none;
  display: flex;
  flex-direction: column;
}
.vault__row {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  /* same block padding as a row on "Your lists" — they're the same pattern (a
     de-outlined row on a hairline), so they must sit on the same rhythm */
  padding-block: var(--space-4);
}
.vault__row + .vault__row {
  border-top: 1px solid var(--line);
}
.vault__main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-px);
}
/* ONE ellipsized run — the same treatment the vault pane gives this line, and for
   the same reasons. Shrinking the three parts as separate flex items made a long row
   spend three ellipses to say one thing ("Mountain Hardw… Ghost Whisperer UL Hoo… ·
   Men's…"), and squeezed the brand — the shortest, most identifying part — down to a
   sliver that still held its box and its gap, so that row's name started a few pixels
   in and sat out of line with the column.
   Plain inline text truncates once, at the end: every row begins in the same place,
   the brand always survives whole, and what yields is the variant and then the tail
   of the model, which is where the redundancy is. */
.vault__name {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}
/* the gaps are margins, not the whitespace between the tags — Vue's compiler
   condenses a newline between elements away entirely */
.vault__brand {
  margin-right: 0.4ch;
  color: var(--ink-2);
}
.vault__variant {
  margin-left: 0.4ch;
  font-style: italic;
  color: var(--ink-3);
}
.vault__weight {
  flex: none;
  color: var(--ink-2);
  /* a fixed column so the weights line up down the list instead of ragging with
     the name lengths beside them */
  min-width: 5rem;
  text-align: right;
}
.vault__remove {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.vault__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-4);
}
/* the transfer disclosure — a quiet footer affordance, not a call to action. The
   link it reveals is a capability, so nothing about this should invite a casual
   click; it sits below the gear, under a hairline, like the "Your account" link it
   replaced. */
.vault__transfer {
  margin-top: var(--space-7);
  padding-top: var(--space-4);
  border-top: 1px solid var(--line);
}
.vault__transferbody {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin-top: var(--space-3);
  max-width: 44rem;
}
.vault__linkrow {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}
/* the link is long and must not wrap — it reads as one object you copy whole */
.vault__linkfield {
  flex: 1;
  min-width: 0;
  font-variant-numeric: tabular-nums;
}
.vault__forget {
  align-self: flex-start;
}

@media (max-width: $bp-stack) {
  /* the search keeps the full width; the unit toggle drops beneath it */
  .vault__bar {
    flex-wrap: wrap;
  }
  .vault__search {
    max-width: none;
    flex-basis: 100%;
  }
  /* name on its own line, weight + remove beneath — nothing cramped */
  .vault__row {
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .vault__main {
    flex-basis: 100%;
  }
  .vault__weight {
    min-width: 0;
    text-align: left;
  }
    .vault__remove {
    margin-left: auto;
  }
}
</style>
