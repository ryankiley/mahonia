<script setup lang="ts">
import { HugeiconsIcon } from "~/utils/hugeicon";
import { Cancel01Icon, ChevronDownIcon, Copy01Icon, Refresh01Icon } from "@hugeicons/core-free-icons";
import type { ListSnapshot } from "~~/shared/types";

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
// The two URLs arrive BUILT rather than being derived here. The editor already owns
// the origin helper and the edit-link path rule, and re-deriving them in a second
// place is how the panel ends up showing a link the copy button doesn't produce.
const props = defineProps<{
  snapshot: ListSnapshot;
  editToken: string;
  readUrl: string;
  editUrl: string;
}>();
const emit = defineEmits<{
  close: [];
  copyRead: [];
  copyEdit: [];
  rotate: [];
}>();

// A draft has no share code and no token until its first real item lands, so every
// link here would be broken. Say so once, rather than four disabled rows.
const isDraft = computed(() => !props.snapshot.shareCode || !props.editToken);

/**
 * Clicking a link field takes the whole link, not a caret.
 *
 * The field is truncated, so dragging to select means dragging past the right edge
 * and waiting for it to scroll — the worst way to get a URL. There is nothing to put
 * a caret in front of here (the input is readonly), so a click has no other job.
 *
 * On @click as well as @focus: focus only fires the first time, and the second click
 * on an already-focused field is exactly the "that didn't work, try again" reflex
 * this is meant to answer.
 */
function selectAll(e: Event) {
  (e.target as HTMLInputElement).select();
}

// ---- recent activity ----
// The recovery points the server already keeps. They are the closest thing to an
// activity log this app has, and they are honest about what they are: a version
// count and a time, not a per-field diff. Fetched on OPEN rather than on mount, so
// the editor never pays for it.
interface SnapshotMeta {
  id: number;
  version: number;
  reason: string | null;
  createdAt: string;
  itemCount: number;
}
const activity = ref<SnapshotMeta[]>([]);
const activityState = ref<"idle" | "loading" | "error">("idle");
// re-rendered against a ticking clock would be churn for no gain — the panel is
// open for seconds, so one read at fetch time is enough
const now = ref(Date.now());
// collapsed by default — see the markup for why
const activityOpen = ref(false);

async function loadActivity() {
  if (!props.editToken) return;
  activityState.value = "loading";
  try {
    const res = await $fetch<{ snapshots: SnapshotMeta[] }>("/api/edit/snapshots", {
      headers: { Authorization: `Bearer ${props.editToken}` },
    });
    activity.value = res.snapshots ?? [];
    now.value = Date.now();
    activityState.value = "idle";
  } catch {
    activityState.value = "error";
  }
}
onMounted(loadActivity);

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
  return `${delta > 0 ? "Added" : "Removed"} ${n} item${n === 1 ? "" : "s"}`;
}
</script>

<template>
  <div class="popover share" role="dialog" aria-label="Sharing">
    <header class="share__head">
      <h2 class="t-label share__title">Sharing</h2>
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
      <!-- Each link is a LABELLED FIELD with its copy beside it, rather than a row of
           prose over a wrapped URL. The edit link is ~60 characters of base64 token:
           printed in full it wrapped to three lines of noise and became the loudest
           thing in the panel, which is precisely backwards for the item you are
           meant to think twice about. Truncated in a field it reads as "a link",
           which is all you need to see before pressing Copy. -->
      <section class="share__field">
        <h3 class="t-label share__subtitle">Read-only link</h3>
        <div class="share__inputrow">
          <input
            class="share__input"
            :value="readUrl"
            readonly
            tabindex="-1"
            :aria-label="'Read-only link'"
            @focus="selectAll"
            @click="selectAll"
          />
          <button type="button" class="btn btn--quiet share__act" @click="emit('copyRead')">
            <HugeiconsIcon :icon="Copy01Icon" :size="14" :stroke-width="2" /> Copy
          </button>
        </div>
        <p class="t-sm t-muted share__hint">Anyone with it can look, not change.</p>
      </section>

      <section class="share__field">
        <h3 class="t-label share__subtitle">Edit link</h3>
        <div class="share__inputrow">
          <input
            class="share__input"
            :value="editUrl"
            readonly
            tabindex="-1"
            :aria-label="'Edit link'"
            @focus="selectAll"
            @click="selectAll"
          />
          <button type="button" class="btn btn--quiet share__act" @click="emit('copyEdit')">
            <HugeiconsIcon :icon="Copy01Icon" :size="14" :stroke-width="2" /> Copy
          </button>
        </div>
        <p class="t-sm t-muted share__hint">Anyone with it can change this list.</p>
        <!-- revocation is a quiet text link under the thing it revokes, not a row of
             its own — it belongs to this link, and giving it equal weight to the two
             copies made replacing your link look like a normal next step -->
        <button type="button" class="btn btn--quiet share__revoke" @click="emit('rotate')">
          <HugeiconsIcon :icon="Refresh01Icon" :size="14" :stroke-width="2" /> Replace this link
        </button>
      </section>

      <!-- ACTIVITY, collapsed. It's reassurance you go looking for, not something you
           need every time you copy a link — and expanded by default it was half the
           panel's height. Deliberately modest even when open: these are the server's
           recovery points, so they say WHEN the list changed and how big it was, not
           who did it. A link-owned list has no identities to attribute to. -->
      <section class="share__activity">
        <button
          type="button"
          class="share__disclosure"
          :aria-expanded="activityOpen"
          @click="activityOpen = !activityOpen"
        >
          <span class="t-label share__subtitle">Recent changes</span>
          <HugeiconsIcon :icon="ChevronDownIcon" class="share__chev"
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
                  <span class="t-sm">{{ changeLabel(i) }}</span>
                  <!-- the count moved to the label where it says something; the trailing
                       column is just when -->
                  <span class="t-sm t-muted">{{ timeAgo(new Date(s.createdAt).getTime(), now) }}</span>
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
  /* clears the vault pane — see --z-panel */
  z-index: var(--z-panel);
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
/* the header is a title bar, ruled off from the body — without it the panel's own
   name read as just another section label in the stack */
.share__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  margin: calc(-1 * var(--space-1)) 0 0;
  /* No rule under the title, and no padding under it either — the padding was there to
     hold the title off that rule. The vault pane, which is the same header at the same
     size with the same close button, never had either. The card's own gap separates. */
}
.share__title {
  color: var(--ink);
}
.share__note {
  margin: 0;
}
/* a link and everything that belongs to it, as one block */
.share__field {
  display: grid;
  gap: var(--space-1);
}
/* A STEP DOWN from the panel title, which it used to match exactly — same size, same
   weight, same ink — so the panel read as a list of equal headings with no way to tell
   which one named the whole surface.
   --text-micro is the tier the tokens already describe as "the small labels sitting
   above its fields", and that is what these are: each one names the input beneath it.
   Same treatment as .head__panellabel in the trail-link panel, so the two panels label
   their fields the same way. */
.share__subtitle {
  color: var(--ink-3);
  font-size: var(--text-micro);
  line-height: 1.2;
}
.share__inputrow {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
/* The link, shown as a FILLED, truncated field rather than printed prose. Two
   reasons it's an <input readonly> and not a <span>: it truncates without wrapping
   at any width, and a pointer landing on it selects the whole link in one click.
   No tab stop — Copy beside it is the keyboard path, and stopping on a read-only
   field on the way there earns nothing. It is NOT aria-hidden: it takes focus on
   click, and hiding a focusable element from the a11y tree is the one thing that
   combination must never do. */
.share__input {
  flex: 1;
  min-width: 0;
  min-height: var(--icon-btn);
  padding-inline: var(--space-2);
  border: 0;
  border-radius: var(--popover-item-radius);
  background: var(--paper-2);
  color: var(--ink-2);
  font: inherit;
  font-size: var(--text-sm);
  text-overflow: ellipsis;
}
/* Copy is FILLED a step deeper than the field beside it: it is the one thing you
   came to this panel to press, and beside the paper-2 field a bare text button
   disappeared into it — while an outline was a box in a de-outlined chrome
   (controls.scss). Distinct ground does the separating; hover deepens a step, the
   same move the .well makes. */
.share__act {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  min-height: var(--icon-btn);
  padding-inline: var(--space-3);
  border: 0;
  background: var(--paper-3);
  border-radius: var(--popover-item-radius);
  color: var(--ink);
  transition: background var(--dur) var(--ease);
}
.share__act:hover {
  background: color-mix(in oklab, var(--ink) 6%, var(--paper-3));
}
.share__hint {
  margin: 0;
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
.share__revoke:hover {
  background: transparent;
  color: var(--ink);
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
  padding: 0;
  border: 0;
  background: transparent;
  font: inherit;
  cursor: pointer;
}
.share__chev {
  flex: none;
  color: var(--ink-3);
  transition: rotate var(--dur) var(--ease);
}
.share__chev.is-open {
  rotate: 180deg;
}
.share__log {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-1);
  /* a long-lived list can hold many recovery points; the panel stays a panel */
  max-height: 11rem;
  overflow-y: auto;
}
.share__logrow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
</style>
