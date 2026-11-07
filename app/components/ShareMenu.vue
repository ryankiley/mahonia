<script setup lang="ts">
import { counted } from "~~/shared/tidyText";
import { HugeiconsIcon } from "~/utils/hugeicon";
import {
  Clock01Icon,
  Edit02Icon,
  Exchange01Icon,
  UserAdd01Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import type { ChangeAuthor, ListSnapshot, SnapshotMeta } from "~~/shared/types";

// Everything about who can see or change this list, in ONE place.
//
// Built as a MENU, the ⋯ menu's twin: the same rows, glyphs, travelling plate, rules
// and fold-out section. It was a panel (a titled card, a label over a field showing
// each address, a line of help under each) and read as a form to fill in, when all
// it ever offered was four things to do. Rows say the whole act ("Copy edit link"),
// so nothing needs a heading or a help line, and the glyph says which link before
// the label does.
//
// These four things existed already and were scattered: the read-only link behind
// its own topbar icon, the edit link and "rotate" buried in a flat ⋯ menu between
// "Import a list…" and "Download CSV", and the recovery points reachable from
// nowhere at all (the endpoint shipped without a caller). Sharing is one question —
// who has this, what can they do, how do I take it back — and answering it meant
// knowing which of three surfaces to look on.
//
// Rendered lazily by the editor, so its snapshot fetch and this markup cost nothing
// until someone actually asks about sharing.
// The links themselves never reach this panel: Copy emits, and the editor builds and
// copies them (it owns the origin and the edit-link path rule).
const props = defineProps<{
  snapshot: ListSnapshot;
  editToken: string;
  /** The capability as request headers — Bearer for a held link, the list-code
   *  header for a claimed open. Built by the editor (which owns the capability)
   *  so this panel can't grow a second opinion about auth. */
  authHeaders: Record<string, string>;
}>();
const emit = defineEmits<{
  close: [];
  copyRead: [];
  copyEdit: [];
  rotate: [];
}>();

// A draft has no share code until its first real item lands, so every link here
// would be broken. Say so once, rather than four disabled rows.
const isDraft = computed(() => !props.snapshot.shareCode);
// A CLAIMED open is saved and shareable, but this device holds no edit link to copy:
// the server only ever stored its hash. So there's no "Copy edit link" row, and the
// replace row reads "Get a new edit link" (a rotate hands this device a fresh one).
const holdsEditLink = computed(() => !!props.editToken);

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
// tracking (see claimRepo), so what reaches this row is essentially a list
// someone shared with you that you want to keep. Unlike the other rows it keeps
// the menu open: the claim is a request, and a failure has to be said here.
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
  const ok = await useClaimedLists().claimOne(props.editToken);
  claim.value = ok ? "idle" : "failed";
}

// the travelling wash every menu in the app shares (atoms/controls.scss)
const { plateRef, listRef, on: plateOn } = useMenuPlate();

// Close BEFORE the action runs, as the ⋯ menu's rows do. The copies and the replace
// hand off to the editor, which toasts the result or asks first.
function act(run: () => void) {
  emit("close");
  run();
}

// ---- recent changes ----
// The recovery points the server already keeps: the closest thing to an activity log
// this app has. One per throttle window, so a summary of the change that opened the
// window, a time, and who made it when anyone can be named; not a per-field diff.
// Fetched when the menu mounts, which is when it opens (the editor renders it lazily),
// so the editor never pays for it.
const activity = ref<SnapshotMeta[]>([]);
const activityState = ref<"idle" | "loading" | "error">("idle");
// re-rendered against a ticking clock would be churn for no gain: the menu is open
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
  <ul
    ref="listRef"
    class="popover menu__list share"
    role="menu"
    aria-label="Sharing"
    v-on="plateOn"
  >
    <li role="none" aria-hidden="true">
      <span ref="plateRef" class="menu__plate" />
    </li>

    <li v-if="isDraft" role="none" class="t-sm t-muted share__note">
      Add an item and this list gets its links.
    </li>

    <template v-else>
      <li role="none">
        <button type="button" data-row role="menuitem" class="menu__item" @click="act(() => emit('copyRead'))">
          <HugeiconsIcon :icon="ViewIcon" :size="16" :stroke-width="2" aria-hidden="true" />
          Copy read-only link
        </button>
      </li>
      <!-- A claimed open (opened from the account) holds no edit link: the server only
           ever stored its hash. No row rather than one that can't copy; the replace row
           below says "Get a new edit link" instead, which is how this device gets one. -->
      <li v-if="holdsEditLink" role="none">
        <button type="button" data-row role="menuitem" class="menu__item" @click="act(() => emit('copyEdit'))">
          <HugeiconsIcon :icon="Edit02Icon" :size="16" :stroke-width="2" aria-hidden="true" />
          Copy edit link
        </button>
      </li>

      <!-- RECENT CHANGES folds out like the ⋯ menu's Export: the same MenuSection, with
           entries in place of rows. Collapsed: it's reassurance you go looking for.
           These are the server's recovery points: WHAT changed, WHEN, and who when
           anyone can be named ("You", "Assistant", or a name an editor chose). -->
      <MenuSection v-model:open="activityOpen" label="Recent changes" :icon="Clock01Icon">
        <div class="share__activity">
          <p v-if="activityState === 'loading'" class="t-sm t-muted">Loading…</p>
          <p v-else-if="activityState === 'error'" class="t-sm t-muted">
            Couldn’t load recent changes.
          </p>
          <p v-else-if="!activity.length" class="t-sm t-muted">No changes yet.</p>
          <ul v-else class="share__log">
            <li v-for="(s, i) in activity" :key="s.id" class="share__logrow">
              <span class="t-sm">{{ changeLabel(i) }}</span>
              <span class="t-muted share__logwhen"
                >{{ timeAgo(new Date(s.createdAt).getTime(), now, { short: true })
                }}<template v-if="showWho && whoLabel(s.by)"> · {{ whoLabel(s.by) }}</template></span
              >
            </li>
          </ul>
        </div>
      </MenuSection>

      <!-- THE FOOT, ruled off where the ⋯ menu keeps Forget and Delete: the two things
           that change who holds this list. Keeping it on your account first (rare: it
           only shows for a list the account doesn't have), replacing the link last,
           since that cuts off everyone who has the old one. Above the rule is what
           you open this for nearly every time: the two copies, then the log. -->
      <li role="none" class="menu__foot">
        <button
          v-if="canAddToAccount"
          type="button"
          data-row
          role="menuitem"
          class="menu__item"
          :disabled="claim === 'claiming'"
          @click="addToAccount"
        >
          <HugeiconsIcon :icon="UserAdd01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
          Add to your account
        </button>
        <p v-if="claim === 'failed'" role="alert" class="t-sm t-muted share__note">
          That didn’t save. Check your connection and try again.
        </p>
        <button type="button" data-row role="menuitem" class="menu__item" @click="act(() => emit('rotate'))">
          <HugeiconsIcon :icon="Exchange01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
          {{ holdsEditLink ? "Replace edit link" : "Get a new edit link" }}
        </button>
      </li>
    </template>
  </ul>
</template>

<!-- lang="scss" for $bp-stack (nuxt.config injects it into every scss block). In a
     plain CSS block `@media (max-width: $bp-stack)` is not reported as an error — the
     rule is just silently dropped. -->
<style scoped lang="scss">
/* The surface, the rows, the rules, the section head and the plate are the menu
   atoms (atoms/controls.scss), the same ones the ⋯ menu beside it wears. Only what a
   menu doesn't usually hold is styled here: a line of prose and the change log. */

/* On a phone the editor drops this menu's wrapper out of the positioning chain (see
   .editor__sharemenu), so `right` measures from the viewport rather than from the
   trigger. Take the page gutter instead of sitting flush against the edge. */
@media (max-width: $bp-stack) {
  .share {
    right: var(--space-4);
  }
}
/* Prose where a row would be, inset like a row. Sized BY the rows rather than sizing
   them (width 0, min-width 100%): the menu is as wide as its labels, and a long line
   wraps inside that instead of widening it. */
.share__note,
.share__activity {
  width: 0;
  min-width: 100%;
}
.share__note {
  padding: var(--space-2) var(--space-3);
}
/* The entries take a row's inset, not its label's: indented past the glyph too, a
   change like "Added MSR Pocket Rocket 2" wrapped in a menu only as wide as its rows. */
.share__activity {
  padding: var(--space-1) var(--space-3) var(--space-2);
}
.share__log {
  display: grid;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
  /* a long-lived list can hold many recovery points; the menu stays a menu */
  max-height: 11rem;
  overflow-y: auto;
}
/* what changed, and under it when (and who, once more than one person has), a size
   down so the pair reads as one entry and not two */
.share__logrow {
  display: grid;
}
.share__logwhen {
  font-size: var(--text-chrome);
}
</style>
