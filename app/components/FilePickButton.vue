<script setup lang="ts">
// A real button proxying a hidden <input type=file>, for the import dialogs: the
// native file control ("Choose File · No file chosen") can't be styled, and choosing
// a file acts immediately, so there is no chosen-name state to show.
//
// The selection is cleared the moment it is read (the File object is already
// captured): a failed import keeps its dialog open, and re-choosing the SAME file —
// the natural retry after fixing it — fires no change event while a value sticks.
//
// Both dialogs read the file as text, so that read lives here too; each gets the text
// and the File, for the name and type the list import sniffs a JSON backup by.
const {
  /** the two formats the import dialogs take — a CSV (LighterPack's export among them)
   *  or the app's own JSON backup */
  accept = ".csv,.tsv,.json,text/csv,text/plain,application/json",
  label = "Choose a file…",
} = defineProps<{ accept?: string; label?: string }>();
const emit = defineEmits<{ text: [text: string, file: File] }>();

const inputRef = useTemplateRef<HTMLInputElement>("inputRef");
function onChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => emit("text", String(reader.result), file);
  reader.readAsText(file);
}
</script>

<template>
  <input
    ref="inputRef"
    type="file"
    :accept="accept"
    class="visually-hidden"
    tabindex="-1"
    aria-hidden="true"
    @change="onChange"
  />
  <button class="btn btn--ghost filepick" type="button" @click="inputRef?.click()">{{ label }}</button>
</template>

<style scoped>
/* first in a .dlg__actions row (atoms/dialog.scss), and the row's one control anchored
   to the leading edge: the margin pushes Cancel and the primary to the trailing one */
.filepick {
  margin-right: auto;
}
</style>
