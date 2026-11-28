// An edit sent twice lands once.
//
// The editor keeps every op it queues on the device until the server answers for it
// (useGearList), and sends what the device holds on the next open. So an op whose answer
// never arrived (the tab closed, the editor moved to another list) goes again, though it
// may already have landed. The reducer's ops are absolute (a removal removes, a setMeta
// sets), so a second landing undid whatever had happened in between: a restore, a
// collaborator's rename, an assistant's edit.
//
// So each queued op carries where it came from: the editing session that queued it
// (`from`, random per session) and its place in that session's queue (`seq`, from 1).
// The list remembers, for its most recent sessions, the highest seq it has applied
// (lists.applied_through), and an op at or below that is a copy of one already applied
// and is skipped. That holds because a session's ops reach the server in order: one
// request at a time, each starting at the oldest op not yet answered for, so no op is
// applied before one queued ahead of it.
//
// An op without a stamp (the connector, the iOS app, an editor cached from before this)
// is applied as it always was.
import { uid } from "./id";
import type { Op } from "./ops";

export type OpStamp = { from: string; seq: number };
export type StampedOp = Op & Partial<OpStamp>;

/** For each recent session, the highest seq applied, the most recent session last. */
export type AppliedThrough = [from: string, seq: number][];

/** Sessions a list remembers. A copy from an older one than these would land again. */
export const APPLIED_SESSIONS_KEPT = 100;

const FROM = /^[A-Za-z0-9_-]{1,32}$/;

/** The op's stamp, or null for an op without one, or with one it can't read. */
function stampOf(op: unknown): OpStamp | null {
  if (!op || typeof op !== "object") return null;
  const { from, seq } = op as Partial<Record<keyof OpStamp, unknown>>;
  return typeof from === "string" && FROM.test(from) && Number.isSafeInteger(seq) && (seq as number) >= 1
    ? { from, seq: seq as number }
    : null;
}

/**
 * The ops not yet applied to a list that has applied `applied`, and what it has applied
 * once they are. `applied` comes back as given when no op carried a stamp.
 */
export function freshOps<T>(ops: T[], applied: AppliedThrough | null): { fresh: T[]; applied: AppliedThrough | null } {
  const reached = new Map(applied ?? []);
  let stamped = false;
  const fresh = ops.filter((op) => {
    const stamp = stampOf(op);
    if (!stamp) return true;
    stamped = true;
    if (stamp.seq <= (reached.get(stamp.from) ?? 0)) return false;
    reached.delete(stamp.from); // re-set below, so the session moves to the end
    reached.set(stamp.from, stamp.seq);
    return true;
  });
  if (!stamped) return { fresh, applied };
  return { fresh, applied: [...reached].slice(-APPLIED_SESSIONS_KEPT) };
}

/** A new session's `from`: random, short, and in the stamp's form. */
export const newSessionStamp = (): string => uid().replace(/-/g, "").slice(0, 16);
