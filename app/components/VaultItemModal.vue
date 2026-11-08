<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChevronDownIcon, DashedLine02Icon } from "@hugeicons/core-free-icons";
import type { Classification, Unit } from "~~/shared/types";
import { VAULT_NAME_MAX, VAULT_NOTE_MAX, VAULT_SHORT_MAX, VAULT_URL_MAX, type VaultEntry } from "~~/shared/vault";
import { formatPrice, parsePriceInput } from "~~/shared/money";
import { CLASS_ICONS } from "~/utils/classIcons";
import { entryUnitFromInput, formatWeight, itemDisplayName, parseWeightInput } from "~~/shared/weights";
import { offersKcal, offersWorn } from "~~/shared/fuel";
import type { GearGlyph } from "~~/shared/gearGlyph";
import { GEAR_ICON_CHOICES, gearIcon, gearIconLabel } from "~/utils/gearIcons";

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
  /** "icon" opens the dialog with its icon grid showing (the row's icon was pressed). */
  focus?: "icon" | null;
  /** The brands and gear types already in your gear, most used first: suggested ahead
   *  of the catalog's, since what you already call things is the likelier answer. */
  known?: { brands: string[]; types: string[] };
}>();

// Suggestions under Brand and Gear type: yours first, then the catalog's, loaded on the
// field's first focus so a dialog opened to fix a weight never fetches them.
const catalogBrands = useCatalogVocab("/api/catalog/brands");
const catalogTypes = useCatalogVocab("/api/catalog/types");
const vocabId = useId();
/** Yours, then theirs, each label once however it's capitalised. */
function mergeVocab(mine: string[] = [], theirs: string[] | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...mine, ...(theirs ?? [])]) {
    const label = v.trim();
    const key = label.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}
const brandOptions = computed(() => mergeVocab(props.known?.brands, catalogBrands.names.value));
const typeOptions = computed(() => mergeVocab(props.known?.types, catalogTypes.names.value));
const emit = defineEmits<{ close: []; saved: [VaultEntry] }>();

const { vaultFetch } = useVaultAccess();

// Three-way, not the editor's two toggles. Those are toggles because each ALSO opens
// the detail that only exists while it's on, so the row gains no third control; there
// is no row to protect here, and a vault row has no qty, so it has no worn split.
const CLASS_OPTIONS = [
  { key: "base", label: "Base", icon: CLASS_ICONS.base },
  { key: "worn", label: "Worn", icon: CLASS_ICONS.worn },
  { key: "consumable", label: "Consumable", icon: CLASS_ICONS.consumable },
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
// The icon you picked by hand; null = the gear type decides, live, as you type it.
const icon = ref<GearGlyph | null>(null);
const iconsOpen = ref(false);
const shownIcon = computed(() => gearIcon(commonName.value, name.value, icon.value));
const shownLabel = computed(() => gearIconLabel(commonName.value, name.value, icon.value));
// what "Automatic" would draw: the type's icon, read from the fields as they stand
const autoIcon = computed(() => gearIcon(commonName.value, name.value));
const iconBtn = useTemplateRef<HTMLButtonElement>("iconBtn");
function pickIcon(glyph: GearGlyph | null) {
  icon.value = glyph;
  iconsOpen.value = false;
  // the grid goes with the press, and the button that was pressed with it: hand focus
  // back to the box that opened it, rather than dropping a keyboard user on the page
  nextTick(() => iconBtn.value?.focus());
}
// the unit this piece's weight reads in: its own, else the page's (the row's rowUnit)
const rowUnit = computed<Unit>(() => props.entry?.entryUnit ?? props.unit);
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
  icon: null as GearGlyph | null,
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
    weight.value = e.weightMg ? formatWeight(e.weightMg, e.entryUnit ?? props.unit, { raw: true }) : "";
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
    icon.value = e.icon ?? null;
    iconsOpen.value = props.focus === "icon";
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
      icon: icon.value,
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
  if (icon.value !== opened.icon) patch.icon = icon.value;
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
  if (weight.value !== opened.weight) {
    const raw = weight.value.trim();
    // Blank clears to 0 — gear you own but haven't weighed is a legitimate state
    // here, unlike an automatic capture, which waits (see isVaultWorthy).
    const parsed = raw ? parseWeightInput(raw, rowUnit.value) : 0;
    if (parsed == null || parsed < 0) {
      error.value = "That weight doesn’t read as a number. Try “540 g” or “1.2 kg”.";
      return;
    }
    patch.weightMg = parsed;
    // a weight typed WITH its unit ("3.8 oz") reads back in that unit, as on a list row
    const named = entryUnitFromInput(raw);
    if (named) patch.entryUnit = named;
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
      <!-- No explainer under the title. What you change here is pinned (vaultRepo), so no
           list writes over it, and that is what anyone expects of an edit; a line saying
           so took a row on every open, and went in review. -->

      <div class="vitem__pair">
        <label class="dlg__field">
          <span class="t-sm t-muted">Brand</span>
          <!-- "Add a …" like the note's placeholder: these fields have no border, so an
               empty one was blank space under its label. Not an example ("Patagonia"),
               which reads as data the way "399" did as a price. -->
          <input
            v-model="brand"
            class="field"
            placeholder="Add a brand"
            :list="`${vocabId}-brands`"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            @focus="catalogBrands.load()"
            @keydown.enter="onSubmit"
          />
        </label>
        <label class="dlg__field">
          <!-- the same words as the editor row's field for this value (ItemRow):
               "variant" is the catalog's word, not a person's -->
          <span class="t-sm t-muted">Size or version</span>
          <input v-model="variant" class="field" placeholder="Add a size" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
        </label>
      </div>

      <label class="dlg__field">
        <!-- "Product", not "Name": beside Brand, "Name" read as the whole name, and this
             is only the part after it ("Keb Hike 30", "Builders Protein Bar") -->
        <span class="t-sm t-muted">Product</span>
        <input ref="nameEl" v-model="name" class="field" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
      </label>

      <!-- The gear type, then the icon beside it, because the type decides the icon until
           you pick one: type "puffy" and the box beside it turns into a jacket. On the
           dialog's two columns like every other pair, so Gear type starts under Name and
           the icon under Size or version. -->
      <div class="vitem__typed">
        <!-- the placeholder is ItemRow's, word for word, so the field is named the same
             way in both places -->
        <label class="dlg__field">
          <span class="t-sm t-muted">Gear type</span>
          <input
            v-model="commonName"
            class="field"
            placeholder="Type of gear"
            :list="`${vocabId}-types`"
            @focus="catalogTypes.load()"
            @keydown.enter="onSubmit"
          />
        </label>
        <div class="dlg__field">
          <span class="t-sm t-muted">Icon</span>
          <button
            ref="iconBtn"
            type="button"
            class="field vitem__iconbtn"
            :aria-expanded="iconsOpen"
            aria-controls="vitem-icons"
            :aria-label="`Icon: ${shownLabel ?? 'none'}`"
            @click="iconsOpen = !iconsOpen"
          >
            <HugeiconsIcon v-if="shownIcon" :icon="shownIcon" :size="20" :stroke-width="2" aria-hidden="true" />
            <HugeiconsIcon v-else :icon="DashedLine02Icon" class="vitem__noicon" :size="20" :stroke-width="2" aria-hidden="true" />
            <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': iconsOpen }" :size="14" :stroke-width="2" aria-hidden="true" />
          </button>
        </div>
      </div>
      <!-- In the dialog's own flow, not a floating menu: forty-odd glyphs are a grid to
           look over, and the dialog already scrolls. "Automatic" first, since going back
           to the type's icon is the one choice that isn't a picture. -->
      <div v-if="iconsOpen" id="vitem-icons" class="vitem__icons" role="group" aria-label="Icons">
        <button type="button" class="vitem__auto" :aria-pressed="icon === null" @click="pickIcon(null)">
          <HugeiconsIcon v-if="autoIcon" :icon="autoIcon" :size="20" :stroke-width="2" aria-hidden="true" />
          <span>{{ autoIcon ? "Match the gear type" : "No icon" }}</span>
        </button>
        <button
          v-for="c in GEAR_ICON_CHOICES"
          :key="c.glyph"
          type="button"
          class="vitem__icon"
          :aria-pressed="icon === c.glyph"
          :aria-label="c.label"
          :title="c.label"
          @click="pickIcon(c.glyph)"
        >
          <HugeiconsIcon :icon="c.icon" :size="20" :stroke-width="2" aria-hidden="true" />
        </button>
      </div>

      <div class="vitem__pair">
        <label class="dlg__field">
          <span class="t-sm t-muted">Weight</span>
          <input
            v-model="weight"
            class="field"
            :placeholder="`0 ${rowUnit}`"
            inputmode="decimal"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            @keydown.enter="onSubmit"
          />
        </label>
        <div class="dlg__field">
          <!-- "Counts as", not "Type": the field above is the GEAR type, and two labels
               saying "type" asked which was which -->
          <span class="t-sm t-muted">Counts as</span>
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

      <!-- what it cost and where it came from, read together, on the same two columns as
           every pair above: a narrower price track started the link's column 66px left
           of every other second column in the dialog -->
      <div class="vitem__pair">
        <label class="dlg__field">
          <span class="t-sm t-muted">Price</span>
          <!-- inputmode text, not decimal: a currency symbol is part of what this
               field reads, and a numeric keypad can't type one -->
          <!-- "0", like the weight and kcal beside it: an example figure ("399") read as
               a real price on a protein bar -->
          <input v-model="price" class="field" placeholder="0" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
        </label>
        <label class="dlg__field">
          <span class="t-sm t-muted">
            Product link
            <a v-if="urlOk" :href="productUrl.trim()" class="link" target="_blank" rel="noopener noreferrer">Open</a>
          </span>
          <input v-model="productUrl" class="field" placeholder="https://" inputmode="url" @keydown.enter="onSubmit" />
        </label>
      </div>

      <!-- the row's own sub-line, in the dialog's words: ItemRow's note placeholder
           verbatim, because it is the same text moved — a list wrote it, and this is
           where it stops being overwritten. Last, with the price and link: the fields
           you set now and then, below the ones you set on every piece. -->
      <label class="dlg__field">
        <span class="t-sm t-muted">Note</span>
        <input v-model="note" class="field" placeholder="Add a note" autocorrect="off" spellcheck="true" @keydown.enter="onSubmit" />
      </label>

      <p v-if="error" class="t-sm vitem__err">{{ error }}</p>

      <!-- the two suggestion lists, yours first: native datalists, the editor's own
           gear-type mechanism (GearEditor's #gear-types) -->
      <datalist :id="`${vocabId}-brands`">
        <option v-for="b in brandOptions" :key="b" :value="b" />
      </datalist>
      <datalist :id="`${vocabId}-types`">
        <option v-for="t in typeOptions" :key="t" :value="t" />
      </datalist>

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
/* the picker wears the field's own box, so it sits level with the weight input
   beside it rather than reading as a different kind of control */
.vitem__cls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
}
/* its chevron is the .chev atom (controls.scss), not a copy */
/* the gear type and the icon box, on the same two columns as every pair so the second
   column starts in one place down the dialog. Its own class rather than a .vitem__pair,
   so it stays one line on a phone — the box is too small to deserve a row of its own. */
/* the icon button only as wide as its glyph and chevron, at the start of its column */
.vitem__typed {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
.vitem__iconbtn {
  /* .field sets a field's full width; this one is a glyph and a chevron */
  align-self: flex-start;
  width: auto;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--ink);
  cursor: pointer;
}
/* nothing to draw yet: the dashed square an empty row slot wears */
.vitem__noicon {
  color: var(--ink-3);
}
/* fixed cells spread edge to edge, so a cell's glyph inset is a known number that
   "Match the gear type" can repeat, and its icon sits in the first column */
.vitem__icons {
  --vitem-cell: 2.5rem;
  display: grid;
  grid-template-columns: repeat(auto-fill, var(--vitem-cell));
  justify-content: space-between;
  gap: var(--space-1);
}
.vitem__icon,
.vitem__auto {
  min-height: 2.5rem;
  padding: 0;
  border: 0;
  border-radius: var(--radius-2);
  background: none;
  color: var(--ink-2);
  font: inherit;
  cursor: pointer;
}
.vitem__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.vitem__auto {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-inline: calc((var(--vitem-cell) - 20px) / 2);
  text-align: start;
}
/* the one you have: a plate of ink at the menus' wash, under full-strength ink. Ink
   mixed thin, not --paper-3, because --paper-3 IS the dialog's surface in dark and the
   plate vanished into it. */
.vitem__icon[aria-pressed="true"],
.vitem__auto[aria-pressed="true"] {
  background: color-mix(in oklab, var(--ink) var(--popover-wash, 8%), transparent);
  color: var(--ink);
}
@media (hover: hover) and (pointer: fine) {
  .vitem__icon:hover,
  .vitem__auto:hover {
    color: var(--ink);
  }
}
.vitem__icon:active,
.vitem__auto:active {
  opacity: 0.7;
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
