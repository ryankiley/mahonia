<script setup lang="ts">
import { Trash2 } from "@lucide/vue";
import type { Unit } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import { formatWeightAuto, itemDisplayName } from "~~/shared/weights";
import { formatMoney, parseMoneyInput } from "~~/shared/money";

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

const { token, hasVault, setToken, forget, authHeaders } = useVaultToken();

// The vault's currency, as the server knows it — used to label costs. Comes back
// with the gear rather than from a second request.
const currency = ref<string | null>(null);

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

async function loadVault() {
  if (!hasVault.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    const res = await $fetch<{ items: VaultEntry[]; currency: string | null }>("/api/vault/list", {
      headers: authHeaders(),
    });
    items.value = res.items || [];
    currency.value = res.currency ?? null;
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

// ---- cost ----------------------------------------------------------------
// What a thing cost belongs with the GEAR, not with any one list — otherwise it
// gets retyped into every list the item appears in. Editing is inline and commits
// on blur or Enter; there's no save button because there's one field.
const totalCents = computed(() =>
  filtered.value.reduce((sum, i) => sum + (i.priceCents ?? 0), 0),
);
const pricedCount = computed(() => filtered.value.filter((i) => i.priceCents != null).length);
const costLabel = (cents: number) => formatMoney(cents, currency.value ?? undefined);

// Which row's cost is being typed into. At rest a cost reads as MONEY ("$699");
// under the caret it's the plain number you'd actually type. Same split the
// editor's weight field uses — a formatted string is for reading, not editing.
const editingPrice = ref<number | null>(null);
const rawPrice = (entry: VaultEntry) =>
  entry.priceCents != null ? (entry.priceCents / 100).toFixed(2) : "";
const priceValue = (entry: VaultEntry) =>
  editingPrice.value === entry.id
    ? rawPrice(entry)
    : entry.priceCents != null
      ? costLabel(entry.priceCents)
      : "";

function onPriceFocus(entry: VaultEntry, e: Event) {
  editingPrice.value = entry.id;
  const el = e.target as HTMLInputElement;
  el.value = rawPrice(entry);
  el.select();
}

async function onPrice(entry: VaultEntry, e: Event) {
  const el = e.target as HTMLInputElement;
  const raw = el.value.trim();
  const next = raw ? parseMoneyInput(raw) : null;
  // unparseable text is not a clear — put the old value back rather than silently
  // wiping a price because someone typed a stray character
  if (raw && next == null) {
    editingPrice.value = null;
    el.value = priceValue(entry);
    return;
  }
  if (next === (entry.priceCents ?? null)) {
    editingPrice.value = null;
    el.value = priceValue(entry);
    return;
  }
  const prior = entry.priceCents;
  // optimistic: the row shows the new figure (and the total moves) immediately
  entry.priceCents = next ?? undefined;
  editingPrice.value = null;
  el.value = priceValue(entry);
  try {
    const res = await $fetch<{ ok: boolean }>("/api/vault/update", {
      method: "POST",
      body: { id: entry.id, priceCents: next },
    });
    if (!res.ok) throw new Error("rejected");
  } catch {
    entry.priceCents = prior;
    el.value = priceValue(entry);
    loadError.value = "Couldn’t save that price. Try again?";
  }
}

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
    await $fetch("/api/vault/remove", { method: "POST", body: { id: entry.id } });
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
    await $fetch("/api/vault/remove", { method: "POST", body: { id: entry.id, restore: true } });
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
        <p class="t-sm t-muted vault__sub">
          Every piece of gear you’ve put in a list, in one place — so the next list is picking,
          not retyping.
        </p>
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
            <input
              v-model="query"
              class="field vault__search"
              type="search"
              placeholder="Search your gear…"
              aria-label="Search your gear"
            />
            <div class="vault__units" role="group" aria-label="Weight units">
              <button
                type="button"
                class="btn btn--quiet"
                :class="{ 'is-on': system === 'metric' }"
                :aria-pressed="system === 'metric'"
                @click="setSystem('metric')"
              >g</button>
              <button
                type="button"
                class="btn btn--quiet"
                :class="{ 'is-on': system === 'imperial' }"
                :aria-pressed="system === 'imperial'"
                @click="setSystem('imperial')"
              >oz</button>
            </div>
          </div>

          <p v-if="loadError" class="t-sm vault__error">{{ loadError }}</p>

          <p v-if="undoable" class="t-sm vault__undo">
            Removed “{{ itemDisplayName(undoable.brand, undoable.name, undoable.variant) }}”.
            <button type="button" class="btn btn--quiet" @click="undoRemove">Undo</button>
          </p>

          <p v-if="loading" class="t-muted vault__empty">Loading your gear…</p>

          <template v-else-if="filtered.length">
            <p class="t-sm t-muted vault__count">
              {{ filtered.length }} {{ filtered.length === 1 ? "item" : "items" }} ·
              {{ weightLabel(totalMg) }}<template v-if="totalCents > 0"> · {{ costLabel(totalCents) }}</template>
              <!-- say so when the total only covers part of the vault, rather than
                   letting it read as the cost of everything -->
              <template v-if="totalCents > 0 && pricedCount < filtered.length">
                <span class="vault__partial"> ({{ pricedCount }} of {{ filtered.length }} priced)</span>
              </template>
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
                <span class="vault__cost">
                  <input
                    class="field t-num vault__costinput"
                    type="text"
                    inputmode="decimal"
                    :value="priceValue(entry)"
                    placeholder="—"
                    :aria-label="`Cost of ${itemDisplayName(entry.brand, entry.name, entry.variant)}`"
                    @focus="onPriceFocus(entry, $event)"
                    @change="onPrice(entry, $event)"
                    @keydown.enter="($event.target as HTMLInputElement).blur()"
                  />
                </span>
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

/* --- sign-in --- */
.vault__auth {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 44ch;
}
.vault__form {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
/* the shared .field is deliberately borderless (it sits inside list rows, where a
   box would be noise). On a standalone sign-in form there's nothing to show where
   to click, so give it the same bottom rule the editor's title field carries —
   the system's existing answer to "this text is editable". */
.vault__email {
  flex: 1 1 auto;
  min-width: 0;
  border-bottom: 1px solid var(--line);
}
.vault__email:focus {
  border-bottom-color: var(--ink-2);
}
/* the button must not be squeezed into two lines by the growing input */
.vault__form .btn {
  flex: none;
  white-space: nowrap;
}
/* the passkey path, as a sentence rather than a second black button — it inherits
   the surrounding muted prose and only deepens on hover, like every other inline
   link on the site */
.vault__pklink {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--ink-2);
  text-decoration: underline;
  text-decoration-color: var(--underline);
  text-underline-offset: 2px;
  cursor: pointer;
}
.vault__pklink:hover {
  color: var(--ink);
  text-decoration-color: var(--ink-2);
}
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
.vault__note {
  max-width: 46ch;
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
.vault__search {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 32ch;
}
.vault__units {
  display: flex;
  gap: var(--space-1);
  margin-left: auto;
}
/* the selected unit is the only chrome that carries weight here — everything else
   on the page is monochrome text, so "on" is a deepened ink, not a fill */
.vault__units .is-on {
  color: var(--ink);
  text-decoration: underline;
  text-decoration-color: var(--ink-2);
  text-underline-offset: 3px;
}
.vault__count {
  margin-bottom: var(--space-2);
}
.vault__undo {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  color: var(--ink);
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
.vault__name {
  display: flex;
  align-items: baseline;
  gap: 0.4ch;
  min-width: 0;
  color: var(--ink);
}
.vault__name > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vault__brand {
  color: var(--ink-2);
}
.vault__variant {
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
.vault__cost {
  flex: none;
  display: inline-flex;
  justify-content: flex-end;
  min-width: 6rem;
}
/* .field is borderless by design; here the rule only appears on hover/focus, so a
   column of empty costs reads as quiet placeholders rather than a wall of boxes */
.vault__costinput {
  width: 100%;
  text-align: right;
  color: var(--ink-2);
  border-bottom: 1px solid transparent;
}
.vault__costinput:hover {
  border-bottom-color: var(--line);
}
.vault__costinput:focus {
  color: var(--ink);
  border-bottom-color: var(--ink-2);
}
.vault__partial {
  color: var(--ink-3);
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
/* --- passkeys --- */
.vault__footer {
  margin-top: var(--space-4);
  padding-top: 0;
  border-top: 0;
}
.vault__footer {
  margin-top: var(--space-7);
  padding-top: var(--space-4);
  border-top: 1px solid var(--line);
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
  /* the field and its button stack rather than squeezing on a phone */
  .vault__form {
    flex-direction: column;
    align-items: stretch;
  }
  /* the search keeps the full width; the unit toggle drops beneath it */
  .vault__bar {
    flex-wrap: wrap;
  }
  .vault__search {
    max-width: none;
    flex-basis: 100%;
  }
  .vault__units {
    margin-left: 0;
  }
  /* name on its own line, weight + cost + remove beneath — nothing cramped */
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
  .vault__cost {
    min-width: 5rem;
    justify-content: flex-start;
  }
  .vault__costinput {
    text-align: left;
    /* always visible on touch: there's no hover to reveal the affordance */
    border-bottom-color: var(--line);
  }
  .vault__remove {
    margin-left: auto;
  }
}
</style>
