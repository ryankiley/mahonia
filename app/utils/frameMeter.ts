// A frame-time graph laid over the page, for checking an animation on a real screen: a bar a
// frame for the last few seconds, green when the frame came on time and red when it took half
// again as long as the usual one, under the frame rate and a count of the slow ones.
// /trail-spin shows it when its address carries `?fps`, so the stage can be checked on a phone
// or a big display with no console to paste into.
//
// What it can see is a frame the browser didn't deliver on time. GPU work that still makes its
// frame doesn't show from JavaScript at all (a Metal trace is the only honest view of that), so
// a clean graph says "no dropped frames", not "no headroom".

const BARS = 240; // four seconds at 60, two at 120
const WIDTH = BARS;
const HEIGHT = 72;
/** a frame this many times the median gap counts as slow */
const SLOW = 1.5;

/** Shows the graph; the function it returns takes it away. */
export function showFrameMeter(): () => void {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH * ratio;
  canvas.height = HEIGHT * ratio;
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "fixed",
    top: "8px",
    left: "8px",
    width: `${WIDTH}px`,
    height: `${HEIGHT}px`,
    zIndex: "2147483647",
    pointerEvents: "none",
    borderRadius: "8px",
    background: "rgb(0 0 0 / 0.75)",
  });
  document.body.append(canvas);
  const ctx = canvas.getContext("2d")!;
  ctx.scale(ratio, ratio);
  const gaps: number[] = [];
  let last = 0;
  let raf = 0;
  const tick = (now: number) => {
    if (last) {
      gaps.push(now - last);
      if (gaps.length > BARS) gaps.shift();
    }
    last = now;
    const usual = gaps.length ? [...gaps].sort((a, b) => a - b)[gaps.length >> 1]! : 1000 / 60;
    let slow = 0;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    gaps.forEach((gap, i) => {
      const late = gap > usual * SLOW;
      if (late) slow++;
      // two px a millisecond, so a 60 Hz frame stands 33 px and a dropped one twice that
      const bar = Math.min(HEIGHT - 20, gap * 2);
      ctx.fillStyle = late ? "#ff5a4f" : "#4cc38a";
      ctx.fillRect(i, HEIGHT - bar, 1, bar);
    });
    ctx.fillStyle = "#fff";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(`${Math.round(1000 / usual)} fps · ${usual.toFixed(1)} ms · slow ${slow}/${gaps.length}`, 6, 13);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    canvas.remove();
  };
}
