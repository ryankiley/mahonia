<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Cancel01Icon, ChevronDownIcon, MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { Classification, Unit } from "~~/shared/types";
import {
  VAULT_NAME_MAX,
  VAULT_NOTE_MAX,
  VAULT_SHORT_MAX,
  VAULT_URL_MAX,
  type VaultEntry,
  type VaultKitPart,
} from "~~/shared/vault";
import { VAULT_KIT_QTY_MAX, kitWeightMg } from "~~/shared/vaultKit";
import { searchVaultRows } from "~~/shared/vaultView";
import { formatPrice, parsePriceInput } from "~~/shared/money";
import { counted } from "~~/shared/tidyText";
import { formatWeight, itemDisplayName, parseWeightInput } from "~~/shared/weights";
import { offersKcal, offersWorn } from "~~/shared/fuel";

// Correcting a piece of gear in place — the half of My Gear that capture can't do.
//
// A DIALOG rather than an in-flow .reveal, and the motion vocabulary is why: that
// family is for "a row's note" (atoms/controls.scss), and ten fields is a form, not
// a note. Two mechanical reasons agree. The classification picker is an absolutely
// positioned .menu__list, and /gear's rows live inside .folder__bodyinner's
// `overflow: hidden` — going in-flow would mean growing the editor's whole
// overlay-lift apparatus for one control. And the row is a drag handle whose
// createPressArm excludes buttons but NOT inputs, so selecting text in an inline
// weight field would arm a re-file at 5px of travel.
//
// The cost, plainly: a run of tidy-ups is open/edit/save per row rather than tabbing
// down a column. Acceptable because /gear's row is DISPLAY — turning it into the
// editor's live form is a bigger change than this page wants to be.
const props = defineProps<{
  entry: VaultEntry | null;
  unit: Unit;
  /** The money the rest of your gear is priced in, when it is priced in one. A bare
   *  number falls back to it, so stating a currency once is enough — see onSubmit. */
  defaultCurrency?: string;
  /** the page's live gear, which a kit's parts are picked from */
  gear?: VaultEntry[];
}>();
/** `kitChanged`: the items moved, so OTHER rows changed too (each item's "In …"),
 *  and the page re-reads rather than patching the one row. */
const emit = defineEmits<{ close: []; saved: [item: VaultEntry, kitChanged: boolean] }>();

const { vaultFetch } = useVaultAccess();

// ---- parts: what makes a row a kit -----------------------------------------
// The draft of the row's parts. Any makes it a kit on Save; emptying a kit's turns it
// back into a piece, at the total it showed. While it holds parts the weight field is
// a read-out, not an input: a kit weighs its own weight plus its parts, and a total
// typed into it would count every part twice (the server refuses one too).
const partsDraft = ref<VaultKitPart[]>([]);
const ownWeight = ref("");
const partQuery = ref("");
let openedParts = "";
let openedOwn = "";
const partsKey = (ps: VaultKitPart[]) => ps.map((p) => `${p.id}x${p.qty}`).join(",");
const isKit = computed(() => partsDraft.value.length > 0);
// One level deep: a piece that is already some kit's part can't hold parts itself.
const inKits = computed(() => props.entry?.inKits?.length ?? 0);
const ownWeightMg = computed(() => {
  const raw = ownWeight.value.trim();
  return raw ? parseWeightInput(raw, props.unit) : 0;
});
const kitTotalMg = computed(() => kitWeightMg(ownWeightMg.value ?? 0, partsDraft.value));
// What can go in: your other PIECES — not kits (one level deep), not this row, not
// one it already holds. The page's own search, so a part is found the way the page
// finds it, typos and notes included.
const partChoices = computed(() => {
  const q = partQuery.value.trim();
  if (!q || !props.entry) return [];
  const taken = new Set(partsDraft.value.map((p) => p.id));
  const pool = (props.gear ?? []).filter((g) => g.kind !== "kit" && g.id !== props.entry!.id && !taken.has(g.id));
  return searchVaultRows(pool, q).slice(0, 6);
});
const partEl = useTemplateRef<HTMLInputElement>("partEl");
function addPart(g: VaultEntry) {
  partsDraft.value = [
    ...partsDraft.value,
    { id: g.id, qty: 1, brand: g.brand, name: g.name, variant: g.variant, weightMg: g.weightMg },
  ];
  partQuery.value = "";
  // back to the search, so a kit's parts go in one after another: the first part
  // re-lays the dialog out as a kit's, and that re-render drops the field's focus
  nextTick(() => partEl.value?.focus());
}
function stepPart(id: number, by: number) {
  partsDraft.value = partsDraft.value.map((p) =>
    p.id === id ? { ...p, qty: Math.min(VAULT_KIT_QTY_MAX, Math.max(1, p.qty + by)) } : p,
  );
}
function dropPart(id: number) {
  partsDraft.value = partsDraft.value.filter((p) => p.id !== id);
}

// Three-way, not the editor's two toggles. Those are toggles because each ALSO opens
// the detail that only exists while it's on, so the row gains no third control; there
// is no row to protect here, and a vault row has no qty, so it has no worn split.
const CLASS_OPTIONS = [
  { key: "base", label: "Base" },
  { key: "worn", label: "Worn" },
  { key: "consumable", label: "Consumable" },
];
// the same list without Worn, for a row that can't be (see classOptions) — a constant
// rather than a filter per recompute, so the picker's options keep one identity
const CLASS_OPTIONS_UNWORN = CLASS_OPTIONS.filter((o) => o.key !== "worn");

const brand = ref("");
const name = ref("");
const variant = ref("");
const commonName = ref("");
const weight = ref("");
const kcal = ref("");
const note = ref("");
const price = ref("");
const productUrl = ref("");
const classification = ref<Classification>("base");
const saving = ref(false);
const error = ref("");
const nameEl = useTemplateRef<HTMLInputElement>("nameEl");
// What the row says it is, read LIVE from the two fields as they are typed, the way the
// class picker's own value is: the name and gear type decide the row's other controls
// (shared/fuel), and the dialog answers as the editor row would for the same words.
const named = computed(() => ({ name: name.value, commonName: commonName.value }));
// The kcal field's rule, ItemRow's verbatim: only once it IS consumable (the only state
// in which the number is counted), and not on stove fuel holding no number — a
// canister's "calories" are the wrong kind, and would feed the food plan (offersKcal).
// The "holds a number" half reads what the row OPENED with, not the field — the field
// is the thing being edited, and a field that vanished under the cursor as its last
// digit went would be a trap, not a rule. The field can still go while the dialog is
// open, when the name is edited into fuel with a number typed but unsaved; onSubmit
// drops that number rather than saving what the form no longer shows.
const kcalOffered = computed(
  () => classification.value === "consumable" && offersKcal({ ...named.value, kcal: props.entry?.kcal }),
);
// ...and "Worn" leaves the picker on water and stove fuel, as the editor row drops its
// worn toggle there (offersWorn, the one rule for both): nobody wears a gas canister.
// Kept while the entry IS worn, so a value that got there can be walked back — the
// picker can't offer a way out of a state it doesn't list.
const classOptions = computed(() =>
  offersWorn(named.value, classification.value === "worn") ? CLASS_OPTIONS : CLASS_OPTIONS_UNWORN,
);

// What the dialog opened with. The patch is the DIFF against this, because a field
// that reaches the server gets PINNED — and pinning is a promise about the future,
// not a description of the save. Sending the whole form would mean opening this to
// look at a row and pressing Save quietly opted it out of ever learning anything
// from your lists again, which is not what "your lists stop overwriting a field once
// you've corrected it" says. Only what you actually changed becomes yours.
let opened = {
  brand: "",
  name: "",
  variant: "",
  commonName: "",
  weight: "",
  kcal: "",
  note: "",
  price: "",
  productUrl: "",
  classification: "base" as Classification,
};

// `immediate`, because this component is Lazy-mounted on first use when `entry` is
// ALREADY set — a plain watch would never fire for that first open. The same trap
// CatalogCorrectionModal's prefill and BaseModal's own focus watcher both note.
watch(
  () => props.entry,
  (e) => {
    if (!e) return;
    brand.value = e.brand ?? "";
    name.value = e.name;
    variant.value = e.variant ?? "";
    commonName.value = e.commonName ?? "";
    // raw: true — an editable field must never be handed "<1 g", which is a summary,
    // not a value: parsing it back would throw away the weight it stands for. The
    // UNIT stays in the string (CatalogCorrectionModal prefills the same way), so a
    // field showing "1.2" can't be misread when the page is in kg — and
    // parseWeightInput reads the suffix straight back.
    weight.value = e.weightMg ? formatWeight(e.weightMg, props.unit, { raw: true }) : "";
    // absent means "never stated", which for a vault row IS base: capture drops the
    // field when the list row was inheriting its folder's default
    classification.value = e.classification ?? "base";
    kcal.value = e.kcal ? String(e.kcal) : "";
    note.value = e.description ?? "";
    // FORMATTED, not the bare cents: "$399.00" is what the row shows and what
    // parsePriceInput reads straight back, so the symbol you'd otherwise have to
    // retype is already there — and the same only-if-the-string-changed guard the
    // weight field uses (below) keeps the round trip from re-pricing anything.
    price.value = e.priceCents != null ? formatPrice(e.priceCents, e.currency) : "";
    productUrl.value = e.productUrl ?? "";
    partsDraft.value = (e.parts ?? []).map((p) => ({ ...p }));
    ownWeight.value = e.kind === "kit" && e.ownWeightMg ? formatWeight(e.ownWeightMg, props.unit, { raw: true }) : "";
    partQuery.value = "";
    openedParts = partsKey(partsDraft.value);
    openedOwn = ownWeight.value;
    saving.value = false;
    error.value = "";
    opened = {
      brand: brand.value,
      name: name.value,
      variant: variant.value,
      commonName: commonName.value,
      weight: weight.value,
      kcal: kcal.value,
      note: note.value,
      price: price.value,
      productUrl: productUrl.value,
      classification: classification.value,
    };
  },
  { immediate: true },
);

// A name is the one thing a vault row cannot be without: vaultNormKey returns "" for
// a nameless row and every caller reads that as "not gear".
const canSave = computed(() => !!name.value.trim());
const urlOk = computed(() => /^https?:\/\/\S/i.test(productUrl.value.trim()));

async function onSubmit() {
  if (!canSave.value || saving.value || !props.entry) return;

  // null, not undefined, for a field you emptied: the edit op has to be able to
  // CLEAR one, which capture's coalesce merge structurally can't (see vaultRepo).
  const patch: Record<string, unknown> = {};
  if (brand.value !== opened.brand) patch.brand = brand.value.trim().slice(0, VAULT_SHORT_MAX) || null;
  if (name.value !== opened.name) patch.name = name.value.trim().slice(0, VAULT_NAME_MAX);
  if (variant.value !== opened.variant) patch.variant = variant.value.trim().slice(0, VAULT_SHORT_MAX) || null;
  if (commonName.value !== opened.commonName) {
    patch.commonName = commonName.value.trim().slice(0, VAULT_SHORT_MAX) || null;
  }
  if (classification.value !== opened.classification) {
    // "base" is stored as absent, the convention the capture path keeps
    patch.classification = classification.value === "base" ? null : classification.value;
  }
  // The kcal is sent only where the fuel rule would show the field for it — the same
  // test kcalOffered makes, minus the class: a kcal on a non-consumable row is carried
  // but never counted, so a number you typed is kept rather than wiped (the value never
  // stops being true of the food). On a fuel row it WOULD be counted, so a number typed
  // before the name was edited into fuel — the field gone, the digits still in the ref —
  // is dropped rather than saved unseen, and the next list to pick this row gets none.
  if (kcal.value !== opened.kcal && offersKcal({ ...named.value, kcal: props.entry?.kcal })) {
    const k = kcal.value.trim() ? Math.max(0, Math.round(Number(kcal.value))) : 0;
    patch.kcal = k > 0 ? k : null;
  }
  if (note.value !== opened.note) {
    patch.description = note.value.trim().slice(0, VAULT_NOTE_MAX) || null;
  }
  if (price.value !== opened.price) {
    const raw = price.value.trim();
    const parsed = raw ? parsePriceInput(raw) : null;
    if (raw && !parsed) {
      error.value = "That price doesn’t read as a number. Try “399” or “$62.50”.";
      return;
    }
    patch.priceCents = parsed ? parsed.cents : null;
    // A number typed with no symbol keeps the currency the row already carries, and
    // failing that the one the rest of your gear is in — there is no separate
    // currency field, so re-typing the amount would otherwise silently strip the
    // money it was in, and a first price would land currency-less beside a total
    // that has one. Type a new symbol to change it.
    if (parsed) {
      patch.currency = parsed.currency ?? props.entry.currency ?? props.defaultCurrency ?? null;
    }
  }
  if (productUrl.value !== opened.productUrl) {
    const url = productUrl.value.trim().slice(0, VAULT_URL_MAX);
    if (url && !urlOk.value) {
      error.value = "A product link has to start with http:// or https://.";
      return;
    }
    patch.productUrl = url || null;
  }
  // Only when the string CHANGED. formatWeight → parseWeightInput is lossy (0.1 oz
  // resolution) and locale-shaped, so round-tripping a field nobody typed in would
  // silently re-weigh the row. CatalogCorrectionModal splits the same way.
  // A kit's weight is its parts' — shown, never sent (the server refuses one too).
  if (!isKit.value && weight.value !== opened.weight) {
    const raw = weight.value.trim();
    // Blank clears to 0 — gear you own but haven't weighed is a legitimate state
    // here, unlike an automatic capture, which waits (see isVaultWorthy).
    const parsed = raw ? parseWeightInput(raw, props.unit) : 0;
    if (parsed == null || parsed < 0) {
      error.value = "That weight doesn’t read as a number. Try “540 g” or “1.2 kg”.";
      return;
    }
    patch.weightMg = parsed;
  }

  // The parts are their own op: they write other rows' links, not this row's fields.
  const kitChanged =
    partsKey(partsDraft.value) !== openedParts || (isKit.value && ownWeight.value !== openedOwn);
  if (kitChanged && isKit.value && (ownWeightMg.value == null || ownWeightMg.value < 0)) {
    error.value = "The kit’s own weight doesn’t read as a number. Try “0” or “40 g”.";
    return;
  }

  // Nothing changed: closing is the honest answer. Sending an empty patch would be a
  // round trip to write nothing, and the endpoint refuses one anyway.
  if (!Object.keys(patch).length && !kitChanged) return emit("close");

  saving.value = true;
  error.value = "";
  const post = (op: Record<string, unknown>) =>
    vaultFetch<{ ok: boolean; item?: VaultEntry }>("/api/vault/items", { method: "POST", body: { op } }).catch(
      () => ({ ok: false }) as { ok: boolean; item?: VaultEntry },
    );
  let item: VaultEntry | undefined;
  // The kit first: a row that just stopped being one takes a typed weight only once it
  // is a piece again (the server refuses a weight on a kit).
  if (kitChanged) {
    const parts = partsDraft.value.map((p) => ({ id: p.id, qty: p.qty }));
    const res = await post({ t: "kit", id: props.entry.id, parts, ownWeightMg: ownWeightMg.value ?? 0 });
    if (!res.ok || !res.item) {
      saving.value = false;
      error.value = "Couldn’t save the items. Check your connection and try again.";
      return;
    }
    item = res.item;
  }
  if (Object.keys(patch).length) {
    const res = await post({ t: "edit", id: props.entry.id, patch });
    if (!res.ok || !res.item) {
      saving.value = false;
      error.value = "Couldn’t save that. Check your connection and try again.";
      // the parts did land: let the page show them even though the fields didn't
      if (item) emit("saved", item, true);
      return;
    }
    item = res.item;
  }
  saving.value = false;
  if (item) emit("saved", item, kitChanged);
}
</script>

<template>
  <BaseModal :open="!!entry" label="Edit gear" @close="emit('close')">
    <template v-if="entry">
      <h2 class="t-label">Edit gear</h2>
      <p class="dlg__item">{{ itemDisplayName(entry.brand, entry.name, entry.variant) }}</p>
      <!-- The one thing a dialog has room to say that a row doesn't: these three
           fields ARE how the vault recognises this piece of gear. -->
      <p class="t-sm t-muted dlg__lede">
        Whatever you change here is yours: your lists stop overwriting a field once
        you’ve corrected it.
      </p>

      <div class="vitem__pair">
        <label class="dlg__field">
          <span class="t-sm t-muted">Brand</span>
          <input v-model="brand" class="field" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
        </label>
        <label class="dlg__field">
          <!-- the same words as the editor row's field for this value (ItemRow):
               "variant" is the catalog's word, not a person's -->
          <span class="t-sm t-muted">Size or version</span>
          <input v-model="variant" class="field" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
        </label>
      </div>

      <label class="dlg__field">
        <span class="t-sm t-muted">Name</span>
        <input ref="nameEl" v-model="name" class="field" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
      </label>

      <!-- the placeholder is ItemRow's, word for word, so the field is named the same
           way in both places -->
      <label class="dlg__field">
        <span class="t-sm t-muted">Gear type</span>
        <input v-model="commonName" class="field" placeholder="Type of gear" @keydown.enter="onSubmit" />
      </label>

      <!-- the row's own sub-line, in the dialog's words: ItemRow's note placeholder
           verbatim, because it is the same text moved — a list wrote it, and this is
           where it stops being overwritten -->
      <label class="dlg__field">
        <span class="t-sm t-muted">Note</span>
        <input v-model="note" class="field" placeholder="Add a note" autocorrect="off" spellcheck="true" @keydown.enter="onSubmit" />
      </label>

      <div class="vitem__pair">
        <!-- a kit's weight is a read-out: the field's box, not its input -->
        <div v-if="isKit" class="dlg__field">
          <span class="t-sm t-muted">Weight</span>
          <p class="field vitem__derived t-num" title="A kit weighs its items plus its own weight. Change an item to change it.">
            {{ formatWeight(kitTotalMg, unit) }}
          </p>
        </div>
        <label v-else class="dlg__field">
          <span class="t-sm t-muted">Weight</span>
          <input
            v-model="weight"
            class="field"
            :placeholder="`0 ${unit}`"
            inputmode="decimal"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            @keydown.enter="onSubmit"
          />
        </label>
        <div class="dlg__field">
          <span class="t-sm t-muted">Type</span>
          <OptionMenu
            class="vitem__cls field"
            :options="classOptions"
            :current="classification"
            label="Gear classification"
            @pick="(k) => (classification = k as Classification)"
          >
            <template #trigger="{ active, open }">
              <span>{{ active?.label }}</span>
              <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2" aria-hidden="true" />
            </template>
          </OptionMenu>
        </div>
      </div>

      <!-- calories only once it IS consumable, and not on fuel that has none to show
           — ItemRow's rule verbatim (see kcalOffered) -->
      <label v-if="kcalOffered" class="dlg__field">
        <span class="t-sm t-muted">kcal each</span>
        <input v-model="kcal" class="field" inputmode="numeric" placeholder="0" @keydown.enter="onSubmit" />
      </label>

      <!-- what it cost and where it came from, read together. Price takes the
           narrower track: it is four characters next to an address. -->
      <div class="vitem__pair vitem__pair--money">
        <label class="dlg__field">
          <span class="t-sm t-muted">Price</span>
          <!-- inputmode text, not decimal: a currency symbol is part of what this
               field reads, and a numeric keypad can't type one -->
          <input v-model="price" class="field" placeholder="399" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
        </label>
        <label class="dlg__field">
          <span class="t-sm t-muted">
            Product link
            <a v-if="urlOk" :href="productUrl.trim()" class="link" target="_blank" rel="noopener noreferrer">Open</a>
          </span>
          <input v-model="productUrl" class="field" placeholder="https://" inputmode="url" @keydown.enter="onSubmit" />
        </label>
      </div>

      <!-- Parts: what makes a row a KIT. Picked from your own gear, so each part is a
           real piece with its own weight, and the kit weighs what they weigh; on a
           list it unfolds into a group with these under it. A piece already in a kit
           can't hold parts — kits are one level deep. -->
      <section v-if="!inKits" class="vitem__parts" aria-label="Items in this kit">
        <div class="vitem__partshead">
          <span class="t-sm t-muted">Items</span>
          <span v-if="isKit" class="t-sm t-muted t-num">
            {{ counted(partsDraft.length, "item") }} · {{ formatWeight(kitTotalMg, unit) }}
          </span>
        </div>
        <p v-if="!isKit" class="t-sm t-muted vitem__hint">
          Is this a kit? Add the items it holds, and it weighs what they weigh.
        </p>
        <p v-else-if="entry.kind !== 'kit' && entry.weightMg" class="t-sm t-muted vitem__hint">
          Its {{ formatWeight(entry.weightMg, unit) }} becomes the items’ sum, plus any weight of its own below.
        </p>
        <ul v-if="isKit" class="vitem__partlist">
          <li v-for="p in partsDraft" :key="p.id" class="vitem__part">
            <span class="t-clip vitem__partname">
              {{ itemDisplayName(p.brand, p.name, p.variant) }}<span v-if="p.removed" class="t-muted"> · removed</span>
            </span>
            <span class="t-sm t-num t-muted">{{ formatWeight(p.weightMg, unit) }}</span>
            <span class="vitem__qty">
              <button
                type="button"
                class="btn btn--icon btn--ghost"
                :disabled="p.qty <= 1"
                :aria-label="`One fewer ${p.name}`"
                @click="stepPart(p.id, -1)"
              >
                <HugeiconsIcon :icon="MinusSignIcon" :size="14" :stroke-width="2" aria-hidden="true" />
              </button>
              <span class="t-sm t-num">×{{ p.qty }}</span>
              <button type="button" class="btn btn--icon btn--ghost" :aria-label="`One more ${p.name}`" @click="stepPart(p.id, 1)">
                <HugeiconsIcon :icon="PlusSignIcon" :size="14" :stroke-width="2" aria-hidden="true" />
              </button>
            </span>
            <button
              type="button"
              class="btn btn--icon btn--ghost vitem__drop"
              :aria-label="`Take ${p.name} out of the kit`"
              :title="`Take ${p.name} out of the kit`"
              @click="dropPart(p.id)"
            >
              <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
            </button>
          </li>
        </ul>
        <input
          ref="partEl"
          v-model="partQuery"
          class="field"
          placeholder="Add an item from your gear"
          aria-label="Find an item in your gear"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          @keydown.enter.prevent="partChoices[0] && addPart(partChoices[0])"
        />
        <ul v-if="partChoices.length" class="vitem__choices">
          <li v-for="g in partChoices" :key="g.id">
            <button type="button" class="vitem__choice" @click="addPart(g)">
              <span class="t-clip">{{ itemDisplayName(g.brand, g.name, g.variant) }}</span>
              <span class="t-sm t-num t-muted">{{ formatWeight(g.weightMg, unit) }}</span>
            </button>
          </li>
        </ul>
        <p v-else-if="partQuery.trim()" class="t-sm t-muted vitem__hint">
          None of your gear matches. Add it to My Gear first, then pick it here.
        </p>
        <label v-if="isKit" class="dlg__field">
          <span class="t-sm t-muted">Its own weight, beyond the items (a stuff sack, a strap)</span>
          <input
            v-model="ownWeight"
            class="field"
            :placeholder="`0 ${unit}`"
            inputmode="decimal"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            @keydown.enter="onSubmit"
          />
        </label>
      </section>
      <p v-else class="t-sm t-muted vitem__hint">
        In {{ inKits === 1 ? "a kit" : `${inKits} kits` }}, so it can’t hold items of its own.
      </p>

      <p v-if="error" class="t-sm vitem__err">{{ error }}</p>

      <div class="dlg__actions">
        <button class="btn btn--ghost" @click="emit('close')">Cancel</button>
        <button class="btn btn--primary" :disabled="!canSave || saving" @click="onSubmit">
          {{ saving ? "Saving…" : "Save" }}
        </button>
      </div>
    </template>
  </BaseModal>
</template>

<style scoped lang="scss">
/* the overlay, the shell, the field stack and the action row are atoms/dialog.scss —
   only the pairs and the error line are this dialog's own */
/* the item's name at title size is .dlg__item — atoms/dialog.scss, shared with the
   catalog-correction dialog */
/* Two short fields on one line. Brand/variant and weight/type are each a pair you
   read together, and a single stacked column of eight fields makes the dialog scroll
   on a phone before you reach Save. */
.vitem__pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
/* a price is four characters and a URL is a line of them, so this pair is not an
   even split — the address gets the room */
.vitem__pair--money {
  grid-template-columns: minmax(0, 9rem) 1fr;
}
/* the picker wears the field's own box, so it sits level with the weight input
   beside it rather than reading as a different kind of control */
.vitem__cls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
}
/* its chevron is the .chev atom (controls.scss), not a copy */
/* a kit's weight: the field's box, not its input — it reads, it doesn't take */
.vitem__derived {
  margin: 0;
  color: var(--ink-2);
}
/* Parts: a hairline above sets it apart from the row's own fields — it edits which
   OTHER gear this row is made of */
.vitem__parts {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-3);
  border-top: 1px solid var(--line);
}
.vitem__partshead {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-2);
}
.vitem__hint {
  margin: 0;
}
.vitem__partlist,
.vitem__choices {
  margin: 0;
  padding: 0;
  list-style: none;
}
.vitem__part {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: var(--icon-btn);
}
.vitem__part + .vitem__part {
  border-top: 1px solid var(--line);
}
.vitem__partname {
  flex: 1 1 auto;
  min-width: 0;
}
.vitem__qty {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
}
.vitem__qty .t-num {
  min-width: 2.2ch;
  text-align: center;
}
.vitem__drop {
  color: var(--ink-3);
}
/* the search's answers, in flow under the field: a dialog has the room, and an
   absolutely placed menu inside the modal's scroll box would clip at its edge */
.vitem__choices {
  border: 1px solid var(--line);
  border-radius: var(--radius-2);
  overflow: hidden;
}
.vitem__choices li + li {
  border-top: 1px solid var(--line);
}
.vitem__choice {
  display: flex;
  width: 100%;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 0;
  background: none;
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.vitem__choice:hover,
.vitem__choice:focus-visible {
  background: var(--popover-hover);
}
/* Plain ink, not --danger: the monochrome rule reserves colour for irreversible acts
   and for the data viz (tokens.scss), and a save that didn't go through is neither.
   Matches /gear's own .vault__error. */
.vitem__err {
  color: var(--ink);
}
@media (max-width: $bp-stack) {
  .vitem__pair,
  .vitem__pair--money {
    grid-template-columns: 1fr;
  }
}
</style>
