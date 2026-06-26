<script setup lang="ts">
import { csvToListData } from "~~/shared/exporters/csv";
import { lighterpackId } from "~~/shared/lighterpack";
import type { ListData, ListSnapshot } from "~~/shared/types";

// "Import a list" dialog — mint a NEW list from a LighterPack share link, a
// pasted CSV, or an uploaded file, then navigate into it. Mounted once in the
// editor; opened from the menu. LighterPack links are resolved + parsed
// server-side (/api/import — host-allowlisted, no SSRF surface); plain CSV/TSV
// is parsed client-side. This is the importer the old home page used to host.
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const router = useRouter();
const myLists = useMyLists();

const text = ref("");
const importing = ref(false);
const error = ref("");

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

async function createFrom(data: ListData) {
  if (!data.items.length) {
    error.value = "No items found — paste a CSV with a header row.";
    return;
  }
  importing.value = true;
  error.value = "";
  try {
    const res = await $fetch<{ editToken: string; snapshot: ListSnapshot }>("/api/lists/create", {
      method: "POST",
      body: { title: "Imported list", data },
    });
    emit("close");
    router.push(`/e#${myLists.registerCreated(res)}`);
  } catch {
    error.value = "Import failed — check the CSV and try again.";
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
  // otherwise treat the pasted text as CSV/TSV — parsed client-side
  createFrom(csvToListData(raw));
}

function onFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => createFrom(csvToListData(String(reader.result)));
  reader.readAsText(file);
}
</script>

<template>
  <BaseModal :open="open" label="Import a list" @close="emit('close')">
    <p class="t-label">Import a list</p>
    <p class="t-sm t-muted dlg__lede">
      Paste a LighterPack share link, a CSV (LighterPack’s “Export to CSV” or any
      spreadsheet), or choose a file. It becomes a new list.
    </p>

    <textarea
      v-model="text"
      class="field import__text"
      rows="5"
      placeholder="https://lighterpack.com/r/… — or — Category,Item Name,Qty,Weight,Unit,Worn,Consumable…"
    />

    <p v-if="error" class="t-sm import__err">{{ error }}</p>

    <div class="import__actions">
      <input type="file" accept=".csv,.tsv,text/csv,text/plain" @change="onFile" />
      <span class="dlg__spacer" />
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
  border: 1px solid var(--line);
  padding: var(--space-3);
  resize: vertical;
}
.import__err {
  color: var(--ink);
}
.import__actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.dlg__spacer {
  flex: 1;
}
</style>
