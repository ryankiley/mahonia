// The live controller, opened over a stubbed network. For the suites that drive the
// real useGearList through a SEQUENCE of dispatches (itemNesting, itemPaste) and read
// the snapshot back — the shape gearList.nuxt.test.ts explains, minus its interest in
// what reaches the wire.
//
// Routes go through registerEndpoint, NOT a $fetch global stub: under the Nuxt
// environment $fetch is already bound to test-utils' own mock, which 404s anything
// unregistered — a plain vi.stubGlobal never gets a look in.
import { registerEndpoint } from "@nuxt/test-utils/runtime";
import { useGearList } from "../../app/composables/useGearList";
import type { ListSnapshot } from "../../shared/types";

type Controller = ReturnType<typeof useGearList>;

// what /api/edit/list hands back — set by openList, read by the default listResponse
let served: ListSnapshot | undefined;

/**
 * The four routes a load-then-edit touches, as the optimistic-snapshot suites want
 * them: the list as `listResponse()` says, a poll that reports nothing new, the
 * fire-and-forget ranking ping, and a mutate that swallows writes — these cases are
 * about the snapshot the reducer builds, not about what reaches the server.
 * File-global, like every registerEndpoint: call it once at module scope.
 */
export function registerEditorEndpoints(listResponse: () => unknown = () => served): void {
  registerEndpoint("/api/edit/list", () => ({ snapshot: listResponse() }));
  registerEndpoint("/api/edit/changes", () => ({ version: 1 }));
  registerEndpoint("/api/catalog/use", () => ({}));
  registerEndpoint("/api/edit/mutate", { method: "POST", handler: () => ({ ok: true }) });
}

/** Serve `list` from /api/edit/list and open it in the controller by edit token. */
export async function openList(list: ListSnapshot, token: string): Promise<Controller> {
  served = list;
  const c = useGearList();
  await c.load({ token });
  return c;
}

/** This list's items in sortOrder — top-level and children interleaved by that one key. */
export const itemsOf = (c: Controller) =>
  [...(c.snapshot.value?.items ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
export const byId = (c: Controller, id: string) => c.snapshot.value?.items.find((i) => i.id === id);
export const childrenOf = (c: Controller, parentId: string) =>
  itemsOf(c).filter((i) => i.parentId === parentId);
