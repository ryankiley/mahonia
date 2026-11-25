<script setup lang="ts">
// "Add folder" is a quiet label that becomes an inline text field on press, and
// commits on enter or on clicking away — the editor's folder foot and My Gear's wear
// the same one, so the words, the focus hand-off and the commit rules can't drift
// between them (they were two byte-identical copies). It only says the NAME; what a
// folder is, and where it goes, belongs to the surface that asked. Escape stands the
// field down without a word, and a blank commit is a cancel too — the next "Add
// folder" is right back where the field was.
//
// My Gear's Kits tab wears it as "New kit": a kit is that page's folder, made the way
// a list makes one. Only the words change.
//
// `triggerClass` redraws the resting label for a place where the quiet one is wrong:
// alone in the middle of an empty Kits tab it is the page's one action, and a ghost
// heading there read as a title, not a button (Ryan: "this doesn't seem like our usual
// style"), so that one wears the app's primary button. The field it becomes, and the
// commit rules, are the same.
const props = withDefaults(defineProps<{ label?: string; placeholder?: string; triggerClass?: string }>(), {
  label: "Add folder",
  placeholder: "Folder name",
  triggerClass: "addfolder__btn",
});
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
      :placeholder="props.placeholder"
      :aria-label="`New ${props.placeholder.toLowerCase()}`"
      autocorrect="off"
      spellcheck="false"
      @keydown.enter.prevent="commit"
      @keydown.esc="adding = false"
      @blur="commit"
    />
    <button v-else type="button" :class="props.triggerClass" @click="open">{{ props.label }}</button>
  </div>
</template>
