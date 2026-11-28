<script setup lang="ts">
import { IconCircleMinus, IconEyeOpen } from "~/icons/central";
import { SvgIcon } from "~/utils/icon";

// My Gear's Sharing panel: the list editor's (SharePanel) on its Share tab, for the one
// link gear has. The same card under the bar's share glyph, the same row ("Copy
// read-only link", and who that hands it to), and the same ruled-off foot for the act
// that cuts people off, which asks first, as "Replace edit link" does. It replaces a
// dialog of its own (a text field of the URL, Turn on / Turn off / Copy link) that
// shared nothing with the way a list is shared.
//
// No tabs: a list's Export tab is beside its links because the two are one question
// (how do I get this to someone); My Gear's downloads are backups of your own gear, and
// stay in its ⋯.
//
// Off, the copy row is still the whole act: asking for the link turns it on, the way a
// draft list's row saves the list before it copies. The page does the copying and the
// stopping (useVaultShare); this panel closes first, as the editor's does.
defineProps<{ sharing: boolean | null }>();
const emit = defineEmits<{ close: []; copy: []; stop: [] }>();

const listRef = useTemplateRef<HTMLElement>("listRef");
const { atStart, above, place } = useMenuPlacement(listRef);
onMounted(place);

function act(run: () => void) {
  emit("close");
  run();
}
</script>

<template>
  <div
    ref="listRef"
    class="popover menu__list menu__panel"
    :class="{ 'menu__list--start': atStart, 'menu__list--above': above }"
    role="dialog"
    aria-label="Sharing"
  >
    <ul>
      <li>
        <ShareRow
          :icon="IconEyeOpen"
          label="Copy read-only link"
          hint="Anyone with it can see your gear and kits, never prices or food"
          @click="act(() => emit('copy'))"
        />
      </li>
      <li v-if="sharing" class="menu__foot">
        <button type="button" class="menu__item" @click="act(() => emit('stop'))">
          <SvgIcon :icon="IconCircleMinus" aria-hidden="true" />
          Stop sharing
        </button>
      </li>
    </ul>
  </div>
</template>
