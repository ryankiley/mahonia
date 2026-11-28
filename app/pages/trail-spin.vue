<script setup lang="ts">
// /trail-spin: a route file in, the route turning in 3D out, and a video of it to keep. A
// utility, not a brand: the page says what it does, and "trail-spin" is only its address.
//
// A page of its own, needing no list and no account: one of the small free tools a person
// finds by searching, rather than by already having Mahonia. The file is read in the
// browser (readRouteFile, the Trip tab's reader, loaded with the first file) and never sent
// anywhere; the CSP's `connect-src 'self'` makes that a fact, as it does for the Trip tab.
import {
  isSpinFormat,
  isVideoTurns,
  spinModel,
  videoSeconds,
  VIDEO_TURN_CHOICES,
  type SpinFormat,
  type SpinModel,
  type VideoTurns,
} from "~~/shared/routeSpin";
import { formatDistance, heightWithUnit, resolveDistanceUnit } from "~~/shared/trailDistance";
import { contrast, mix, readableShare, rgbOf, luminance, type Rgb } from "~~/shared/contrast";
import RouteSpin from "~/components/RouteSpin.vue";
import { spinExampleTrack } from "~/data/spinExample";
import { IconChevronDownMedium, IconCircleInfo, IconMap } from "~/icons/central";
import { FrameSquareGlyph, FrameVerticalGlyph, FrameWideGlyph, SaveGlyph } from "~/icons/mahonia";
import { SvgIcon } from "~/utils/icon";
import { SAVE_PROGRESS_MS } from "~/utils/spinVideo";

/** a route the visitor gave the page */
interface Spun {
  model: SpinModel;
  name: string;
  distanceM: number;
  ascentM: number;
}
const spun = shallowRef<Spun | null>(null);
/** the route the page opens with, until there's one of the visitor's own (below) */
const example = shallowRef<SpinModel | null>(null);
const shown = computed(() => spun.value?.model ?? example.value);
const error = ref("");
const busy = ref(false);
const unit = resolveDistanceUnit(undefined);
/** Said in the (i)'s card: true of every file, so said once and quietly. "Upload" is the word
 *  people look for on a button that takes a file; this is what actually happens to it. The
 *  line under the bar is Mahonia's, where the name stays in sight. */
const PRIVACY = "Your route is read on this device and never uploaded.";

const inputRef = useTemplateRef<HTMLInputElement>("inputRef");

// The route button's popover (the map, at the dock's leading end): the route's name and
// numbers, and the way to a different one. Closed by a tap outside it or Escape, as the
// app's menus are.
const infoOpen = ref(false);
const infoRef = useTemplateRef<HTMLElement>("infoRef");
useMenuDismiss(infoOpen, infoRef);
// and the top bar's (i): what the page is, for someone who arrived from a search
const aboutOpen = ref(false);
const aboutRef = useTemplateRef<HTMLElement>("aboutRef");
useMenuDismiss(aboutOpen, aboutRef);
function changeRoute() {
  infoOpen.value = false;
  pickFile();
}
const stageRef = useTemplateRef<InstanceType<typeof RouteSpin>>("stageRef");

// THE EXAMPLE. A first visit sees the tool working before it has a file to give it, so the
// page opens on the Timberline Trail (app/data/spinExample.ts) until a route of the visitor's
// own takes its place. It isn't labelled as an example: the bar under it offers one thing,
// Upload a route, until there is one, which says enough. Built on mount, not on the server: the stage
// is a canvas, and a prerendered page has nothing to draw it with.
onMounted(() => (example.value = spinModel(spinExampleTrack())));

// The reader (shared/gpx.ts and its formats) arrives with the first file, as it does in the
// editor: the page opens on the example, which needs none of it. It's asked for as soon as a
// file is on its way (the picker opening, a file dragged over the page), so it has usually
// arrived by the time one is chosen.
let reader: Promise<typeof import("~~/shared/gpx")> | null = null;
function loadReader() {
  reader ??= import("~~/shared/gpx").catch((e) => {
    reader = null; // a failed fetch is tried again with the next file
    throw e;
  });
  return reader;
}
function pickFile() {
  void loadReader().catch(() => {});
  inputRef.value?.click();
}

let reads = 0;
async function open(file: File) {
  const mine = ++reads;
  error.value = "";
  busy.value = true;
  try {
    const { readRouteFile } = await loadReader();
    const read = await readRouteFile(file);
    if (mine !== reads) return;
    if (read === "too-big") {
      error.value = ROUTE_FILE_TOO_BIG;
      return;
    }
    const model = spinModel(read.points);
    if (!model) throw new Error("no line");
    spun.value = {
      model,
      name: read.name || file.name.replace(/\.[^.]+$/, ""),
      distanceM: read.stats.distanceM,
      ascentM: read.stats.ascentM,
    };
  } catch {
    if (mine === reads) error.value = ROUTE_FILE_UNREADABLE;
  } finally {
    if (mine === reads) busy.value = false;
  }
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // so choosing the same file twice still fires a change
  if (file) open(file);
}

// A file dropped ANYWHERE on the page opens like a picked one: the page is one tool, and
// a drop that missed a target would otherwise be the browser opening the GPX as text in
// place of the page. Only a drag that carries files lights the stage.
const dropping = ref(false);
const carriesFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
function onDragOver(e: DragEvent) {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  if (!dropping.value) void loadReader().catch(() => {});
  dropping.value = true;
}
function onDragLeave(e: DragEvent) {
  // leaving the window, not crossing from one element to the next
  if (!e.relatedTarget) dropping.value = false;
}
function onDrop(e: DragEvent) {
  if (!carriesFiles(e)) return;
  e.preventDefault();
  dropping.value = false;
  const file = e.dataTransfer?.files?.[0];
  if (file) open(file);
}
useWindowEvent("dragover", onDragOver);
useWindowEvent("dragleave", onDragLeave);
useWindowEvent("drop", onDrop);

// ---- The video's shape and length (remembered), and its colours (not) ----
// Shape and length are each one menu (OptionMenu, the app's own picker): the dock shows the
// choice made (the shape as its glyph alone, the word is in the list and the spoken name),
// and the list of the rest opens on a press. Both are choices about the saved
// file only: the stage stays full screen whatever shape the video will be. The shapes are
// drawn as their own frames, in the trigger and in the list.
const FORMATS = [
  { key: "vertical", label: "Vertical", icon: FrameVerticalGlyph },
  { key: "wide", label: "Wide", icon: FrameWideGlyph },
  { key: "square", label: "Square", icon: FrameSquareGlyph },
];
const LENGTHS = VIDEO_TURN_CHOICES.map((t) => ({ key: String(t), label: `${videoSeconds(t)} seconds` }));
const FORMAT_KEY = "gear.spin.format.v1";
const TURNS_KEY = "gear.spin.turns.v1";
// Vertical first: most of these are made to post from a phone, where it fills the screen. Once
// picked, a shape is remembered (below), so the default only decides a first save.
const format = ref<SpinFormat>("vertical");
const formatLabel = computed(() => FORMATS.find((f) => f.key === format.value)?.label ?? "");
const turns = ref<VideoTurns>(1);
const ink = ref("#ffffff");
const ground = ref("#000000");
onMounted(() => {
  const f = recall(FORMAT_KEY);
  if (isSpinFormat(f)) format.value = f;
  turns.value = recallJson(TURNS_KEY, isVideoTurns, turns.value);
});
function pickFormat(key: string) {
  if (isSpinFormat(key)) format.value = key;
}
function pickLength(key: string) {
  const t = Number(key);
  if (isVideoTurns(t)) turns.value = t;
}
// The video's shape and length are remembered, whichever control set them: they're how you
// export, and a second visit means the same again. The colours are not: they're one route's
// look, and a page that opened in last week's colours read as broken. (Their inputs say
// autocomplete="off" too, so a browser restoring a reloaded form can't put one back.)
watch(format, (v) => remember(FORMAT_KEY, v));
watch(turns, (v) => remember(TURNS_KEY, String(v)));

// THE WHOLE PAGE IS THE GROUND. The picked background runs edge to edge, the stage draws
// the same colour and so has no edge of its own, and the line floats on the page itself.
// The page's own words take whichever colour scheme reads on that ground: every token is a
// light-dark() pair, so one color-scheme on the body turns the bar, the buttons and the
// line under it dark-on-light or light-on-dark together. Light when black text outcontrasts
// white on it, which by WCAG's luminance is above about 0.18.
const scheme = computed(() => (luminance(rgbOf(ground.value)) > 0.179 ? "light" : "dark"));

// THE QUIETER INKS, worked out for the picked background (shared/contrast.ts). The theme's
// secondary and tertiary greys are fixed shares of ink over pure black or white; over a
// mid-tone (an orange, a teal) the same shares fall below what reads. So each starts at the
// theme's share and takes more ink until it clears WCAG: secondary sets the muted words, 4.5:1
// against the background; tertiary the menus' chevrons, 3:1 against the bar's wash (below).
// Over black and white the theme's own shares already clear, and nothing changes.
//
// THE BAR, too. It is a wash of the ink over the background, 8% in the theme, which shows on
// black and white and all but vanishes over a saturated mid-tone: a pure red or blue under
// white ink moved the bar 1.04:1 off its ground, and white over a pale yellow less. So the
// wash strengthens until the bar stands off the ground at least as far as the theme's own
// does on black (1.14:1); the most any colour needs is about 20%. The chevrons are measured
// against that wash, and the bar's hover keeps the theme's step above it. Mixed in sRGB, the
// space the arithmetic above uses, so what's drawn is what was measured.
const SECONDARY_SHARE = 0.65; // #a8a8a8 on black, #595959 on white
const TERTIARY_SHARE = 0.53; // #878787 on black, #767676 on white
const WASH_SHARE = 0.08; // --background-hover-opacity
const WASH_FOCUS_STEP = 0.02; // --background-field-focus, 10% to the field's 8%
const WASH_CONTRAST = 1.14; // the theme's 8% wash over black
const inks = computed(() => {
  const back = rgbOf(ground.value);
  const ink: Rgb = scheme.value === "light" ? [0, 0, 0] : [255, 255, 255];
  const washShare = readableShare(back, ink, WASH_SHARE, back, WASH_CONTRAST);
  const wash = mix(back, ink, washShare);
  const css = (share: number) => `rgb(${mix(back, ink, share).map(Math.round).join(" ")})`;
  const washCss = (share: number) => `color-mix(in srgb, var(--foreground-primary) ${Math.round(share * 100)}%, transparent)`;
  return {
    "--foreground-secondary": css(readableShare(back, ink, SECONDARY_SHARE, back, 4.5)),
    "--foreground-tertiary": css(readableShare(back, ink, TERTIARY_SHARE, wash, 3)),
    "--background-field": washCss(washShare),
    "--background-field-focus": washCss(washShare + WASH_FOCUS_STEP),
  };
});
// `bare` drops the site footer (layouts/default.vue): this page is one screen, the tool and
// nothing under it, and it doesn't scroll.
// What it does, in the words people search with: the title is the page's whole name. The tab
// and a shared link's preview both carry the site's after it, as every page's tab does: a
// preview in Messages shows only this title and the domain.
const PAGE_TITLE = "Turn a GPX into a spinning 3D video";
const TITLE = `${PAGE_TITLE} — Mahonia`;
const PAGE_DESCRIPTION =
  "Turn a GPX, KML, TCX or FIT file into a spinning 3D line, and save it as a video: vertical, wide or square. Free, no account, and the file never leaves your browser.";
// The preview a pasted link unfurls into: the page's own title and description over the site's,
// and its own card, the first frame of the example (scripts/spinCard.ts, `npm run og:spin`).
const previewImage = `${useSiteOrigin()}/og-trail-spin.png`;
useSeoMeta({
  description: PAGE_DESCRIPTION,
  ogTitle: TITLE,
  ogDescription: PAGE_DESCRIPTION,
  ogImage: previewImage,
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageType: "image/png",
  ogImageAlt: "A hiking route drawn as one white line on black, turned in 3D.",
  twitterImage: previewImage,
});
useHead({
  title: TITLE,
  // The ground's scheme goes on the body, where the theme's tokens resolve, in WebKit as in
  // Chrome (checked in the iOS Simulator). A dark-mode extension can still repaint the page;
  // none of the opt-outs tried stopped the one on Ryan's phone (2026-11-28), so the page
  // carries none, and an extension's own per-site setting is the way out.
  bodyAttrs: {
    class: "bare",
    // Held still: one screen with nothing to scroll to. The rubber band is already off
    // (overscroll-behavior-y, reset.scss), and only on y: the shorthand's x half would turn
    // off a Mac's two-finger swipe back.
    style: computed(() => `background: ${ground.value}; color-scheme: ${scheme.value}; overflow: hidden`),
  },
});

const facts = computed(() => {
  const s = spun.value;
  if (!s) return "";
  const parts = [formatDistance(s.distanceM, unit)];
  if (s.model.exaggeration) parts.push(`${heightWithUnit(s.ascentM, unit)} of climb`);
  return parts.join(" · ");
});

// ---- Save video ----
const recording = ref<number | null>(null);
// read on the client only: the prerendered page has no encoder to ask
const canRecord = ref(false);
onMounted(() => (canRecord.value = canSaveVideo()));
async function save() {
  const stage = stageRef.value;
  const s = spun.value;
  if (!stage || !s || recording.value !== null) return;
  recording.value = 0;
  error.value = "";
  try {
    const blob = await stage.record(format.value, turns.value, (share) => (recording.value = share));
    const ext = blob.type === "video/mp4" ? "mp4" : "webm";
    downloadBlob(`${listFileBase(s.name, "route")}-spin-${format.value}.${ext}`, blob);
  } catch (e) {
    console.error("Save video failed:", e);
    error.value = "This browser couldn’t record the video.";
  } finally {
    recording.value = null;
  }
}
/** Save's name, for its tooltip and a screen reader alike: the count while it saves. */
const saveLabel = computed(() =>
  recording.value === null ? "Save video" : `Saving video, ${Math.floor(recording.value * 100)}%`,
);
</script>

<template>
  <!-- ONE SCREEN, top to bottom: the (i); the stage, taking every pixel left over; and the
       dock, everything about the video you're making, with whose tool it is under it. No
       footer: the page is marked bare (see useHead above). -->
  <div class="spin-screen" :style="inks">
    <!-- Only what the page is, in the corner: no mark, no section name, no account. The page
         is one tool, and its way home is the name in the line under the dock. -->
    <header class="wrap spin-screen__top">
      <div ref="aboutRef" class="menu spin-screen__about">
        <button
          type="button"
          class="btn btn--icon btn--ghost spin-round"
          aria-label="About this page"
          aria-haspopup="dialog"
          :aria-expanded="aboutOpen"
          @click="aboutOpen = !aboutOpen"
        >
          <SvgIcon :icon="IconCircleInfo" />
        </button>
        <Transition name="menu">
          <MenuList v-if="aboutOpen" tag="div" role="dialog" aria-label="About this page" class="spin-info">
            <p>Turn a hike into a spinning 3D video.</p>
            <p class="t-muted">{{ PRIVACY }}</p>
          </MenuList>
        </Transition>
      </div>
    </header>
    <main id="main-content" tabindex="-1" class="spin-screen__main">
      <h1 class="visually-hidden">{{ PAGE_TITLE }}</h1>

      <input
        ref="inputRef"
        type="file"
        :accept="ROUTE_FILE_ACCEPT"
        class="visually-hidden"
        tabindex="-1"
        aria-hidden="true"
        @change="onPick"
      />
      <p v-if="error" class="wrap spin-screen__error" role="alert">{{ error }}</p>

      <div class="spin-screen__stage" :class="{ 'spin-screen__stage--dropping': dropping }">
        <RouteSpin
          v-if="shown"
          ref="stageRef"
          :model="shown"
          :label="spun ? `${spun.name}, turning in 3D` : 'An example route, turning in 3D'"
          :ink="ink"
          :ground="ground"
        />
        <p v-if="dropping" class="t-label spin-screen__drop">Drop to use this route</p>
      </div>

      <div class="wrap spin-screen__dockrow">
        <!-- ONE CHOICE until there's a route of your own: the example turns behind it, unnamed,
             and everything about the video waits until there's a video of yours to make. The
             bar IS that choice, the same size and plate as the dock it becomes, its words on
             the plate: one container, not a button inside one. -->
        <button v-if="!spun" class="spin-dock spin-dock--upload" type="button" :disabled="busy" @click="pickFile">
          {{ busy ? "Reading…" : "Upload a route" }}
        </button>
        <div v-else class="spin-dock" role="group" aria-label="Video">
          <!-- the map at the leading end opens your route's details -->
          <div ref="infoRef" class="menu">
            <button
              type="button"
              class="btn btn--icon btn--ghost spin-round"
              aria-label="Route info"
              aria-haspopup="dialog"
              :aria-expanded="infoOpen"
              @click="infoOpen = !infoOpen"
            >
              <!-- the map, as the Trip tab marks a route: the (i) is the page's, up top -->
              <SvgIcon :icon="IconMap" />
            </button>
            <!-- the app's popover (MenuList, drawn as a card): a dialog, since it holds
                 the route's details rather than a list of choices -->
            <Transition name="menu">
              <MenuList v-if="infoOpen" tag="div" side="start" role="dialog" aria-label="Route" class="spin-info">
                <p class="t-label">{{ spun?.name }}</p>
                <p class="t-muted">{{ facts }}</p>
                <button class="btn btn--soft spin-info__change" type="button" :disabled="busy" @click="changeRoute">
                  {{ busy ? "Reading…" : "Change route…" }}
                </button>
              </MenuList>
            </Transition>
          </div>
          <OptionMenu
            :options="FORMATS"
            :current="format"
            label="Video shape"
            :trigger-label="`Video shape: ${formatLabel}`"
            trigger-class="spin-menu"
            @pick="pickFormat"
          >
            <template #trigger="{ active, open }">
              <SvgIcon v-if="active?.icon" :icon="active.icon" aria-hidden="true" />
              <SvgIcon :icon="IconChevronDownMedium" class="chev" :class="{ 'is-open': open }" size="sm" aria-hidden="true" />
            </template>
          </OptionMenu>
          <OptionMenu
            :options="LENGTHS"
            :current="String(turns)"
            label="Video length"
            :trigger-label="`Video length: ${videoSeconds(turns)} seconds`"
            trigger-class="spin-menu"
            @pick="pickLength"
          >
            <template #trigger="{ open }">
              <span class="t-num">{{ videoSeconds(turns) }} s</span>
              <SvgIcon :icon="IconChevronDownMedium" class="chev" :class="{ 'is-open': open }" size="sm" aria-hidden="true" />
            </template>
          </OptionMenu>
          <span class="spin-dock__rule" aria-hidden="true" />
          <span class="spin-dock__colors">
            <!-- The dot is ours and the picker is the system's: the native input lies over the
                 whole chip, transparent, so a press anywhere on it opens the panel. -->
            <Tooltip text="Line color">
              <label class="spin-swatch">
                <span class="spin-swatch__dot" :style="{ background: ink }" aria-hidden="true" />
                <input v-model="ink" type="color" autocomplete="off" class="spin-swatch__input" aria-label="Line color" />
              </label>
            </Tooltip>
            <Tooltip text="Background color">
              <label class="spin-swatch">
                <span class="spin-swatch__dot" :style="{ background: ground }" aria-hidden="true" />
                <input v-model="ground" type="color" autocomplete="off" class="spin-swatch__input" aria-label="Background color" />
              </label>
            </Tooltip>
          </span>
          <!-- The one action, on a plate of its own so it reads as one (and needs no rule before
               it): the app's soft button, a tint of the ink rather than a solid disc, which was
               harsh beside the bar's quiet controls (Ryan, 2026-11-28). Round, so the plate
               stays one height. While it saves, a ring fills round where the glyph was: the
               button never changes width, and the count is in its name for a screen reader. -->
          <Tooltip :text="saveLabel">
            <button
              class="btn btn--soft spin-dock__save"
              type="button"
              :aria-label="saveLabel"
              :disabled="!canRecord || recording !== null"
              @click="save"
            >
              <SvgIcon v-if="recording === null" :icon="SaveGlyph" />
              <svg v-else class="spin-dock__ring" viewBox="0 0 24 24" aria-hidden="true">
                <circle class="spin-dock__ring-track" cx="12" cy="12" r="9" />
                <circle
                  class="spin-dock__ring-fill"
                  cx="12"
                  cy="12"
                  r="9"
                  pathLength="100"
                  :style="{ strokeDashoffset: 100 - Math.max(1, recording * 100), transitionDuration: `${SAVE_PROGRESS_MS}ms` }"
                />
              </svg>
            </button>
          </Tooltip>
        </div>
        <p class="t-muted spin-screen__note">
          A free tool from <NuxtLink to="/" class="prose-link">Mahonia</NuxtLink>, a packing list app for hikers.
        </p>
      </div>
    </main>
  </div>
</template>

<style scoped>
/* EXACTLY a screen, and nothing scrolls: the stage takes whatever the top bar and the dock
   leave, down to nothing on a short screen, rather than pushing the page past the window.
   The body is held still too (useHead above), as the editor holds its page.
   The dock's control size lives here, not on the dock: the top bar's (i) is one too. */
.spin-screen {
  --dock-control: var(--field-h);
  --dock-pad: var(--space-2);
  display: flex;
  flex-direction: column;
  height: 100svh;
  overflow: hidden;
}
/* the (i), at the trailing edge */
.spin-screen__top {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  /* the window's full width, not the page column's: the (i) belongs in the corner at every
     size. .wrap still gives it the gutter, safe-area insets and all. */
  max-width: none;
  padding-block: var(--space-2);
}
/* The button pulled out by its own inset round its glyph, so the glyph (not the button) sits
   on the page's gutter: as far from the right edge as the bar's padding and that same inset
   put it from the top. The menu wrapper stays on the gutter, so its card's edge lines up
   with the glyph's. */
.spin-screen__about > .spin-round {
  margin-inline-end: calc((var(--icon) - var(--dock-control)) / 2);
}
.spin-screen__main {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.spin-screen__error {
  padding-top: var(--space-2);
  color: var(--danger);
}

/* The room the trail is sized to, between the top bar and the dock: RouteSpin fills it and
   sets the turn on the screen's middle. Positioned: the stage and the drop prompt fill it
   absolutely, which needs no definite height from a flex item. */
.spin-screen__stage {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  outline: 2px dashed transparent;
  outline-offset: calc(var(--space-3) * -1);
  transition: outline-color var(--spring-fade-dur) var(--spring-fade);
}
.spin-screen__stage--dropping {
  outline-color: var(--border-strong);
}
.spin-screen__drop {
  position: absolute;
  inset: auto 0 var(--space-5);
  padding: var(--space-4);
  text-align: center;
  pointer-events: none;
}

/* THE DOCK (and the line under it): the video, in one plate. The route's map at the leading
   end, its shape and length (each a menu showing the choice made), its colors, and Save.
   Sized and rounded like the portfolio's nav island (ExpandableTabs there): 36px controls
   (--field-h, set on .spin-screen as --dock-control) on 8px of padding, a 52px bar, 4px
   between controls, every control a pill and the plate's corner its padding plus theirs
   (18 + 8 = 26), so the curves run parallel. Narrow enough for the smallest phone on one
   row. */
.spin-screen__dockrow {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  padding-block: var(--space-3) var(--space-4);
}
/* whose tool this is, said once and quietly under the bar, the name a link home */
.spin-screen__note {
  font-size: var(--text-chrome);
  text-align: center;
  /* two even lines on a phone, not a long one and a stranded "for hikers." */
  text-wrap: balance;
}
/* the name in the sentence's own colour, its underline saying it's a link: in the page's
   full ink it read as a word of another colour (Ryan, 2026-11-28) */
.spin-screen__note .prose-link {
  color: inherit;
}
.spin-dock {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  max-width: 100%;
  padding: var(--dock-pad);
  border-radius: calc(var(--dock-control) / 2 + var(--dock-pad));
  /* a wash of the page's ink over the picked background; the inks inside it are worked
     out against that wash (see `inks` in the script) */
  background: var(--background-field);
}
/* The menus' triggers. OptionMenu's button is its own element, so these reach it through
   :deep(); the glyph, word and chevron inside are this page's slot content. A tab's size,
   corner and hover, in the foreground colour (a trigger shows a value, not an unchosen
   option), and the selected plate while its menu is open. */
.spin-dock :deep(.spin-menu) {
  gap: var(--space-1);
  height: var(--dock-control);
  padding-inline: var(--space-3) var(--space-2);
  border-radius: var(--radius-pill);
  font-size: var(--text-chrome);
  color: var(--foreground-primary);
  white-space: nowrap;
}
.spin-dock :deep(.spin-menu[aria-expanded="true"]) {
  background: var(--background-selected);
}
.spin-dock__rule {
  flex: none;
  align-self: stretch;
  width: 1px;
  margin: var(--space-2) var(--space-half);
  background: var(--border-primary);
}
.spin-dock__colors {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-1);
}
/* The two popovers (the route's, and the page's (i)): cards of type, so the menu card's row
   padding makes way for their own, as deep as the card's corner (--radius-4) so the text sits
   evenly inside the curve. As wide as the text: one line each on a laptop, and no wider than
   the screen less its gutters on a phone, where MenuList pulls the card in to its longest
   wrapped line. */
.spin-info {
  display: grid;
  gap: var(--space-1);
  width: max-content;
  max-width: min(28rem, calc(100vw - 2 * var(--space-4)));
  padding: var(--radius-4);
}
/* Balanced, not the paragraphs' usual `pretty`: lines of even length are what a card this
   size wants, and balance holds still when MenuList pulls the card in to its longest line,
   where `pretty` re-broke the lines shorter each time and left the card padded on one side
   in WebKit, then taller than it needed to be. */
.spin-info p {
  text-wrap: balance;
}
.spin-info__change {
  justify-self: start;
  margin-top: var(--space-2);
  min-height: var(--control-compact);
  padding-inline: var(--space-3);
}
/* The round buttons: the page's (i), the route's map, and Save. Each the dock's control size;
   .btn makes them pills. */
.spin-round,
.spin-dock__save {
  flex: none;
  inline-size: var(--dock-control);
  min-height: var(--dock-control);
}
/* Every glyph on the page in the one ink, the menus' glyphs and words included; only the
   chevrons step down a tone (--foreground-tertiary, worked out for the ground). A ghost
   button's own quieter ink made the map and the (i) a third colour beside them (Ryan,
   2026-11-28: "All icons should be same colour. Chevrons just a lighter tone of it"). */
.spin-round {
  color: var(--foreground-primary);
}
/* Under a pointer, the dock's controls all take the same soft plate: the menu triggers, the
   round buttons (a ghost button's own hover only brightens its glyph) and the color chips. */
@media (hover: hover) and (pointer: fine) {
  .spin-dock :deep(.spin-menu:hover),
  .spin-round:hover,
  .spin-swatch:hover {
    background: var(--background-hover-subtle);
  }
}
.spin-dock :deep(.spin-menu),
.spin-swatch {
  transition: background-color var(--spring-fade-dur) var(--spring-fade);
}
/* The start state: the bar as one button. The dock's height and corner (its control plus its
   padding), its wash, and the label in the page's own ink; a step brighter under a pointer. */
.spin-dock--upload {
  justify-content: center;
  height: calc(var(--dock-control) + 2 * var(--dock-pad));
  padding-inline: var(--space-5);
  font-size: var(--text-base);
  font-weight: var(--font-weight-semibold);
  color: var(--foreground-primary);
  transition: background-color var(--spring-fade-dur) var(--spring-fade);
}
@media (hover: hover) and (pointer: fine) {
  .spin-dock--upload:hover {
    background: var(--background-field-focus);
  }
}
.spin-dock--upload:disabled {
  cursor: default;
  opacity: var(--opacity-disabled);
}
/* a step of its own after the colors, more than the 4px between the dock's controls: it is
   the action, and the chips beside it are settings */
.spin-dock__save {
  padding: 0;
  margin-inline-start: var(--space-2);
}
/* the button stays enabled-looking while it saves: the ring is the state, not a grey-out */
.spin-dock__save:disabled:has(.spin-dock__ring) {
  opacity: 1;
}
.spin-dock__ring {
  inline-size: var(--icon);
  block-size: var(--icon);
  rotate: -90deg;
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
}
.spin-dock__ring-track {
  opacity: 0.25;
}
/* The fill glides from one report to the next: a linear move over the save's own report beat
   (SAVE_PROGRESS_MS, app/utils/spinVideo.ts, set inline so the two can't drift) is one
   continuous sweep at the encoder's pace rather than a step every report. Drawn as an offset
   into one dash the circle's length, which animates where a changing dash length doesn't
   everywhere. */
.spin-dock__ring-fill {
  stroke-linecap: round;
  stroke-dasharray: 100;
  transition-property: stroke-dashoffset;
  transition-timing-function: linear;
}

/* A color chip: a round control the dock's size, with a menu trigger's hover and a dot in
   it. */
.spin-swatch {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  inline-size: var(--dock-control);
  block-size: var(--dock-control);
  border-radius: var(--radius-pill);
  cursor: pointer;
}
.spin-swatch:has(.spin-swatch__input:focus-visible) {
  outline: var(--focus-ring) solid var(--foreground-primary);
  outline-offset: var(--focus-offset-inset);
}
.spin-swatch__dot {
  inline-size: var(--icon);
  block-size: var(--icon);
  border-radius: var(--radius-round);
  /* a light ring of the page's ink: enough that a dot the page's own color still shows as a
     dot, not so much that it outlines every swatch in the quieter ink */
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--foreground-primary) 30%, transparent);
}
.spin-swatch__input {
  position: absolute;
  inset: 0;
  inline-size: 100%;
  block-size: 100%;
  padding: 0;
  border: 0;
  opacity: 0;
  cursor: pointer;
}
/* A short screen (a phone on its side): the stage would be only what's left between the
   top bar and the dock. So the bar floats over the foot of the stage instead of taking its own
   rows, and the trail is sized to the whole screen below the top bar; where it runs under
   the dock, the dock covers it. The line under the bar stays, as it does at every size. */
@media (max-height: 30rem) {
  .spin-screen {
    position: relative;
  }
  .spin-screen__top {
    padding-block: 0;
  }
  .spin-screen__dockrow {
    position: absolute;
    inset: auto 0 0;
    gap: var(--space-2);
    padding-block: var(--space-1) var(--space-2);
  }
}
</style>
