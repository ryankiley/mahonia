<script setup lang="ts">
// The shortcuts the editor never told you about.
//
// Every one of these already existed and was reachable only by accident. Arrowing a
// weight, arrowing a grip, Escape mid-drag — all shipped as quiet refinements on
// controls that look like they do nothing but what they say, and nobody finds a
// keystroke by hovering. Alt-drag is the one that forced the issue: a gesture whose
// whole point is saving a power user twenty repetitions is worthless if the power
// user never learns it exists.
//
// A SHEET, not a settings screen. Nothing here is configurable and nothing here is
// new — this is a reference for behaviour that is already true, which is why it
// reads as a table and closes with a button.
//
// The list is deliberately short. Everything on it is something the app really does
// and a reasonable person would never guess; standard widget behaviour (Tab, Escape
// closing a dialog, arrowing a radio group) is left off, because a reference padded
// with things you already know is one you stop trusting.
defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

// "⌥" on a Mac, "Alt" elsewhere. A sheet that exists to make an unguessable gesture
// findable cannot name a key the reader's keyboard doesn't have — see app/utils/platform.
const ALT = altKeyLabel();

// `mod` is the key HELD while `keys` are pressed, rendered with a "+" between the two
// halves and nothing between the keys themselves — because ↑ and ↓ are one control,
// not two shortcuts, and "Shift + ↑ + ↓" would be a chord nobody can play.
interface Row {
  mod?: string;
  keys: string[];
  what: string;
}
const GROUPS: { title: string; rows: Row[] }[] = [
  {
    title: "A row",
    rows: [
      { mod: ALT, keys: ["drag"], what: "Duplicate a row — it lands where you drop it, with everything on it" },
      { keys: ["↑", "↓"], what: "In a weight field, nudge the weight in that row’s own unit" },
      { mod: "Shift", keys: ["↑", "↓"], what: "Nudge it by ten of those" },
      { keys: ["↑", "↓"], what: "On the drag handle, move a row — or a folder — one place" },
    ],
  },
  {
    title: "While dragging",
    rows: [
      { keys: ["Esc"], what: "Put it back — the drop is cancelled and nothing moves" },
      // the non-obvious half of the copy gesture, and the reason it earns a second
      // line: the modifier LATCHES, so you needn't still be holding it at the drop
      { keys: [ALT], what: "Press it any time before the drop; let go and keep dragging to cancel" },
    ],
  },
  {
    title: "Naming an item",
    rows: [{ keys: ["↑", "↓"], what: "Move through the suggestions; Enter takes the highlighted one" }],
  },
];
</script>

<template>
  <BaseModal :open="open" label="Keyboard shortcuts" @close="emit('close')">
    <h2 class="t-label">Keyboard shortcuts</h2>

    <div v-for="g in GROUPS" :key="g.title" class="keys__group">
      <p class="t-label t-muted keys__head">{{ g.title }}</p>
      <dl class="keys__list">
        <template v-for="(r, i) in g.rows" :key="i">
          <dt class="keys__keys">
            <template v-if="r.mod">
              <kbd class="keys__kbd">{{ r.mod }}</kbd>
              <span class="keys__join" aria-hidden="true">+</span>
            </template>
            <kbd v-for="k in r.keys" :key="k" class="keys__kbd">{{ k }}</kbd>
          </dt>
          <dd class="t-sm keys__what">{{ r.what }}</dd>
        </template>
      </dl>
    </div>

    <!-- Not a keystroke, but the same kind of thing: true, useful, and invisible
         unless somebody says it out loud. One line, and only one — a shortcut sheet
         that starts collecting tips stops being a shortcut sheet. -->
    <p class="t-sm t-muted keys__note">
      A weight field also takes its unit: type <em>32.5 oz</em> on a gram list and that row keeps ounces.
    </p>

    <div class="dlg__actions">
      <button type="button" class="btn btn--primary" @click="emit('close')">Close</button>
    </div>
  </BaseModal>
</template>

<style scoped>
.keys__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.keys__head {
  margin: 0;
}
/* Two columns, keys then meaning, on ONE grid per group so every row's description
   starts at the same x — a <dl> whose dt/dd are grid items directly, which is what
   keeps the pairing in the markup where a screen reader can still hear it.
   The key column is auto so it takes only what the widest chord needs. */
.keys__list {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: var(--space-2) var(--space-3);
  margin: 0;
}
.keys__keys {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  white-space: nowrap;
}
.keys__join {
  color: var(--ink-3);
}
.keys__what {
  margin: 0;
  color: var(--ink-2);
}
/* the key cap: the row's own quiet chrome — a hairline box on the raised surface,
   sized off the small text so a chord doesn't stand taller than the line beside it */
.keys__kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.6em;
  padding: 0.1em 0.4em;
  font: inherit;
  font-size: var(--text-sm);
  line-height: 1.4;
  color: var(--ink);
  background: var(--paper-2);
  border: 1px solid var(--line-2);
  border-radius: var(--radius-2);
}
.keys__note {
  margin: 0;
}
.keys__note em {
  font-style: normal;
  color: var(--ink);
}
</style>
