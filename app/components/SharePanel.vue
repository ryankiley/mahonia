<script setup lang="ts">
import { counted } from "~~/shared/tidyText";
import { HugeiconsIcon } from "~/utils/hugeicon";
import {
  Cancel01Icon,
  ChevronDownIcon,
  Copy01Icon,
  Refresh01Icon,
  UserAdd01Icon,
} from "@hugeicons/core-free-icons";
import type { ListSnapshot, SnapshotMeta } from "~~/shared/types";

// Everything about who can see or change this list, in ONE place.
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
// tracking (see claimRepo), so what reaches this button is essentially a list
// someone shared with you that you want to keep. It sits under "Replace this
// link" because it belongs to the edit link — the two things you can do about
// who holds this list.
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
  <div class="popover share" role="dialog" aria-label="Sharing">
    <header class="panel__head share__head">
      <h2 class="t-label panel__title">Sharing</h2>
      <button
        type="button"
        class="btn btn--icon btn--ghost btn--flush-end"
        aria-label="Close sharing"
        @click="emit('close')"
      >
        <HugeiconsIcon :icon="Cancel01Icon" :size="16" :stroke-width="2" />
      </button>
    </header>

    <p v-if="isDraft" class="t-sm t-muted share__note">
      Add an item and this list gets its links: one to read, one to edit.
    </p>

    <template v-else>
      <!-- Each link is ONE ROW: its name and Copy. It used to be a label over a filled
           field showing the address over a line of help, three tiers per link and two
           grey boxes, and the panel read as a form. The address told nobody anything
           (a truncated code), and a copy the clipboard refuses already opens it
           selectable (the editor's showLinkFallback). The help lines went too: "Anyone
           with it can see / edit this list" only repeated the names, and copying the
           edit link already asks first and says who it's for. -->
      <section class="share__row">
        <h3 class="share__name">Read-only link</h3>
        <button type="button" class="btn btn--quiet share__act" @click="emit('copyRead')">
          <HugeiconsIcon :icon="Copy01Icon" :size="14" :stroke-width="2" /> Copy
        </button>
      </section>

      <section class="share__field">
        <div class="share__row">
          <div class="share__what">
            <h3 class="share__name">Edit link</h3>
            <!-- the claimed-open case: opened from the account, and the server only ever
                 stored the link's hash, so there is nothing here to copy. Replacing it
                 is how this device gets one (and it cuts off the old link). -->
            <p v-if="!holdsEditLink" class="t-sm t-muted">Not on this device. Replace it to get a new one.</p>
          </div>
          <button
            v-if="holdsEditLink"
            type="button"
            class="btn btn--quiet share__act"
            @click="emit('copyEdit')"
          >
            <HugeiconsIcon :icon="Copy01Icon" :size="14" :stroke-width="2" /> Copy
          </button>
        </div>
        <!-- revocation is a quiet text link under the thing it revokes, not a row of
             its own: it belongs to this link, and giving it a button's weight made
             replacing your link look like a normal next step -->
        <button type="button" class="btn btn--quiet share__revoke" @click="emit('rotate')">
          <HugeiconsIcon :icon="Refresh01Icon" :size="14" :stroke-width="2" /> Replace this link
        </button>
        <!-- The other thing you can do about who holds this list, in the same quiet
             voice, and only while it would do something. A list already on the
             account says nothing here; see the script. -->
        <button
          v-if="canAddToAccount"
          type="button"
          class="btn btn--quiet share__revoke"
          :disabled="claim === 'claiming'"
          @click="addToAccount"
        >
          <HugeiconsIcon :icon="UserAdd01Icon" :size="14" :stroke-width="2" />
          Add to your account
        </button>
        <p v-if="claim === 'failed'" class="t-sm t-muted" role="alert">
          That didn’t save. Check your connection and try again.
        </p>
      </section>

      <!-- ACTIVITY, collapsed. It's reassurance you go looking for, not something you
           need every time you copy a link — and expanded by default it was half the
           panel's height. Deliberately modest even when open: these are the server's
           recovery points, so they say WHAT changed and WHEN, not who: a link-owned
           list has no identities to attribute to. The one exception is an edit made
           through the connector, which says it was an assistant's. -->
      <section class="share__activity">
        <button
          type="button"
          class="share__disclosure"
          :aria-expanded="activityOpen"
          @click="activityOpen = !activityOpen"
        >
          <span class="t-label share__subtitle">Recent changes</span>
          <HugeiconsIcon :icon="ChevronDownIcon" class="chev"
            :class="{ 'is-open': activityOpen }"
            :size="14"
            :stroke-width="2"
            aria-hidden="true" />
        </button>
        <!-- slides open like the app's other disclosures — the shared .reveal
             recipe this surface is named as a consumer of (controls.scss) -->
        <Transition name="reveal">
          <div v-if="activityOpen" class="reveal">
            <div>
              <p v-if="activityState === 'loading'" class="t-sm t-muted">Loading…</p>
              <p v-else-if="activityState === 'error'" class="t-sm t-muted">
                Couldn’t load recent changes.
              </p>
              <p v-else-if="!activity.length" class="t-sm t-muted">No changes recorded yet.</p>
              <ul v-else class="share__log">
                <li v-for="(s, i) in activity" :key="s.id" class="share__logrow">
                  <span class="t-sm share__logwhat"
                    >{{ changeLabel(i) }}
                    <!-- its own line: run on after a dot, it broke wherever the label
                         happened to end and left the dot hanging -->
                    <span v-if="s.actor === 'assistant'" class="t-muted share__logwho">By an assistant</span></span
                  >
                  <!-- the count moved to the label where it says something; the trailing
                       column is just when -->
                  <span class="t-sm t-muted share__logwhen">{{ timeAgo(new Date(s.createdAt).getTime(), now) }}</span>
                </li>
              </ul>
            </div>
          </div>
        </Transition>
      </section>
    </template>
  </div>
</template>

<!-- lang="scss" for $bp-stack (nuxt.config injects it into every scss block). In a
     plain CSS block `@media (max-width: $bp-stack)` is not reported as an error — the
     rule is just silently dropped. -->
<style scoped lang="scss">
/* Anchored under its trigger in the topbar. The .popover atom supplies the surface
   (lift, radius, shadow) and hands down --popover-item-radius, so nothing here
   redraws what the autocomplete and kebab already agree on. */
.share {
  position: absolute;
  top: calc(100% + var(--space-1));
  right: 0;
  /* The same layer every other topbar popover takes. It carried a layer of its own
     (--z-panel: 55) to climb over the vault pane, which could never have worked —
     the topbar's own z-index makes a stacking context, so this is resolved inside it
     and 55 bought exactly nothing. The pane sits under the whole bar now (--z-pane),
     so all this has to do is order correctly against its siblings in the bar. */
  z-index: var(--z-menu);
  width: min(22rem, calc(100vw - 2 * var(--space-4)));
  padding: var(--space-3);
  display: grid;
  gap: var(--space-3);
  text-align: left;
}
/* On a phone the editor drops this panel's wrapper out of the positioning chain (see
   .editor__sharemenu), so `right` now measures from the viewport rather than from the
   trigger. Take the same gutter the width above already reserves, and the panel sits
   centred between the two edges instead of flush against one. */
@media (max-width: $bp-stack) {
  .share {
    right: var(--space-4);
  }
}
/* THE PANEL HEADER is the .panel__head atom (controls.scss); only the offset onto
   this container's edge is ours. */
.share__head {
  /* the optical nudge the account dialog carries too: a line of type sits lower inside
     its box than a padding value suggests, so a header aligned by the box alone reads
     as more inset at the top than at the sides */
  margin-top: calc(-1 * var(--space-1));
  /* No rule under the title, and no padding under it either — the padding was there to
     hold the title off that rule. The vault pane, which is the same header at the same
     size with the same close button, never had either. The card's own gap separates. */
}
/* the edit link and the two quiet actions that belong to it, as one block */
.share__field {
  display: grid;
  gap: var(--space-2);
}
/* what the link is on the left, Copy on the right, centred on the pair of lines */
.share__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}
.share__what {
  min-width: 0;
}
.share__name {
  font-size: var(--text-base);
  font-weight: 500;
  color: var(--ink);
}
/* The activity disclosure's label: a step down from the panel title, the tier the
   tokens describe as the small labels above a group. */
.share__subtitle {
  color: var(--ink-3);
  font-size: var(--text-micro);
  line-height: 1.2;
}
/* Copy is FILLED: it is the one thing you came to this panel to press. A bare text
   button read as one more line of words, and an outline was a box in a de-outlined
   chrome (controls.scss). Hover deepens a step, the same move the .well makes. */
.share__act {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--icon-btn);
  padding-inline: var(--space-3);
  background: var(--paper-3);
  border-radius: var(--popover-item-radius);
  color: var(--ink);
  transition: background var(--spring-fade-dur) var(--spring-fade);
}
/* pointer-gated — it paints (see the note on .btn:hover, controls.scss). Copying
   doesn't dismiss the panel, so the deepened chip used to sit there for the rest of
   the visit, under a finger that had already gone. */
@media (hover: hover) and (pointer: fine) {
  .share__act:hover {
    background: color-mix(in oklab, var(--ink) 6%, var(--paper-3));
  }
}
/* Replacing the link is quiet TEXT under the field it replaces. It is destructive
   and rarely wanted; giving it a button's weight beside the copies would have made
   it read as a third equal option. */
.share__revoke {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: 0;
  padding: 0;
  color: var(--ink-3);
}
@media (hover: hover) and (pointer: fine) {
  .share__revoke:hover {
    background: transparent;
    color: var(--ink);
  }
}
.share__activity {
  padding-top: var(--space-2);
  border-top: 1px solid var(--line);
  display: grid;
  gap: var(--space-1);
}
.share__disclosure {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  width: 100%;
  cursor: pointer;
}
/* the chevron is the .chev atom (controls.scss) — the same quiet mark that
   turns over on the ⋯ menu's Export section; it had a byte-identical copy here */
.share__log {
  display: grid;
  gap: var(--space-1);
  /* a long-lived list can hold many recovery points; the panel stays a panel */
  max-height: 11rem;
  overflow-y: auto;
}
/* WHAT changed, then WHEN. Both were bare flex items, which let the two columns
   negotiate for width as equals — so a long entry ("Removed Arc'teryx Sinsola Cinch
   Cap") squeezed the timestamp until "1 hour ago" broke across two lines, and the
   right-hand column stopped being a column at all. The split isn't symmetric: the
   timestamp is a short fixed phrase and the thing you scan down, the label is the part
   with something to say and the only one that should ever take a second line. */
.share__logrow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
/* min-width, because a flex item's is `auto` — it refuses to shrink below its longest
   word, which is what pushed the overflow onto its neighbour instead of wrapping here */
.share__logwhat {
  min-width: 0;
}
.share__logwho {
  display: block;
}
.share__logwhen {
  flex: none;
  white-space: nowrap;
}
</style>
