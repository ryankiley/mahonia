// A route as a line in three dimensions, turning about its own middle: /trail-spin.
//
// The look is one line on a plain ground, white on black unless picked otherwise. Height is
// the elevation, drawn taller than life so a day's climb reads at a glance. The camera sits
// just above the horizon (4°), so the line's highs and lows stay at almost the same height
// on screen while it turns, and its shape on the map is what comes and goes. One turn every
// ten seconds. Orthographic: nothing grows as it nears you, and the turn alone carries the
// depth. The line is there whole from the first frame, or draws itself on from the trail's
// start to its end while it turns (drawnAt).
//
// Arithmetic over track points, and one function that draws it on a canvas. The stage
// (app/components/RouteSpin.vue) owns the loop and the size, the page the colours.
import { M_PER_DEG, segmentAt } from "./polyline";
import type { TrackPoint } from "./gpx";
import { filledElevations } from "./profile";

/** One full turn, in milliseconds. */
export const SPIN_PERIOD_MS = 10_000;
/** The lengths a saved video comes in, as whole turns: 10, 20 or 30 seconds. Whole turns
 *  because each ends where it began, so the file loops cleanly on a player that repeats it,
 *  and at the stage's own speed, so the preview is the video. */
export const VIDEO_TURN_CHOICES = [1, 2, 3] as const;
export type VideoTurns = (typeof VIDEO_TURN_CHOICES)[number];
export const isVideoTurns = (v: unknown): v is VideoTurns => VIDEO_TURN_CHOICES.includes(v as VideoTurns);
/** How the line appears: drawn on from the trail's start while it turns, or whole from the
 *  first frame. */
const SPIN_REVEALS = ["draw", "whole"] as const;
export type SpinReveal = (typeof SPIN_REVEALS)[number];
export const isSpinReveal = (v: unknown): v is SpinReveal => SPIN_REVEALS.includes(v as SpinReveal);
/** How long the line takes to draw itself on: the same in a video of any length, so the
 *  length is only how long it then goes on turning whole. Six seconds is a little over half
 *  a turn, and leaves a ten-second video four to show the whole route turning. */
export const DRAW_ON_MS = 6000;
/** How far above the horizon the camera sits when there is elevation to look at. */
const PITCH = (4 * Math.PI) / 180;
/** And when there isn't: a flat track seen from 4° is a line, so it is looked down on. */
const FLAT_PITCH = (35 * Math.PI) / 180;
/** The relief, top to bottom, as a share of the route's reach from the middle of its bounds
 *  (the size it was tuned against, kept when the turn moved to a tighter centre)… */
const RELIEF_OF_RADIUS = 1.1;
/** …but never more than this many times its true height. A long, flat route stays flat:
 *  stretched to the same relief as a mountain, its few metres of GPS noise would be peaks. */
const MAX_EXAGGERATION = 12;
/** A point closer than this to the last one kept adds nothing a screen can show (about a
 *  pixel at full size), so it is dropped. A watch's track at one point a second is
 *  thousands of points a mile. */
const THIN_OF_RADIUS = 1 / 800;
/** How much of the frame the line may fill across: less of a wide frame, whose sides are
 *  room to turn in, than of a square or tall one, where the width is all the room there is… */
const FILL_ACROSS_WIDE = 0.6;
const FILL_ACROSS_NARROW = 0.84;
/** …and down. */
const FILL_DOWN = 0.58;
/** The line's weight, as a share of the frame's short side (about 2.5 px at 1080). */
const LINE_OF_SHORT_SIDE = 0.0023;

/** The shapes a video comes in, in pixels: vertical for a phone held upright (a story, a
 *  reel), wide for a screen, square for a feed. */
export const SPIN_FORMATS = {
  vertical: { width: 1080, height: 1920 },
  wide: { width: 1920, height: 1080 },
  square: { width: 1080, height: 1080 },
} as const;
export type SpinFormat = keyof typeof SPIN_FORMATS;
export const isSpinFormat = (v: unknown): v is SpinFormat => typeof v === "string" && v in SPIN_FORMATS;

/** How near the earlier path a point has to be to count as going back over it: across the
 *  ground, and in height. A recorded track's return wanders a few metres off its way out;
 *  the legs of a switchback can sit ten metres apart across the ground, and are told apart
 *  by height, since a climb puts them metres above one another. */
const RETRACE_ACROSS_M = 12;
const RETRACE_UP_M = 10;
/** How long a stretch on earlier ground has to run before it is one: shorter, it is a
 *  crossing, or a switchback's turn, and keeps its line. */
const RETRACE_MIN_M = 200;
/** How far back along the track the path it is compared with starts, so a point is never
 *  "on" the stretch it is part of. */
const RETRACE_LAG_M = 5 * RETRACE_ACROSS_M;
/** A gap this short between two retraced stretches is the same way back wandering a little
 *  wider for a moment (a recorded track strays more than RETRACE_ACROSS_M now and then): it
 *  joins them, rather than standing alone as a stray dash beside the line. */
const RETRACE_BRIDGE_M = 250;
/** A watch records a point every second or so, a metre apart; nothing the model does can
 *  see finer than a few. Thinned to this first, a 100k-point track is a third the work. */
const PRE_THIN_M = 3;

export interface SpinModel {
  /** East, north and up, in units of the route's radius: the smallest circle round it, which
   *  it turns about, is 1 across from its middle. */
  e: Float64Array;
  n: Float64Array;
  u: Float64Array;
  /** How far the line reaches above and below its middle. */
  halfHeight: number;
  /** How many times its true height the relief is drawn at. 0 with no elevation. */
  exaggeration: number;
  /** 1 where the line lifts and starts again: after a stretch that went back over ground
   *  the line has already drawn (see retraces). The first point is always a start. */
  starts: Uint8Array;
  /** How far along the drawn line each point is, as a share of its whole length: 0 at the
   *  first point, 1 at the last. The jump where it lifts adds nothing, so a line drawing
   *  itself on picks up at the next start without a pause. */
  along: Float64Array;
}

/**
 * The stretches of a track that go back over ground it has already covered: the way back of
 * an out-and-back, the stem of a lollipop loop, a spur to a viewpoint and back. Drawn twice,
 * the two passes never quite coincide (a recorded track wanders a few metres either way), and
 * read as a doubled, shimmering strand; drawn once, the line is the shape of the ground walked.
 *
 * Each is [first, last] point index. A point is on earlier ground when it lies within
 * RETRACE_ACROSS_M of a segment walked at least RETRACE_LAG_M before it, and within RETRACE_UP_M
 * of that segment's height (when there is height to compare). A run of such points counts once
 * it is RETRACE_MIN_M long, and two runs a brief wander apart (RETRACE_BRIDGE_M) count as one.
 * Positions in metres; a grid of the path walked so far keeps it linear in the track's length.
 */
export function retraces(
  x: readonly number[],
  y: readonly number[],
  z: readonly number[] | null,
): [number, number][] {
  const count = x.length;
  const along = new Float64Array(count);
  for (let i = 1; i < count; i++) along[i] = along[i - 1]! + Math.hypot(x[i]! - x[i - 1]!, y[i]! - y[i - 1]!);
  const cell = RETRACE_ACROSS_M;
  const key = (cx: number, cy: number) => cx * 1_000_003 + cy;
  const grid = new Map<number, number[]>();
  /** segment s runs from point s − 1 to point s; filed in every cell its line passes */
  const file = (s: number) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x[s]! - x[s - 1]!, y[s]! - y[s - 1]!) / (cell / 2)));
    for (let k = 0; k <= steps; k++) {
      const px = x[s - 1]! + ((x[s]! - x[s - 1]!) * k) / steps;
      const py = y[s - 1]! + ((y[s]! - y[s - 1]!) * k) / steps;
      const at = key(Math.floor(px / cell), Math.floor(py / cell));
      const list = grid.get(at);
      if (!list) grid.set(at, [s]);
      else if (list.at(-1) !== s) list.push(s);
    }
  };
  const onSegment = (i: number, s: number) => {
    const ax = x[s - 1]!;
    const ay = y[s - 1]!;
    const dx = x[s]! - ax;
    const dy = y[s]! - ay;
    const length2 = dx * dx + dy * dy;
    const t = length2 ? Math.max(0, Math.min(1, ((x[i]! - ax) * dx + (y[i]! - ay) * dy) / length2)) : 0;
    if (Math.hypot(x[i]! - ax - t * dx, y[i]! - ay - t * dy) > RETRACE_ACROSS_M) return false;
    return !z || Math.abs(z[i]! - (z[s - 1]! + t * (z[s]! - z[s - 1]!))) <= RETRACE_UP_M;
  };

  const runs: [number, number][] = [];
  let filed = 0;
  let from = -1;
  const close = (to: number) => {
    if (from >= 0 && to > from + 1 && along[to]! - along[from]! >= RETRACE_MIN_M) runs.push([from, to]);
    from = -1;
  };
  /** whether point i lies on a segment filed so far, in its cell or the eight round it */
  const onEarlierPath = (i: number) => {
    const cx = Math.floor(x[i]! / cell);
    const cy = Math.floor(y[i]! / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const s of grid.get(key(cx + dx, cy + dy)) ?? []) if (onSegment(i, s)) return true;
      }
    }
    return false;
  };
  for (let i = 0; i < count; i++) {
    while (filed + 1 < count && along[filed + 1]! <= along[i]! - RETRACE_LAG_M) file(++filed);
    const on = onEarlierPath(i);
    if (on && from < 0) from = i;
    else if (!on && from >= 0) close(i - 1);
  }
  close(count - 1);
  // join stretches only a brief wander apart
  const joined: [number, number][] = [];
  for (const run of runs) {
    const prev = joined.at(-1);
    if (prev && along[run[0]]! - along[prev[1]]! < RETRACE_BRIDGE_M) prev[1] = run[1];
    else joined.push(run);
  }
  return joined;
}

/**
 * The smallest circle round a set of points: its centre and radius (Welzl's algorithm, in
 * its incremental form). The points are taken in a fixed shuffled order, so it runs in about
 * linear time however the track was walked (in walking order, a track heading steadily
 * outward is its worst case), and gives the same circle every time.
 */
function smallestCircle(x: readonly number[], y: readonly number[]): { cx: number; cy: number; r: number } {
  const order = Array.from(x, (_, i) => i);
  let seed = 0x2545f491;
  for (let i = order.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  let cx = 0;
  let cy = 0;
  let r = -1;
  const outside = (i: number) => Math.hypot(x[i]! - cx, y[i]! - cy) > r + 1e-9 * (1 + r);
  const across = (a: number, b: number) => {
    cx = (x[a]! + x[b]!) / 2;
    cy = (y[a]! + y[b]!) / 2;
    r = Math.hypot(x[a]! - cx, y[a]! - cy);
  };
  const through = (a: number, b: number, c: number) => {
    const [ax, ay, bx, by, qx, qy] = [x[a]!, y[a]!, x[b]!, y[b]!, x[c]!, y[c]!];
    const d = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
    if (Math.abs(d) < 1e-12) {
      // three in a line: the circle across the two farthest apart
      const ab = Math.hypot(ax - bx, ay - by);
      const ac = Math.hypot(ax - qx, ay - qy);
      const bc = Math.hypot(bx - qx, by - qy);
      if (ab >= ac && ab >= bc) across(a, b);
      else if (ac >= bc) across(a, c);
      else across(b, c);
      return;
    }
    const a2 = ax * ax + ay * ay;
    const b2 = bx * bx + by * by;
    const q2 = qx * qx + qy * qy;
    cx = (a2 * (by - qy) + b2 * (qy - ay) + q2 * (ay - by)) / d;
    cy = (a2 * (qx - bx) + b2 * (ax - qx) + q2 * (bx - ax)) / d;
    r = Math.hypot(ax - cx, ay - cy);
  };
  for (let p = 0; p < order.length; p++) {
    const i = order[p]!;
    if (!outside(i)) continue;
    cx = x[i]!;
    cy = y[i]!;
    r = 0;
    for (let q = 0; q < p; q++) {
      const j = order[q]!;
      if (!outside(j)) continue;
      across(i, j);
      for (let t = 0; t < q; t++) if (outside(order[t]!)) through(i, j, order[t]!);
    }
  }
  return { cx, cy, r };
}

/**
 * A track as the line /trail-spin turns. Null when there is no line to draw: fewer than two
 * points, or all of them in one place.
 *
 * It turns about the centre of the smallest circle round the track, and that circle's radius
 * is the model's unit. A turn is as wide as that circle at its widest moment, and on a phone,
 * or in a vertical or square video, the width is what limits how big the line can be drawn;
 * about the middle of the track's bounds it swept a wider circle (Timberline's, 7% wider).
 * Flat-earth arithmetic is plenty at the size of a walk. A track across the 180th meridian
 * (Taveuni in Fiji straddles it, as do the Aleutians and Chukotka) is taken the short way
 * round: its longitudes jump from 179.9 to -179.9, and read as they come the loop was as wide
 * as the world and drew as one straight line.
 */
export function spinModel(points: readonly TrackPoint[]): SpinModel | null {
  if (points.length < 2) return null;
  // each longitude the short way round from the one before, so a jump across 180° is a step
  const lons = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    let lon = points[i]!.lon;
    if (i) lon += Math.round((lons[i - 1]! - lon) / 360) * 360;
    lons[i] = lon;
  }
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  points.forEach((p, i) => {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, lons[i]!);
    maxLon = Math.max(maxLon, lons[i]!);
  });
  const lat0 = (minLat + maxLat) / 2;
  const lon0 = (minLon + maxLon) / 2;
  const perDegEast = M_PER_DEG * Math.cos((lat0 * Math.PI) / 180);
  const east = points.map((_, i) => (lons[i]! - lon0) * perDegEast);
  const north = points.map((p) => (p.lat - lat0) * M_PER_DEG);
  const { cx, cy, r: radius } = smallestCircle(east, north);
  if (!(radius > 0)) return null;
  let reach = 0;
  for (let i = 0; i < east.length; i++) reach = Math.max(reach, Math.hypot(east[i]!, north[i]!));

  const ele = filledElevations(points);
  // a loop, not Math.min(...ele): a long watch track is more arguments than a call can take
  let lowest = Infinity;
  let highest = -Infinity;
  for (const v of ele) {
    lowest = Math.min(lowest, v);
    highest = Math.max(highest, v);
  }
  const relief = ele.length ? highest - lowest : 0;
  const exaggeration = relief > 0 ? Math.min((RELIEF_OF_RADIUS * reach) / relief, MAX_EXAGGERATION) : 0;
  const mid = (lowest + highest) / 2;

  // Thinned to a point every few metres before anything walks the track point by point (the
  // extremes above are the full track's).
  const kept: number[] = [0];
  for (let i = 1; i < east.length; i++) {
    const k = kept.at(-1)!;
    if (i === east.length - 1 || Math.hypot(east[i]! - east[k]!, north[i]! - north[k]!) >= PRE_THIN_M) kept.push(i);
  }
  const x = kept.map((i) => east[i]!);
  const y = kept.map((i) => north[i]!);
  const z = ele.length ? kept.map((i) => ele[i]!) : null;

  // A retraced stretch keeps its two ends, so the line runs up to where it starts and picks
  // up again where it ends, and leaves out everything between.
  const skip = new Uint8Array(x.length);
  const restart = new Uint8Array(x.length);
  for (const [first, last] of retraces(x, y, z)) {
    skip.fill(1, first + 1, last);
    restart[last] = 1;
  }

  const e: number[] = [];
  const n: number[] = [];
  const u: number[] = [];
  const starts: number[] = [];
  const lastIndex = x.length - 1;
  for (let i = 0; i < x.length; i++) {
    if (skip[i]) continue;
    const pe = (x[i]! - cx) / radius;
    const pn = (y[i]! - cy) / radius;
    const pu = exaggeration && z ? ((z[i]! - mid) * exaggeration) / radius : 0;
    const k = e.length - 1;
    // a stretch's ends are kept however close they sit to the point before
    const end = i === lastIndex || restart[i] === 1 || skip[i + 1] === 1;
    if (k >= 0 && !end && Math.hypot(pe - e[k]!, pn - n[k]!, pu - u[k]!) < THIN_OF_RADIUS) continue;
    e.push(pe);
    n.push(pn);
    u.push(pu);
    starts.push(k < 0 || restart[i] ? 1 : 0);
  }
  // measured in the model's own units, height drawn tall and all: the length on screen,
  // so the line draws on at an even pace however the route climbs
  const along = new Float64Array(e.length);
  for (let i = 1; i < e.length; i++) {
    along[i] = along[i - 1]! + (starts[i] ? 0 : Math.hypot(e[i]! - e[i - 1]!, n[i]! - n[i - 1]!, u[i]! - u[i - 1]!));
  }
  const total = along[e.length - 1]!;
  for (let i = 0; i < e.length; i++) along[i] = total > 0 ? along[i]! / total : 1;
  return {
    e: Float64Array.from(e),
    n: Float64Array.from(n),
    u: Float64Array.from(u),
    halfHeight: (relief * exaggeration) / 2 / radius,
    exaggeration,
    starts: Uint8Array.from(starts),
    along,
  };
}

/** The camera's angle above the horizon for this line. */
export const pitchFor = (m: SpinModel): number => (m.exaggeration ? PITCH : FLAT_PITCH);

/** The turn, in radians, this far into the spin. */
export const spinAngle = (ms: number): number => (ms / SPIN_PERIOD_MS) * 2 * Math.PI;
/** How long a video of `turns` full turns runs, in milliseconds and in seconds. */
export const videoMs = (turns: number): number => turns * SPIN_PERIOD_MS;
export const videoSeconds = (turns: number): number => videoMs(turns) / 1000;

/** How much of the line is drawn `ms` into a video (or the stage's loop of one): all of it
 *  when it appears whole; drawn on, none at the start and all of it after DRAW_ON_MS, easing
 *  in and out (smoothstep) so the pen sets off and arrives rather than starting and stopping
 *  dead. */
export function drawnAt(reveal: SpinReveal, ms: number): number {
  if (reveal === "whole" || ms >= DRAW_ON_MS) return 1;
  if (ms <= 0) return 0;
  const t = ms / DRAW_ON_MS;
  return t * t * (3 - 2 * t);
}

/** Where a route starts: an eighth of a turn in, so its first frame isn't the flat
 *  north-facing view that every other picture of it already is. The stage opens here, and
 *  the page's link preview is the whole line at this angle. */
export const SPIN_START_ANGLE = Math.PI / 4;

/** Model units to pixels for a turn that stays inside `box`, centred: fixed for the whole
 *  turn, from the line's widest possible extent rather than any one frame's, so the line
 *  never breathes in and out as it turns. */
function spinScale(m: SpinModel, box: { width: number; height: number }): number {
  const pitch = pitchFor(m);
  const tallest = m.halfHeight * Math.cos(pitch) + Math.sin(pitch);
  return Math.min(box.width / 2, box.height / 2 / tallest);
}

/**
 * The line as the camera sees it, turned by `angle` about the vertical: x to the right and
 * y UP, in the model's units, two numbers a point. At angle 0 the camera looks north, so a
 * camera straight overhead would see the map the right way up.
 *
 * A growing angle turns the route CLOCKWISE seen from above: its far side travels right
 * across the screen and its near side left, as the video /trail-spin was modelled on turns (its
 * summit, highest while farthest away, moves rightward then).
 */
export function projectSpin(m: SpinModel, angle: number, pitch: number, out?: Float64Array): Float64Array {
  const xy = out && out.length === m.e.length * 2 ? out : new Float64Array(m.e.length * 2);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const up = Math.cos(pitch);
  const away = Math.sin(pitch);
  for (let i = 0; i < m.e.length; i++) {
    const e = m.e[i]!;
    const n = m.n[i]!;
    xy[2 * i] = e * cos + n * sin;
    // how far from the camera, which a camera above the horizon sees as height
    const depth = n * cos - e * sin;
    xy[2 * i + 1] = m.u[i]! * up + depth * away;
  }
  return xy;
}

/** The canvas a frame is drawn on, in device pixels, and what it's drawn in. */
export interface SpinFrame {
  width: number;
  height: number;
  ink: string;
  /** The colour of the whole frame behind the line, painted first. The video's frames need
   *  it; the stage leaves it out and clears to transparent, because the page behind it is
   *  already that colour, and filling a full-screen canvas every frame was most of what the
   *  GPU did to draw the stage (3.3 of 3.6 ms a frame at a 5K size in Chrome, 2026-11-28). */
  ground?: string;
  /** The thinnest the line may get, in device pixels. A small stage would otherwise draw
   *  the video's weight scaled down to a hairline. */
  minLine?: number;
  /** The box, centred on the turn, that the whole turn stays inside, in device pixels. A
   *  video's is a share of its frame (FILL_ACROSS_*, FILL_DOWN); the stage's is the room the
   *  page's bars leave round the middle of the screen. */
  fit?: { width: number; height: number };
  /** How far down the frame the turn's middle sits, in device pixels: the frame's middle
   *  unless said. The stage's frame is the room between the bars, and its turn sits on the
   *  middle of the screen, which the room needn't be centred on. */
  middleY?: number;
  /** How much of the line to draw, from its start, as a share of its length (drawnAt): all
   *  of it unless said. */
  drawn?: number;
}

/**
 * One frame. Returns the projected points, to be handed back as `scratch` next frame so a
 * spin at 60 frames a second doesn't allocate at 60 frames a second.
 */
export function drawSpin(
  ctx: CanvasRenderingContext2D,
  m: SpinModel,
  angle: number,
  { width, height, ink, ground, minLine = 1, fit, middleY = height / 2, drawn = 1 }: SpinFrame,
  scratch?: Float64Array,
): Float64Array {
  if (ground) {
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.clearRect(0, 0, width, height);
  }
  const box = fit ?? { width: width * (width > height ? FILL_ACROSS_WIDE : FILL_ACROSS_NARROW), height: height * FILL_DOWN };
  const scale = spinScale(m, box);
  const xy = projectSpin(m, angle, pitchFor(m), scratch);
  if (drawn <= 0) return xy;
  const x = (i: number) => width / 2 + xy[2 * i]! * scale;
  const y = (i: number) => middleY - xy[2 * i + 1]! * scale;
  // the segment the pen is on (from point `last`), and how far along it: the walk the
  // track's own resamplers use, which never stops on the jump where the line lifts
  const { i: last, f } = drawn >= 1 ? { i: m.e.length - 1, f: 0 } : segmentAt(m.along, drawn);
  ctx.beginPath();
  for (let i = 0; i <= last; i++) {
    if (m.starts[i]) ctx.moveTo(x(i), y(i));
    else ctx.lineTo(x(i), y(i));
  }
  const next = last + 1;
  if (f > 0 && next < m.e.length && !m.starts[next]) {
    ctx.lineTo(x(last) + (x(next) - x(last)) * f, y(last) + (y(next) - y(last)) * f);
  }
  ctx.lineWidth = Math.max(minLine, Math.min(width, height) * LINE_OF_SHORT_SIDE);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = ink;
  ctx.stroke();
  return xy;
}
