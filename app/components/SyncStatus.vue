<script setup lang="ts">
// The list's live sync state + last-edit time, in one quiet text line on the
// leading edge of the editor's top bar. The words carry the state — "Syncing…",
// "Synced · edited 1 hour ago", "Offline · saved on device" — and the state word
// swaps in place on change. No animation here: a save
// cycle flips the word Synced→Syncing…→Synced in ~15ms, so animating a word that
// changes faster than the motion runs looked like it was racing itself. A subtler
// motion is worth revisiting, but plain-swap is the calm baseline. Self-contained:
// reads the editor singleton, so callers just drop in <SyncStatus />.
const c = useGearList();
const status = c.status;
const snapshot = c.snapshot;

// authoritative last write, from the server snapshot — so a collaborator's edit the
// poll pulls in moves it too. Absent on a never-server-saved draft.
const { editedAt, now } = useEditedAt(() => snapshot.value?.updatedAt);

// mirrors the controller's hasRealContent gate (a name or a weight; a bare
// "Add an item" row doesn't count) — drives the empty-new-list case below
const hasContent = computed(
  () => !!snapshot.value?.items.some((i) => i.name.trim() !== "" || i.unitWeightMg > 0),
);

// state word (announced on change) and the time suffix (silent, updates in place)
// are kept apart so the 30s tick never re-announces the state
const stateWord = computed(() => {
  switch (status.value) {
    case "loading":
      return "Loading…";
    case "saving":
      return "Syncing…";
    case "offline":
      return "Offline · saved on device";
    case "error":
      return "Not saved";
    case "synced":
      // NOTHING, once it's safely on the server — the time suffix below carries on
      // alone, so the resting line reads "edited 4 minutes ago" rather than
      // "Synced · edited 4 minutes ago".
      //
      // "Synced" is a word that is almost always true, in the most valuable spot in
      // the toolbar, saying nothing you can act on. The timestamp beside it is the
      // half that's actually information. Dropping the state word at rest lets the
      // bar's leading edge hold one thing at a time — the list switcher when all is
      // well, a real state when there is one — and everything below still speaks up
      // the moment there IS news: syncing, offline, not saved, no longer online.
      //
      // A draft with content but no server time yet still says so: "saved on device"
      // is news (it's NOT on the server), which is exactly the test this applies.
      return editedAt.value != null ? "" : hasContent.value ? "Saved on device" : "";
    case "missing":
      // the server no longer knows this list (deleted or reaped) but the local
      // copy is intact — say so honestly instead of claiming a sync state
      return "No longer online · saved on device";
    default:
      return ""; // idle
  }
});
// No leading "·" when the state word has stood down — it would open the line with a
// dangling separator. The dot only joins two things when there are two.
const timeSuffix = computed(() =>
  status.value === "synced" && editedAt.value != null
    ? `${stateWord.value ? " · " : ""}edited ${timeAgo(editedAt.value, now.value.getTime())}`
    : "",
);

// Either half can carry the line now that the resting state drops its word.
const shown = computed(() => stateWord.value !== "" || timeSuffix.value !== "");
</script>

<template>
  <p v-if="shown" class="syncstatus" :class="{ 'is-alert': status === 'error' }">
    <!-- polite live region: the state word swaps in place and re-announces on
         change, while the time suffix updates silently outside it (so the 30s tick
         never re-announces) --><span
      class="syncstatus__state"
      aria-live="polite"
    >{{ stateWord }}</span><span v-if="timeSuffix" class="syncstatus__time">{{ timeSuffix }}</span>
  </p>
</template>

<!-- lang="scss" is load-bearing, not decoration: the $bp-stack breakpoint below is
     injected by vite's additionalData (nuxt.config), which only reaches scss blocks.
     In a plain CSS block the literal `$bp-stack` survives to the minifier and fails
     the production build with "Invalid media query" — dev is happy either way. -->
<style scoped lang="scss">
.syncstatus {
  margin: 0;
  color: var(--ink-3);
  /* the chrome tier, not body size: this annotates the app rather than being part of
     the list, and it shares a dense toolbar with 32px icon buttons */
  font-size: var(--text-chrome);
  /* one line; a long "edited Jul 8" clips rather than wraps */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Below the stack point the bar is genuinely tight — the mode toggle, share and kebab
   leave ~130px, and the full string wants ~180. Drop the TIME rather than ellipsis the
   line: "Synced · edi…" is worse than "Synced", and the state word is the part that's
   load-bearing. This is the same mobile-crowding concern that used to keep the whole
   line out of the bar; it's answered here instead of by relocating the component. */
@media (max-width: $bp-stack) {
  .syncstatus__time {
    display: none;
  }
}
/* a genuine "Not saved" is the one state worth full ink */
.syncstatus.is-alert {
  color: var(--ink);
}
</style>
