import { describe, expect, it } from "vitest";
import type { TrackPoint } from "../shared/gpx";
import { DRAW_ON_MS, drawnAt, drawSpin, pitchFor, projectSpin, retraces, SPIN_PERIOD_MS, spinAngle, spinModel } from "../shared/routeSpin";

// A loop about 4.4 km across, highest at its north end and lowest at its south.
const loop = (relief: number | null, n = 400): TrackPoint[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    const p = { lat: 45.37 + 0.02 * Math.cos(a), lon: -121.7 + 0.028 * Math.sin(a) };
    return relief === null ? p : { ...p, ele: 1500 + (relief / 2) * Math.cos(a) };
  });

const radiusOf = (m: NonNullable<ReturnType<typeof spinModel>>) =>
  Math.max(...Array.from(m.e, (e, i) => Math.hypot(e, m.n[i]!)));

describe("spinModel", () => {
  it("measures the route in its own radius, about its middle", () => {
    const m = spinModel(loop(600))!;
    expect(radiusOf(m)).toBeCloseTo(1, 6);
    expect(Math.max(...m.e)).toBeCloseTo(-Math.min(...m.e), 3);
    expect(Math.max(...m.n)).toBeCloseTo(-Math.min(...m.n), 3);
  });

  it("turns about the centre of the smallest circle round the route, not the middle of its bounds", () => {
    // an equilateral triangle on the equator, 2 km a side, walked round its edges: the
    // middle of its bounds is half way up, the middle of its circle a third of the way
    const corners = [[0, 0], [0, 0.018], [0.0155885, 0.009]] as const;
    const track: TrackPoint[] = [];
    for (let k = 0; k < 3; k++) {
      const [a, b] = [corners[k]!, corners[(k + 1) % 3]!];
      for (let i = 0; i < 100; i++) track.push({ lat: a[0] + ((b[0] - a[0]) * i) / 100, lon: a[1] + ((b[1] - a[1]) * i) / 100 });
    }
    track.push({ lat: 0, lon: 0 });
    const m = spinModel(track)!;
    expect(radiusOf(m)).toBeCloseTo(1, 6);
    expect(Math.max(...m.n)).toBeCloseTo(1, 2);
    expect(Math.min(...m.n)).toBeCloseTo(-0.5, 2);
    expect(Math.max(...m.e)).toBeCloseTo(-Math.min(...m.e), 3);
  });

  it("draws a mountain's relief at the same share of its size, whatever its height", () => {
    const low = spinModel(loop(300))!;
    const high = spinModel(loop(900))!;
    expect(low.halfHeight).toBeCloseTo(0.55, 6);
    expect(high.halfHeight).toBeCloseTo(0.55, 6);
    expect(low.exaggeration).toBeCloseTo(3 * high.exaggeration, 6);
    // the north end is the top
    const top = m3Top(high);
    expect(high.n[top]).toBeGreaterThan(0.9);
  });

  it("keeps a flat route flat rather than stretching its GPS noise into peaks", () => {
    const m = spinModel(loop(3))!;
    expect(m.exaggeration).toBe(12);
    expect(m.halfHeight).toBeLessThan(0.01);
  });

  it("lies flat and is looked down on when the file has no elevation", () => {
    const flat = spinModel(loop(null))!;
    expect(flat.exaggeration).toBe(0);
    expect(flat.halfHeight).toBe(0);
    expect(Math.max(...flat.u.map(Math.abs))).toBe(0);
    expect(pitchFor(flat)).toBeGreaterThan(pitchFor(spinModel(loop(600))!));
  });

  it("has no line to draw for a single place", () => {
    expect(spinModel([{ lat: 45, lon: -121 }])).toBeNull();
    expect(spinModel([{ lat: 45, lon: -121, ele: 10 }, { lat: 45, lon: -121, ele: 20 }])).toBeNull();
  });

  it("thins a dense track to what a screen can show", () => {
    const m = spinModel(loop(600, 100_000))!;
    expect(m.e.length).toBeGreaterThan(1000);
    expect(m.e.length).toBeLessThan(10_000);
  });

  it("drops a point that sits on the one before it, but never the last", () => {
    const a = { lat: 45, lon: -121, ele: 100 };
    const b = { lat: 45.01, lon: -121, ele: 200 };
    const nearB = { lat: 45.01, lon: -121.000001, ele: 200 };
    const c = { lat: 45.01, lon: -120.99, ele: 150 };
    expect(spinModel([a, b, nearB, c])!.e.length).toBe(3);
    expect(spinModel([a, b, nearB])!.e.length).toBe(3);
  });
});

describe("projectSpin", () => {
  const m = spinModel(loop(600))!;

  it("sees the map the right way up from straight overhead, facing north", () => {
    const xy = projectSpin(m, 0, Math.PI / 2);
    for (let i = 0; i < m.e.length; i += 37) {
      expect(xy[2 * i]).toBeCloseTo(m.e[i]!, 9);
      expect(xy[2 * i + 1]).toBeCloseTo(m.n[i]!, 9);
    }
  });

  it("holds every height still as it turns, seen from the horizon", () => {
    const a = projectSpin(m, 0, 0);
    const b = projectSpin(m, 1.3, 0);
    for (let i = 0; i < m.e.length; i += 37) {
      expect(a[2 * i + 1]).toBeCloseTo(m.u[i]!, 9);
      expect(b[2 * i + 1]).toBeCloseTo(m.u[i]!, 9);
    }
  });

  it("comes round to where it started once a period", () => {
    expect(spinAngle(SPIN_PERIOD_MS)).toBeCloseTo(2 * Math.PI, 12);
    const start = projectSpin(m, 0.4, pitchFor(m));
    const round = projectSpin(m, 0.4 + spinAngle(SPIN_PERIOD_MS), pitchFor(m));
    for (let i = 0; i < start.length; i++) expect(round[i]).toBeCloseTo(start[i]!, 9);
  });
});

function m3Top(m: NonNullable<ReturnType<typeof spinModel>>): number {
  let top = 0;
  for (let i = 1; i < m.u.length; i++) if (m.u[i]! > m.u[top]!) top = i;
  return top;
}

describe("retraces", () => {
  // Tracks in metres, a point every 10 m, so the shapes are easy to reason about.
  type Track = { x: number[]; y: number[]; z: number[] };
  const walk = (steps: [number, number, number][]): Track => ({
    x: steps.map((s) => s[0]),
    y: steps.map((s) => s[1]),
    z: steps.map((s) => s[2]),
  });
  // 1 km east, climbing 100 m, with a wiggle so it isn't a ruler line
  const out: [number, number, number][] = Array.from({ length: 101 }, (_, i) => [i * 10, 8 * Math.sin(i / 4), i]);
  const back = (shift: [number, number, number] = [0, 0, 0]) =>
    out
      .slice(0, -1)
      .reverse()
      .map(([x, y, z]) => [x + shift[0], y + shift[1], z + shift[2]] as [number, number, number]);

  it("finds the way back of an out-and-back, running to the end of the track", () => {
    const t = walk([...out, ...back()]);
    const runs = retraces(t.x, t.y, t.z);
    expect(runs).toHaveLength(1);
    const [first, last] = runs[0]!;
    expect(last).toBe(t.x.length - 1);
    // the turnaround's own few points stay drawn: they're within the lag of themselves
    expect(first).toBeGreaterThan(100);
    expect(first).toBeLessThan(110);
  });

  it("finds it on a recorded track, whose way back wanders a few metres off the way out", () => {
    const t = walk([...out, ...back([0, 5, 3])]);
    expect(retraces(t.x, t.y, t.z)).toHaveLength(1);
  });

  it("finds it with no elevation to compare", () => {
    const t = walk([...out, ...back()]);
    expect(retraces(t.x, t.y, null)).toHaveLength(1);
  });

  it("keeps switchbacks, whose legs sit ten metres apart but metres above one another", () => {
    // six 150 m legs, ten metres apart, climbing 15% along the path
    const steps: [number, number, number][] = [];
    let z = 0;
    for (let leg = 0; leg < 6; leg++) {
      for (let k = 0; k <= 15; k++) {
        const x = leg % 2 ? 150 - k * 10 : k * 10;
        if (steps.length) z += 1.5;
        steps.push([x, leg * 10, z]);
      }
    }
    const t = walk(steps);
    expect(retraces(t.x, t.y, t.z)).toEqual([]);
  });

  it("keeps a loop, and a figure of eight that crosses itself", () => {
    const loop = walk(Array.from({ length: 315 }, (_, i) => [500 * Math.cos(i / 50), 500 * Math.sin(i / 50), 0]));
    expect(retraces(loop.x, loop.y, loop.z)).toEqual([]);
    const eight = walk(
      Array.from({ length: 629 }, (_, i) => [400 * Math.sin(i / 100), 200 * Math.sin(i / 50), 50 * Math.sin(i / 100)]),
    );
    expect(retraces(eight.x, eight.y, eight.z)).toEqual([]);
  });

  it("finds the stem of a lollipop on the way back down it, and only that", () => {
    const stem: [number, number, number][] = Array.from({ length: 51 }, (_, i) => [i * 10, 0, i * 2]);
    const loop: [number, number, number][] = Array.from({ length: 189 }, (_, i) => {
      const a = (i / 188) * 2 * Math.PI;
      return [800 - 300 * Math.cos(a), 300 * Math.sin(a), 100];
    });
    const down = stem.slice(0, -1).reverse();
    const t = walk([...stem, ...loop, ...down]);
    const runs = retraces(t.x, t.y, t.z);
    expect(runs).toHaveLength(1);
    // it starts where the loop closes back onto the top of the stem, a point or two early
    expect(runs[0]![0]).toBeGreaterThanOrEqual(stem.length + loop.length - 4);
    expect(runs[0]![1]).toBe(t.x.length - 1);
  });
});

describe("spinModel on an out-and-back", () => {
  it("draws the way out once and leaves the way back undrawn", () => {
    const way: TrackPoint[] = Array.from({ length: 200 }, (_, i) => ({
      lat: 44.1 + i * 0.0002,
      lon: -121.77 + 0.0001 * Math.sin(i / 5),
      ele: 1700 + i * 4,
    }));
    const both = spinModel([...way, ...way.slice(0, -1).reverse()])!;
    const once = spinModel(way)!;
    // the way back is a single restart and nothing after it: within a few points of the
    // way out alone (the turnaround's own lag stays drawn)
    expect(both.e.length - once.e.length).toBeLessThan(15);
    expect(both.starts[0]).toBe(1);
    expect(Array.from(both.starts).filter(Boolean)).toHaveLength(2);
  });
});

describe("the way it turns", () => {
  it("turns clockwise seen from above: the far side travels right, the near side left", () => {
    // one point due north (the far side, at angle 0) and one due south (the near side)
    const m = { e: Float64Array.of(0, 0), n: Float64Array.of(1, -1), u: Float64Array.of(0, 0), halfHeight: 0, exaggeration: 0, starts: Uint8Array.of(1, 0), along: Float64Array.of(0, 1) };
    const now = projectSpin(m, 0, 0.07);
    const later = projectSpin(m, 0.1, 0.07);
    expect(later[0]! - now[0]!).toBeGreaterThan(0); // far side, rightward
    expect(later[2]! - now[2]!).toBeLessThan(0); // near side, leftward
    // and the far side is the higher on screen, a camera above the horizon looking at it
    expect(now[1]!).toBeGreaterThan(now[3]!);
  });
});

describe("retraces, on a way back that wanders", () => {
  it("joins two retraced stretches a brief wander apart, rather than leaving a stray dash", () => {
    // 1 km out; back along it, but 25 m off for 60 m in the middle (beyond the 12 m reach)
    const out: [number, number, number][] = Array.from({ length: 101 }, (_, i) => [i * 10, 0, i]);
    const back = out
      .slice(0, -1)
      .reverse()
      .map(([x, y, z]) => [x, x > 470 && x < 530 ? y + 25 : y, z] as [number, number, number]);
    const all = [...out, ...back];
    const runs = retraces(all.map((p) => p[0]), all.map((p) => p[1]), all.map((p) => p[2]));
    expect(runs).toHaveLength(1);
    expect(runs[0]![1]).toBe(all.length - 1);
  });
});

describe("drawing the line on", () => {
  it("draws none of it at the start, all of it after DRAW_ON_MS, and more each moment between", () => {
    expect(drawnAt("draw", 0)).toBe(0);
    expect(drawnAt("draw", DRAW_ON_MS / 2)).toBeCloseTo(0.5, 9);
    expect(drawnAt("draw", DRAW_ON_MS)).toBe(1);
    expect(drawnAt("draw", 25_000)).toBe(1);
    let before = 0;
    for (let ms = 100; ms <= DRAW_ON_MS; ms += 100) {
      const now = drawnAt("draw", ms);
      expect(now).toBeGreaterThan(before);
      before = now;
    }
    // easing: slower at the ends than through the middle
    expect(drawnAt("draw", DRAW_ON_MS * 0.1)).toBeLessThan(0.1);
  });

  it("draws the whole line from the first frame when it appears whole", () => {
    expect(drawnAt("whole", 0)).toBe(1);
    expect(drawnAt("whole", 1234)).toBe(1);
  });

  it("measures the way along from 0 to 1, adding nothing where the line lifts", () => {
    const way: TrackPoint[] = Array.from({ length: 200 }, (_, i) => ({
      lat: 44.1 + i * 0.0002,
      lon: -121.77 + 0.0001 * Math.sin(i / 5),
      ele: 1700 + i * 4,
    }));
    const m = spinModel([...way, ...way.slice(0, -1).reverse()])!;
    expect(m.along[0]).toBe(0);
    expect(m.along[m.along.length - 1]).toBe(1);
    for (let i = 1; i < m.along.length; i++) {
      expect(m.along[i]!).toBeGreaterThanOrEqual(m.along[i - 1]!);
      if (m.starts[i]) expect(m.along[i]).toBe(m.along[i - 1]);
    }
  });

  // the calls drawSpin makes on its canvas, the points in order
  const recorder = () => {
    const path: { op: "move" | "line"; x: number; y: number }[] = [];
    let stroked = 0;
    const grounds: string[] = [];
    const ctx = {
      fillRect: () => grounds.push("fill"),
      clearRect: () => grounds.push("clear"),
      beginPath() {},
      moveTo: (x: number, y: number) => path.push({ op: "move", x, y }),
      lineTo: (x: number, y: number) => path.push({ op: "line", x, y }),
      stroke: () => stroked++,
    } as unknown as CanvasRenderingContext2D;
    return { ctx, path, grounds, strokes: () => stroked };
  };
  // three points due east, evenly spaced, the camera's angle 0 looking north at them
  const straight = {
    e: Float64Array.of(-1, 0, 1),
    n: Float64Array.of(0, 0, 0),
    u: Float64Array.of(0, 0, 0),
    halfHeight: 0,
    exaggeration: 0,
    starts: Uint8Array.of(1, 0, 0),
    along: Float64Array.of(0, 0.5, 1),
  };
  const frame = { width: 200, height: 200, ink: "#fff", ground: "#000", fit: { width: 200, height: 200 } };

  it("ends the line part way between two points, where the pen has got to", () => {
    const { ctx, path } = recorder();
    drawSpin(ctx, straight, 0, { ...frame, drawn: 0.75 });
    expect(path.map((p) => p.op)).toEqual(["move", "line", "line"]);
    // from x 0 (the left end) through 100 (the middle), and stopping half way to 200
    expect(path.map((p) => Math.round(p.x))).toEqual([0, 100, 150]);
  });

  it("fills the frame with the ground when given one (the video), and clears it when not (the stage)", () => {
    const video = recorder();
    drawSpin(video.ctx, straight, 0, frame);
    expect(video.grounds).toEqual(["fill"]);
    const stage = recorder();
    const { ground: _, ...noGround } = frame;
    drawSpin(stage.ctx, straight, 0, noGround);
    expect(stage.grounds).toEqual(["clear"]);
    expect(stage.path.map((p) => Math.round(p.x))).toEqual([0, 100, 200]);
  });

  it("draws nothing at all before the pen sets off, and every point once it has finished", () => {
    const none = recorder();
    drawSpin(none.ctx, straight, 0, { ...frame, drawn: 0 });
    expect(none.path).toHaveLength(0);
    expect(none.strokes()).toBe(0);
    const all = recorder();
    drawSpin(all.ctx, straight, 0, frame);
    expect(all.path.map((p) => Math.round(p.x))).toEqual([0, 100, 200]);
  });
});

describe("a route across the 180th meridian", () => {
  // a 10 km loop drawn once round longitude 0 and once round 180, where its longitudes jump
  // from 179.97 to -179.97: the two must come out the same shape
  const ring = (lon0: number): TrackPoint[] =>
    Array.from({ length: 200 }, (_, i) => {
      const a = (i / 200) * 2 * Math.PI;
      let lon = lon0 + 0.03 * Math.sin(a);
      if (lon > 180) lon -= 360;
      return { lat: -16.85 + 0.02 * Math.cos(a), lon, ele: 300 + 200 * Math.cos(a) };
    });

  it("is taken the short way round, not as wide as the world", () => {
    const across = spinModel(ring(180))!;
    const home = spinModel(ring(0))!;
    expect(across.e.length).toBe(home.e.length);
    across.e.forEach((e, i) => expect(e).toBeCloseTo(home.e[i]!, 6));
    across.n.forEach((n, i) => expect(n).toBeCloseTo(home.n[i]!, 6));
  });
});
