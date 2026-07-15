<script setup lang="ts">
import { Ellipsis } from "@lucide/vue";
import type { ListSnapshot, Totals } from "~~/shared/types";

// The read-only share views' ⋯ actions menu — the quiet counterpart to the editor's
// kebab. Everything here is a READ of the list the viewer is looking at: take an
// editable copy, grab the link, or export it. (No edit-link / rotate / import — those
// are the owner's, and the viewer has no edit token.) Uses the shared .menu popover
// atom (controls.scss) so it looks + opens exactly like the editor's.
const props = defineProps<{
  snapshot: ListSnapshot;
  totals: Totals | null;
}>();

const menuOpen = ref(false);
const menuRef = useTemplateRef<HTMLElement>("menuRef");

// tiny toast for the copy actions (a link/markdown copy is otherwise invisible); the
// downloads also confirm here, alongside the browser's own download chrome
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function flash(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2000);
}
onBeforeUnmount(() => clearTimeout(toastTimer));

// close on the action itself, an outside tap, or Escape (mirrors the editor kebab)
onClickOutside(menuRef, () => (menuOpen.value = false));
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && menuOpen.value) menuOpen.value = false;
});

// the exporters are on-demand chunks (kept out of the read view's initial payload),
// warmed when the menu opens so the copy stays inside the click's gesture window
const mdExporter = () => import("~~/shared/exporters/markdown");
const csvExporter = () => import("~~/shared/exporters/csv");
const jsonExporter = () => import("~~/shared/exporters/json");
function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) {
    void mdExporter();
    void csvExporter();
    void jsonExporter();
  }
}

const { copying, copyList } = useCopyList();
const { showLinkFallback } = useDialogs();

function runMenu(action: string) {
  menuOpen.value = false;
  switch (action) {
    case "copy": return void copyThis();
    case "link": return void copyLink();
    case "markdown": return void copyMarkdown();
    case "csv": return void downloadCsv();
    case "json": return void downloadJson();
  }
}

async function copyThis() {
  // success navigates to the new copy's editor, so only a failure needs a word here
  const ok = await copyList(props.snapshot, props.totals?.totalMg ?? 0);
  if (!ok) flash("Couldn’t copy. Try again.");
}
async function copyLink() {
  const url = typeof location !== "undefined" ? location.href : "";
  if (await copyText(url)) return flash("Link copied");
  // blocked clipboard → show the link selectable instead of dead-ending
  showLinkFallback(url, "Copy this link");
}
async function copyMarkdown() {
  try {
    const { listToMarkdown } = await mdExporter();
    flash((await copyText(listToMarkdown(props.snapshot))) ? "Copied as Markdown" : "Copy failed");
  } catch {
    flash("Couldn’t load the exporter. Try again.");
  }
}
async function downloadCsv() {
  try {
    const { listToCsv } = await csvExporter();
    downloadFile(`${fileBase()}.csv`, listToCsv(props.snapshot), "text/csv");
    flash("CSV downloaded");
  } catch {
    flash("Couldn’t load the exporter. Try again.");
  }
}
async function downloadJson() {
  try {
    // same module as the import dialog's parser — export/import can't drift
    const { listToJson } = await jsonExporter();
    downloadFile(`${fileBase()}.json`, listToJson(props.snapshot), "application/json");
    flash("JSON downloaded");
  } catch {
    flash("Couldn’t load the exporter. Try again.");
  }
}
function fileBase() {
  return listFileBase(props.snapshot.title, props.snapshot.slug);
}
</script>

<template>
  <div ref="menuRef" class="menu">
    <button
      type="button"
      class="btn btn--icon btn--ghost menu__btn"
      aria-label="More actions"
      aria-haspopup="true"
      :aria-expanded="menuOpen"
      @click="toggleMenu"
    >
      <Ellipsis :size="16" />
    </button>
    <Transition name="menu">
      <ul v-if="menuOpen" class="popover menu__list" role="menu" aria-label="More actions">
        <li role="none">
          <button type="button" role="menuitem" class="menu__item" :disabled="copying" @click="runMenu('copy')">Copy this list</button>
        </li>
        <li role="none">
          <button type="button" role="menuitem" class="menu__item" @click="runMenu('link')">Copy link</button>
        </li>
        <li role="none">
          <button type="button" role="menuitem" class="menu__item" @click="runMenu('markdown')">Copy as Markdown</button>
        </li>
        <li role="none">
          <button type="button" role="menuitem" class="menu__item" @click="runMenu('csv')">Download CSV</button>
        </li>
        <li role="none">
          <button type="button" role="menuitem" class="menu__item" @click="runMenu('json')">Download JSON</button>
        </li>
      </ul>
    </Transition>

    <!-- to body so the fixed toast escapes the topbar's stacking/overflow context;
         the pill + its motion come from the shared .toast atom (controls.scss) -->
    <Teleport to="body">
      <Transition name="toast">
        <div v-if="toast" class="toast t-sm" role="status">{{ toast }}</div>
      </Transition>
    </Teleport>
  </div>
</template>
