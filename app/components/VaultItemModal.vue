<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";
import type { Classification, Unit } from "~~/shared/types";
import { VAULT_NAME_MAX, VAULT_SHORT_MAX, VAULT_URL_MAX, type VaultEntry } from "~~/shared/vault";
import { formatWeight, itemDisplayName, parseWeightInput } from "~~/shared/weights";

// Correcting a piece of gear in place — the half of My Gear that capture can't do.
//
// A DIALOG rather than an in-flow .reveal, and the motion vocabulary is why: that
// family is for "a row's note" (atoms/controls.scss), and eight fields is a form, not
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
const props = defineProps<{ entry: VaultEntry | null; unit: Unit }>();
const emit = defineEmits<{ close: []; saved: [VaultEntry] }>();

const { vaultFetch } = useVaultAccess();

// Three-way, not the editor's two toggles. Those are toggles because each ALSO opens
// the detail that only exists while it's on, so the row gains no third control; there
// is no row to protect here, and a vault row has no qty, so it has no worn split.
const CLASS_OPTIONS = [
  { key: "base", label: "Base" },
  { key: "worn", label: "Worn" },
  { key: "consumable", label: "Consumable" },
];

const brand = ref("");
const name = ref("");
const variant = ref("");
const commonName = ref("");
const weight = ref("");
const kcal = ref("");
const productUrl = ref("");
const classification = ref<Classification>("base");
const saving = ref(false);
const error = ref("");
const nameEl = useTemplateRef<HTMLInputElement>("nameEl");

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
    productUrl.value = e.productUrl ?? "";
    saving.value = false;
    error.value = "";
    opened = {
      brand: brand.value,
      name: name.value,
      variant: variant.value,
      commonName: commonName.value,
      weight: weight.value,
      kcal: kcal.value,
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
  if (kcal.value !== opened.kcal) {
    // a kcal on a non-consumable row is carried but never counted, so a number you
    // typed is kept rather than wiped — the value never stops being true of the food
    const k = kcal.value.trim() ? Math.max(0, Math.round(Number(kcal.value))) : 0;
    patch.kcal = k > 0 ? k : null;
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
  if (weight.value !== opened.weight) {
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

  // Nothing changed: closing is the honest answer. Sending an empty patch would be a
  // round trip to write nothing, and the endpoint refuses one anyway.
  if (!Object.keys(patch).length) return emit("close");

  saving.value = true;
  error.value = "";
  const res = await vaultFetch<{ ok: boolean; item?: VaultEntry }>("/api/vault/items", {
    method: "POST",
    body: { op: { t: "edit", id: props.entry.id, patch } },
  }).catch(() => ({ ok: false }) as { ok: boolean; item?: VaultEntry });
  saving.value = false;
  if (res.ok && res.item) return emit("saved", res.item);
  error.value = "Couldn’t save that. Check your connection and try again.";
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
        Whatever you change here is yours — your lists stop overwriting a field once
        you’ve corrected it.
      </p>

      <div class="vitem__pair">
        <label class="dlg__field">
          <span class="t-sm t-muted">Brand</span>
          <input v-model="brand" class="field" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
        </label>
        <label class="dlg__field">
          <span class="t-sm t-muted">Variant</span>
          <input v-model="variant" class="field" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
        </label>
      </div>

      <label class="dlg__field">
        <span class="t-sm t-muted">Name</span>
        <input ref="nameEl" v-model="name" class="field" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
      </label>

      <!-- the placeholder is ItemRow's, word for word: three real canonical values
           from the catalog's own common names, so the vocabulary is stated once -->
      <label class="dlg__field">
        <span class="t-sm t-muted">Gear type</span>
        <input v-model="commonName" class="field" placeholder="Tent, Backpack, Quilt…" @keydown.enter="onSubmit" />
      </label>

      <div class="vitem__pair">
        <label class="dlg__field">
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
            :options="CLASS_OPTIONS"
            :current="classification"
            label="Gear classification"
            @pick="(k) => (classification = k as Classification)"
          >
            <template #trigger="{ active, open }">
              <span>{{ active?.label }}</span>
              <HugeiconsIcon :icon="ChevronDownIcon" class="vitem__chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2" aria-hidden="true" />
            </template>
          </OptionMenu>
        </div>
      </div>

      <!-- calories only once it IS consumable — ItemRow's rule verbatim, because that
           is the only state in which the number is counted, and offering it sooner
           would collect a value the totals ignore -->
      <label v-if="classification === 'consumable'" class="dlg__field">
        <span class="t-sm t-muted">kcal each</span>
        <input v-model="kcal" class="field" inputmode="numeric" placeholder="0" @keydown.enter="onSubmit" />
      </label>

      <label class="dlg__field">
        <span class="t-sm t-muted">
          Product link
          <a v-if="urlOk" :href="productUrl.trim()" class="link" target="_blank" rel="noopener noreferrer">Open</a>
        </span>
        <input v-model="productUrl" class="field" placeholder="https://" inputmode="url" @keydown.enter="onSubmit" />
      </label>

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
.dlg__item {
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: var(--track-tight);
}
/* Two short fields on one line. Brand/variant and weight/type are each a pair you
   read together, and a single stacked column of eight fields makes the dialog scroll
   on a phone before you reach Save. */
.vitem__pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
/* the picker wears the field's own box, so it sits level with the weight input
   beside it rather than reading as a different kind of control */
.vitem__cls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
}
.vitem__chev {
  flex: none;
  color: var(--ink-3);
  transition: rotate var(--dur) var(--ease);
}
.vitem__chev.is-open {
  rotate: 180deg;
}
/* Plain ink, not --danger: the monochrome rule reserves colour for irreversible acts
   and for the data viz (tokens.scss), and a save that didn't go through is neither.
   Matches /gear's own .vault__error. */
.vitem__err {
  color: var(--ink);
}
@media (max-width: $bp-stack) {
  .vitem__pair {
    grid-template-columns: 1fr;
  }
}
</style>
