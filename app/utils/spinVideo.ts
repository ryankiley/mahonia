// /trail-spin's Save video: a route's turns as a file, made on the device and never uploaded.
//
// TWO WAYS, best first, the second tried when the first can't (or stalls).
//
// 1. Frame by frame (WebCodecs). Every frame drawn at exactly its own angle, handed to the
//    browser's video encoder, and written into an MP4 by shared/mp4.ts. Nothing waits on the
//    clock, so it runs as fast as the device can encode (a 10-second video in about 2), and
//    no frame can be dropped: a busy moment only makes the save slower.
// 2. As it plays (MediaRecorder). The browser records a canvas while it's drawn, in real
//    time, so a video takes as long to save as it runs, and a frame the device was too busy
//    to draw is a frame the video repeats. For a browser with no video encoder.
//
// Both draw with drawSpin at the format's full size, so the two can't come out looking
// different.
//
// It runs on the page, not in a worker. A worker kept the page's thread free while it saved
// (its longest busy stretch 3 ms rather than about 21), but saved no faster, and Safari's never
// answered: a save sat at 0% until a watchdog gave up on it (2026-11-27). The stage holds
// still while it saves anyway.
import { mp4Blob, mp4Colour, type Mp4Colour, type Mp4Sample } from "~~/shared/mp4";
import {
  drawnAt,
  drawSpin,
  SPIN_FORMATS,
  videoSeconds,
  type SpinFormat,
  type SpinModel,
  type SpinReveal,
  type VideoTurns,
} from "~~/shared/routeSpin";

const VIDEO_FPS = 60;
/** Line art on a flat ground compresses well; this is generous for 1080p at 60. */
const VIDEO_BITRATE = 12_000_000;
/** A keyframe every two seconds: somewhere for a scrubbing player to land. */
const KEY_EVERY = 2 * VIDEO_FPS;
/** H.264 at level 4.2, which holds 1080p at 60 in any of the three shapes. Constrained Baseline
 *  first, the profile every H.264 encoder has: Safari's says it can do Main and High, then
 *  takes frames and never gives one back (WebKit on a Mac and in the iOS Simulator,
 *  2026-11-28), so every save there sat four seconds at 0% before recording in real time. A
 *  line on a flat ground at this bitrate looks the same in any profile. Main and High stay
 *  for an encoder that lacks Baseline. */
const AVC_CODECS = ["avc1.42E02A", "avc1.4D402A", "avc1.64002A"];
/** How many frames may wait on the encoder before drawing pauses for it. */
const QUEUE_LIMIT = 6;
/** How often, at most, progress is reported: each report re-renders the page's ring, on the
 *  thread drawing the frames. The ring glides over the same beat (pages/trail-spin.vue). */
export const SAVE_PROGRESS_MS = 100;
/** How long an encoder may sit on queued frames, or on a question, before the save gives up
 *  on it: an encoder that has stopped is a save that never ends, and recording is better. */
const STALL_MS = 4000;
/** For the as-it-plays fallback: an MP4 where the browser can make one, WebM where not. */
const RECORDER_TYPES = ["video/mp4;codecs=avc1.640028", "video/mp4", "video/webm;codecs=vp9", "video/webm"];

export interface SpinVideoJob {
  model: SpinModel;
  format: SpinFormat;
  /** the angle the stage was at when Save was pressed: the video starts where you were looking */
  from: number;
  /** how many full turns the video runs, ten seconds each */
  turns: VideoTurns;
  /** whether the line draws itself on from the first frame, or is there whole */
  reveal: SpinReveal;
  ink: string;
  ground: string;
  onProgress: (share: number) => void;
  /** aborted when the stage goes away mid-save: the work stops, and nothing is kept */
  signal?: AbortSignal;
}

/** Whether this browser can save a video at all, either way. */
export function canSaveVideo(): boolean {
  return typeof VideoEncoder !== "undefined" || recorderType() !== null;
}

/** The video, saved the best way this browser has. When both ways fail, the error says why
 *  each did. */
export async function saveSpinVideo(job: SpinVideoJob): Promise<Blob> {
  const failures: string[] = [];
  const attempt = async (way: string, run: () => Promise<Blob | null>) => {
    try {
      const video = await run();
      if (!video) failures.push(`${way}: not in this browser`);
      return video;
    } catch (e) {
      // a save that was called off is just over
      if (job.signal?.aborted) throw e;
      failures.push(`${way}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
      console.warn(`Save video: ${way} failed.`, e);
      job.onProgress(0);
      return null;
    }
  };
  const video = (await attempt("frame by frame", () => encodeFrames(job))) ?? (await attempt("as it plays", () => recordAsItPlays(job)));
  if (video) return video;
  throw new Error(failures.join("; "));
}

const angleAt = (job: SpinVideoJob, share: number) => job.from + share * job.turns * 2 * Math.PI;
/** How much of the line is drawn `share` of the way through the video. */
const drawnFor = (job: SpinVideoJob, share: number) => drawnAt(job.reveal, share * videoSeconds(job.turns) * 1000);

/** A page canvas at the format's full size, drawn on and never shown. Opaque: every pixel is
 *  painted, and an opaque canvas is cheaper to read back. */
function canvasFor(format: SpinFormat) {
  const { width, height } = SPIN_FORMATS[format];
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  return { canvas, ctx, frame: { width, height } };
}

// ---- 1. Frame by frame ----

/** The promise, or an error once `ms` has passed without it. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} didn't answer`)), ms)));
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function avcConfig(width: number, height: number): Promise<VideoEncoderConfig | null> {
  for (const codec of AVC_CODECS) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate: VIDEO_BITRATE,
      framerate: VIDEO_FPS,
      avc: { format: "avc" },
    };
    try {
      if ((await within(VideoEncoder.isConfigSupported(config), STALL_MS, "the encoder's support check")).supported) return config;
    } catch {
      // a codec string this browser can't parse is a no, not an error
    }
  }
  return null;
}

/** Until the encoder has taken a frame off its queue: its own "dequeue" event, so the loop
 *  sleeps while it works rather than spinning to ask. The timer is a backstop for an engine
 *  that doesn't fire the event; the loop asks again either way. */
const dequeued = (encoder: VideoEncoder) =>
  new Promise<void>((resolve) => {
    const done = () => {
      encoder.removeEventListener("dequeue", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 20);
    encoder.addEventListener("dequeue", done);
  });

/**
 * The video as an MP4, or null when this browser has no encoder for the frame. Throws if the
 * encoder fails or stalls part way, or the save is called off.
 *
 * The frames are folded into a Blob every keyframe group as they arrive, not kept as arrays
 * to the end: the finished file is put together from those Blobs, which the browser can hold
 * without a second copy (and page to disk), so a save peaks near the file's size rather than
 * twice it.
 */
async function encodeFrames(job: SpinVideoJob): Promise<Blob | null> {
  if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
  const { canvas, ctx, frame } = canvasFor(job.format);
  const { width, height } = frame;
  const config = ctx && (await avcConfig(width, height));
  if (!ctx || !config) return null;

  const samples: Mp4Sample[] = [];
  const parts: Blob[] = [];
  let group: Uint8Array<ArrayBuffer>[] = [];
  const fold = () => {
    if (group.length) parts.push(new Blob(group));
    group = [];
  };
  let avcC: Uint8Array | null = null;
  let colour: Mp4Colour | undefined;
  let failure: unknown = null;
  let lastOutput = performance.now();
  const encoder = new VideoEncoder({
    output(chunk, meta) {
      lastOutput = performance.now();
      const decoder = meta?.decoderConfig;
      if (decoder?.description && !avcC) {
        const d = decoder.description;
        // copied out: the encoder may reuse the buffer it lent
        avcC = ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice() : new Uint8Array(d).slice();
        if (decoder.colorSpace) colour = mp4Colour(decoder.colorSpace);
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ size: data.length, key: chunk.type === "key", pts: chunk.timestamp });
      group.push(data);
      if (group.length >= KEY_EVERY) fold();
    },
    error(e) {
      failure = e;
    },
  });
  encoder.configure(config);

  const frames = Math.round(videoSeconds(job.turns) * VIDEO_FPS);
  const step = 1e6 / VIDEO_FPS;
  const look = { ...frame, ink: job.ink, ground: job.ground };
  let scratch: Float64Array | undefined;
  let told = performance.now();
  try {
    for (let i = 0; i < frames; i++) {
      job.signal?.throwIfAborted();
      if (failure) throw failure;
      const share = i / frames;
      scratch = drawSpin(ctx, job.model, angleAt(job, share), { ...look, drawn: drawnFor(job, share) }, scratch);
      const picture = new VideoFrame(canvas, { timestamp: Math.round(i * step), duration: Math.round(step) });
      encoder.encode(picture, { keyFrame: i % KEY_EVERY === 0 });
      picture.close();
      while (encoder.encodeQueueSize > QUEUE_LIMIT && !failure) {
        if (performance.now() - lastOutput > STALL_MS) throw new Error(`the encoder stopped at frame ${i} of ${frames}`);
        await dequeued(encoder);
      }
      if (performance.now() - told > SAVE_PROGRESS_MS) {
        job.onProgress(i / frames);
        told = performance.now();
      }
    }
    await within(encoder.flush(), STALL_MS, "the encoder's last frames");
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  if (failure) throw failure;
  fold();
  if (!avcC || samples.length !== frames) throw new Error("encoder came up short");
  job.onProgress(1);
  return mp4Blob({ width, height, fps: VIDEO_FPS, avcC, colour }, samples, parts);
}

// ---- 2. As it plays ----

function recorderType(): string | null {
  if (typeof MediaRecorder === "undefined" || !("captureStream" in HTMLCanvasElement.prototype)) return null;
  return RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

async function recordAsItPlays(job: SpinVideoJob): Promise<Blob | null> {
  const type = recorderType();
  const { canvas, ctx, frame } = canvasFor(job.format);
  if (!type || !ctx) return null;
  const look = { ...frame, ink: job.ink, ground: job.ground };
  let scratch = drawSpin(ctx, job.model, job.from, { ...look, drawn: drawnFor(job, 0) });
  const stream = canvas.captureStream(VIDEO_FPS);
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: VIDEO_BITRATE });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start();
  const t0 = performance.now();
  let told = t0;
  try {
    await new Promise<void>((resolve, reject) => {
      const tick = (now: number) => {
        if (job.signal?.aborted) return reject(job.signal.reason);
        const share = Math.min(1, (now - t0) / (videoSeconds(job.turns) * 1000));
        scratch = drawSpin(ctx, job.model, angleAt(job, share), { ...look, drawn: drawnFor(job, share) }, scratch);
        if (now - told > SAVE_PROGRESS_MS) {
          job.onProgress(share);
          told = now;
        }
        if (share < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  } finally {
    recorder.stop();
    await stopped;
    for (const track of stream.getTracks()) track.stop();
  }
  if (!chunks.length) throw new Error(`the recorder (${type}) gave no data`);
  return new Blob(chunks, { type: type.split(";")[0] });
}
