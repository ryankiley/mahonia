<script setup lang="ts">
import { counted } from "~~/shared/tidyText";
import { HugeiconsIcon } from "~/utils/hugeicon";
import {
  Clock01Icon,
  Copy01Icon,
  Edit02Icon,
  Exchange01Icon,
  UserAdd01Icon,
  UserMultiple02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import type { ExportItem } from "~/composables/useListExports";
import type { ChangeAuthor, ListSnapshot, SnapshotMeta } from "~~/shared/types";

// Everything about getting this list to someone else, in ONE place, as two tabs.
//
// SHARE is the sharing menu as it was, moved into the panel: copy either link, what
// has changed and by whom, and the two acts that change who holds it. EXPORT is the list as a file
// or a paste, under a card that asks whether a file is really what you want: a link
// stays current and a file is out of date the moment you change anything, so the
// tab you open to send a copy offers the link first.
//
// Export used to be a fold-out in the ⋯ menu, a toolbar glyph away from the links,
// so the two ways of sending a list were on two surfaces and the better one was not
// the one beside the CSV. They are one question (how do I get this to someone), so
// they are one panel.
//
// Both tabs draw their rows the menu's way: `.menu__item`, `[data-row]`, the
// travelling plate, the 16px glyph in the menu's one glyph column, plus a second line.
// On Share the label is the whole act ("Copy edit link") and the line is who that
// hands the list to. Read one at a time that looks like it restates the name; read
// as the pair it is, "see" against "change" is the plainest statement of how the two
// links differ, which in an app with no sign-in is the thing a newcomer doesn't know.
// On Export the line says what you get ("A table to paste", "Spreadsheet file"),
// which is also what tells a copy from a download. The line is each row's
// description (aria-describedby), its label the name. No tile behind a glyph (an
// earlier pass boxed each one, and it read as a different app's list dropped into
// this one's menu) and no trailing copy or download mark.
//
// Rendered lazily by the editor, so its snapshot fetch, the export rows and this
// markup cost nothing until someone actually asks about sharing. The links
// themselves never reach this panel: Copy emits, and the editor builds and copies
// them (it owns the origin and the edit-link path rule). The read-only link does
// come in once, as `shareUrl`, for the plain-text export to append.
const props = defineProps<{
  snapshot: ListSnapshot;
  editToken: string;
  /** The capability as request headers — Bearer for a held link, the list-code
   *  header for a claimed open. Built by the editor (which owns the capability)
   *  so this panel can't grow a second opinion about auth. */
  authHeaders: Record<string, string>;
  /** the READ-ONLY link the plain-text export appends — see the note in GearEditor */
  shareUrl: string;
  /** The editor's toast, as a function rather than an event: an export closes the
   *  panel and THEN finishes (the exporter chunk loads, the clipboard answers), and
   *  by then this component is unmounted, and an unmounted component's emits go
   *  nowhere. A function prop is just a reference and still reaches the editor. */
  flash: (msg: string) => void;
}>();
const emit = defineEmits<{
  close: [];
  copyRead: [];
  copyEdit: [];
  rotate: [];
}>();

const { plateRef, listRef, on } = useMenuPlate();

// A draft has no share code until its first real item lands, so every link here
// would be broken and every export empty. Say so once, rather than two tabs of
// disabled rows.
const isDraft = computed(() => !props.snapshot.shareCode);
// A CLAIMED open is saved and shareable, but this device holds no edit link to copy:
// the server only ever stored its hash. So there's no edit-link row, and the replace
// row reads "Get a new edit link" (a rotate hands this device a fresh one).
const holdsEditLink = computed(() => !!props.editToken);

// ---- the tabs ----
// Real tabs, unlike the mode bar's radiogroup: two different panels, one shown at a
// time, so role="tab" with aria-controls is the honest markup. Selection follows
// focus under the arrows (useRovingRadio), which is right where switching is free.
// Opens on Share every time: the panel mounts on open, and the tab you used last is
// not a preference worth remembering.
const TABS = [
  { key: "share", label: "Share" },
  { key: "export", label: "Export" },
] as const;
type Tab = (typeof TABS)[number]["key"];
const tab = ref<Tab>("share");
const uid = useId();
const tabId = (t: Tab) => `${uid}-tab-${t}`;
const panelId = (t: Tab) => `${uid}-panel-${t}`;
const { onKey } = useRovingRadio(
  () => TABS.length,
  () => TABS.findIndex((t) => t.key === tab.value),
  (at) => (tab.value = TABS[at]!.key),
);

// ---- export ----
// The rows, their wording and their marks are useListExports', shared with the read
// views' ⋯ menu. Warmed when the Export tab opens: the first honest signal that one
// of them is about to run, and the markdown copy's clipboard write has to land
// inside iOS Safari's gesture window, which a cold chunk fetch would spend.
const { warmExporters, exportItems } = useListExports(
  () => props.snapshot,
  (msg) => props.flash(msg),
  () => props.shareUrl,
);
watch(tab, (t) => t === "export" && warmExporters());

// ---- the account ----
// ONE ACTION, and only while pressing it would do something. Not a section, not a
// status line, not a confirmation.
//
// This started as a "Your account" block that said which state the list was in.
// The overwhelmingly common answer is "it's on your account", and saying so
// answers a question nobody asked — a list being safe is the premise of the app,
// so reassuring you about it reads as a reason to doubt it. Same rule the row's
// Save-to-My-Gear button follows: inert controls are absent, not disabled, and a
// state worth no action is worth no words either.
//
// What's left is the rare case that IS actionable: a list this device holds a
// link for that the account doesn't have. Sign-in sweeps up the lists this
// browser made, and the server adds anything old enough to predate origin
// tracking (see claimRepo), so what reaches this row is mostly a list someone
// shared with you that you want to keep. (And, one at a time, your own, where
// the sign-in was one you only confirmed here and you said "Not now" to the
// lists: see startSession in server/utils/authSession.ts.) Unlike the other rows it keeps
// the panel open: the claim is a request, and a failure has to be said here.
const { signedIn } = useSession();
const claimed = useClaimedLists();
const claim = ref<"idle" | "claiming" | "failed">("idle");
// Gated on `loaded`, not just on the array: before the first fetch answers, an
// already-claimed list would flash the button — offering to do what's done.
const canAddToAccount = computed(
  () =>
    holdsEditLink.value &&
    signedIn.value &&
    claimed.loaded.value &&
    !claimed.lists.value.some((l) => l.shareCode === props.snapshot.shareCode),
);

async function addToAccount() {
  if (claim.value === "claiming") return;
  claim.value = "claiming";
  // claimOne folds the server's refreshed claim set into useClaimedLists, so
  // success flips canAddToAccount and the button simply leaves. Nothing takes its
  // place: the list is on the account, which is what you asked for and what the
  // absence now means.
  const ok = await claimed.claimOne(props.editToken);
  claim.value = ok ? "idle" : "failed";
}

// Close BEFORE the action runs, as the ⋯ menu's rows do. The copies and the replace
// hand off to the editor, which toasts the result or asks first; an export runs here
// and toasts through `flash`.
function act(run: () => unknown) {
  emit("close");
  void run();
}
const runExport = (item: ExportItem) => act(item.run);

// ---- recent changes ----
// The recovery points the server already keeps: the closest thing to an activity log
// this app has. One per throttle window, so a summary of the change that opened the
// window, a time, and who made it when anyone can be named; not a per-field diff.
// Fetched when the panel mounts, which is when it opens (the editor renders it
// lazily), so the editor never pays for it.
const activity = ref<SnapshotMeta[]>([]);
const activityState = ref<"idle" | "loading" | "error">("idle");
// re-rendered against a ticking clock would be churn for no gain: the panel is open
// for seconds, so one read at fetch time is enough
const now = ref(Date.now());
// collapsed by default — see the markup for why
const activityOpen = ref(false);

async function loadActivity() {
  if (isDraft.value) return; // no server row yet — nothing to list
  activityState.value = "loading";
  try {
    const res = await $fetch<{ snapshots: SnapshotMeta[] }>("/api/edit/snapshots", {
      headers: props.authHeaders,
    });
    activity.value = res.snapshots ?? [];
    now.value = Date.now();
    activityState.value = "idle";
  } catch {
    activityState.value = "error";
  }
}
onMounted(() => {
  void loadActivity();
  // The claim set, fetched the same way: on open, because this is the first surface
  // that needs it when a list is opened straight from its link (the switcher hasn't
  // necessarily run). refresh() resolves to empty without a request when signed out,
  // and canAddToAccount waits on `loaded`, so the row never shows before a real
  // answer has landed.
  void claimed.refresh();
});

// Say WHAT changed, not just that something did: a column of five identical
// "Edited"s is a column of noise.
//
// Points written since summaries shipped carry one in `reason` (see
// shared/changeSummary). Older ones say only "edit", and for those the item counts
// are a sequence: the list is newest-first, so entry i's count is the state at that
// point and entry i+1 the state before it, and their delta can still tell add from
// remove. A rename or a weight fix leaves the count unmoved and falls back to
// "Edited" rather than inventing a description, as does the oldest entry.
const RESTORE_LABEL = "Restored an earlier version";

function changeLabel(i: number): string {
  const s = activity.value[i];
  if (!s) return "Edited";
  if (s.reason === "before restore") return RESTORE_LABEL;
  if (s.reason && s.reason !== "edit") return s.reason;
  const older = activity.value[i + 1];
  if (!older) return "Edited";
  const delta = s.itemCount - older.itemCount;
  if (delta === 0) return "Edited";
  const n = Math.abs(delta);
  return `${delta > 0 ? "Added" : "Removed"} ${counted(n, "item")}`;
}

/** "You", "Assistant", or the name another editor chose; nothing when nobody can
 *  be named (the server decides which, see listSnapshotsByEditHash). */
function whoLabel(by: ChangeAuthor | null): string | null {
  if (!by) return null;
  if (by.kind === "assistant") return "Assistant";
  if (by.kind === "you") return "You";
  return by.name;
}
// Only when more than one hand shows up in the log. A list only you have touched,
// or only an assistant, would say so on every line and tell nobody anything. An
// unnamed change counts as a hand of its own: beside an assistant's, it's the
// difference worth seeing.
const whoKey = (by: ChangeAuthor | null) => (!by ? "" : by.kind === "named" ? `named:${by.name}` : by.kind);
const showWho = computed(() => new Set(activity.value.map((s) => whoKey(s.by))).size > 1);
</script>

<template>
  <!-- The card is the menu's (.popover.menu__list: the anchor, the lift, the 8px inset
       the travelling plate is measured against), widened to a panel. A dialog, not a
       menu: it holds tabs, a card of prose and rows that aren't all menuitems. -->
  <div ref="listRef" class="popover menu__list share" role="dialog" aria-label="Sharing" v-on="on">
    <span ref="plateRef" class="menu__plate" aria-hidden="true" />

    <p v-if="isDraft" class="t-muted share__note">Add an item and this list gets its links.</p>

    <template v-else>
      <div class="share__tabs" role="tablist" aria-label="Sharing" @keydown="onKey">
        <button
          v-for="t in TABS"
          :id="tabId(t.key)"
          :key="t.key"
          ref="opts"
          type="button"
          role="tab"
          class="share__tab"
          :class="{ 'is-active': tab === t.key }"
          :aria-selected="tab === t.key"
          :aria-controls="panelId(t.key)"
          :tabindex="tab === t.key ? 0 : -1"
          @click="tab = t.key"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- SHARE: the two links, what's changed, and under the rule the two acts that
           change who holds the list. -->
      <div v-if="tab === 'share'" :id="panelId('share')" role="tabpanel" :aria-labelledby="tabId('share')">
        <ul class="share__rows">
          <li>
            <button
              type="button"
              data-row
              class="menu__item share__row"
              aria-label="Copy read-only link"
              :aria-describedby="`${uid}-hint-read`"
              @click="act(() => emit('copyRead'))"
            >
              <HugeiconsIcon :icon="ViewIcon" :size="16" :stroke-width="2" aria-hidden="true" />
              <span class="share__text">
                <span class="share__name">Copy read-only link</span>
                <span :id="`${uid}-hint-read`" class="share__hint">Anyone with it can see this list</span>
              </span>
            </button>
          </li>
          <!-- A claimed open (opened from the account) holds no edit link: the server only
               ever stored its hash. No row rather than one that can't copy; the replace row
               below says "Get a new edit link" instead, which is how this device gets one. -->
          <li v-if="holdsEditLink">
            <button
              type="button"
              data-row
              class="menu__item share__row"
              aria-label="Copy edit link"
              :aria-describedby="`${uid}-hint-edit`"
              @click="act(() => emit('copyEdit'))"
            >
              <HugeiconsIcon :icon="Edit02Icon" :size="16" :stroke-width="2" aria-hidden="true" />
              <span class="share__text">
                <span class="share__name">Copy edit link</span>
                <span :id="`${uid}-hint-edit`" class="share__hint">Anyone with it can change this list</span>
              </span>
            </button>
          </li>

          <!-- RECENT CHANGES folds out: the same MenuSection the read views' ⋯ uses, with
               entries in place of rows. Collapsed: it's reassurance you go looking for.
               These are the server's recovery points: WHAT changed, WHEN, and who when
               anyone can be named ("You", "Assistant", or a name an editor chose). -->
          <MenuSection v-model:open="activityOpen" label="Recent changes" :icon="Clock01Icon">
            <div class="share__activity">
              <p v-if="activityState === 'loading'" class="t-muted">Loading…</p>
              <p v-else-if="activityState === 'error'" class="t-muted">Couldn’t load recent changes.</p>
              <p v-else-if="!activity.length" class="t-muted">No changes yet.</p>
              <ul v-else class="share__log">
                <li v-for="(s, i) in activity" :key="s.id" class="share__logrow">
                  <span>{{ changeLabel(i) }}</span>
                  <span class="t-muted share__logwhen"
                    >{{ timeAgo(new Date(s.createdAt).getTime(), now, { short: true })
                    }}<template v-if="showWho && whoLabel(s.by)"> · {{ whoLabel(s.by) }}</template></span
                  >
                </li>
              </ul>
            </div>
          </MenuSection>

          <!-- THE FOOT, ruled off: the two things that change who holds this list.
               Keeping it on your account first (rare: it only shows for a list the
               account doesn't have), replacing the link last, since that cuts off
               everyone who has the old one. -->
          <li class="menu__foot">
            <button
              v-if="canAddToAccount"
              type="button"
              data-row
              class="menu__item"
              :disabled="claim === 'claiming'"
              @click="addToAccount"
            >
              <HugeiconsIcon :icon="UserAdd01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
              Add to your account
            </button>
            <p v-if="claim === 'failed'" role="alert" class="t-muted share__note">
              That didn’t save. Check your connection and try again.
            </p>
            <button type="button" data-row class="menu__item" @click="act(() => emit('rotate'))">
              <HugeiconsIcon :icon="Exchange01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
              {{ holdsEditLink ? "Replace edit link" : "Get a new edit link" }}
            </button>
          </li>
        </ul>
      </div>

      <!-- EXPORT: the link first, then the files. -->
      <div v-else :id="panelId('export')" role="tabpanel" :aria-labelledby="tabId('export')">
        <div class="share__nudge">
          <HugeiconsIcon :icon="UserMultiple02Icon" :size="16" :stroke-width="2" aria-hidden="true" />
          <div class="share__nudgebody">
            <p class="share__name">Sending this to someone?</p>
            <p class="share__nudgetext">Send the link instead. It always shows the latest version.</p>
            <button type="button" class="btn btn--primary share__nudgebtn" @click="act(() => emit('copyRead'))">
              <HugeiconsIcon :icon="Copy01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
              Copy read-only link
            </button>
          </div>
        </div>
        <ul class="share__rows">
          <li v-for="item in exportItems" :key="item.key">
            <button
              type="button"
              data-row
              class="menu__item share__row"
              :aria-label="item.label"
              :aria-describedby="`${uid}-hint-${item.key}`"
              @click="runExport(item)"
            >
              <HugeiconsIcon :icon="item.icon" :size="16" :stroke-width="2" aria-hidden="true" />
              <span class="share__text">
                <span class="share__name">{{ item.format }}</span>
                <span :id="`${uid}-hint-${item.key}`" class="share__hint">{{ item.hint }}</span>
              </span>
            </button>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<!-- lang="scss" for $bp-stack (nuxt.config injects it into every scss block). In a
     plain CSS block `@media (max-width: $bp-stack)` is not reported as an error — the
     rule is just silently dropped. -->
<style scoped lang="scss">
/* The card, the anchor under the trigger, the plate and the row atoms are the menu's
   (atoms/controls.scss). What a menu doesn't have is styled here: a fixed width (a
   menu sizes to its longest label; a panel with prose in it has to choose), the tabs,
   a row's second line, and the card on the Export tab. */
.share {
  width: 22.5rem;
  max-height: calc(100svh - var(--space-9));
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* On a phone the editor drops this panel's wrapper out of the positioning chain (see
   .editor__sharemenu), so `right` measures from the viewport rather than from the
   trigger. Take the page gutter on both sides instead of a width that might not fit. */
@media (max-width: $bp-stack) {
  .share {
    left: var(--space-4);
    right: var(--space-4);
    width: auto;
  }
}

/* ---- the tabs: the mode bar's look (ModeBar.vue), not a segmented track ----
   No track and no outline: the selected tab wears --lit, the one tone the app uses for
   "this is the one that's on" (the mode bar, the person filter, the chips), and the
   other answers the pointer with the mode bar's wash. A raised white pill in an outlined
   track was the reference's control, and the only one of its kind in this app. */
.share__tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-px);
  margin-bottom: var(--space-2);
}
.share__tab {
  height: var(--control-compact);
  border-radius: var(--popover-item-radius);
  color: var(--ink-3);
  font-size: var(--text-chrome);
  font-weight: 600;
  transition:
    background-color var(--spring-fade-dur) var(--spring-fade),
    color var(--spring-fade-dur) var(--spring-fade);
}
/* the mode bar's two amounts, for its reason (sRGB isn't symmetric) */
@media (hover: hover) and (pointer: fine) {
  .share__tab:hover {
    background: light-dark(
      color-mix(in oklab, var(--ink) 3.5%, transparent),
      color-mix(in oklab, var(--ink) 5%, transparent)
    );
    color: var(--ink);
  }
}
.share__tab:focus-visible {
  outline: var(--focus-ring) solid var(--ink);
  outline-offset: var(--focus-offset-inset);
}
.share__tab.is-active {
  background: var(--lit);
  color: var(--ink);
}
@media (hover: hover) and (pointer: fine) {
  .share__tab.is-active:hover {
    background: var(--lit-hover);
  }
}
/* the 30px tab grows a hit area to the --tap floor on a phone, the mode bar's way */
@media (pointer: coarse) {
  .share__tab {
    position: relative;
  }
  .share__tab::before {
    content: "";
    position: absolute;
    inset: calc((var(--control-compact) - var(--tap)) / 2) 0;
  }
}

/* ---- rows ---- */
/* A menu row with a second line, glyph · label over hint. Its inset,
   gap and glyph are .menu__item's; it only wraps (a menu row doesn't, but the hint is
   prose in a panel of fixed width) and hangs its glyph on the LABEL's line rather than
   the middle of the pair, so the mark stays with the word it marks. */
.share__row {
  align-items: start;
  white-space: normal;
}
.share__row > svg {
  margin-block: calc((1lh - var(--icon)) / 2);
}
.share__text {
  display: grid;
  flex: 1 1 auto;
}
.share__name {
  color: var(--ink);
  font-size: var(--text-base);
}
.share__hint {
  color: var(--ink-2);
  font-size: var(--text-chrome);
}

/* ---- the Export tab's card: should this be a link instead? ---- */
/* Laid out on the rows' columns: its mark in the glyph column (the card's inset is a
   row's), its text where a row's label starts, so it reads as part of the same list
   rather than a box dropped on top of it. Shaped like the plate (the item radius),
   since it sits where a row would. */
.share__nudge {
  display: flex;
  align-items: start;
  gap: var(--space-3);
  margin-bottom: var(--space-1);
  padding: var(--space-3);
  border-radius: var(--popover-item-radius);
  background: var(--paper-2);
}
.share__nudge > svg {
  flex: none;
  margin-block: calc((1lh - var(--icon)) / 2);
  color: var(--ink-2);
}
.share__nudgebody {
  display: grid;
  justify-items: start;
  gap: var(--space-1);
}
.share__nudgetext {
  color: var(--ink-2);
  font-size: var(--text-chrome);
}
.share__nudgebtn {
  min-height: var(--icon-btn);
  margin-top: var(--space-2);
  padding: 0 var(--space-3);
  font-size: var(--text-chrome);
}

/* Prose where a row would be, inset like a row. */
.share__note {
  padding: var(--space-2) var(--space-3);
}
/* The entries start where the rows' labels do: past a row's inset, its 16px glyph and
   the gap, so they read as the section's contents. */
.share__activity {
  padding: var(--space-1) var(--space-3) var(--space-2) calc(var(--space-3) + var(--space-4) + var(--space-3));
}
.share__log {
  display: grid;
  gap: var(--space-2);
  /* a long-lived list can hold many recovery points; the panel stays a panel */
  max-height: 11rem;
  overflow-y: auto;
}
/* what changed, and under it when (and who, once more than one person has) */
.share__logrow {
  display: grid;
}
.share__logwhen {
  font-size: var(--text-chrome);
}
</style>
