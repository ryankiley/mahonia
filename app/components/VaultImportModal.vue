<script setup lang="ts">
import { parseVaultImport } from "~~/shared/vaultImport";

// "Import gear" — the other end of the ⋯ menu's two downloads.
//
// Without it, "Download JSON" was a backup you could take and never restore, which
// is a worse promise than no backup at all. Takes our own JSON at full fidelity
// (pins included), or any CSV — ours, a spreadsheet's, or a LighterPack export —
// through the same header vocabulary the list importer reads.
//
// Deliberately NOT ImportModal: that one mints a new LIST and navigates you into
// it, resolves LighterPack links server-side, and carries a list's meta. The only
// thing the two share is the shape of the form, which is the app's own dialog atoms.
//
// An import ADDS what's missing and leaves the rest alone (see importVaultItems), so
// there is nothing here to confirm and nothing to undo — which is why the dialog can
// report a plain count and be done.
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: []; imported: [] }>();

const { vaultFetch } = useVaultAccess();

const text = ref("");
const busy = ref(false);
const error = ref("");
// the outcome, shown in place of the form once there is one — an import you can't
// see the result of is an import you run twice
const done = ref<{ added: number; skipped: number } | null>(null);
const fileRef = useTemplateRef<HTMLInputElement>("fileRef");

// fresh each time it opens, like ImportModal's own reset
watch(
  () => props.open,
  (o) => {
    if (!o) return;
    text.value = "";
    error.value = "";
    busy.value = false;
    done.value = null;
  },
);

async function send(raw: string) {
  const { rows } = parseVaultImport(raw);
  if (!rows.length) {
    error.value = "No gear found in that. A CSV needs a header row with an item name.";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const res = await vaultFetch<{ ok: boolean; added: number; skipped: number }>(
      "/api/vault/import",
      { method: "POST", body: { items: rows } },
    );
    done.value = { added: res.added, skipped: res.skipped };
    // the page reloads its gear behind the open dialog, so closing lands on the
    // result rather than on a list that hasn't caught up
    emit("imported");
  } catch {
    error.value = "Couldn’t import that. Check your connection and try again.";
  }
  busy.value = false;
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  // cleared immediately — re-choosing the SAME file after a failure is the natural
  // retry, and it fires no change event while a value sticks (ImportModal's note)
  input.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => void send(String(reader.result));
  reader.readAsText(file);
}

// What happened, in as few words as say it. Two shapes are worth spelling out
// rather than leaving to the numbers: the second sentence appears only when there
// IS a second fact, and "added 0" is said as what it means — a count of nothing
// reads as a failure, when it is almost always the same file arriving twice.
const summary = computed(() => {
  const d = done.value;
  if (!d) return "";
  if (!d.added) {
    return d.skipped === 1
      ? "Nothing new — you already had that one."
      : `Nothing new — you already had all ${d.skipped}.`;
  }
  const added = `Added ${d.added === 1 ? "1 piece of gear" : `${d.added} pieces of gear`}.`;
  if (!d.skipped) return added;
  return `${added} ${d.skipped === 1 ? "1 was" : `${d.skipped} were`} already yours.`;
});
</script>

<template>
  <BaseModal :open="open" label="Import gear" @close="emit('close')">
    <h2 class="t-label">Import gear</h2>

    <template v-if="done">
      <p class="dlg__lede">{{ summary }}</p>
      <div class="dlg__actions">
        <button class="btn btn--primary" @click="emit('close')">Done</button>
      </div>
    </template>

    <template v-else>
      <!-- The one thing worth saying before you press the button, and the reason
           the result screen needs no second paragraph: what an import will NOT do. -->
      <p class="t-sm t-muted dlg__lede">
        Paste a CSV or a JSON backup, or choose a file. Gear you already have is left
        as it is.
      </p>

      <textarea
        v-model="text"
        class="field well vimport__text"
        rows="5"
        placeholder="A CSV like Folder,Item Name,Brand,Weight,Unit… or a JSON backup from Download JSON"
      />

      <p v-if="error" class="t-sm vimport__err">{{ error }}</p>

      <div class="dlg__actions vimport__actions">
        <!-- a real button proxying a hidden input, like ImportModal: the native
             file control can't be styled, and choosing a file imports immediately -->
        <input
          ref="fileRef"
          type="file"
          accept=".csv,.tsv,.json,text/csv,text/plain,application/json"
          class="visually-hidden"
          tabindex="-1"
          aria-hidden="true"
          @change="onFile"
        />
        <button class="btn btn--ghost vimport__choose" type="button" @click="fileRef?.click()">
          Choose a file…
        </button>
        <button class="btn btn--ghost" @click="emit('close')">Cancel</button>
        <button class="btn btn--primary" :disabled="busy || !text.trim()" @click="send(text)">
          {{ busy ? "Importing…" : "Import" }}
        </button>
      </div>
    </template>
  </BaseModal>
</template>

<style scoped>
/* the overlay, shell and action row are atoms/dialog.scss; the tint is .well */
.vimport__text {
  width: 100%;
  font-family: var(--font);
  font-size: var(--text-sm);
  padding: var(--space-3);
  /* no resize — ImportModal's reasoning: the grip notches the rounded corner and
     the box scrolls anyway */
  resize: none;
}
/* plain ink, not --danger: colour is reserved for the data viz and irreversible
   acts, and an import that didn't go through is neither (matches .vitem__err) */
.vimport__err {
  color: var(--ink);
}
.vimport__actions {
  flex-wrap: wrap;
}
.vimport__choose {
  margin-right: auto;
}
</style>
