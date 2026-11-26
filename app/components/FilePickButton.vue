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
/** the two formats the import dialogs take — a CSV (LighterPack's export among them)
 *  or the app's own JSON backup */
const ACCEPT = ".csv,.tsv,.json,text/csv,text/plain,application/json";
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
    :accept="ACCEPT"
    class="visually-hidden"
    tabindex="-1"
    aria-hidden="true"
    @change="onChange"
  />
  <button class="btn btn--soft filepick" type="button" @click="inputRef?.click()">Choose a file…</button>
</template>

<style scoped>
/* UNDER THE PASTE BOX, not in the dialog's action row. It is the other way to put
   something in (paste, or choose a file), so it stands with the box it is the
   alternative to. It was the first of three in .dlg__actions, a bare phrase beside the
   contained Cancel and Import: it read as a caption on them, and on a phone the row
   wrapped and left Import alone on a second line. Contained like the other second
   buttons (.btn--soft), and its own width at the box's leading edge. */
.filepick {
  align-self: flex-start;
}
</style>
