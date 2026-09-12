// Everything an account holds, in one file: the takeout.
//
// Deleting an account asks what to do with your lists; this is the equivalent for
// leaving with them. Every claimed list in the same shape as a list's own "Download
// JSON" (shared/exporters/json.ts), so any one of them can be cut out of this file and
// restored through the import dialog, plus My Gear in the same shape as its own export
// (shared/exporters/vault.ts). Two existing shapes side by side rather than a third:
// a takeout whose lists differed from a list's backup would be one more thing to keep
// in step.
//
// A list here carries two keys the single backup doesn't: its share code, which is the
// only stable name a list has (an edit token is never stored, so an edit link cannot be
// written out), and when it was last edited. Both are ignored by the importer.

import type { ListMeta, ListData, ListSnapshot } from "../types";
import { pickListMeta } from "../types";
import { vaultExportObject, type VaultExport } from "./vault";

export const EVERYTHING_FORMAT = "mahonia-account-export";
export const EVERYTHING_VERSION = 1;

/** One list, the backup's shape plus its handle. */
export function listExportObject(list: ListSnapshot): Record<string, unknown> {
  const { folders, items, days, waypoints, people } = list;
  return {
    shareCode: list.shareCode,
    updatedAt: list.updatedAt,
    ...pickListMeta(list as ListMeta & ListData),
    folders,
    items,
    days,
    waypoints,
    people,
  };
}

export interface EverythingExport {
  format: typeof EVERYTHING_FORMAT;
  version: typeof EVERYTHING_VERSION;
  exportedAt: string;
  lists: Record<string, unknown>[];
  gear: ReturnType<typeof vaultExportObject>;
}

export function everythingExport(lists: readonly ListSnapshot[], gear: VaultExport, exportedAt: string): EverythingExport {
  return {
    format: EVERYTHING_FORMAT,
    version: EVERYTHING_VERSION,
    exportedAt,
    lists: lists.map(listExportObject),
    gear: vaultExportObject(gear),
  };
}
