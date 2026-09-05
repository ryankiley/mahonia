<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Bug02Icon, ChevronDownIcon, Copy01Icon, CopyPlusIcon, Csv01Icon, EllipsisIcon, FileExportIcon, Flag02Icon, HashIcon, ThirdBracketIcon, Txt01Icon } from "@hugeicons/core-free-icons";
import type { ListSnapshot, Totals } from "~~/shared/types";

// The read-only share views' ⋯ actions menu — the quiet counterpart to the editor's
// kebab. Everything here is a READ of the list the viewer is looking at: take an
// editable copy, grab the link, or export it. (No edit-link / rotate / import — those
// are the owner's, and the viewer has no edit token.) Uses the shared .menu popover
// atom (controls.scss) so it looks + opens exactly like the editor's.
//
// And it READS in the same order as the editor's, which is the half that was missing:
// plain rows, then Send feedback…, then Export last of the body, then a hairline and
// the row that takes the list away — Report here, Forget/Delete there. The two menus
// are seen by the same person minutes apart (you share a list, then open your own
// link to check it), so a row that moves between them is a row you have to re-find.
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
// The MARKS are the editor's too, one per FORMAT rather than four drawings of the
// idea "a file": Txt01 and Csv01 are the set's own file marks, and Markdown and JSON,
// which the set has no icon for, take the character each is actually written with —
// the # a Markdown writer types for a heading, the braces a JSON file opens with. See
// MENU_SECTIONS in GearEditor for the long version; the point of repeating them here
// is that one export reads the same in both menus.
const EXPORT_ITEMS = [
  { key: "text", label: "Copy as plain text", icon: Txt01Icon, run: copyPlainText },
  { key: "markdown", label: "Copy as Markdown", icon: HashIcon, run: copyMarkdown },
  { key: "csv", label: "Download CSV", icon: Csv01Icon, run: downloadCsv },
  { key: "json", label: "Download JSON", icon: ThirdBracketIcon, run: downloadJson },
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
// list" at the foot: that one is about THIS list being spam, this one is about the app.
// Its SEAT is the editor's — last of the plain rows, directly above Export — so the two
// ⋯ menus read in the same order and a hand that knows one knows the other.
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
               nobody has to learn that "duplicate" here is "copy" there.
               The MARK carries the same argument one step earlier: CopyPlus rather than
               the clipboard sheets the genuine copies wear, because a glyph is read
               before its label and a clipboard here would spend the word before you got
               to it. Same pick as the editor's row of this name. -->
          <button type="button" data-row role="menuitem" class="menu__item" :disabled="copying" @click="runMenu('copy')">
            <HugeiconsIcon :icon="CopyPlusIcon" :size="14" :stroke-width="2" aria-hidden="true" />
            Duplicate this list
          </button>
        </li>
        <li role="none">
          <!-- …and THIS one is the clipboard, so it wears the app's clipboard mark —
               the same Copy01 pair of sheets ListHead and SharePanel put on the buttons
               that copy this very link. -->
          <button type="button" data-row role="menuitem" class="menu__item" @click="runMenu('link')">
            <HugeiconsIcon :icon="Copy01Icon" :size="14" :stroke-width="2" aria-hidden="true" />
            Copy link
          </button>
        </li>
        <li role="none">
          <button type="button" data-row role="menuitem" class="menu__item" @click="runMenu('feedback')">
            <HugeiconsIcon :icon="Bug02Icon" :size="14" :stroke-width="2" aria-hidden="true" />
            Send feedback…
          </button>
        </li>
        <!-- Export folds into a disclosure, as it already does in the editor's ⋯ —
             four formats you'd otherwise scan past to reach the thing you came for,
             and only one of them is ever the one you want. Same .menu__sect atom, and
             the same SEAT: last of the body, so opening it pushes nothing but the
             hairline down. -->
        <li role="none" class="menu__sect">
          <button
            type="button"
            data-row
            class="menu__item menu__secthead"
            :aria-expanded="exportOpen"
            @click="exportOpen = !exportOpen"
          >
            <HugeiconsIcon :icon="FileExportIcon" :size="14" :stroke-width="2" aria-hidden="true" />
            <!-- the label takes the slack, so the chevron keeps the trailing edge now
                 that a glyph holds the leading one -->
            <span class="ro__sectlabel">Export</span>
            <HugeiconsIcon
              :icon="ChevronDownIcon"
              class="chev"
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
                  <button type="button" data-row role="menuitem" class="menu__item menu__sectitem" @click="runExport(x.run)">
                    <HugeiconsIcon :icon="x.icon" :size="14" :stroke-width="2" aria-hidden="true" />
                    {{ x.label }}
                  </button>
                </li>
              </ul>
            </div>
          </Transition>
        </li>
        <!-- moderation, not a read of the list — set off from the rows above by the
             shared .menu__foot hairline (controls.scss), and only for public lists (per
             the Terms) that aren't yet reported. The reader's counterpart to the editor's
             foot: both sit under the rule, both are the row that takes a list off
             something, and both now draw that rule from one place — this one had its own
             copy at --space-2, a step further off than the other two for no reason
             anyone chose. -->
        <li v-if="snapshot.isPublic && !reported" role="none" class="menu__foot">
          <!-- A FLAG, the one mark this menu doesn't share with the editor's, because
               the editor has no row to share it with — an owner doesn't report their own
               list. It is the convention every feed uses for exactly this, which matters
               more here than anywhere else in the menu: reporting is the one row a reader
               should recognise without reading, and the one they should never hit by
               mistake reaching for the row above. -->
          <button type="button" data-row role="menuitem" class="menu__item" @click="runMenu('report')">
            <HugeiconsIcon :icon="Flag02Icon" :size="14" :stroke-width="2" aria-hidden="true" />
            Report list
          </button>
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
/* The glyph column and its `flex: none` pin are .menu__item's own (atoms/controls.scss).
   They arrived here as a copy of the editor's, on the argument that only those two menus
   want the shape and the switcher's rows must not inherit it — but every .menu__list in
   the app wants it, this menu's own glyphs being the case that settled it. */
/* NO INDENT on the Export rows, overriding the atom's --space-5 step. The step was
   right while they were bare; now that they carry glyphs it opens a SECOND glyph column
   a step in from the first, which reads as a ragged edge rather than as nesting. What
   says "group" instead is what already did the rest of that job: the quieter ink
   (--ink-2, from the atom) under a header whose chevron has turned over.
   It also settles a jump — the card is sized to its widest row, so an indent that only
   exists while the section is open widened the card on opening. */
.menu__list .menu__sectitem {
  padding-left: var(--space-3);
}
/* the label takes the slack, so the Export header's chevron holds the trailing edge */
.ro__sectlabel {
  flex: 1 1 auto;
}
</style>
