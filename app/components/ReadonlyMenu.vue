<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { ChevronDownIcon, EllipsisIcon } from "@hugeicons/core-free-icons";
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
// Export opens in place. A re-opened menu starts collapsed — the previous session's
// open section is not a preference, and restoring it would put a different item
// under the cursor.
const exportOpen = ref(false);
watch(menuOpen, (open) => open || (exportOpen.value = false));
// the travelling wash shared with the other menus (see useMenuPlate)
const { plateRef, listRef, on: plateOn } = useMenuPlate();
const menuRef = useTemplateRef<HTMLElement>("menuRef");

// tiny toast for the copy actions (a link/markdown copy is otherwise invisible); the
// downloads also confirm here, alongside the browser's own download chrome
const { toast, flash } = useToast();

// close on the action itself, an outside tap, a scroll gesture, or Escape (mirrors the
// editor kebab). The scroll one is mobile's: this hangs off a sticky topbar, so nothing
// about scrolling would otherwise take it down — see onScrollOutside.
useMenuDismiss(menuOpen, menuRef);

// the four export actions + their chunk warm-up live in useListExports, shared
// with the editor's kebab so the copy + error handling can't drift (the exporters
// stay on-demand chunks, out of the read view's initial payload).
//
// The link the plain-text copy appends is THIS PAGE — the same URL "Copy link" below
// hands out, whether that's /s/{code} or a public /l/{slug}. A read view never holds an
// edit token, so unlike the editor there's nothing here to leak.
const { warmExporters, copyPlainText, copyMarkdown, downloadCsv, downloadJson } = useListExports(
  () => props.snapshot,
  flash,
  () => (typeof location !== "undefined" ? location.href : ""),
);
// The section's rows, table-driven as the editor's kebab has them (MENU_SECTIONS in
// GearEditor) — same order, same words — so a new export is one row here and one
// there rather than a fifth hand-written <li>. First, because it's the one people
// reach for most: it's the format a comment box actually accepts. Markdown below it
// is the same idea for somewhere that renders it.
const EXPORT_ITEMS = [
  { key: "text", label: "Copy as plain text", run: copyPlainText },
  { key: "markdown", label: "Copy as Markdown", run: copyMarkdown },
  { key: "csv", label: "Download CSV", run: downloadCsv },
  { key: "json", label: "Download JSON", run: downloadJson },
];
function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) warmExporters();
}
function runExport(run: () => Promise<void>) {
  menuOpen.value = false;
  void run();
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
    // the exports are EXPORT_ITEMS' — see runExport
    case "report": return void reportThis();
    case "feedback":
      feedbackEverOpened.value = true;
      feedbackOpen.value = true;
      return;
  }
}

// Feedback used to be a link in the site footer. It moved to where you are when you
// have something to say — which for a reader is this menu. Distinct from "Report
// list" below it: that one is about THIS list being spam, this one is about the app.
// Lazy + everOpened, so a reader who never sends anything pays nothing for it.
const feedbackOpen = ref(false);
const feedbackEverOpened = ref(false);

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
      <HugeiconsIcon :icon="EllipsisIcon" :size="16" :stroke-width="2" />
    </button>
    <Transition name="menu">
      <ul v-if="menuOpen" ref="listRef" class="popover menu__list" role="menu" aria-label="More actions" v-on="plateOn">
        <!-- the travelling wash (atoms/controls.scss + useMenuPlate) -->
        <li role="none" aria-hidden="true">
          <span ref="plateRef" class="menu__plate" />
        </li>
        <li role="none">
          <!-- NOT "Copy this list". Two of this menu's other items are clipboard
               actions ("Copy link", "Copy as Markdown"), and this one is the odd one
               out: it mints an independent list, registers it in this browser and
               navigates you into its editor. Three items opening with the same verb,
               one of which takes you off the page, is a menu you have to read twice.
               Matches the editor's kebab word-for-word — one action, one name, so
               nobody has to learn that "duplicate" here is "copy" there. -->
          <button type="button" data-row role="menuitem" class="menu__item" :disabled="copying" @click="runMenu('copy')">Duplicate this list</button>
        </li>
        <li role="none">
          <button type="button" data-row role="menuitem" class="menu__item" @click="runMenu('link')">Copy link</button>
        </li>
        <!-- Export folds into a disclosure, as it already does in the editor's ⋯ —
             three formats you'd otherwise scan past to reach the thing you came for,
             and only one of them is ever the one you want. Same .menu__sect atom, so
             the two menus can't drift. -->
        <li role="none" class="menu__sect">
          <button
            type="button"
            data-row
            class="menu__item menu__secthead"
            :aria-expanded="exportOpen"
            @click="exportOpen = !exportOpen"
          >
            Export
            <HugeiconsIcon
              :icon="ChevronDownIcon"
              class="menu__sectchev"
              :class="{ 'is-open': exportOpen }"
              :size="14"
              :stroke-width="2"
              aria-hidden="true"
            />
          </button>
          <!-- Transition + v-if, NOT a class: .reveal is a transition recipe (it has
               no open/closed state of its own and defaults to 1fr), so driving it
               with a class leaves the section permanently expanded and the chevron
               spinning over nothing. v-if also takes the collapsed items out of the
               tab order, which a height-0 box would not. -->
          <Transition name="reveal">
            <div v-if="exportOpen" class="reveal">
              <ul class="menu__sectlist" role="group" aria-label="Export">
                <!-- one row per export action, in EXPORT_ITEMS' order (see the script) -->
                <li v-for="x in EXPORT_ITEMS" :key="x.key" role="none">
                  <button type="button" data-row role="menuitem" class="menu__item menu__sectitem" @click="runExport(x.run)">{{ x.label }}</button>
                </li>
              </ul>
            </div>
          </Transition>
        </li>
        <li role="none">
          <button type="button" data-row role="menuitem" class="menu__item" @click="runMenu('feedback')">Send feedback…</button>
        </li>
        <!-- moderation, not a read of the list — set off from the copy/export group by a
             hairline, and only for public lists (per the Terms) that aren't yet reported -->
        <li v-if="snapshot.isPublic && !reported" role="none" class="menu__report">
          <button type="button" data-row role="menuitem" class="menu__item" @click="runMenu('report')">Report list</button>
        </li>
      </ul>
    </Transition>

    <LazyFeedbackModal v-if="feedbackEverOpened" :open="feedbackOpen" @close="feedbackOpen = false" />

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
