<script setup lang="ts">
import { csvToListData } from "~~/shared/exporters/csv";
import { jsonToListImport } from "~~/shared/exporters/json";
import { lighterpackId } from "~~/shared/lighterpack";
import { linkImportedItems } from "~~/shared/catalogMatch";
import type { CatalogSearchResult } from "~~/shared/catalogSearch";
import { MAX_TITLE_LEN } from "~~/shared/ops";
import { editLinkPath } from "~~/shared/links";
import type { ListData, ListMeta } from "~~/shared/types";
import { IconQuestionmarkCircle } from "~/icons/central";
import { SvgIcon } from "~/utils/icon";

// "Import a list" dialog — mint a NEW list from a LighterPack share link, a
// pasted CSV, a JSON backup (the menus' "Download JSON"), or an uploaded file,
// then navigate into it. Mounted once in the editor; opened from the menu.
// LighterPack links are resolved + parsed server-side (/api/import —
// host-allowlisted, no SSRF surface); CSV/TSV and JSON are parsed client-side.
// This is the importer the old home page used to host.
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const router = useRouter();

const text = ref("");
// what to call the list; empty falls back to the backup's own title, then "Imported list"
const title = ref("");
const importNote = useImportNote();
const importing = ref(false);
const error = ref("");
// Which opening of the dialog a request belongs to. Nothing can recall a request already
// sent, but closing is still an answer: what comes back afterwards must not go on to the
// next step, write into a form that has moved on, or take you off the list you stayed on.
let opening = 0;
// Where a backup comes from, by the words the editor shows: the row is "JSON" on the
// Sharing panel's Export tab. "Download JSON" is only that row's aria-label here (it is
// the visible label in the read view's and My Gear's menus), and Help says it this way.
const BACKUP_FROM = "Make one from the Export tab in Sharing.";
/** what the (?) beside "Choose a file…" says: the CSV's columns, and the other file it takes */
const FORMATS =
  "A CSV needs a header row: Category, Item Name, Qty, Weight, Unit, Worn, Consumable. A file can also be a JSON backup from the Export tab in Sharing.";

// fresh form each time the dialog is opened
watch(
  () => props.open,
  (o) => {
    opening++;
    if (o) {
      text.value = "";
      title.value = "";
      error.value = "";
      importing.value = false;
    }
  },
);

// A JSON-backup restore arrives as the whole list — its meta (title, unit, the route
// read off a GPX, the trip dates) around its content; CSV/LighterPack imports are
// content alone and keep the stock title.
async function createFrom(list: Partial<ListMeta> & { data: ListData }) {
  const mine = opening;
  // a folders-only JSON backup is still a real restore; an empty CSV is not
  if (!list.data.items.length && !list.data.folders.length) {
    error.value = "No items found. Paste a CSV with a header row.";
    importing.value = false;
    return;
  }
  importing.value = true;
  error.value = "";
  try {
    // Rows that name a catalog product word for word arrive linked, as if picked (the
    // matcher is exact-only). One request; if it fails the list still imports, unlinked —
    // the link is a nicety on top of the import, never a condition of it.
    const linked = await linkToCatalog(list.data.items);
    if (mine !== opening) return;
    const data: ListData = { ...list.data, items: linked.items };
    // the backup forwarded whole, meta and content. It was thirteen `x: meta?.x`
    // lines, one per ListMeta field — the shape that once let trip dates go
    // missing from this very list (see LIST_META_KEYS); a field the export writes
    // now reaches the restore without anyone remembering to add it here.
    // An import arrives whole (no ops), so the create ALSO captures it to your vault
    // and registers it here, in the order the copy path keeps (createAndRegisterList).
    const { snapshot, token } = await createAndRegisterList({
      ...list,
      data,
      title: title.value.trim() || list.title || "Imported list",
    });
    tally("import");
    // Past the point of recall: the list exists and is in your lists. You just don't get
    // moved to it, having left.
    if (mine !== opening) return;
    emit("close");
    // set before the navigation, so the editor finds it the moment the list lands; a
    // list where nothing matched gets no note — "0 of 25" reads as a failure it isn't
    importNote.value = linked.matched
      ? `${linked.matched} of ${data.items.length} items linked to the catalog.`
      : null;
    router.push(editLinkPath(snapshot.shareCode, token));
  } catch {
    if (mine === opening) error.value = "Import failed. Check the file and try again.";
  } finally {
    if (mine === opening) importing.value = false;
  }
}

async function linkToCatalog(items: ListData["items"]): Promise<{ items: ListData["items"]; matched: number }> {
  // a backup carries its links already; only unlinked, named rows are worth a question
  if (!items.some((i) => i.catalogItemId == null && i.name.trim())) return { items, matched: 0 };
  try {
    const { matches } = await $fetch<{ matches: (CatalogSearchResult | null)[] }>("/api/catalog/match", {
      method: "POST",
      body: { names: items.map((i) => ({ name: i.name, brand: i.brand, variant: i.variant })) },
    });
    return linkImportedItems(items, matches);
  } catch {
    return { items, matched: 0 };
  }
}

async function importFromText() {
  const raw = text.value.trim();
  if (!raw) return;
  // a LighterPack share link → resolve + parse its sanctioned CSV export server-side
  if (lighterpackId(raw)) {
    const mine = opening;
    importing.value = true;
    error.value = "";
    try {
      const { data } = await $fetch<{ data: ListData }>("/api/import", {
        method: "POST",
        body: { url: raw },
      });
      if (mine !== opening) return;
      await createFrom({ data });
    } catch (e: unknown) {
      if (mine !== opening) return;
      const err = e as { data?: { statusMessage?: string; message?: string } };
      error.value =
        err?.data?.statusMessage || err?.data?.message || "Couldn’t import that LighterPack link.";
      importing.value = false;
    }
    return;
  }
  // a pasted JSON backup (the menus' "Download JSON") — restored at full fidelity
  if (raw.startsWith("{")) {
    const parsed = jsonToListImport(raw);
    if (parsed) return createFrom(parsed);
    error.value = `That looks like JSON, but not a list backup. ${BACKUP_FROM}`;
    return;
  }
  // otherwise treat the pasted text as CSV/TSV — parsed client-side
  createFrom({ data: csvToListData(raw) });
}

// a chosen file, already read (FilePickButton). A .json file is a "Download JSON"
// backup — full-fidelity restore. Sniff {-leading content too, so a mis-extensioned
// backup still restores.
function importFile(text: string, file: File) {
  // the file button stays live beside a request in flight; one import at a time
  if (importing.value) return;
  const isJson = /\.json$/i.test(file.name) || file.type === "application/json";
  if (isJson || text.trimStart().startsWith("{")) {
    const parsed = jsonToListImport(text);
    if (parsed) return void createFrom(parsed);
    if (isJson) {
      error.value = `Couldn’t read that file as a list backup. ${BACKUP_FROM}`;
      return;
    }
  }
  void createFrom({ data: csvToListData(text) });
}
</script>

<template>
  <BaseModal :open="open" label="Import a list" @close="emit('close')">
    <h2 class="t-label panel__title">Import a list</h2>
    <!-- Two things nothing else on screen says: that the file picker takes the app's
         own JSON backup (its accept filter is invisible until the picker opens), and
         that an import ARRIVES as a new list rather than merging into the one you're
         looking at. The (?) beside the file button carries the CSV shape. -->
    <p class="t-sm t-muted dlg__lede">
      Paste a LighterPack link or a CSV, or choose a file. It becomes a new list.
    </p>

    <input
      v-model="title"
      class="field well import__name"
      :maxlength="MAX_TITLE_LEN"
      placeholder="List name"
      aria-label="List name"
      autocorrect="off"
      spellcheck="false"
    />

    <textarea
      v-model="text"
      class="field well import__text"
      rows="5"
      placeholder="https://lighterpack.com/r/… or paste a CSV"
      aria-label="LighterPack link or CSV"
    />
    <!-- the other way in, with the box it is the alternative to (FilePickButton says why
         it left the action row); choosing a file imports immediately, so there's no
         chosen-name state to show.
         Beside it, the (?) the header's "Import map file" has for the same job: which
         files and what shape. That was four lines of grey type under the button, the
         longest thing on the card, read by everyone to serve the few composing a CSV by
         hand. It is one tap or hover away for them, and the lede already says a link, a
         CSV or a file. -->
    <div class="import__pick">
      <FilePickButton @text="importFile" />
      <Tooltip :text="FORMATS" preferred-placement="top">
        <button type="button" class="import__why foreground-quiet" aria-label="Which files and columns can be imported">
          <SvgIcon :icon="IconQuestionmarkCircle" aria-hidden="true" />
        </button>
      </Tooltip>
    </div>

    <p v-if="error" class="t-sm import__err">{{ error }}</p>

    <div class="dlg__actions">
      <button class="btn btn--soft" @click="emit('close')">Cancel</button>
      <button class="btn btn--primary" :disabled="importing || !text.trim()" @click="importFromText">
        {{ importing ? "Importing…" : "Import" }}
      </button>
    </div>
  </BaseModal>
</template>

<style scoped>
/* overlay + dialog shell live in atoms/dialog.scss; only the import-specific
   body is scoped here */
/* the tint is the shared .well atom (controls.scss) */
/* ONE GROUP, one distance. The name, the paste box and the file button are the dialog's
   inputs, so they sit the card's own gap apart (--space-3), and
   the two wider steps are the shared ones on either side of them: under the lede and
   over the buttons. The name used to push the box a further --space-2 away and the hint
   itself the same from the button, so the steps down the card ran 12, 20, 20, 12, 20,
   20 and nothing read as belonging with anything.
   Its placeholder says what the field IS, in the words the editor's own title field
   uses. It said "Imported list", the name an empty field falls back to, which read as
   a caption on the box below it.
   The name is CONTAINED, in the paste box's own tint (.well). Bare, its placeholder
   was a grey phrase adrift between the lede and the box, with nothing to say it was a
   field or what it named: on a floating card there are no rows around a control to
   imply its edges. */
.import__name {
  /* the height the copy-link field has (AppDialogs), the other one-line well on a card */
  padding-block: var(--space-2);
}
/* No font-size of its own. .field sets the literal 16px (--text-input) that keeps
   iOS from zooming the page when the box takes focus; a var(--text-base) here
   overrode it with the fluid max(), which iOS mis-reads and zooms on anyway
   (controls.scss, .field). */
.import__text {
  padding: var(--space-3);
  /* no resize: the native grip drew a square notch over the rounded corner, and
     the box scrolls anyway (the dialog is fixed-width, rows are fixed) */
  resize: none;
}
/* the file button and the (?) that says what it takes, on one line */
.import__pick {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
/* the header's (?) for map files, the same quiet treatment (.foreground-quiet, in the markup),
   at the icon scale's full step and not its small one: the small glyph is sized to sit
   in a row of figures, and beside a 40px button it was a speck. The padding is its
   press area, taken back by the margin so the row's spacing is the glyph's. */
.import__why {
  display: inline-flex;
  padding: var(--space-2);
  margin: calc(-1 * var(--space-2));
  cursor: help;
}
.import__err {
  color: var(--foreground-primary);
}
</style>
