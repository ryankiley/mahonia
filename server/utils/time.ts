/** A timestamp column as ISO text. Both drivers hand back a Date for timestamptz; a
 *  string only reaches here from a fixture, and passes through as it is. Six repo
 *  rows each spelled the conversion. */
export function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** The most rows one sweep may touch in a run, whatever limit it is asked for. */
const SWEEP_BATCH_MAX = 10_000;

/**
 * A sweep's window: how far back `days` reaches (floored at one day), and how many
 * rows one run may touch (floored at one, capped at SWEEP_BATCH_MAX) — so a backlog
 * drains over successive nights and one run can never issue an unbounded write. The
 * lists' two sweeps and the vaults' two each worked this out. The day floor is applied
 * here to the default as well, so a default read from the environment needs no floor
 * of its own.
 */
export function sweepWindow(
  days: number | undefined,
  defaultDays: number,
  limit: number | undefined,
): { cutoff: Date; limit: number } {
  const d = Math.max(1, Math.floor(days ?? defaultDays));
  return {
    cutoff: new Date(Date.now() - d * 86_400_000),
    limit: Math.max(1, Math.min(SWEEP_BATCH_MAX, Math.floor(limit ?? 5_000))),
  };
}
