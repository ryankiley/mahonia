<script setup lang="ts">
// The stage /trail-spin draws on: the route turning on a canvas, and turned by hand when
// dragged. What it looks like is shared/routeSpin.ts; this is the loop, the size and the
// drag, and the hand-off to the page's Save video.
//
// Not a .client component, though it only ever runs in the browser: /trail-spin renders it only
// once it has a route, which is never on the server. The .client wrapper ran this file's
// onMounted before its canvas existed when the stage appeared mid-hydration (the example
// route does), and ResizeObserver threw on the missing element.
//
// The stage fills the ROOM the page gives it (the page's stage, between its bars) and turns
// the route about the middle of the SCREEN, which that room needn't be centred on: as big a
// turn as fits round the screen's middle without reaching the room's nearer edge, so it is
// centred on the screen and still clear of the bars above and below it. It draws in the colours the video will have, with the same function. The
// video's SHAPE is not shown here: vertical, wide or square is a choice about the file Save
// makes, and the preview is the route, not a mock-up of a frame. Its TIME is: the stage plays
// the video's length over and over, so a line that draws itself on draws again each time
// round, as the saved file will when a player repeats it.
import {
  DRAW_ON_MS,
  drawnAt,
  drawSpin,
  SPIN_START_ANGLE,
  spinAngle,
  videoSeconds,
  type SpinFormat,
  type SpinModel,
  type SpinReveal,
  type VideoTurns,
} from "~~/shared/routeSpin";

const props = defineProps<{
  model: SpinModel;
  label: string;
  /** the line's colour and the ground's, as CSS colours */
  ink: string;
  ground: string;
  /** the video's: how the line appears, and how many turns long it is */
  reveal: SpinReveal;
  turns: VideoTurns;
  /** play the video's start once and go on turning, rather than the video over and over: a
   *  line that draws on draws once, then stays whole (the page's example) */
  once?: boolean;
}>();

/** A drag the stage's full width turns it half way round, the near side following the
 *  finger: a drag to the right turns it back against its own clockwise spin
 *  (projectSpin), whose near side travels left. */
const DRAG_TURN = Math.PI;
/** The line's floor on screen, in CSS pixels: the line is weighed against the stage's short
 *  side, as the video's is against its frame, and a phone's short side is a third of a
 *  1080p frame, where that weight is a hairline. */
const MIN_LINE_PX = 1.5;
/** Pixel density the stage draws at, at most: a 3x phone fills more than twice the pixels of
 *  a 2x one each frame for a thin line nobody can tell apart. */
const MAX_RATIO = 2;
/** How much of the screen's width the whole turn may take: its widest moment, a radius
 *  either side of the middle, still clear of the edges. */
const FIT_ACROSS = 0.9;
/** …and of the clear room's height: a little short of all of it, so the turn's tallest
 *  moment doesn't touch the bars. */
const FIT_DOWN = 0.95;

const roomRef = useTemplateRef<HTMLDivElement>("roomRef");
const canvasRef = useTemplateRef<HTMLCanvasElement>("canvasRef");
let angle = SPIN_START_ANGLE;
/** how far into the video the stage is, in ms: it starts again from 0 each time round, or
 *  stops counting once there's nothing more to draw (once) */
let clock = 0;
const loopMs = () => videoSeconds(props.turns) * 1000;
let raf = 0;
let last = 0;
let drag: { x: number; angle: number } | null = null;
let scratch: Float64Array | undefined;
let reduce: MediaQueryList | null = null;
/** while Save makes its video: the stage holds still and leaves the frames to the encoder */
let saving = false;
let saveAbort: AbortController | null = null;
/** opaque: every pixel is painted each frame, and an opaque layer is cheaper to composite */
let ctx: CanvasRenderingContext2D | null = null;
/** where the screen's middle falls in the room, and the box the turn fits round it, in CSS
 *  pixels: measured when the room changes size, not each frame */
let place = { middleY: 0, width: 0, height: 0 };

function measure() {
  const room = roomRef.value?.getBoundingClientRect();
  if (!room) return;
  const middleY = window.innerHeight / 2 - room.top;
  const clear = 2 * Math.max(0, Math.min(middleY, room.height - middleY));
  place = { middleY, width: room.width * FIT_ACROSS, height: clear * FIT_DOWN };
}

function paint() {
  const canvas = canvasRef.value;
  if (!canvas || !ctx) return;
  const ratio = Math.min(window.devicePixelRatio || 1, MAX_RATIO);
  const w = Math.round(canvas.clientWidth * ratio);
  const h = Math.round(canvas.clientHeight * ratio);
  if (!w || !h) return;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const frame = {
    width: w,
    height: h,
    ink: props.ink,
    ground: props.ground,
    minLine: MIN_LINE_PX * ratio,
    fit: { width: place.width * ratio, height: place.height * ratio },
    middleY: place.middleY * ratio,
    // a stage held still for reduced motion shows the line whole: there's no next frame to
    // draw any more of it in
    drawn: reduce?.matches ? 1 : drawnAt(props.reveal, clock),
  };
  scratch = drawSpin(ctx, props.model, angle, frame, scratch);
}

function tick(now: number) {
  raf = 0;
  if (last) {
    angle += spinAngle(now - last);
    clock = props.once ? Math.min(clock + now - last, DRAW_ON_MS) : (clock + now - last) % loopMs();
  }
  last = now;
  paint();
  schedule();
}
/** Spinning only while nobody has hold of it, nothing is being saved, and motion is welcome
 *  (a hidden tab gets no frames anyway). Otherwise it holds still and repaints when something
 *  changes. */
function schedule() {
  if (raf || drag || saving || reduce?.matches) return;
  raf = requestAnimationFrame(tick);
}
function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
  last = 0;
}

function onDown(e: PointerEvent) {
  if (e.button !== 0) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  drag = { x: e.clientX, angle };
  stop();
}
function onMove(e: PointerEvent) {
  const canvas = canvasRef.value;
  if (!drag || !canvas) return;
  angle = drag.angle - ((e.clientX - drag.x) / canvas.clientWidth) * DRAG_TURN;
  paint();
}
function onUp() {
  if (!drag) return;
  drag = null;
  schedule();
}

let resize: ResizeObserver | null = null;
const onMotionPref = () => {
  stop();
  paint();
  schedule();
};
onMounted(() => {
  ctx = canvasRef.value!.getContext("2d", { alpha: false });
  reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  reduce.addEventListener("change", onMotionPref);
  resize = new ResizeObserver(() => {
    measure();
    paint();
  });
  resize.observe(roomRef.value!);
  measure();
  paint();
  schedule();
});
onBeforeUnmount(() => {
  stop();
  saveAbort?.abort();
  resize?.disconnect();
  reduce?.removeEventListener("change", onMotionPref);
});
// a new route starts from the same place every route does, and a new way of appearing starts
// from the top, so it's seen from its first frame
watch(
  () => props.model,
  () => {
    angle = SPIN_START_ANGLE;
    clock = 0;
    paint();
  },
);
watch(
  () => props.reveal,
  () => {
    clock = 0;
    paint();
  },
);
watch(
  () => props.turns,
  () => (clock %= loopMs()),
);
// a still stage (reduced motion, held, saving) has no next frame to show a new colour in;
// a spinning one does, and a second paint per picker step would only repeat it
watch(
  () => [props.ink, props.ground],
  () => {
    if (!raf) paint();
  },
  { flush: "post" },
);

// ---- Save video ----
// The video is the stage's, in its colours, in the shape the dock chose; how it's made is
// app/utils/spinVideo.ts. A line that appears whole starts where the stage is, at the angle
// you were looking from. One that draws on starts where the stage's time round began, so the
// file is the loop you were watching, from its first frame. The stage holds still while it
// saves, and leaving the page calls the save off.
async function record(format: SpinFormat, onProgress: (share: number) => void): Promise<Blob> {
  saving = true;
  stop();
  saveAbort = new AbortController();
  try {
    return await saveSpinVideo({
      model: props.model,
      format,
      from: props.reveal === "draw" ? angle - spinAngle(clock) : angle,
      turns: props.turns,
      reveal: props.reveal,
      ink: props.ink,
      ground: props.ground,
      onProgress,
      signal: saveAbort.signal,
    });
  } finally {
    saving = false;
    saveAbort = null;
    schedule();
  }
}

defineExpose({ record });
</script>

<template>
  <div
    ref="roomRef"
    class="spin"
    role="img"
    :aria-label="label"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
  >
    <canvas ref="canvasRef" class="spin__canvas" />
  </div>
</template>

<style scoped>
/* The room: fills its positioned parent, whatever shape that is, and takes the drag. Every
   touch on it is the drag's: /trail-spin doesn't scroll, so there is no vertical pan for the
   browser to keep. */
.spin {
  position: absolute;
  inset: 0;
  cursor: grab;
  touch-action: none;
}
.spin__canvas {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
}
.spin:active {
  cursor: grabbing;
}
</style>
