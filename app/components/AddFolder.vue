<script setup lang="ts">
// "Add folder" is a quiet label that becomes an inline text field on press, and
// commits on enter or on clicking away — the editor's folder foot and My Gear's wear
// the same one, so the words, the focus hand-off and the commit rules can't drift
// between them (they were two byte-identical copies). It only says the NAME; what a
// folder is, and where it goes, belongs to the surface that asked. Escape stands the
// field down without a word, and a blank commit is a cancel too — the next "Add
// folder" is right back where the field was.
const emit = defineEmits<{ add: [name: string] }>();

const adding = ref(false);
const inputRef = useTemplateRef<HTMLInputElement>("inputRef");
function open() {
  adding.value = true;
  nextTick(() => inputRef.value?.focus());
}
function commit() {
  const name = inputRef.value?.value.trim();
  adding.value = false;
  if (name) emit("add", name);
}
</script>

<template>
  <!-- the type and colour are the .addfolder atom's (atoms/controls.scss); the caller
       places the row with its own class, which lands here through fallthrough -->
  <div class="addfolder">
    <input
      v-if="adding"
      ref="inputRef"
      class="addfolder__input"
      placeholder="Folder name"
      aria-label="New folder name"
      autocorrect="off"
      spellcheck="false"
      @keydown.enter.prevent="commit"
      @keydown.esc="adding = false"
      @blur="commit"
    />
    <button v-else type="button" class="addfolder__btn" @click="open">Add folder</button>
  </div>
</template>
