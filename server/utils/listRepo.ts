// List repository — all DB access for lists. Capability-based: callers hold an
// edit token (write) or a share code (read); the internal numeric id never
// leaves this module.

import { createError } from "h3";
import { and, eq, isNull } from "drizzle-orm";
import { lists, type ListRow } from "../db/schema";
import {
  applyOps,
  MAX_FOLDERS,
  MAX_ITEMS,
  normalizeFolder,
  normalizeItem,
  type Op,
} from "../../shared/ops";
import { computeTotals } from "../../shared/weights";
import type { ListData, ListSnapshot, ListState, Unit } from "../../shared/types";
import { useDb } from "./db";
import { randomEditToken, randomShareCode, randomSlug, sha256Hex } from "./tokens";

export function rowToSnapshot(row: ListRow): ListSnapshot {
  const data = (row.data ?? { folders: [], items: [] }) as ListData;
  return {
    shareCode: row.shareCode,
    slug: row.publicSlug,
    title: row.title,
    description: row.description ?? undefined,
    displayUnit: row.displayUnit as Unit,
    folders: data.folders ?? [],
    items: data.items ?? [],
    version: row.version,
    isPublic: row.isPublic,
  };
}

function rowToState(row: ListRow): ListState {
  const data = (row.data ?? { folders: [], items: [] }) as ListData;
  return {
    title: row.title,
    description: row.description ?? undefined,
    displayUnit: row.displayUnit as Unit,
    folders: structuredClone(data.folders ?? []),
    items: structuredClone(data.items ?? []),
    version: row.version,
  };
}

const liveOnly = (col: typeof lists.editTokenHash | typeof lists.shareCode, val: string) =>
  and(eq(col, val), eq(lists.status, "active"), isNull(lists.deletedAt));

// Enforce the advertised case-insensitive Crockford contract + reject malformed
// codes before any DB round-trip.
const CROCKFORD_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{12}$/;
function normShareCode(raw: string): string | null {
  const c = (raw || "").toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  return CROCKFORD_RE.test(c) ? c : null;
}

async function findByEditToken(editToken: string): Promise<ListRow | null> {
  const db = await useDb();
  const hash = sha256Hex(editToken);
  const rows = await db.select().from(lists).where(liveOnly(lists.editTokenHash, hash)).limit(1);
  return rows[0] ?? null;
}

export async function getByShareCode(code: string): Promise<ListSnapshot | null> {
  const c = normShareCode(code);
  if (!c) return null;
  const db = await useDb();
  const rows = await db.select().from(lists).where(liveOnly(lists.shareCode, c)).limit(1);
  return rows[0] ? rowToSnapshot(rows[0]) : null;
}

export async function getByEditToken(editToken: string): Promise<ListSnapshot | null> {
  const row = await findByEditToken(editToken);
  return row ? rowToSnapshot(row) : null;
}

/** version of a list addressed by share code (cheap; for live-sync polling). */
export async function versionByShareCode(code: string): Promise<number | null> {
  const c = normShareCode(code);
  if (!c) return null;
  const db = await useDb();
  const rows = await db
    .select({ version: lists.version })
    .from(lists)
    .where(liveOnly(lists.shareCode, c))
    .limit(1);
  return rows[0]?.version ?? null;
}

export async function versionByEditToken(editToken: string): Promise<number | null> {
  const db = await useDb();
  const hash = sha256Hex(editToken);
  const rows = await db
    .select({ version: lists.version })
    .from(lists)
    .where(liveOnly(lists.editTokenHash, hash))
    .limit(1);
  return rows[0]?.version ?? null;
}

export async function createList(init?: {
  title?: string;
  displayUnit?: Unit;
  data?: ListData;
}): Promise<{ editToken: string; snapshot: ListSnapshot }> {
  const db = await useDb();
  const editToken = randomEditToken();
  const editTokenHash = sha256Hex(editToken);
  const title = (init?.title ?? "Untitled list").slice(0, 200);
  // Normalize + cap inbound content through the SAME reducer helpers the mutate
  // path uses — the create path must not be a clamp-bypass into raw JSONB.
  const data: ListData = {
    folders: (init?.data?.folders ?? []).slice(0, MAX_FOLDERS).map(normalizeFolder),
    items: (init?.data?.items ?? []).slice(0, MAX_ITEMS).map(normalizeItem),
  };
  const totals = computeTotals(data);
  const displayUnit = init?.displayUnit ?? "g";

  // Retry on slug/share_code unique collision (regenerated each attempt).
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const inserted = await db
        .insert(lists)
        .values({
          publicSlug: randomSlug(title),
          editTokenHash,
          shareCode: randomShareCode(),
          title,
          displayUnit,
          data,
          baseWeightMg: totals.baseMg,
          wornWeightMg: totals.wornMg,
          consumableWeightMg: totals.consumableMg,
          totalWeightMg: totals.totalMg,
          itemCount: totals.itemCount,
          version: 1,
        })
        .returning();
      return { editToken, snapshot: rowToSnapshot(inserted[0]!) };
    } catch (e) {
      if ((e as { code?: string })?.code === "23505" && attempt < 4) continue;
      throw e;
    }
  }
  throw createError({ statusCode: 500, statusMessage: "Could not allocate list code" });
}

/**
 * Apply a batch of ops via compare-and-set on version. Ops MERGE: if another
 * editor bumped the version between read and write, we re-read and re-apply onto
 * the latest state (so independent edits both land). Returns the authoritative
 * snapshot, or null if the list doesn't exist (→ 404).
 */
export async function applyOpsByEditToken(
  editToken: string,
  ops: Op[],
): Promise<ListSnapshot | null> {
  const db = await useDb();
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await findByEditToken(editToken);
    if (!row) return null;

    const state = rowToState(row);
    applyOps(state, ops);
    const data: ListData = { folders: state.folders, items: state.items };
    const totals = computeTotals(data);

    const updated = await db
      .update(lists)
      .set({
        title: state.title,
        description: state.description ?? null,
        displayUnit: state.displayUnit,
        data,
        baseWeightMg: totals.baseMg,
        wornWeightMg: totals.wornMg,
        consumableWeightMg: totals.consumableMg,
        totalWeightMg: totals.totalMg,
        itemCount: totals.itemCount,
        version: row.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(lists.id, row.id), eq(lists.version, row.version)))
      .returning();

    if (updated[0]) return rowToSnapshot(updated[0]);
    // version moved under us — retry against the latest
  }
  // extreme contention: refuse rather than silently drop the caller's ops.
  // The client's flush() catch re-queues and retries (no ops lost).
  throw createError({ statusCode: 409, statusMessage: "Save contention — retry" });
}

export async function rotateEditToken(editToken: string): Promise<string | null> {
  const db = await useDb();
  const row = await findByEditToken(editToken);
  if (!row) return null;
  const next = randomEditToken();
  await db
    .update(lists)
    .set({ editTokenHash: sha256Hex(next), updatedAt: new Date() })
    .where(eq(lists.id, row.id));
  return next;
}
