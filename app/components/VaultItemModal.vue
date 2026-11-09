<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChevronDownIcon, DashedLine02Icon } from "@hugeicons/core-free-icons";
import type { Classification, Unit } from "~~/shared/types";
import { ownedOf, VAULT_NAME_MAX, VAULT_SHORT_MAX, VAULT_URL_MAX, type VaultEntry, type VaultItemOp, type VaultItemPatch } from "~~/shared/vault";
import { formatPrice, parsePriceInput, zeroPrice } from "~~/shared/money";
import { CLASS_ICONS } from "~/utils/classIcons";
import { entryUnitFromInput, formatWeight, itemDisplayName, parseWeightInput } from "~~/shared/weights";
import { offersKcal, offersWorn } from "~~/shared/fuel";
import type { GearGlyph } from "~~/shared/gearGlyph";
import { gearIcon, gearIconLabel } from "~/utils/gearIcons";
import type { NameCommit } from "~/composables/useCatalogSearch";

// Correcting a piece of gear in place — the half of My Gear that capture can't do —
// and adding one by hand (`adding`): the same form, blank, with a catalog search on top
// whose pick fills it in. One form for both, so a piece is added with everything it can
// hold rather than a name and a weight, and the two can't drift apart.
//
// A DIALOG rather than an in-flow .reveal, and the motion vocabulary is why: that
// family is for "a row's note" (atoms/controls.scss), and ten fields is a form, not
// a note. A mechanical reason agrees: the classification picker is an absolutely
// positioned .menu__list, and /gear's rows live inside .folder__bodyinner's
// `overflow: hidden`, so going in-flow would mean lifting that clip for one control.
//
// The cost, plainly: a run of tidy-ups is open/edit/save per row rather than tabbing
// down a column. Acceptable because /gear's row is DISPLAY — turning it into the
// editor's live form is a bigger change than this page wants to be.
const props = defineProps<{
  /** the piece being edited; when `adding`, a blank one the form starts from */
  entry: VaultEntry | null;
  adding?: boolean;
  unit: Unit;
  /** The money the rest of your gear is priced in, when it is priced in one. A bare
   *  number falls back to it, so stating a currency once is enough — see onSubmit. */
  defaultCurrency?: string;
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
const emit = defineEmits<{ close: []; saved: [item: VaultEntry]; added: [item: VaultEntry] }>();

const vault = useVaultOps();

// This dialog is a PIECE's. A kit is edited in its section on the Kits tab
// (VaultKitSection), and made there with New kit; it had a "Make it a kit" button
// too, and it went (2026-11-08) for being a second door to the same room.

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

// The form, as typed: one object, so a field is listed once here, once in formFrom,
// and the template binds it. (They were eleven refs, restated in `opened` and in the
// watcher twice, so a new field had four places to be added in step.)
interface ItemForm {
  brand: string;
  name: string;
  variant: string;
  commonName: string;
  weight: string;
  kcal: string;
  /** how many you own, as typed; blank or 1 is one */
  owned: string;
  price: string;
  productUrl: string;
  classification: Classification;
  /** the icon you picked by hand; null = the gear type decides, live, as you type it */
  icon: GearGlyph | null;
}
const blankForm = (): ItemForm => ({
  brand: "",
  name: "",
  variant: "",
  commonName: "",
  weight: "",
  kcal: "",
  owned: "",
  price: "",
  productUrl: "",
  classification: "base",
  icon: null,
});
const form = reactive(blankForm());
const shownIcon = computed(() => gearIcon(form.commonName, form.name, form.icon));
const shownLabel = computed(() => gearIconLabel(form.commonName, form.name, form.icon));
// what "Match the gear type" would draw: the type's icon, read from the fields as they stand
const autoIcon = computed(() => gearIcon(form.commonName, form.name));
// the unit this piece's weight reads in: its own, else the page's (the row's rowUnit)
const rowUnit = computed<Unit>(() => props.entry?.entryUnit ?? props.unit);
const saving = ref(false);
const error = ref("");

// ---- adding: the catalog search -------------------------------------------------
// A pick fills the form: what the product IS (brand, name, size, its catalog link)
// always, and its gear type, weight and calories only where the field is empty or
// still holds the last pick's, so a weight you typed first is kept (the one you
// measured is the one My Gear keeps) and a second pick replaces the first's. The link
// goes with the piece only while brand, name and size still say that product.
const picked = ref<{ id: number; brand: string; name: string; variant: string } | null>(null);
let pickFill = { commonName: "", weight: "", kcal: "" };
function onPick(c: NameCommit) {
  form.brand = c.brand ?? "";
  form.name = c.name;
  form.variant = c.variant ?? "";
  const fill = (field: "commonName" | "weight" | "kcal", value: string) => {
    if (!value || (form[field] && form[field] !== pickFill[field])) return;
    form[field] = value;
    pickFill[field] = value;
  };
  fill("commonName", c.commonName ?? "");
  fill("weight", c.weightMg ? formatWeight(c.weightMg, rowUnit.value, { raw: true }) : "");
  fill("kcal", c.kcal ? String(c.kcal) : "");
  if (c.classification && form.classification === "base") form.classification = c.classification;
  picked.value = c.catalogItemId != null ? { id: c.catalogItemId, brand: form.brand, name: form.name, variant: form.variant } : null;
}
// Enter on text that isn't a product: it is the name you meant
let searchText = "";
function onSearchSubmit() {
  if (searchText.trim()) form.name = searchText.trim();
}
const linkedId = (): number | undefined =>
  picked.value && picked.value.brand === form.brand && picked.value.name === form.name && picked.value.variant === form.variant
    ? picked.value.id
    : undefined;
// What the row says it is, read LIVE from the two fields as they are typed, the way the
// class picker's own value is: the name and gear type decide the row's other controls
// (shared/fuel), and the dialog answers as the editor row would for the same words.
const named = computed(() => ({ name: form.name, commonName: form.commonName }));
// The kcal field's rule, ItemRow's verbatim: only once it IS consumable (the only state
// in which the number is counted), and not on stove fuel holding no number — a
// canister's "calories" are the wrong kind, and would feed the food plan (offersKcal).
// The "holds a number" half reads what the row OPENED with, not the field — the field
// is the thing being edited, and a field that vanished under the cursor as its last
// digit went would be a trap, not a rule. The field can still go while the dialog is
// open, when the name is edited into fuel with a number typed but unsaved; onSubmit
// drops that number rather than saving what the form no longer shows.
const kcalOffered = computed(
  () => form.classification === "consumable" && offersKcal({ ...named.value, kcal: props.entry?.kcal }),
);
// ...and "Worn" leaves the picker on water and stove fuel, as the editor row drops its
// worn toggle there (offersWorn, the one rule for both): nobody wears a gas canister.
// Kept while the entry IS worn, so a value that got there can be walked back — the
// picker can't offer a way out of a state it doesn't list.
const classOptions = computed(() =>
  offersWorn(named.value, form.classification === "worn") ? CLASS_OPTIONS : CLASS_OPTIONS_UNWORN,
);

// What the dialog opened with. The patch is the DIFF against this, because a field
// that reaches the server gets PINNED — and pinning is a promise about the future,
// not a description of the save. Sending the whole form would mean opening this to
// look at a row and pressing Save quietly opted it out of ever learning anything
// from your lists again, which is not what "your lists stop overwriting a field once
// you've corrected it" says. Only what you actually changed becomes yours.
let opened = blankForm();
const changed = (field: keyof ItemForm) => form[field] !== opened[field];

/** The form a stored piece opens as. */
function formFrom(e: VaultEntry): ItemForm {
  return {
    brand: e.brand ?? "",
    name: e.name,
    variant: e.variant ?? "",
    commonName: e.commonName ?? "",
    // raw: true — an editable field must never be handed "<1 g", which is a summary,
    // not a value: parsing it back would throw away the weight it stands for. The
    // UNIT stays in the string (CatalogCorrectionModal prefills the same way), so a
    // field showing "1.2" can't be misread when the page is in kg — and
    // parseWeightInput reads the suffix straight back.
    weight: e.weightMg ? formatWeight(e.weightMg, e.entryUnit ?? props.unit, { raw: true }) : "",
    kcal: e.kcal ? String(e.kcal) : "",
    owned: e.owned ? String(e.owned) : "",
    // FORMATTED, not the bare cents: "$399.00" is what the row shows and what
    // parsePriceInput reads straight back, so the symbol you'd otherwise have to
    // retype is already there — and the same only-if-the-string-changed guard the
    // weight field uses (below) keeps the round trip from re-pricing anything.
    price: e.priceCents != null ? formatPrice(e.priceCents, e.currency) : "",
    productUrl: e.productUrl ?? "",
    // absent means "never stated", which for a vault row IS base: capture drops the
    // field when the list row was inheriting its folder's default
    classification: e.classification ?? "base",
    icon: e.icon ?? null,
  };
}

// Which opening of the dialog this is. A save is a round trip, and Cancel (and Esc)
// stay live while it's out, so its answer can land after the dialog closed or opened on
// another piece: that answer still updates its own row on the page (`saved` / `added`),
// but it must not close the dialog now showing, put its error there, or re-enable a
// Save that belongs to a different send. Each send keeps the number it started under.
let opening = 0;

// `immediate`, because this component is Lazy-mounted on first use when `entry` is
// ALREADY set — a plain watch would never fire for that first open. The same trap
// CatalogCorrectionModal's prefill and BaseModal's own focus watcher both note.
watch(
  () => props.entry,
  (e) => {
    opening++;
    if (!e) return;
    Object.assign(form, formFrom(e));
    opened = { ...form };
    saving.value = false;
    error.value = "";
    picked.value = null;
    pickFill = { commonName: "", weight: "", kcal: "" };
  },
  { immediate: true },
);

// A name is the one thing a vault row cannot be without: vaultNormKey returns "" for
// a nameless row and every caller reads that as "not gear".
const canSave = computed(() => !!form.name.trim());
const urlOk = computed(() => /^https?:\/\/\S/i.test(form.productUrl.trim()));

async function onSubmit() {
  if (!canSave.value || saving.value || !props.entry) return;

  // null, not undefined, for a field you emptied: the edit op has to be able to
  // CLEAR one, which capture's coalesce merge structurally can't (see vaultRepo).
  const patch: VaultItemPatch = {};
  if (changed("brand")) patch.brand = form.brand.trim().slice(0, VAULT_SHORT_MAX) || null;
  if (changed("name")) patch.name = form.name.trim().slice(0, VAULT_NAME_MAX);
  if (changed("variant")) patch.variant = form.variant.trim().slice(0, VAULT_SHORT_MAX) || null;
  if (changed("commonName")) {
    patch.commonName = form.commonName.trim().slice(0, VAULT_SHORT_MAX) || null;
  }
  if (changed("owned")) {
    // a whole number above one, or back to one (blank, 0 and 1 all mean one), by the
    // server's own rule (ownedOf)
    const n = Number(form.owned.trim() || "1");
    if (!Number.isFinite(n) || n < 0) {
      error.value = "How many you own should be a whole number, like 3.";
      return;
    }
    patch.owned = ownedOf(n) ?? null;
  }
  if (changed("icon")) patch.icon = form.icon;
  if (changed("classification")) {
    // "base" is stored as absent, the convention the capture path keeps
    patch.classification = form.classification === "base" ? null : form.classification;
  }
  // The kcal is sent only where the fuel rule would show the field for it — the same
  // test kcalOffered makes, minus the class: a kcal on a non-consumable row is carried
  // but never counted, so a number you typed is kept rather than wiped (the value never
  // stops being true of the food). On a fuel row it WOULD be counted, so a number typed
  // before the name was edited into fuel — the field gone, the digits still in the ref —
  // is dropped rather than saved unseen, and the next list to pick this row gets none.
  if (changed("kcal") && offersKcal({ ...named.value, kcal: props.entry?.kcal })) {
    const k = form.kcal.trim() ? Math.max(0, Math.round(Number(form.kcal))) : 0;
    patch.kcal = k > 0 ? k : null;
  }
  if (changed("price")) {
    const raw = form.price.trim();
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
  if (changed("productUrl")) {
    const url = form.productUrl.trim().slice(0, VAULT_URL_MAX);
    if (url && !urlOk.value) {
      error.value = "A product link has to start with http:// or https://.";
      return;
    }
    patch.productUrl = url || null;
  }
  // Only when the string CHANGED. formatWeight → parseWeightInput is lossy (0.1 oz
  // resolution) and locale-shaped, so round-tripping a field nobody typed in would
  // silently re-weigh the row. CatalogCorrectionModal splits the same way.
  if (changed("weight")) {
    const raw = form.weight.trim();
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

  if (props.adding) return add(patch);
  // Nothing changed: closing is the honest answer. Sending an empty patch would be a
  // round trip to write nothing, and the endpoint refuses one anyway.
  if (!Object.keys(patch).length) return emit("close");

  saving.value = true;
  error.value = "";
  const mine = opening;
  const res = await vault.op({ t: "edit", id: props.entry.id, patch });
  // the row takes what was saved whichever piece the dialog shows by now
  if (res.ok && res.item) emit("saved", res.item);
  if (mine !== opening) return;
  saving.value = false;
  if (!res.ok || !res.item) {
    error.value = "Couldn’t save that. Check your connection and try again.";
    return;
  }
  emit("close");
}

// Adding: the form read the same way an edit is (the patch against a blank form is
// everything typed), sent as one add. An icon picked by hand follows as an edit, the
// one field an add doesn't take.
async function add(p: VaultItemPatch) {
  const op: VaultItemOp = {
    t: "add",
    name: form.name.trim().slice(0, VAULT_NAME_MAX),
    ...(p.brand ? { brand: p.brand } : {}),
    ...(p.variant ? { variant: p.variant } : {}),
    ...(p.commonName ? { commonName: p.commonName } : {}),
    ...(p.weightMg ? { weightMg: p.weightMg } : {}),
    ...(p.entryUnit ? { entryUnit: p.entryUnit } : {}),
    ...(p.classification ? { classification: p.classification } : {}),
    ...(p.kcal ? { kcal: p.kcal } : {}),
    ...(p.priceCents ? { priceCents: p.priceCents, ...(p.currency ? { currency: p.currency } : {}) } : {}),
    ...(p.productUrl ? { productUrl: p.productUrl } : {}),
    ...(p.owned ? { owned: p.owned } : {}),
    ...(linkedId() != null ? { catalogItemId: linkedId() } : {}),
  };
  saving.value = true;
  error.value = "";
  const mine = opening;
  // read now, with the form: by the time the add answers, the form may hold whatever
  // piece the dialog has opened on since
  const pickedIcon = form.icon;
  const res = await vault.op(op);
  if (!res.ok || !res.item) {
    if (mine !== opening) return;
    saving.value = false;
    // the refusals are worth naming: "you already have that" says to search for it
    error.value =
      res.reason === "duplicate"
        ? "You already have that in My Gear."
        : res.reason === "full"
          ? "My Gear is full. Remove something to make room."
          : "Couldn’t add that. Check your connection and try again.";
    return;
  }
  let item = res.item;
  if (pickedIcon) {
    const set = await vault.op({ t: "edit", id: item.id, patch: { icon: pickedIcon } });
    if (set.ok && set.item) item = set.item;
  }
  emit("added", item);
  if (mine !== opening) return;
  saving.value = false;
  emit("close");
}
</script>

<template>
  <BaseModal :open="!!entry" :label="adding ? 'Add gear' : 'Edit gear'" @close="emit('close')">
    <template v-if="entry">
      <h2 class="t-label">{{ adding ? "Add gear" : "Edit gear" }}</h2>
      <p v-if="!adding" class="dlg__item">{{ itemDisplayName(entry.brand, entry.name, entry.variant) }}</p>
      <!-- Adding: a catalog search over the form, given by the page (#search; /gear
           passes the list editor's own name field). A pick fills the fields below and the
           box clears; Enter on a name the catalog doesn't have puts it in Product. -->
      <slot v-if="adding" name="search" :pick="onPick" :typed="(v: string) => (searchText = v)" :submit="onSearchSubmit" />
      <!-- No explainer under the title. What you change here is pinned (vaultRepo), so no
           list writes over it, and that is what anyone expects of an edit; a line saying
           so took a row on every open, and went in review. -->

      <div class="vitem">
      <div class="vitem__pair">
        <label class="dlg__field">
          <span class="t-sm t-muted">Brand</span>
          <!-- "Add a …" like the note's placeholder: these fields have no border, so an
               empty one was blank space under its label. Not an example ("Patagonia"),
               which reads as data the way "399" did as a price. -->
          <input
            v-model="form.brand"
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
          <input v-model="form.variant" class="field" placeholder="Add a size" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
        </label>
      </div>

      <label class="dlg__field">
        <!-- "Product", not "Name": beside Brand, "Name" read as the whole name, and this
             is only the part after it ("Keb Hike 30", "Builders Protein Bar") -->
        <span class="t-sm t-muted">Product</span>
        <input v-model="form.name" class="field" autocomplete="off" autocorrect="off" spellcheck="false" @keydown.enter="onSubmit" />
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
            v-model="form.commonName"
            class="field"
            placeholder="Type of gear"
            :list="`${vocabId}-types`"
            @focus="catalogTypes.load()"
            @keydown.enter="onSubmit"
          />
        </label>
        <div class="dlg__field">
          <span class="t-sm t-muted">Icon</span>
          <!-- a popover over the box, as on the row's own icon -->
          <GearIconPicker v-model="form.icon" class="vitem__iconpick" :auto="autoIcon" label="Icons">
            <template #trigger="{ open, toggle, attrs }">
              <button
                type="button"
                class="field vitem__iconbtn"
                v-bind="attrs"
                :aria-label="`Icon: ${shownLabel ?? 'none'}`"
                @click="toggle"
              >
                <HugeiconsIcon v-if="shownIcon" :icon="shownIcon" :size="20" :stroke-width="2" aria-hidden="true" />
                <HugeiconsIcon v-else :icon="DashedLine02Icon" class="vitem__noicon" :size="20" :stroke-width="2" aria-hidden="true" />
                <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2" aria-hidden="true" />
              </button>
            </template>
          </GearIconPicker>
        </div>
      </div>

      <div class="vitem__pair">
        <label class="dlg__field">
          <span class="t-sm t-muted">Weight</span>
          <input
            v-model="form.weight"
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
            :current="form.classification"
            label="Gear classification"
            @pick="(k) => (form.classification = k as Classification)"
          >
            <template #trigger="{ active, open }">
              <span>{{ active?.label }}</span>
              <HugeiconsIcon :icon="ChevronDownIcon" class="chev" :class="{ 'is-open': open }" :size="14" :stroke-width="2" aria-hidden="true" />
            </template>
          </OptionMenu>
        </div>
      </div>

      <!-- How many you own, beside the calories: both are counts about the piece itself,
           and a pair keeps the dialog's two columns. Calories only once it IS consumable,
           and not on fuel that has none to show — ItemRow's rule verbatim (see
           kcalOffered). -->
      <div class="vitem__pair">
        <label class="dlg__field">
          <!-- "Number owned", not "How many" or "Quantity": either reads as how many a
               trip takes, which is the list row's qty (and a kit's count), never this.
               A noun, like the dialog's other labels. -->
          <span class="t-sm t-muted">Number owned</span>
          <input v-model="form.owned" class="field" inputmode="numeric" placeholder="1" @keydown.enter="onSubmit" />
        </label>
        <label v-if="kcalOffered" class="dlg__field">
          <span class="t-sm t-muted">kcal each</span>
          <input v-model="form.kcal" class="field" inputmode="numeric" placeholder="0" @keydown.enter="onSubmit" />
        </label>
      </div>

      <!-- what it cost and where it came from, read together, on the same two columns as
           every pair above: a narrower price track started the link's column 66px left
           of every other second column in the dialog -->
      <div class="vitem__pair">
        <label class="dlg__field">
          <span class="t-sm t-muted">Price</span>
          <!-- inputmode text, not decimal: a currency symbol is part of what this
               field reads, and a numeric keypad can't type one -->
          <!-- zero, like the weight and kcal beside it (an example figure, "399", read as a
               real price on a protein bar), in the currency a bare number will be saved
               in: the piece's own, else the one the rest of your gear is priced in. The
               same order onSubmit applies, so "$0" is a promise, not a guess. -->
          <input
            v-model="form.price"
            class="field"
            :placeholder="zeroPrice(entry.currency ?? defaultCurrency)"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            @keydown.enter="onSubmit"
          />
        </label>
        <label class="dlg__field">
          <span class="t-sm t-muted">
            Product link
            <a v-if="urlOk" :href="form.productUrl.trim()" class="link" target="_blank" rel="noopener noreferrer">Open</a>
          </span>
          <input v-model="form.productUrl" class="field" placeholder="https://" inputmode="url" @keydown.enter="onSubmit" />
        </label>
      </div>
      </div>

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
          {{ saving ? "Saving…" : adding ? "Add" : "Save" }}
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
/* The dialog's own width decides its columns, not the window's: a 30rem dialog has
   room for two fields side by side in a narrow pane as much as on a wide screen, and
   only a phone-narrow dialog stacks them. .vitem is the container the pairs ask, and
   the column the fields stand in. */
.vitem {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
@container (max-width: 22rem) {
  .vitem__pair {
    grid-template-columns: 1fr;
  }
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
/* the popover's anchor is the whole Icon column, not the small box: the card then
   hangs from the dialog's right edge and stays inside it, where hung from the box in
   the second column it ran off the dialog's left */
.vitem__iconpick {
  width: 100%;
}
.vitem__iconbtn {
  /* .field sets a field's full width; this one is a glyph and a chevron */
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
/* Brand and Gear type suggest from a native datalist, and Chrome and Safari draw their
   own triangle on such a field: a browser control in a dialog of borderless fields,
   which read as a broken chevron. The suggestions still open as you type. */
.dlg__field input::-webkit-calendar-picker-indicator,
.dlg__field input::-webkit-list-button {
  display: none !important;
}
/* Plain ink, not --danger: the monochrome rule reserves colour for irreversible acts
   and for the data viz (tokens.scss), and a save that didn't go through is neither.
   Matches /gear's own .vault__error. */
.vitem__err {
  color: var(--ink);
}
</style>
