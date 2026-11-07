<script setup lang="ts">
import { counted } from "~~/shared/tidyText";
import { HugeiconsIcon } from "~/utils/hugeicon";
import {
  ChevronDownIcon,
  Clock01Icon,
  Edit02Icon,
  Exchange01Icon,
  UserAdd01Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import type { ListSnapshot, SnapshotMeta } from "~~/shared/types";

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
// A CLAIMED open is saved and shareable, but this device holds no edit link to
// print — the server only ever stored its hash. The edit-link section says so and
// offers "replace" (a rotate hands this device the fresh link) instead of showing
// an empty field with a Copy button that copies nothing.
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

// ---- recent activity ----
// The recovery points the server already keeps. They are the closest thing to an
// activity log this app has, and they are honest about what they are: a version
// count and a time, not a per-field diff. Fetched on OPEN rather than on mount, so
// the editor never pays for it.
const activity = ref<SnapshotMeta[]>([]);
const activityState = ref<"idle" | "loading" | "error">("idle");
// re-rendered against a ticking clock would be churn for no gain — the panel is
// open for seconds, so one read at fetch time is enough
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
  // The claim set, fetched the same way: on open, because the panel is the first
  // surface that needs it when a list is opened straight from its link (the
  // switcher hasn't necessarily run). refresh() resolves to empty without a
  // request when signed out, and `claimKnown` keeps the section unrendered until
  // a real answer has landed.
  void claimed.refresh();
});

// Say WHAT changed, not just that something did.
//
// A column of five identical "Edited"s is a column of noise. The server doesn't
// describe changes — a recovery point carries only a reason, a time and an item
// count — but the counts are a sequence, and consecutive ones give the delta. The
// list is newest-first, so entry i's count is the state at that point and entry i+1
// is the state before it.
//
// Honest about its limits: this can only see the COUNT. Renaming an item, fixing a
// weight, or adding one thing while removing another all leave the count unmoved,
// and those correctly fall back to "Edited" rather than inventing a description.
// The oldest entry has nothing older to compare against, so it does too.
const RESTORE_LABEL = "Restored an earlier version";

function changeLabel(i: number): string {
  const s = activity.value[i];
  if (!s) return "Edited";
  if (s.reason === "before restore") return RESTORE_LABEL;
  // Snapshots written since summaries shipped carry one in `reason` (see
  // shared/changeSummary). "edit" is the old constant, and everything older than
  // this change has it — those fall back to the count delta, which can still tell
  // add from remove.
  if (s.reason && s.reason !== "edit") return s.reason;
  const older = activity.value[i + 1];
  if (!older) return "Edited";
  const delta = s.itemCount - older.itemCount;
  if (delta === 0) return "Edited";
  const n = Math.abs(delta);
  return `${delta > 0 ? "Added" : "Removed"} ${counted(n, "item")}`;
}
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
      <li v-if="canAddToAccount" role="none">
        <button
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
      </li>
      <li v-if="claim === 'failed'" role="alert" class="t-sm t-muted share__note">
        That didn’t save. Check your connection and try again.
      </li>

      <!-- RECENT CHANGES folds out like the ⋯ menu's Export (MenuSection's markup, with
           entries in place of rows). Collapsed: it's reassurance you go looking for.
           These are the server's recovery points, so they say WHAT changed and WHEN,
           not who: a link-owned list has no identities to attribute to. The one
           exception is an edit made through the connector, which says so. -->
      <li role="none" class="menu__sect">
        <button
          type="button"
          data-row
          class="menu__item menu__secthead"
          :aria-expanded="activityOpen"
          @click="activityOpen = !activityOpen"
        >
          <HugeiconsIcon :icon="Clock01Icon" :size="16" :stroke-width="2" aria-hidden="true" />
          <span class="menu__sectlabel">Recent changes</span>
          <HugeiconsIcon
            :icon="ChevronDownIcon"
            class="chev"
            :class="{ 'is-open': activityOpen }"
            :size="14"
            :stroke-width="2"
            aria-hidden="true"
          />
        </button>
        <Transition name="reveal">
          <div v-if="activityOpen" class="reveal">
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
                    >{{ timeAgo(new Date(s.createdAt).getTime(), now)
                    }}<template v-if="s.actor === 'assistant'"> · by an assistant</template></span
                  >
                </li>
              </ul>
            </div>
          </div>
        </Transition>
      </li>

      <!-- Replacing the link last and ruled off, where the ⋯ menu keeps Forget and
           Delete: it cuts off everyone who has the old one. -->
      <li role="none" class="menu__foot">
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
/* A touch wider than its rows need (they come to about 13rem), so a change in the
   log ("Added MSR Pocket Rocket 2") sits on one line instead of breaking in two. */
.share {
  min-width: 16rem;
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
/* The entries take a row's inset, not its label's: indented past the glyph as well,
   a change ("Added MSR Pocket Rocket 2") wrapped in a menu only as wide as its rows. */
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
/* what changed, and under it when (and, for a connector's edit, by whom), a size
   down so the pair reads as one entry and not two */
.share__logrow {
  display: grid;
}
.share__logwhen {
  font-size: var(--text-micro);
}
</style>
