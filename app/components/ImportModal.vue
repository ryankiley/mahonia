<script setup lang="ts">
import { csvToListData } from "~~/shared/exporters/csv";
import { jsonToListImport } from "~~/shared/exporters/json";
import { lighterpackId } from "~~/shared/lighterpack";
import { editLinkPath } from "~~/shared/links";
import type { ListData, ListSnapshot, Unit } from "~~/shared/types";

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

// meta rides along on a JSON-backup restore (its title/unit/description are the
// list's own); CSV/LighterPack imports have no meta and keep the stock title
async function createFrom(
  data: ListData,
  meta?: { title?: string; description?: string; displayUnit?: Unit },
) {
  // a folders-only JSON backup is still a real restore; an empty CSV is not
  if (!data.items.length && !data.folders.length) {
    error.value = "No items found. Paste a CSV with a header row.";
    return;
  }
  importing.value = true;
  error.value = "";
  try {
    const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>("/api/lists/create", {
      method: "POST",
      body: {
        title: meta?.title || "Imported list",
        description: meta?.description,
        displayUnit: meta?.displayUnit,
        data,
      },
    });
    emit("close");
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
      await createFrom(data);
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
    if (parsed) return createFrom(parsed.data, parsed);
    error.value = "That looks like JSON, but not a list backup. Use “Download JSON” to make one.";
    return;
  }
  // otherwise treat the pasted text as CSV/TSV — parsed client-side
  createFrom(csvToListData(raw));
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
      if (parsed) return void createFrom(parsed.data, parsed);
      if (isJson) {
        error.value = "Couldn’t read that file as a list backup. Use “Download JSON” to make one.";
        return;
      }
    }
    void createFrom(csvToListData(text));
  };
  reader.readAsText(file);
}
</script>

<template>
  <BaseModal :open="open" label="Import a list" @close="emit('close')">
    <p class="t-label">Import a list</p>
    <p class="t-sm t-muted dlg__lede">
      Paste a LighterPack share link, a CSV (LighterPack’s “Export to CSV” or any
      spreadsheet), or choose a file. A JSON backup from “Download JSON” restores
      the full list. It becomes a new list.
    </p>

    <textarea
      v-model="text"
      class="field import__text"
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
.import__text {
  width: 100%;
  font-family: var(--font);
  font-size: var(--text-sm);
  /* the menus' language, not a hairline box: quiet tinted well, rounded like a
     popover item (radius-3 − space-2, the same concentric step the menus use) */
  border: 0;
  background: var(--paper-2);
  border-radius: calc(var(--radius-3) - var(--space-2));
  padding: var(--space-3);
  /* no resize: the native grip drew a square notch over the rounded corner, and
     the box scrolls anyway (the dialog is fixed-width, rows are fixed) */
  resize: none;
  color: var(--ink);
  transition: background var(--dur) var(--ease);
}
.import__text::placeholder {
  color: var(--ink-3);
}
/* focus deepens the well a step (the caret carries focus, house-style — no ring) */
.import__text:focus {
  outline: none;
  background: color-mix(in oklab, var(--ink) 4%, var(--paper-2));
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
