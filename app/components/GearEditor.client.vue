<script setup lang="ts">
import { Backpack, Ellipsis, Share2, SquareCheck, Undo2 } from "@lucide/vue";
import { editLinkPath } from "~~/shared/links";
import type { Item } from "~~/shared/types";
import { bySortOrder, groupItemsByFolder, groupItemsByParent, ungroupedTopLevel } from "~~/shared/weights";

// The whole editor surface (its own sticky topbar + flex shell + the shared
// SiteFooter). Rendered by the page routes: /e (bare, ssr:false) and /e/[code]
// (client-only under a server-rendered <head>). It is CLIENT-ONLY — it holds a
// singleton controller with IndexedDB + window listeners, so it never runs on the
// server (the /e/[code] page wraps it in <ClientOnly>; /e is ssr:false).

const c = useGearList();
const router = useRouter();
const my = useMyLists();
// app-wide dialogs (replace native confirm()/the copy dead-end) — see useDialogs
const { confirm: askConfirm, showLinkFallback } = useDialogs();

const snapshot = c.snapshot;
const totals = c.totals;
const status = c.status;
const pendingUndo = c.pendingUndo;

// First-run / returning-user helper: an untouched draft (not yet saved to the
// server, no named item — the starter draft ships one blank row) shows a one-line
// intro so the bare-domain landing isn't a nameless editor, plus a pointer back to
// saved lists for anyone who has them (the editor otherwise only reaches "Your
// lists" via the footer). shareCode/items are reactive, so it recedes the moment
// the first real item lands (which is also when the draft gets its shareCode).
const savedCount = computed(() => my.entries.value.length);
const isFirstRun = computed(() => {
  const s = snapshot.value;
  if (!s || s.shareCode) return false;
  return !s.items.some((i) => i.name.trim());
});

// Reflect the list's given name in the tab title AND the page's social/preview
// metadata, matching the read views (/l, /s): a named list carries its name; an
// unnamed draft (the bare-domain landing) keeps the generic site card, so the
// static nuxt.config card that unfurls the bare domain is unchanged.
//
// This runs client-side, so it drives the browser tab + in-app share targets. The
// SERVER-rendered name that JS-less unfurl bots (Apple Notes/iMessage/Slack) read
// comes from the /e/[code] route's <head> — that's why the shareable edit link
// embeds the share code in its path.
// naming rule + description builder shared with the /e/[code] SSR head via
// editorSeo (app/utils/editorSeo.ts), so the two surfaces can't drift
const seo = computed(() => editorSeo(snapshot.value?.title, totals.value));
const listName = computed(() => seo.value.name);
useHead({
  title: () =>
    !snapshot.value
      ? "Mahonia"
      : seo.value.name
        ? `${seo.value.name} — Mahonia`
        : "Untitled list — Mahonia",
});
useSeoMeta({
  description: () => seo.value.desc,
  ogTitle: () => seo.value.name || GENERIC_TITLE,
  ogDescription: () => seo.value.desc,
});
// items whose folder was removed (e.g. by a concurrent editor) land here, not as invisible ghosts
// (ungroupedTopLevel: nested children render under their parent, via ItemRow)
const ungrouped = computed(() =>
  snapshot.value ? ungroupedTopLevel(snapshot.value.items) : [],
);
// render folders in sortOrder so drag-reorder (moveFolderBefore) reflects immediately
const sortedFolders = computed(() =>
  snapshot.value ? [...snapshot.value.folders].sort(bySortOrder) : [],
);
// one grouping pass per snapshot, handed to each FolderSection — so a keystroke
// in one folder doesn't make every folder re-filter + re-sort the whole item array.
// Folders are passed so each group honors its own `sortBy` (manual = drag order).
const itemsByFolder = computed(() => {
  const map = groupItemsByFolder(snapshot.value?.items ?? [], snapshot.value?.folders ?? []);
  // A just-added, still-blank row is pinned to the BOTTOM of its (possibly sorted)
  // folder — otherwise a name/weight sort would immediately yank the empty row it
  // autofocused off to the top, away from where you clicked "Add an item". Once you
  // name it and blur, pendingBlankId clears and it slots into sorted position.
  const pid = c.pendingBlankId.value;
  if (pid) {
    for (const group of map.values()) {
      const i = group.findIndex((it) => it.id === pid);
      if (i >= 0) {
        group.push(...group.splice(i, 1));
        break;
      }
    }
  }
  return map;
});
// one children pass per snapshot, threaded to every row — so a parent row doesn't
// re-scan the whole item array for its children on each render
const childrenByParent = computed(() => groupItemsByParent(snapshot.value?.items ?? []));
const NO_ITEMS: Item[] = [];

const packed = ref(false);
// packing progress — rows checked / rows total (a row is one check, whatever its qty)
const packProgress = computed(() => {
  const items = snapshot.value?.items ?? [];
  return { done: items.filter((i) => i.packed).length, total: items.length };
});
// start the next trip clean: uncheck everything (each row is its own op, so the
// existing queue/flush machinery — offline, CAS, live-sync — applies unchanged)
async function clearChecks() {
  if (!snapshot.value) return;
  if (!(await askConfirm({
    title: "Clear checks",
    message: "Uncheck every packed item? Your gear stays. Only the check marks reset.",
    confirmLabel: "Clear checks",
  }))) return;
  if (!snapshot.value) return; // re-check after the awaited dialog
  for (const it of snapshot.value.items) if (it.packed) c.updateItem(it.id, { packed: false });
}
// The undo toast holds its dismiss timer while hovered or containing focus, and
// restarts the window on leave/blur. Two flags (pointer, focus) so releasing one
// while the other still holds doesn't resume the clock. They reset when the toast
// goes, since no mouseleave/focusout fires for an element that just unmounted —
// otherwise a stale "hovered" would pin the NEXT toast open forever.
const undoHovered = ref(false);
const undoFocused = ref(false);
watch(
  () => undoHovered.value || undoFocused.value,
  (held) => (held ? c.holdUndo() : c.releaseUndo()),
);
watch(pendingUndo, (u) => {
  if (!u) {
    undoHovered.value = false;
    undoFocused.value = false;
  }
});
const importOpen = ref(false);
const menuOpen = ref(false);
const menuRef = useTemplateRef<HTMLElement>("menuRef");
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;

// "Add folder" becomes an inline text field on tap; it only creates the folder
// (and shows the next "Add folder") once you commit — enter or click away.
const addingFolder = ref(false);
const newFolderRef = useTemplateRef<HTMLInputElement>("newFolderRef");
function openAddFolder() {
  addingFolder.value = true;
  nextTick(() => newFolderRef.value?.focus());
}
function commitAddFolder() {
  const name = newFolderRef.value?.value.trim();
  if (name) c.addFolder(name);
  addingFolder.value = false;
}

const route = useRoute();
// The epoch of the session THIS instance started. On an /e ↔ /e/[code] route
// swap, Nuxt runs the incoming page's setup (whose watcher below starts a new
// session) BEFORE this instance unmounts — passing our own epoch lets dispose()
// no-op when the session is no longer ours, instead of tearing down the newer
// instance's in-flight load (which stranded the editor on "Loading…").
let ownedEpoch: number | undefined;
// Drive load off the reactive hash so back/forward + same-route nav between two
// of your lists dispose+reload correctly (the editor singleton holds one list).
watch(
  () => route.hash,
  (h) => {
    // first run: ownedEpoch is undefined → unconditional, clearing (and flushing)
    // whatever session a previous page instance left behind
    c.dispose(ownedEpoch);
    const token = decodeURIComponent((h || "").replace(/^#/, ""));
    if (token) c.load(token);
    else c.startDraft(); // no token = a fresh, unsaved draft (persists on first real content)
    ownedEpoch = c.epoch; // load()/startDraft() mint their epoch synchronously
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  clearTimeout(toastTimer);
  c.dispose(ownedEpoch);
});

// On touch, the browser's own "scroll the focused field into view" is flaky — it
// sometimes no-ops, leaving the field sitting under the keyboard. Force it: once
// the keyboard has had time to animate up, centre the field in the space that's
// left. Gated to coarse pointers (desktop clicks shouldn't jump the page) and
// skips the sticky-header fields, which are always visible anyway.
let focusScrollTimer: ReturnType<typeof setTimeout> | undefined;
function onFocusIn(ev: FocusEvent) {
  const el = ev.target as HTMLElement | null;
  if (!el?.matches?.("input, textarea")) return;
  if (el.closest(".topbar")) return;
  if (!window.matchMedia("(pointer: coarse)").matches) return;
  clearTimeout(focusScrollTimer);
  focusScrollTimer = setTimeout(() => {
    // Only intervene if the field is ACTUALLY obscured (hidden under the keyboard or
    // scrolled off the top). When iOS's own focus-scroll already made it visible, a
    // second scrollIntoView is a visible double-reposition. visualViewport.height is
    // the area left above the keyboard.
    const vvH = window.visualViewport?.height ?? window.innerHeight;
    const r = el.getBoundingClientRect();
    if (r.bottom > vvH || r.top < 0) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, 300);
}
useWindowEvent("focusin", onFocusIn); // auto-removes on unmount
onBeforeUnmount(() => clearTimeout(focusScrollTimer));

function flash(msg: string) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 2000);
}
// Clipboard writes fire from real button clicks (the ⋯ menu items + the share
// button), so the async Clipboard API has the user gesture iOS Safari demands. The
// async-first write + synchronous execCommand fallback lives in the shared copyText()
// util (app/utils/clipboard.ts); flash() just reports the outcome.
async function copy(text: string, msg: string, linkFallbackTitle?: string) {
  if (await copyText(text)) return flash(msg);
  // a blocked clipboard write shouldn't dead-end: for a link, show it selectable
  // so it can be copied by hand; other copies (markdown) fall back to a brief toast
  if (linkFallbackTitle) return showLinkFallback(text, linkFallbackTitle);
  flash("Copy failed");
}
const origin = () => (typeof location !== "undefined" ? location.origin : "");

// the three export actions + their chunk warm-up live in useListExports, shared
// with the read views' ⋯ menu so the copy + error handling can't drift
const { warmExporters, copyMarkdown, downloadCsv, downloadJson } = useListExports(
  () => snapshot.value,
  flash,
);

// the ⋯ actions menu is a custom popover of real <button>s (was a native <select>).
// Each item dispatches from a CLICK — the clipboard actions (markdown, edit link)
// need a direct user gesture, and a <select> change isn't one on iOS Safari, so the
// copy silently failed there. Close on the action itself, an outside tap, or Escape.
onClickOutside(menuRef, () => (menuOpen.value = false));
useWindowEvent("keydown", (e) => {
  if (e.key === "Escape" && menuOpen.value) menuOpen.value = false;
});
function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) warmExporters();
}

function copyShare() {
  // a draft has no shareCode/token yet — nudge instead of copying a broken link
  if (!snapshot.value?.shareCode) return flash("Add an item first to share");
  copy(`${origin()}/s/${snapshot.value.shareCode}`, "Read-only link copied", "Read-only link");
}
async function copyEditLink() {
  if (!c.editToken) return flash("Add an item first to get an edit link");
  if (!(await askConfirm({
    title: "Copy edit link",
    message: "Anyone with this link can edit your list. Only send it to people you trust.",
    confirmLabel: "Copy edit link",
  }))) return;
  // /e/{shareCode}#{token} so link previews (Apple Notes/iMessage) show the name;
  // token stays in the fragment (see shared/links.editLinkPath)
  copy(`${origin()}${editLinkPath(snapshot.value?.shareCode, c.editToken)}`, "Edit link copied", "Edit link");
}
async function rotate() {
  if (!(await askConfirm({
    title: "Rotate edit link",
    message: "Make the old edit link stop working and create a new one? Anyone you shared the old link with will lose edit access.",
    confirmLabel: "Rotate link",
    danger: true,
  }))) return;
  const next = await c.rotate();
  if (next) {
    // keep the pretty path (rotate only swaps the token, not the share code)
    history.replaceState(null, "", editLinkPath(snapshot.value?.shareCode, next));
    flash("Edit link rotated");
  }
}
const { copyList } = useCopyList();
async function cloneList() {
  if (!snapshot.value) return;
  const ok = await copyList(snapshot.value, totals.value?.totalMg ?? 0);
  flash(ok ? "List duplicated" : "Couldn’t duplicate. Try again.");
}

// one table drives the ⋯ menu — its markup AND its dispatch — so an action can't
// exist in one without the other (a string-keyed lookup would let a typo no-op)
const MENU_ACTIONS = [
  { label: "Duplicate this list", run: cloneList },
  { label: "Import a list…", run: () => { importOpen.value = true; } },
  { label: "Copy as Markdown", run: copyMarkdown },
  { label: "Download CSV", run: downloadCsv },
  { label: "Download JSON", run: downloadJson },
  { label: "Copy edit link…", run: copyEditLink },
  { label: "Rotate edit link…", run: rotate },
];

function newList() {
  // a fresh draft — no server row until something is added. Clearing the hash fires
  // the route watcher → startDraft; replace so Back doesn't return to the dead token.
  router.replace("/e");
}

// Both dialogs are Lazy + mounted on first use, so their code (incl. the CSV
// parser + LighterPack link handling behind the import) stays out of the editor's
// boot chunk. Once opened they STAY mounted — an unmount-on-close would cut the
// leave transition short, and re-opens then reuse the fetched component.
const importEverOpened = ref(false);
watch(importOpen, (o) => {
  if (o) importEverOpened.value = true;
});
const { target: correctionTarget } = useCatalogCorrection();
const correctionEverOpened = ref(false);
watch(correctionTarget, (t) => {
  if (t) correctionEverOpened.value = true;
});

function onCorrected(res: { status: string; itemName?: string }) {
  flash(
    res.status === "applied"
      ? "Catalog updated for everyone. Thank you."
      : res.status === "proposed"
        ? "Suggested, pending a citation"
        : res.status === "noop"
          ? "That already matches the catalog"
          : "Couldn’t submit that fix",
  );
}

</script>

<template>
  <div class="editor" :class="{ 'editor--centered': !(snapshot && totals) }">
    <!-- the editor's page heading — visually the title input carries it, but a
         real (hidden) h1 gives AT users a page title on this client-only view -->
    <h1 class="visually-hidden">{{ listName ? `${listName} — pack list` : "New pack list — Mahonia" }}</h1>
    <header class="topbar">
      <div class="wrap topbar__inner">
        <div v-if="snapshot" class="editor__titlewrap">
          <input
            class="field editor__title"
            :value="snapshot.title"
            placeholder="Untitled list"
            autocorrect="off"
            spellcheck="false"
            @change="c.setMeta({ title: ($event.target as HTMLInputElement).value })"
          />
        </div>
        <template v-if="snapshot">
          <div class="modetoggle" role="group" aria-label="View mode">
            <!-- one pill tracks between the two segments (damped --ease, never overshoot —
                 a tracking indicator must not leave its track); the icons sit above it -->
            <span class="modetoggle__pill" :class="{ 'is-packing': packed }" aria-hidden="true" />
            <button
              type="button"
              class="modetoggle__opt"
              :class="{ 'is-active': !packed }"
              title="Editing"
              aria-label="Editing mode"
              :aria-pressed="!packed"
              @click="packed = false"
            >
              <Backpack :size="16" :stroke-width="2" />
            </button>
            <button
              type="button"
              class="modetoggle__opt"
              :class="{ 'is-active': packed }"
              title="Packing"
              aria-label="Packing mode"
              :aria-pressed="packed"
              @click="packed = true"
            >
              <SquareCheck :size="16" :stroke-width="2" />
            </button>
          </div>
          <button
            class="btn btn--icon btn--ghost editor__share"
            title="Copy read-only link"
            aria-label="Copy read-only link"
            @click="copyShare"
          >
            <Share2 :size="16" />
          </button>
          <div ref="menuRef" class="menu">
            <!-- a custom popover of real <button>s (was a native <select>): the
                 clipboard items need a direct click gesture, which a <select> change
                 isn't on iOS Safari. The kebab toggles it; each item runs on click. -->
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
                <!-- no "Your lists" here — the footer already carries that link.
                     Close BEFORE the action runs, matching the old dispatch order. -->
                <li v-for="a in MENU_ACTIONS" :key="a.label" role="none">
                  <button type="button" role="menuitem" class="menu__item" @click="menuOpen = false; a.run()">{{ a.label }}</button>
                </li>
              </ul>
            </Transition>
          </div>
        </template>
      </div>
    </header>

    <main v-if="snapshot && totals" class="wrap editor__body">
      <!-- first-run / returning-user intro: a fresh, empty draft gets one quiet
           line of identity + help (the bare domain lands straight in the editor),
           and anyone who already has lists gets a pointer back to them. Recedes the
           moment the list has an item. -->
      <div v-if="isFirstRun" class="editor__intro">
        <p class="editor__introlede">
          Mahonia weighs your pack. Type a gear name and the weight fills itself. No login, no app.
        </p>
        <NuxtLink v-if="savedCount" to="/mine" class="btn btn--link editor__introlink">
          Your {{ savedCount }} saved {{ savedCount === 1 ? "list" : "lists" }} →
        </NuxtLink>
      </div>
      <!-- persistent sync state + last-edit time, in the calm zone under the
           header (not crammed into the dense control row above) -->
      <SyncStatus />
      <TotalsBar
        :list="snapshot"
        :totals="totals"
        @set-unit="(u) => c.setUnit(u)"
      />
      <!-- packing progress: slides+fades in on entering packing (grid-rows 1fr↔0fr,
           the shared reveal recipe) so the folders below ease down instead of jumping -->
      <Transition name="packbar">
        <div v-if="packed && packProgress.total" class="packbar-reveal">
          <div class="packbar t-sm">
            <span class="t-num" aria-live="polite">{{ packProgress.done }} of {{ packProgress.total }} packed</span>
            <button
              v-if="packProgress.done"
              type="button"
              class="btn btn--quiet packbar__clear"
              @click="clearChecks"
            >Clear checks</button>
          </div>
        </div>
      </Transition>
      <div class="editor__folders">
        <FolderSection
          v-for="f in sortedFolders"
          :key="f.id"
          :list="snapshot"
          :folder="f"
          :items="itemsByFolder.get(f.id) ?? NO_ITEMS"
          :children-by-parent="childrenByParent"
          :packed="packed"
        />
      </div>
      <section v-if="ungrouped.length" class="panel editor__ungrouped">
        <p class="t-label">Ungrouped</p>
        <!-- prev-id follows this section's render order, so the indent affordance
             points at the row actually shown above -->
        <ItemRow
          v-for="(it, i) in ungrouped"
          :key="it.id"
          :list="snapshot"
          :item="it"
          :children-by-parent="childrenByParent"
          :prev-id="ungrouped[i - 1]?.id ?? null"
          :packed="packed"
        />
      </section>

      <div v-if="!packed" class="editor__addfolder">
        <input
          v-if="addingFolder"
          ref="newFolderRef"
          class="editor__addfolderinput"
          placeholder="Folder name"
          aria-label="New folder name"
          autocorrect="off"
          spellcheck="false"
          @keydown.enter.prevent="commitAddFolder"
          @keydown.esc="addingFolder = false"
          @blur="commitAddFolder"
        />
        <button v-else type="button" class="editor__addfolderbtn" @click="openAddFolder">Add folder</button>
      </div>
    </main>

    <main v-else-if="status === 'missing'" class="wrap editor__missing">
      <p class="t-muted">This list isn’t in this browser, or the link is invalid.</p>
      <button class="btn btn--primary" @click="newList">Start a new list</button>
    </main>

    <main v-else class="wrap editor__missing">
      <p class="t-muted">Loading…</p>
    </main>

    <SiteFooter />

    <Transition name="toast">
      <div
        v-if="pendingUndo"
        class="toast undobar"
        @mouseenter="undoHovered = true"
        @mouseleave="undoHovered = false"
        @focusin="undoFocused = true"
        @focusout="undoFocused = false"
      >
        <span class="t-sm">Removed <strong>{{ pendingUndo.label }}</strong></span>
        <button class="undobar__btn t-sm" @click="c.undoRemove()">
          <Undo2 :size="14" /> Undo
        </button>
      </div>
      <div v-else-if="toast" class="toast t-sm">{{ toast }}</div>
    </Transition>

    <LazyCatalogCorrectionModal v-if="correctionEverOpened" @done="onCorrected" />
    <LazyImportModal v-if="importEverOpened" :open="importOpen" @close="importOpen = false" />
  </div>
</template>

<style scoped>
/* column shell so the slim legal footer pins to the bottom on the short
   (empty / missing) states and sits below the list on long ones */
.editor {
  display: flex;
  flex-direction: column;
  min-height: 100svh;
}
.editor > main {
  flex: 1 0 auto;
}
.topbar {
  position: sticky;
  top: 0;
  z-index: var(--z-topbar);
  background: var(--paper);
  border-bottom: 1px solid var(--line);
}
.topbar__inner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-block: var(--space-3);
}
/* the list name is the toolbar's heading. flex:1 so it fills the space up to the
   icon cluster — a long name ellipsizes WITHIN this box instead of nudging the
   app-bar icons. (Sync state + last-edit time live in the SyncStatus line below
   the header, not in this dense row.) */
.editor__titlewrap {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
}
.editor__title {
  /* size to the title text (progressive enhancement; falls back to default
     input width where unsupported) */
  width: auto;
  field-sizing: content;
  /* NO width cap, and shrink-past-content allowed (min-width: 0): the flex row
     — titlewrap flex:1 against the rigid icon cluster — is what bounds the
     title. The old min(46ch, 42vw) cap truncated long names on wide screens
     while the row sat half-empty; now the name runs right up to the icons and
     only ellipsizes when the row genuinely runs out. */
  min-width: 0;
  font-family: var(--font);
  font-size: 1rem; /* static 16px — avoid iOS focus-zoom (see .field in controls.scss) */
  font-weight: 600;
  border-bottom-color: transparent;
  /* a long name that exceeds the available room truncates with an ellipsis at
     rest (the input still scrolls to the caret while you're editing it) */
  text-overflow: ellipsis;
}
.editor__title:focus {
  border-bottom-color: var(--accent);
}
/* the icon cluster is rigid (flex:none) and pinned to the trailing edge by the
   title group's flex:1 — so a long name is absorbed by the title (it ellipsizes)
   and never nudges these icons. */
.editor__share,
.menu {
  flex: none;
}
/* editing/packing toggle — a light container with two icon options + a tracking pill */
.modetoggle {
  position: relative;
  flex: none;
  display: inline-flex;
  gap: var(--space-px);
  padding: var(--space-px);
  background: var(--paper-2);
  border-radius: var(--radius-pill);
}
/* the active tint lives on ONE pill that slides between segments (was a per-segment
   background crossfade). width/translate are percentage-based so it tracks the wider
   coarse-pointer segments too. damped --ease — overshoot would let it leave the track. */
.modetoggle__pill {
  position: absolute;
  top: var(--space-px);
  bottom: var(--space-px);
  left: var(--space-px);
  width: calc((100% - 3 * var(--space-px)) / 2); /* one segment: (inner − gap) / 2 */
  border-radius: var(--radius-pill);
  background: color-mix(in oklab, var(--ink) 12%, transparent);
  pointer-events: none;
  transition: transform var(--dur) var(--ease);
  will-change: transform;
}
.modetoggle__pill.is-packing {
  transform: translateX(calc(100% + var(--space-px))); /* over segment 2: own width + gap */
}
.modetoggle__opt {
  position: relative; /* sits above the pill */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn);
  height: 28px;
  border-radius: var(--radius-pill);
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
  /* Pin a standing compositing layer. These buttons overlap the pill, so when the
     pill's transform animates, Safari promotes them for the run and demotes them
     after — re-rasterising each (at a fractional flex x) to the pixel grid, so the
     icon jumps ~1px per toggle. A static translateZ(0) holds one layer through and
     after the run; will-change is droppable here since the button's own transform
     never animates. Invisible in Chromium (keeps layers warm). Icons only, no text,
     so no glyph-blur cost. See concepts/webkit-relayers-on-animation-boundaries. */
  transform: translateZ(0);
}
.modetoggle__opt:hover {
  color: var(--ink-2);
}
.modetoggle__opt.is-active {
  color: var(--ink);
}
/* touch: each segment becomes a proper tap target (matches the --tap icon buttons) */
@media (pointer: coarse) {
  .modetoggle__opt {
    width: var(--tap);
    height: 40px;
  }
  .modetoggle__opt svg {
    width: var(--icon-touch);
    height: var(--icon-touch);
  }
}
.editor__share {
  color: var(--ink-2);
}
/* the popover's look + open/close come from the shared .menu atom (controls.scss);
   the editor only nudges the trailing cluster (toggle · share · kebab) right into the
   gutter so the kebab lines up with the item rows' drag handle below. The title group
   (flex:1) absorbs the freed space, so the cluster reflows as a unit. */
.menu {
  margin-right: -13px;
}
.editor__body {
  /* no bottom padding: the footer's margin-top is the single content→footer gap
     (matches the inter-folder rhythm), so it isn't doubled up here */
  padding-block: var(--space-4) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}
/* first-run intro — one quiet line of brand + help above the empty totals, plus an
   optional pointer back to saved lists. Recedes once the list has content. */
.editor__intro {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-1);
}
.editor__introlede {
  margin: 0;
  /* no measure cap — it's a single short hint line, so let it use the body width
     (the .wrap container already bounds it) instead of wrapping early mid-sentence */
  color: var(--ink-2);
}
/* packing progress — one quiet line between the totals and the checklist. The
   count is the info; "Clear checks" sits beside it in the site's under-link
   voice (ink-3, darkens on hover, no chrome). */
/* reveal wrapper: carries the tuck + the grid-rows height/fade slide (shared recipe
   with ItemRow's .reveal). The tuck lives here, not on the inner .packbar, so the
   inner line isn't clipped by the wrapper's overflow as it slides. */
.packbar-reveal {
  display: grid;
  grid-template-rows: 1fr;
  /* the body's --space-4 gap reads roomier before a bare text line than before
     the folder blocks — tuck it up toward the totals it annotates */
  margin-top: calc(-1 * var(--space-2));
}
.packbar-reveal > * {
  min-height: 0;
  overflow: hidden;
}
.packbar {
  display: flex;
  align-items: baseline;
  gap: var(--space-4);
  color: var(--ink-2);
}
.packbar-enter-active,
.packbar-leave-active {
  transition:
    grid-template-rows var(--dur) var(--ease),
    opacity var(--dur) var(--ease);
}
.packbar-enter-from,
.packbar-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
/* .packbar__clear kept as the print-hide hook (see print.scss); its button styling
   comes from the shared .btn--quiet */
.editor__folders {
  display: flex;
  flex-direction: column;
  gap: var(--space-7);
}
/* load reveal: folders cascade in (SPACE10 signature), ~50ms apart.
   fill-mode `backwards` (not `both`): holds the hidden start-state during each
   folder's stagger delay, then settles to the natural style afterwards. `both`
   would retain an identity `transform` post-animation, making every folder a
   stacking context that traps the add-item autocomplete dropdown's z-index
   inside its folder (so later folders paint over it). */
.editor__folders > * {
  animation: rise var(--dur-slow) var(--ease) backwards;
}
/* cascade cadence lives in one token (--stagger, ~31ms — SPACE10's kinetic-type
   step), not five magic numbers; child 1 leads at 0, the rest step off it */
.editor__folders > *:nth-child(2) {
  animation-delay: var(--stagger);
}
.editor__folders > *:nth-child(3) {
  animation-delay: calc(var(--stagger) * 2);
}
.editor__folders > *:nth-child(4) {
  animation-delay: calc(var(--stagger) * 3);
}
.editor__folders > *:nth-child(5) {
  animation-delay: calc(var(--stagger) * 4);
}
.editor__folders > *:nth-child(n + 6) {
  animation-delay: calc(var(--stagger) * 5);
}
.editor__ungrouped {
  padding: var(--space-3) var(--space-4) var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.editor__ungrouped .t-label {
  margin-bottom: var(--space-2);
}
/* reads like a folder heading — same type as a folder name, dimmer, flush-left
   with the folder names above it. Tapping it swaps the label for an inline text
   field. */
.editor__addfolder {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  /* sit a full folder-gap below the last folder: the body gap is --space-4, so add
     the remainder to reach --space-7, matching the folder-to-folder rhythm */
  margin-top: calc(var(--space-7) - var(--space-4));
}
/* label + inline input share the folder-name type; label is dimmer */
.editor__addfolderbtn,
.editor__addfolderinput {
  padding: 0;
  background: none;
  border: 0;
  font-family: var(--font);
  font-size: var(--text-title);
  font-weight: 600;
  letter-spacing: -0.02em;
}
.editor__addfolderbtn {
  color: var(--ink-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.editor__addfolderbtn:hover {
  /* full ink, like every quiet add affordance (.folder__addbtn, .item-nest__add) —
     the house hover for quiet text actions (controls.scss) */
  color: var(--ink);
}
.editor__addfolderinput {
  color: var(--ink);
  min-width: 12rem;
}
.editor__addfolderinput:focus {
  outline: none;
}
.editor__addfolderinput::placeholder {
  color: var(--ink-3);
}
.editor__missing {
  padding-block: var(--space-9);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: var(--space-4);
}
/* On the empty states (missing / loading) the message is the whole page, so centre
   it in the viewport: drop the footer's top gap that would otherwise cap the grown
   <main> short of the footer and pull the optical centre upward. */
.editor--centered :deep(.foot) {
  margin-top: 0;
}
/* the toast base + its enter/leave motion now live in the shared .toast atom
   (controls.scss), used by the read views' menu too; the undo bar just adds its
   inner layout on top of that pill. */
.undobar {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.undobar__btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0;
  background: none;
  border: 0;
  color: var(--paper);
  font-weight: 600;
  /* soft underline, matching the site's --underline house style — but the toast is
     inverted (paper text on ink), so soften the PAPER rather than using --ink-3
     (which would vanish on the dark toast). Translucent paper stays legible + quiet. */
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--paper) 55%, transparent);
  text-underline-offset: 2px;
  cursor: pointer;
}
</style>
