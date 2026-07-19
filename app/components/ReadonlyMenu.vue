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
useWindowEvent("keydown", (e) => {
  if (e.key === "Escape" && menuOpen.value) menuOpen.value = false;
});

// the three export actions + their chunk warm-up live in useListExports, shared
// with the editor's kebab so the copy + error handling can't drift (the exporters
// stay on-demand chunks, out of the read view's initial payload)
const { warmExporters, copyMarkdown, downloadCsv, downloadJson } = useListExports(
  () => props.snapshot,
  flash,
);
function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) warmExporters();
}

const { copying, copyList } = useCopyList();
const { confirm: askConfirm, showLinkFallback } = useDialogs();

// "Report list" — flag a public list for review. Only offered when the list is
// public (the Terms scope reporting to public lists, and a private share has
// nothing on the feed to withhold). Hidden once reported so the ⋯ item doesn't
// invite a second, no-op tap. See /api/lists/report for the distinct-reporter
// threshold that actually withholds a list.
const reported = ref(false);

function runMenu(action: string) {
  menuOpen.value = false;
  switch (action) {
    case "copy": return void copyThis();
    case "link": return void copyLink();
    case "markdown": return void copyMarkdown();
    case "csv": return void downloadCsv();
    case "json": return void downloadJson();
    case "report": return void reportThis();
  }
}

async function reportThis() {
  if (reported.value) return;
  if (!(await askConfirm({
    title: "Report this list",
    message: "Report this list as spam or inappropriate? Reports are reviewed, and a list is withheld from public discovery once enough people flag it.",
    confirmLabel: "Report",
  }))) return;
  try {
    await $fetch("/api/lists/report", { method: "POST", body: { slug: props.snapshot.slug } });
    reported.value = true;
    flash("Reported. Thanks, we’ll take a look.");
  } catch {
    // best-effort affordance — a failed report just asks the viewer to retry
    flash("Couldn’t report. Try again.");
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
        <!-- moderation, not a read of the list — set off from the copy/export group by a
             hairline, and only for public lists (per the Terms) that aren't yet reported -->
        <li v-if="snapshot.isPublic && !reported" role="none" class="menu__report">
          <button type="button" role="menuitem" class="menu__item" @click="runMenu('report')">Report list</button>
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

<style scoped>
/* the report row is a different class of action from the copy/export items above
   it — a hairline + a touch of space sets it apart without a heavy divider. The
   rule sits on the <li>, so it aligns to the item hover box (inset by the list's
   own padding), matching the rounded rows rather than bleeding to the card edge. */
.menu__report {
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--line);
}
</style>
