<script setup lang="ts">
import { csvToListData } from "~~/shared/exporters/csv";
import { jsonToListImport } from "~~/shared/exporters/json";
import { lighterpackId } from "~~/shared/lighterpack";
import { editLinkPath } from "~~/shared/links";
import type { ListData, ListMeta, ListSnapshot } from "~~/shared/types";

// "Import a list" dialog — mint a NEW list from a LighterPack share link, a
// pasted CSV, a JSON backup (the menus' "Download JSON"), or an uploaded file,
// then navigate into it. Mounted once in the editor; opened from the menu.
// LighterPack links are resolved + parsed server-side (/api/import —
// host-allowlisted, no SSRF surface); CSV/TSV and JSON are parsed client-side.
// This is the importer the old home page used to host.
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const router = useRouter();
const myLists = useMyLists();

const text = ref("");
const importing = ref(false);
const error = ref("");
const fileRef = useTemplateRef<HTMLInputElement>("fileRef");

// fresh form each time the dialog is opened
watch(
  () => props.open,
  (o) => {
    if (o) {
      text.value = "";
      error.value = "";
      importing.value = false;
    }
  },
);

// A JSON-backup restore arrives as the whole list — its meta (title, unit, the route
// read off a GPX, the trip dates) around its content; CSV/LighterPack imports are
// content alone and keep the stock title.
async function createFrom(list: Partial<ListMeta> & { data: ListData }) {
  // a folders-only JSON backup is still a real restore; an empty CSV is not
  if (!list.data.items.length && !list.data.folders.length) {
    error.value = "No items found. Paste a CSV with a header row.";
    return;
  }
  importing.value = true;
  error.value = "";
  try {
    const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>("/api/lists/create", {
      method: "POST",
      // the backup forwarded whole, meta and content. It was thirteen `x: meta?.x`
      // lines, one per ListMeta field — the shape that once let trip dates go
      // missing from this very list (see LIST_META_KEYS); a field the export writes
      // now reaches the restore without anyone remembering to add it here.
      body: { ...list, title: list.title || "Imported list" },
    });
    emit("close");
    // an import arrives whole (no ops) — capture it here, where the device knows
    // it just created this list from data you supplied
    useVaultCapture().captureNewList(res.snapshot, res.editToken);
    router.push(editLinkPath(res.snapshot.shareCode, myLists.registerCreated(res)));
  } catch {
    error.value = "Import failed. Check the file and try again.";
  } finally {
    importing.value = false;
  }
}

async function importFromText() {
  const raw = text.value.trim();
  if (!raw) return;
  // a LighterPack share link → resolve + parse its sanctioned CSV export server-side
  if (lighterpackId(raw)) {
    importing.value = true;
    error.value = "";
    try {
      const { data } = await $fetch<{ data: ListData }>("/api/import", {
        method: "POST",
        body: { url: raw },
      });
      await createFrom({ data });
    } catch (e: unknown) {
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
    error.value = "That looks like JSON, but not a list backup. Use “Download JSON” to make one.";
    return;
  }
  // otherwise treat the pasted text as CSV/TSV — parsed client-side
  createFrom({ data: csvToListData(raw) });
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  // clear the selection immediately (the File object is already captured): a
  // failed import keeps the dialog open, and re-choosing the SAME file — the
  // natural retry after fixing it — fires no change event while a value sticks
  input.value = "";
  if (!file) return;
  const isJson = /\.json$/i.test(file.name) || file.type === "application/json";
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result);
    // a .json file is a "Download JSON" backup — full-fidelity restore. Sniff
    // {-leading content too, so a mis-extensioned backup still restores.
    if (isJson || text.trimStart().startsWith("{")) {
      const parsed = jsonToListImport(text);
      if (parsed) return void createFrom(parsed);
      if (isJson) {
        error.value = "Couldn’t read that file as a list backup. Use “Download JSON” to make one.";
        return;
      }
    }
    void createFrom({ data: csvToListData(text) });
  };
  reader.readAsText(file);
}
</script>

<template>
  <BaseModal :open="open" label="Import a list" @close="emit('close')">
    <h2 class="t-label">Import a list</h2>
    <!-- The controls below already say the rest: the placeholder shows the link and
         CSV shapes, and the file picker's accept filter covers JSON. This only has
         to carry the part nothing else does — that an import ARRIVES as a new list
         rather than merging into the one you're looking at. -->
    <p class="t-sm t-muted dlg__lede">
      Paste a LighterPack link or CSV, or choose a file. It becomes a new list.
    </p>

    <textarea
      v-model="text"
      class="field well import__text"
      rows="5"
      placeholder="https://lighterpack.com/r/… or a CSV like Category,Item Name,Qty,Weight,Unit,Worn,Consumable…"
    />

    <p v-if="error" class="t-sm import__err">{{ error }}</p>

    <div class="dlg__actions import__actions">
      <!-- the native file control ("Choose File · No file chosen") can't be
           styled; a real button proxies a hidden input, and choosing a file
           imports immediately (onFile), so there's no chosen-name state to show -->
      <input
        ref="fileRef"
        type="file"
        accept=".csv,.tsv,.json,text/csv,text/plain,application/json"
        class="visually-hidden"
        tabindex="-1"
        aria-hidden="true"
        @change="onFile"
      />
      <button class="btn btn--ghost import__choose" type="button" @click="fileRef?.click()">Choose a file…</button>
      <button class="btn btn--ghost" @click="emit('close')">Cancel</button>
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
.import__text {
  width: 100%;
  font-size: var(--text-base);
  padding: var(--space-3);
  /* no resize: the native grip drew a square notch over the rounded corner, and
     the box scrolls anyway (the dialog is fixed-width, rows are fixed) */
  resize: none;
}
.import__err {
  color: var(--ink);
}
/* composes the shared .dlg__actions row (atoms/dialog.scss); this dialog's extras:
   the row may wrap when narrow, and the file picker anchors left while
   Cancel/Import stay trailing */
.import__actions {
  flex-wrap: wrap;
}
.import__choose {
  margin-right: auto;
}
</style>
