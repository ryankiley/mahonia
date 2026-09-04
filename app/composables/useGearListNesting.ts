import type { Op } from "~~/shared/ops";
import { uid } from "~~/shared/id";
import type { Item, ListSnapshot } from "~~/shared/types";
import { bySortOrder, nextSortOrder, siblingItems } from "~~/shared/weights";
import type { Ref } from "vue";

/**
 * Nesting — the wrap, the unwrap, and the move that reindexes around them.
 *
 * Lifted out of useGearList because it is the one cluster in that file that answers
 * to nothing but the snapshot and the op queue. What is left behind is the sync
 * engine: the queue, the debounced flush, the retry backoff, epoch invalidation and
 * the offline replay — the part carrying real correctness risk, now readable without
 * wading through group-wrap semantics on the way.
 *
 * These four dependencies are the whole surface. `discardEmpty` stays in the
 * controller because it is the general "nothing was typed, nothing is lost" rule
 * that several paths share; unwrapEmptied falls through to it rather than
 * reimplementing it.
 *
 * Covered by tests/itemNesting.nuxt.test.ts, which was written BEFORE this move for
 * exactly that reason: nestItem existed in the suite only as a `() => {}` stub and
 * moveItem had no tests at all, so there was nothing to prove the extraction
 * behaved. The tests drive the real controller and were mutation-checked against
 * three deliberate breakages before this ran.
 */
export interface NestingDeps {
  snapshot: Ref<ListSnapshot | null>;
  dispatch: (op: Op) => void;
  /** The row that should take the caret once it renders — see useGearList. */
  pendingBlankId: Ref<string | null>;
  /** The shared "nothing was typed, nothing is lost" removal. */
  discardEmpty: (id: string) => void;
}

export function createNesting({ snapshot, dispatch, pendingBlankId, discardEmpty }: NestingDeps) {
// ---- nesting (a nested item is just a normal item carrying a parentId) ----
// A parent row's weight column shows the GROUP total (own + children) and is
// read-only, so a row that already HAS a weight would take that weight into
// hiding the moment something nested under it: still counted in every total,
// printed on no row, editable in no field. A group is a container, not a product.
//
// So nesting into a row that carries a weight WRAPS it: a new group takes the
// row's slot, the product slides underneath as its first child (name, weight,
// catalog link and all), and the caller nests into the group instead. A row with
// no weight is already a container — nest straight into it, exactly as before,
// which is what keeps a hand-built "Cook kit" group working the way it does now.
//
// The group takes the product's COMMON NAME ("Tent") — the field that exists to
// say what a thing generically IS, which is precisely what the group now is — and
// the child gives it up so it isn't printed on both lines. With no common name to
// take, the group starts empty with its name field focused; it can't be discarded
// out from under the user, as discardEmpty never removes a row that has children.
//
// `focusNewGroup` — whether an unnamed new group should take the caret. True for the
// deliberate, one-at-a-time gestures (the indent button, "add a nested item"); FALSE for
// a drag, where the group is a side effect of the drop and stealing focus summons the
// soft keyboard the instant the finger lifts.
//
// Returns the id to actually nest into: the row itself, or the new group.
function containerFor(targetId: string, focusNewGroup: boolean): string {
  const items = snapshot.value?.items;
  const target = items?.find((i) => i.id === targetId);
  if (!items || !target) return targetId;
  // nothing to strand: no weight of its own, or already a group (whatever weight
  // it had became a child's the first time round). A nested row can't be a parent
  // at all (one level deep) — leave it to the reducer's own coercion.
  if (target.unitWeightMg <= 0 || target.parentId != null) return targetId;
  if (items.some((i) => i.parentId === targetId)) return targetId;
  const id = uid();
  const group: Item = {
    id,
    folderId: target.folderId,
    parentId: null,
    name: target.commonName ?? "",
    unitWeightMg: 0,
    qty: 1,
    classification: null,
    // the carrier comes along with the slot: the group stands where the product
    // stood, and a wrap that dropped it would disinherit every later child (and,
    // under a person filter, make "add a nested item" build an invisible row)
    personId: target.personId,
    sortOrder: target.sortOrder, // take the product's slot in the folder
  };
  dispatch({ t: "addItem", item: group });
  // the product moves under it whole — and this vacates the sortOrder the group
  // just took, so the two never share a slot among their folder's top-level rows
  dispatch({ t: "moveItem", id: targetId, folderId: target.folderId, parentId: id, sortOrder: 0 });
  // commonNameOverridden, not just an empty commonName: the child keeps its catalog
  // link, and hydrateCatalogNames refills an un-overridden common name from the
  // catalog on the very next snapshot — the label would come straight back and
  // print on both lines. Clearing it here IS the "user cleared it" the flag means.
  if (target.commonName)
    dispatch({ t: "updateItem", id: targetId, patch: { commonName: "", commonNameOverridden: true } });
  else if (focusNewGroup) pendingBlankId.value = id; // nothing to name it with — focus the empty field
  return id;
}
// The reverse of the wrap. Pulling the LAST child out of a container that holds nothing
// but a name undoes the whole thing: the container goes, and the name it was given —
// the product's gear type, lifted at wrap time — goes back to the product.
//
// Without this, nest-then-un-nest loses in both directions: the product's gear type was
// cleared WITH commonNameOverridden set (so live-resolve can't refill it — see the wrap
// above), and the childless container outlives discardEmpty precisely because it has a
// name. The user gets a product missing its label plus a stray zero-weight row.
//
// A hand-built group ("Cook kit") is shaped identically to a wrap group — a name and
// nothing else — so the discriminator is on the CHILD: an empty-but-overridden gear type
// is exactly what the wrap leaves behind and nothing else produces. Anything that isn't
// that signature falls through to discardEmpty, which is the old behavior untouched.
function unwrapEmptied(containerId: string, childId: string) {
  const items = snapshot.value?.items;
  const container = items?.find((i) => i.id === containerId);
  const child = items?.find((i) => i.id === childId);
  if (
    !items || !container || !child || !container.name ||
    items.some((i) => i.parentId === containerId) || // still holds other children
    !child.commonNameOverridden || child.commonName || // not a row that gave a label up
    // a container carrying content of its own is a real row, not a wrapper
    container.unitWeightMg > 0 || container.qty !== 1 || container.description ||
    container.productUrl || container.catalogItemId != null ||
    container.classification != null || container.wornQty != null || container.packed
  )
    return discardEmpty(containerId);
  dispatch({
    t: "updateItem",
    id: childId,
    // a catalog-linked row's gear type was the catalog's own default, so hand ownership
    // back to live-resolve; a hand-typed row's label is the user's, so keep it pinned.
    // The carrier moves back too, when the child was only inheriting it — the wrap
    // stamped the group with the product's own (see containerFor), but the user may
    // have reassigned the GROUP since, and deleting it would silently unclaim the row.
    patch: {
      commonName: container.name,
      commonNameOverridden: child.catalogItemId == null,
      ...(container.personId && !child.personId ? { personId: container.personId } : {}),
    },
  });
  // quiet: un-nesting is a shape change, not a deletion — the gear didn't go
  // anywhere, its name just moved back onto the row above
  dispatch({ t: "removeItem", id: containerId, quiet: true });
}
// Add a blank child under `parentId` and focus it — the same blank-row machinery as
// addBlankItem, positioned as the parent's last child (it inherits the parent's folder).
function addChild(parentId: string): string {
  // the blank child below takes the caret, so the wrap must not claim it first
  const containerId = containerFor(parentId, false);
  const parent = snapshot.value?.items.find((i) => i.id === containerId);
  if (!parent) return "";
  const id = uid();
  const sortOrder = nextSortOrder(snapshot.value!.items, parent.folderId, containerId);
  const item: Item = { id, folderId: parent.folderId, parentId: containerId, name: "", unitWeightMg: 0, qty: 1, classification: null, sortOrder };
  // addBlankItem's pre-claim, for the one case inheriting doesn't cover: a group
  // kept on screen only as filter CONTEXT belongs to someone else, so a child
  // that merely inherited would materialize hidden — with the caret trapped on a
  // node that can't take it, which also kept discardEmpty from ever firing
  const claimed = usePersonFilter().assignTarget(snapshot.value?.people);
  if (claimed && claimed !== parent.personId) item.personId = claimed;
  dispatch({ t: "addItem", item });
  pendingBlankId.value = id; // the blank child is what the user asked for
  return id;
}
// Nest `id` under `parentId`, appended to that parent's children (via moveItem so the
// folder + sortOrder + parent all move together and the reducer enforces one level).
function nestItem(id: string, parentId: string) {
  const parent = snapshot.value?.items.find((i) => i.id === parentId);
  if (!parent) return;
  // a deliberate one-row gesture (the indent button), so an unnamed new group is worth
  // the caret — unlike the drag path, which reaches moveItem without this
  moveItem(id, parent.folderId, null, parentId, { focusNewGroup: true });
}
// (Indent lives in ItemRow: the row's DISPLAY-order predecessor comes from the
// parent's v-for as prevId, and the click is nestItem(id, prevId) — a sorted
// folder nests under the row you see above, not the sortOrder-previous one.)
// Outdent: un-nest a child back to top-level, dropped right after its former parent.
function unnest(id: string) {
  const it = snapshot.value?.items.find((i) => i.id === id);
  if (!it || it.parentId == null) return;
  const top = siblingItems(snapshot.value!.items, it.folderId, null).sort(bySortOrder);
  const after = top[top.findIndex((s) => s.id === it.parentId) + 1];
  moveItem(id, it.folderId, after ? after.id : null, null);
}
// Move item `id` into the container (`folderId`, `parentId`), before `beforeId`
// (null = append to the container's end). parentId null = top-level; a string nests it
// under that item. Reindexes the target container to clean 0..n-1 integers in the new
// order — collision-proof and self-healing against duplicate sortOrders (which would
// otherwise re-sort ambiguously on reload). One moveItem op per row that actually
// shifts, all batched into a single flush. Only the moved row carries the explicit
// parentId; shifted siblings reorder in place (their nesting left untouched).
function moveItem(
  id: string,
  folderId: string | null,
  beforeId: string | null,
  parentId: string | null = null,
  { focusNewGroup = false }: { focusNewGroup?: boolean } = {},
) {
  if (!snapshot.value) return;
  const it = snapshot.value.items.find((i) => i.id === id);
  if (!it) return;
  // nesting into a row that carries a weight wraps it in a group first (see
  // containerFor), so the row we nest INTO may be a brand-new id — and beforeId,
  // which addressed a child of the row we aimed at, no longer means anything
  // there. Appending is right: the wrapped product is the group's first child.
  if (parentId != null && parentId !== id) {
    const containerId = containerFor(parentId, focusNewGroup);
    if (containerId !== parentId) {
      parentId = containerId;
      beforeId = null;
    }
  }
  // a row pulled OUT of a group can leave it childless — unwrapEmptied undoes a wrap
  // outright (name back to the product, container gone) and otherwise falls through to
  // discardEmpty, the "nothing was typed, nothing is lost" test that keeps any group
  // the user named or filled
  const formerParentId = it.parentId ?? null;
  const target = siblingItems(snapshot.value.items, folderId, parentId)
    .filter((i) => i.id !== id)
    .sort(bySortOrder);
  let idx = beforeId == null ? target.length : target.findIndex((s) => s.id === beforeId);
  if (idx < 0) idx = target.length;
  const ordered = [...target.slice(0, idx), it, ...target.slice(idx)];
  // Which of these is worth reading later? Only a change of FOLDER. Re-ordering
  // rows and nesting one under another are shape, not content — "Moved 1 item"
  // for an indent tells you nothing you'd act on — so both go out quiet and the
  // history keeps "Moved Sawyer Squeeze to Water" for the one that means something.
  const changedFolder = it.folderId !== folderId;
  ordered.forEach((item, i) => {
    if (item.id === id) {
      if (item.folderId !== folderId || (item.parentId ?? null) !== parentId || item.sortOrder !== i)
        dispatch({ t: "moveItem", id, folderId, parentId, sortOrder: i, ...(changedFolder ? {} : { quiet: true as const }) });
    } else if (item.sortOrder !== i) {
      // a sibling shuffled up or down to make room — never news
      dispatch({ t: "moveItem", id: item.id, folderId, sortOrder: i, quiet: true });
    }
  });
  if (formerParentId && formerParentId !== parentId) unwrapEmptied(formerParentId, id);
}

  return { addChild, nestItem, unnest, moveItem };
}
