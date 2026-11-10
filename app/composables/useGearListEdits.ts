import type { DayPatch, ItemPatch, Op } from "~~/shared/ops";
import { MAX_ITEMS, seedRouteEnds } from "~~/shared/ops";
import { uid } from "~~/shared/id";
import type { CatalogSearchResult } from "~~/shared/catalogSearch";
import { splitWeightTail } from "~~/shared/pasteList";
import { counted, tidyText } from "~~/shared/tidyText";
import { isWaterName, waterMgFromMl, waterPhraseMl } from "~~/shared/water";
import { colorKeyForName, nextFolderColor, usedColorKeys } from "~~/shared/categories";
import { sortedPeople } from "~~/shared/people";
import type { Folder, Item, ListSnapshot, Person, Unit, Waypoint, WaypointKind } from "~~/shared/types";
import type { VaultEntry } from "~~/shared/vault";
import { vaultRowFields } from "~~/shared/vault";
import { bySortOrder, carriesContent, entryUnitFromInput, nextSortOrder, parseWeightInput, siblingItems, storedClassification } from "~~/shared/weights";
import { createNesting } from "~/composables/useGearListNesting";
import type { Ref } from "vue";

/**
 * The list's edits: every mutator a component calls, as one op (or a few) handed to
 * the controller's dispatch. Folders, rows, days, pins and people, the paste, and the
 * nesting moves (useGearListNesting, which this builds).
 *
 * Out of useGearList for the reason nesting left it first: none of this knows about
 * syncing. These four dependencies are the whole surface, so what stays behind is the
 * engine — sessions, the queue and its flush, the poll, persistence — and this file
 * can be read as what an edit MEANS without wading through how it reaches the server.
 * The controller spreads the result into what it returns, so callers are unchanged.
 */
interface EditDeps {
  snapshot: Ref<ListSnapshot | null>;
  /** Apply an op optimistically and queue it — the controller's one way in. */
  dispatch: (op: Op) => void;
  /** Offer to take a removal (or a paste's additions) back. */
  offerUndo: (label: string, restore: () => void, verb?: "Added" | "Removed") => void;
  /** The row that should take the caret once it renders — see useGearList. */
  pendingBlankId: Ref<string | null>;
}

export function createEdits({ snapshot, dispatch, offerUndo, pendingBlankId }: EditDeps) {
  // The patch type is READ OFF the op rather than restated here. It was a hand-copied
  // duplicate of the same field list, so adding a meta field to the reducer left this
  // wrapper rejecting it — which is exactly what happened when trip dates landed.
  const setMeta = (patch: Extract<Op, { t: "setMeta" }>["patch"]) =>
    dispatch({ t: "setMeta", patch });
  const setUnit = (displayUnit: Unit) => setMeta({ displayUnit });

  function addFolder(name = "New folder"): string {
    const folders = snapshot.value?.folders ?? [];
    // a recognised name (e.g. "Clothing") gets its canonical hue; otherwise the
    // next distinct palette colour (see colorKeyForName)
    const colorKey = colorKeyForName(name, usedColorKeys(folders));
    const id = uid();
    dispatch({ t: "addFolder", folder: { id, name, colorKey, defaultClassification: "base", sortOrder: folders.length } });
    return id;
  }
  const updateFolder = (id: string, patch: Partial<Folder>) =>
    dispatch({ t: "updateFolder", id, patch });
  // drag-reorder: move folder `id` to just before/after `targetId`, then reindex
  function moveFolderBefore(id: string, targetId: string, before: boolean) {
    if (!snapshot.value || id === targetId) return;
    const folders = [...snapshot.value.folders].sort(bySortOrder);
    const moving = folders.find((f) => f.id === id);
    if (!moving) return;
    const without = folders.filter((f) => f.id !== id);
    const ti = without.findIndex((f) => f.id === targetId);
    if (ti < 0) return;
    without.splice(before ? ti : ti + 1, 0, moving);
    renumber(without, (id, sortOrder) => updateFolder(id, { sortOrder }));
  }
  // Make `rows` (already in display order) gapless: one patch per row whose sortOrder
  // isn't its position. Folders after a drag, days and people after a removal all
  // need it, so the numbering a person reads ("Day 3", the chip order) stays the
  // position in the list rather than drifting from it.
  function renumber(
    rows: readonly { id: string; sortOrder: number }[],
    update: (id: string, sortOrder: number) => void,
  ) {
    rows.forEach((r, i) => {
      if (r.sortOrder !== i) update(r.id, i);
    });
  }
  // ---- trip days ----
  // Thin, unlike the folder helpers above: a day has no colour to allocate, no items to
  // carry with it, and nothing pointing at it, so there is no cascade to write and no
  // undo to offer — a removed day is two numbers, and re-typing them costs less than the
  // toast would. Reordering is a sortOrder patch, exactly as it is for folders.
  function addDay() {
    const days = snapshot.value?.days ?? [];
    dispatch({ t: "addDay", day: { id: uid(), sortOrder: days.length } });
  }
  const updateDay = (id: string, patch: DayPatch) => dispatch({ t: "updateDay", id, patch });
  /** A pin at a distance along the route. No sortOrder — route order is the only order. */
  function addWaypoint(alongM: number, kind: WaypointKind = "landmark") {
    dispatch({ t: "addWaypoint", waypoint: { id: uid(), kind, alongM } });
  }
  /**
   * The route's two ends, for a list whose geometry predates them.
   *
   * seedRouteEnds fires when the geometry CHANGES (see the reducer's setMeta), so a route
   * imported before this existed has no trailhead and no finish — and no way to grow one,
   * because neither kind is placeable by hand, on purpose. This fills the gap from the
   * geometry the list is already holding, reusing the seeder's own fixed ids so a second
   * call adds nothing and a loop stays a loop.
   *
   * NOT in the reducer. A reducer replays ops and has to give the same answer every time;
   * a rule that invents a waypoint whenever it notices one missing would write a different
   * history depending on when it happened to run.
   */
  function ensureRouteEnds() {
    const geo = snapshot.value?.routeGeometry;
    if (!geo) return;
    const have = new Set((snapshot.value?.waypoints ?? []).map((w) => w.id));
    for (const w of seedRouteEnds(geo)) {
      if (!have.has(w.id)) dispatch({ t: "addWaypoint", waypoint: w });
    }
  }
  const updateWaypoint = (id: string, patch: Partial<Waypoint>) =>
    dispatch({ t: "updateWaypoint", id, patch });
  // No renumbering afterwards, unlike removeDay: nothing about a waypoint's identity comes
  // from its position in the array, so removing one leaves the rest exactly as they were.
  const removeWaypoint = (id: string) => dispatch({ t: "removeWaypoint", id });
  function removeDay(id: string) {
    dispatch({ t: "removeDay", id });
    // close the gap so "Day 3" stays the third day — see renumber
    renumber((snapshot.value?.days ?? []).slice().sort(bySortOrder), (id, sortOrder) =>
      updateDay(id, { sortOrder }),
    );
  }

  // ---- people ----
  // Thin like the day helpers: nothing to cascade client-side (the reducer's
  // removePerson clears assignments itself, on both ends of the wire), and no undo
  // toast — a removed person is one name, and their items stay put, just unclaimed.
  function addPerson(name: string): string {
    const people = sortedPeople(snapshot.value?.people);
    const id = uid();
    dispatch({
      t: "addPerson",
      person: {
        id,
        name,
        // the folder palette walk, seeded with the FOLDERS' hues as well as the
        // people's: person dots and folder dots are the same swatch two rows apart
        // (CategoryBar above, chips below), so a person taking the Shelter
        // folder's green would put one color on two meanings. Distinct across both.
        colorKey: nextFolderColor([
          ...usedColorKeys(snapshot.value?.folders ?? []),
          ...usedColorKeys(people),
        ]),
        sortOrder: people.length,
      },
    });
    return id;
  }
  const updatePerson = (id: string, patch: Partial<Person>) =>
    dispatch({ t: "updatePerson", id, patch });
  function removePerson(id: string) {
    dispatch({ t: "removePerson", id });
    // renumber like removeDay, so the chip order a person reads stays gapless.
    // NOT the place that widens a filter aimed at whoever just left — GearEditor's
    // watcher owns that, and covers a COLLABORATOR's removal arriving by poll too.
    renumber(sortedPeople(snapshot.value?.people), (id, sortOrder) => updatePerson(id, { sortOrder }));
  }

  function removeFolder(id: string) {
    const folder = snapshot.value?.folders.find((f) => f.id === id);
    // parents before children so nesting re-links on undo (addItem drops a child whose
    // parent isn't back yet). Nested children are included — they carry their
    // parent's folderId — which is exactly what the undo needs to restore.
    const items = (snapshot.value?.items ?? [])
      .filter((i) => i.folderId === id)
      .map((i) => ({ ...i }))
      .sort((a, b) => (a.parentId ? 1 : 0) - (b.parentId ? 1 : 0));
    dispatch({ t: "removeFolder", id });
    if (folder) {
      const f = { ...folder };
      offerUndo(folder.name || "Folder", () => {
        dispatch({ t: "addFolder", folder: f });
        for (const it of items) dispatch({ t: "addItem", item: it });
      });
    }
  }

  // "Add an item" drops a real, empty row in immediately (so it has every control
  // a normal row has) and focuses it; discardEmpty cleans it up if abandoned.
  function addBlankItem(folderId: string | null): string {
    if (!snapshot.value) return "";
    const id = uid();
    const sortOrder = nextSortOrder(snapshot.value.items, folderId);
    const item: Item = { id, folderId, name: "", unitWeightMg: 0, qty: 1, classification: null, sortOrder };
    // Under an active person filter the new row is pre-claimed for that person —
    // otherwise it would materialize already hidden by the very filter the user is
    // typing inside. Deliberately not part of discardEmpty's "has content" test:
    // an abandoned blank still tidies itself away, stamp and all.
    const personId = usePersonFilter().assignTarget(snapshot.value.people);
    if (personId) item.personId = personId;
    dispatch({ t: "addItem", item });
    pendingBlankId.value = id;
    return id;
  }
  // Add a piece of gear straight from the vault — the VaultPane's one write.
  //
  // A complete row lands in one dispatch, NOT a blank row that is then patched: a
  // half-built row that briefly exists would trip the pending-blank focus machinery
  // and the discard-on-blur cleanup.
  //
  // The fields are an autocomplete pick's, by the same rule (vaultRowFields, which
  // ItemRow's onNameCommit uses too): the weight, its unit and the name are the
  // HOLDER'S, so they're marked overridden and the catalog's live-resolve leaves them
  // alone; the catalog link rides along when the gear first came from a pick.
  function addVaultItem(
    entry: VaultEntry,
    folderId: string | null,
    // under a group's parent, at the count the kit holds it — see addVaultKit. A
    // child shares its parent's folder, which is the folderId the caller passes.
    nest: { parentId?: string; qty?: number } = {},
  ): string {
    if (!snapshot.value) return "";
    const id = uid();
    const item: Item = {
      id,
      folderId,
      ...(nest.parentId ? { parentId: nest.parentId } : {}),
      name: entry.name,
      unitWeightMg: 0,
      ...vaultRowFields(entry),
      qty: Math.max(1, Math.round(nest.qty ?? 1)),
      // null is stored only where the gear's class AGREES with the folder's default,
      // so the row keeps following a folder it matches — and an explicit "base" stove
      // dropped into a Consumable day folder stays base instead of becoming food.
      classification: storedClassification(entry.classification ?? "base", folderId, snapshot.value.folders),
      // same pre-claim as addBlankItem: gear pulled from the vault while narrowed
      // to one person lands in that person's view, not invisibly outside it
      personId: usePersonFilter().assignTarget(snapshot.value.people),
      sortOrder: nextSortOrder(snapshot.value.items, folderId, nest.parentId),
    };
    dispatch({ t: "addItem", item });
    return id;
  }

  // Enter in a row's name opens the NEXT row right below it (todo-list flow):
  // the same blank-row machinery as "Add an item", but positioned after the
  // source row instead of at the folder's end, so mid-list entry stays in place.
  function addBlankItemAfter(afterId: string): string {
    const src = snapshot.value?.items.find((i) => i.id === afterId);
    if (!src) return "";
    // the new row is a SIBLING of src — a child if src is nested, else top-level
    const parentId = src.parentId ?? null;
    const sibs = siblingItems(snapshot.value!.items, src.folderId, parentId).sort(bySortOrder);
    const next = sibs[sibs.findIndex((s) => s.id === afterId) + 1];
    const id = parentId ? addChild(parentId) : addBlankItem(src.folderId);
    if (id && next) moveItem(id, src.folderId, next.id, parentId);
    return id;
  }
  /**
   * The rows a multi-line paste makes: one per line, as SIBLINGS after `afterId` —
   * the row the paste landed in, which took the first line itself (ItemRow.onPasteRows
   * applies it just before calling this, and hands over `before`, the row as it was).
   * They land in that row's folder and, when it's nested, under its parent, in the
   * order the lines came. Returns the last row made, or "" when none was.
   *
   * Each line is read the way the name field reads a typed name (shared/pasteList):
   * a trailing weight fills the weight and names the row's unit, "water 2 L" is the
   * water row at that volume and a line that just says "water" arrives consumable, as
   * the water row does. Each row lands complete in one dispatch (never a blank that is
   * then patched — see addVaultItem for why).
   *
   * Then the catalog: one request naming every row, the same word-for-word matcher
   * the CSV import uses, and a row that names a product is linked as a pick would
   * link it — brand and variant split out, the product's weight unless the person's
   * own stands (a weight the line gave, or one they had typed before), which is kept
   * and marked. The match lands only on a row still named what was pasted and still
   * unlinked, so a row already retyped or picked from the menu in the meantime is
   * left alone; and never a weight on a group (a group's weight is its children's,
   * the guard every other path keeps). A failed request leaves the rows exactly as
   * typed: the link is a bonus, not the paste.
   *
   * The count is said through the undo toast ("Added 12 rows"), which is also the
   * way out of a paste that went into the wrong folder — twelve rows are twelve
   * deletes otherwise. Undo takes the rows away (a row someone nested under one of
   * them in the meantime steps out first, rather than going with it) and puts the
   * pasted-into row back as it was. Lines past the list's cap are not made, and
   * the label says how many were.
   */
  function pasteItemsAfter(afterId: string, lines: string[], before?: Item): string {
    const snap = snapshot.value;
    const src = snap?.items.find((i) => i.id === afterId);
    if (!snap || !src) return "";
    const parentId = src.parentId ?? null;
    const folderId = src.folderId;
    const room = Math.max(0, MAX_ITEMS - snap.items.length);
    // same pre-claim as addBlankItem: rows made under a person filter belong to that
    // person, or they'd materialize hidden by the very filter the paste happened inside
    const personId = usePersonFilter().assignTarget(snap.people);
    const items: Item[] = [];
    let capped = 0; // lines the cap refused, as distinct from lines that named nothing
    for (const line of lines) {
      if (items.length >= room) { capped++; continue; }
      const item: Item = {
        id: uid(),
        folderId,
        name: "",
        // typed by hand, so the name is the user's: a later catalog link (below) resets
        // this, exactly as a pick through the menu does
        nameOverridden: true,
        unitWeightMg: 0,
        qty: 1,
        classification: null,
        sortOrder: 0, // placed below
      };
      const ml = waterPhraseMl(line);
      if (ml != null) {
        item.name = "Water";
        item.unitWeightMg = waterMgFromMl(ml);
        item.weightOverridden = true;
        item.classification = storedClassification("consumable", folderId, snap.folders);
      } else {
        const split = splitWeightTail(line);
        const name = tidyText(split.name);
        if (!name) continue;
        item.name = name;
        if (isWaterName(name)) item.classification = storedClassification("consumable", folderId, snap.folders);
        const mg = split.weight != null ? parseWeightInput(split.weight, snap.displayUnit) : null;
        if (mg != null) {
          item.unitWeightMg = mg;
          item.weightOverridden = true;
          const named = entryUnitFromInput(split.weight!);
          if (named) item.entryUnit = named;
        }
      }
      if (parentId) item.parentId = parentId;
      if (personId) item.personId = personId;
      items.push(item);
    }

    // Slot them in after `src`: the siblings are renumbered to their positions with a
    // gap of items.length opened after src (quiet moves — a shuffle to make room is
    // never news), and the new rows take the gap. Renumbering ALL of them, not just
    // the followers, because sortOrders are not contiguous (deletes leave holes) and a
    // gap counted from src's index would otherwise sort ahead of src itself.
    if (items.length) {
      const sibs = siblingItems(snap.items, folderId, parentId).sort(bySortOrder);
      const at = sibs.findIndex((s) => s.id === afterId) + 1;
      sibs.forEach((s, i) => {
        const order = i < at ? i : i + items.length;
        if (s.sortOrder !== order) dispatch({ t: "moveItem", id: s.id, folderId, sortOrder: order, quiet: true });
      });
      items.forEach((item, k) => {
        item.sortOrder = at + k;
        dispatch({ t: "addItem", item });
      });
    }

    const ids = items.map((i) => i.id);
    const made = items.length;
    if (!made) return "";
    const rows = counted(made, "row");
    const label = capped ? `${rows} (a list holds ${MAX_ITEMS} items; ${capped} did not fit)` : rows;
    offerUndo(label, () => {
      // quiet: undoing the paste means the rows were never there, so the history
      // shouldn't read "Removed" twelve times over. A row nested under a pasted row
      // since (the reducer's removeItem cascades) steps out to the pasted row's place
      // first; it was never part of the paste.
      for (const id of ids) {
        const kids = (snapshot.value?.items ?? []).filter((i) => i.parentId === id);
        const at = snapshot.value?.items.find((i) => i.id === id)?.sortOrder ?? 0;
        kids.forEach((k, n) => dispatch({ t: "moveItem", id: k.id, folderId, parentId, sortOrder: at + n + 1, quiet: true }));
        dispatch({ t: "removeItem", id, quiet: true });
      }
      // and the row the paste landed in goes back to what it was, every field the
      // first line (or its catalog link) could have touched. A row that was the
      // untouched blank of "Add an item" is that again, and goes the way an abandoned
      // blank goes (discardEmpty leaves a named row alone).
      if (before && snapshot.value?.items.some((i) => i.id === before.id)) {
        dispatch({ t: "updateItem", id: before.id, patch: restorePatch(before) });
        discardEmpty(before.id);
      }
    }, "Added");

    // The catalog, asked once for all of them, and for the row pasted INTO as well:
    // it took the paste's first line through the plain free-text commit, which links
    // nothing, and the first line of a list is as likely to name a product as any
    // other. Only while it's unlinked — a linked row already is what it says — and
    // never for a group: a pick can't stamp a weight on one (ItemRow.onNameCommit's
    // guard), so neither does this.
    const isGroup = (id: string) => (snapshot.value?.items ?? []).some((i) => i.parentId === id);
    const live0 = snapshot.value?.items.find((i) => i.id === src.id);
    const askSrc = !!live0 && live0.catalogItemId == null && !!live0.name && !isGroup(live0.id);
    const asked = [...(askSrc ? [{ id: live0!.id, name: live0!.name }] : []), ...items];
    if (asked.length) $fetch<{ matches: (CatalogSearchResult | null)[] }>("/api/catalog/match", {
      method: "POST",
      body: { names: asked.map((i) => ({ name: i.name })) },
    })
      .then(({ matches }) => {
        matches.forEach((row, k) => {
          if (!row) return;
          const live = snapshot.value?.items.find((i) => i.id === asked[k]!.id);
          if (!live || live.catalogItemId != null || live.name !== asked[k]!.name || isGroup(live.id)) return;
          // The product's weight, unless the person's own stands: a weight the pasted
          // line gave, or one they had typed on the row before (weightOverridden). A
          // weight left behind by a PREVIOUS link is not theirs, and would otherwise
          // ride onto the new product marked as a disagreement, with the "suggest a
          // fix" nudge then offering the wrong product's figure to everyone.
          const keeps = !!live.weightOverridden && live.unitWeightMg > 0;
          dispatch({
            t: "updateItem",
            id: live.id,
            patch: {
              name: row.name,
              brand: row.brand ?? "",
              variant: row.variant ?? "",
              commonName: live.commonName ?? row.commonName ?? "",
              nameOverridden: false,
              unitWeightMg: keeps ? live.unitWeightMg : row.weightMg,
              weightOverridden: keeps && live.unitWeightMg !== row.weightMg,
              catalogItemId: row.id,
              catalogWeightMgAtLink: row.weightMg,
              // only a consumable product changes the class, and through
              // storedClassification as a pick does (ItemRow.onNameCommit): null means
              // "follow the folder", so food landing in a food folder keeps following
              // it rather than being pinned. Any other product leaves the row on the
              // folder's default, which is where a typed row sits.
              ...(row.categoryHint === "consumable"
                ? { classification: storedClassification("consumable", live.folderId, snapshot.value!.folders) }
                : {}),
              // the product's calories with its weight; a kept weight keeps its kcal
              ...(keeps ? (live.kcal == null && row.kcal != null ? { kcal: row.kcal } : {}) : { kcal: row.kcal ?? null }),
            },
          });
        });
      })
      .catch(() => {});
    return ids[ids.length - 1] ?? "";
  }
  // Which fields a paste's first line, or the catalog link after it, can change on
  // the row it landed in — the fields its undo puts back. Absent values clear ("" for
  // the text fields, null for the ids), the reducer's own convention.
  function restorePatch(b: Item): ItemPatch {
    return {
      name: b.name,
      brand: b.brand ?? "",
      variant: b.variant ?? "",
      commonName: b.commonName ?? "",
      commonNameOverridden: !!b.commonNameOverridden,
      nameOverridden: !!b.nameOverridden,
      unitWeightMg: b.unitWeightMg,
      weightOverridden: !!b.weightOverridden,
      entryUnit: b.entryUnit ?? null,
      catalogItemId: b.catalogItemId ?? null,
      catalogWeightMgAtLink: b.catalogWeightMgAtLink,
      classification: b.classification,
      kcal: b.kcal ?? null,
    };
  }
  // A row that's still untouched-empty removes itself when focus leaves it (the
  // row calls this on focusout). Quiet — no undo toast: nothing was typed, so
  // nothing is lost. Emptiness is verified against the snapshot HERE, not just
  // in the caller's view, so a stale event can never discard a row with content.
  // The emptiness test on its own, so the row can ask BEFORE it folds away (ItemRow's
  // leave animation runs on the answer, then calls discardEmpty, which asks again).
  function isEmptyRow(id: string): boolean {
    const it = snapshot.value?.items.find((i) => i.id === id);
    if (!it) return false;
    return !(
      // A NAME, A GEAR TYPE, or anything carriesContent counts (shared/weights — the one
      // list, shared with unwrapEmptied, which deletes on the same reasoning). Both of
      // those are the row's own words rather than a value, which is why they are here
      // and not in the shared predicate: a container is nothing BUT a name, so
      // unwrapEmptied has to answer the name question the other way round.
      it.name.trim() !== "" || it.commonName || carriesContent(it) ||
      snapshot.value?.items.some((c) => c.parentId === id) // has nested children
    );
  }
  function discardEmpty(id: string) {
    if (!isEmptyRow(id)) return;
    if (pendingBlankId.value === id) pendingBlankId.value = null;
    // quiet: nothing was ever typed here, so "Removed 1 item" in the history would
    // be describing a row that never existed as far as anyone is concerned
    dispatch({ t: "removeItem", id, quiet: true });
  }
  function updateItem(id: string, patch: ItemPatch) {
    // any real edit means this row is no longer an untouched blank to clean up
    if (pendingBlankId.value === id) pendingBlankId.value = null;
    dispatch({ t: "updateItem", id, patch });
  }
  function removeItem(id: string) {
    const item = snapshot.value?.items.find((i) => i.id === id);
    // removing a parent cascades to its children (reducer) — capture them so undo can
    // restore the whole group
    const kids = (snapshot.value?.items ?? []).filter((i) => i.parentId === id).map((i) => ({ ...i }));
    dispatch({ t: "removeItem", id });
    if (item) {
      const saved = { ...item };
      offerUndo(item.name || "Item", () => {
        dispatch({ t: "addItem", item: saved }); // parent first, so children re-link
        for (const k of kids) dispatch({ t: "addItem", item: k });
      });
    }
  }
  function setItemWeight(id: string, raw: string) {
    if (!snapshot.value) return;
    // clearing the weight clears the remembered unit with it — an empty field has
    // named nothing, and leaving a stale "oz" behind would relabel the next entry
    if (raw.trim() === "")
      return updateItem(id, { unitWeightMg: 0, weightOverridden: true, entryUnit: null });

    // The unit this row is currently READING in — the one printed beside the field.
    // It has to be the parse default, not the list's: on a row showing "3.8 oz",
    // typing a bare "4.2" means 4.2 ounces. Defaulting to the list unit there would
    // silently reinterpret the number as grams and the row would jump.
    const current = snapshot.value.items.find((i) => i.id === id)?.entryUnit;
    const readingIn = current ?? snapshot.value.displayUnit;

    const mg = parseWeightInput(raw, readingIn);
    if (mg === null) return;
    updateItem(id, {
      unitWeightMg: mg,
      weightOverridden: true,
      // naming a unit re-labels the row; a bare number (or a compound, which names
      // no single unit) leaves the label exactly as it was — so arrow-stepping and
      // editing just the digits both keep the row in the unit you chose.
      entryUnit: entryUnitFromInput(raw) ?? current ?? null,
    });
  }

  // The wrap/unwrap pair and the reindexing move live in useGearListNesting; covered by
  // tests/itemNesting.nuxt.test.ts. discardEmpty is a hoisted declaration, so handing it
  // over above the return is safe, and it stays the one implementation both share.
  const { addChild, nestItem, unnest, moveItem, duplicateItem } = createNesting({
    snapshot,
    dispatch,
    pendingBlankId,
    discardEmpty,
  });

  return {
    setMeta, setUnit, addFolder, updateFolder, moveFolderBefore, addDay,
    updateDay, addWaypoint, ensureRouteEnds, updateWaypoint, removeWaypoint, removeDay,
    addPerson, updatePerson, removePerson, removeFolder, addBlankItem, addVaultItem,
    addBlankItemAfter, pasteItemsAfter, isEmptyRow, discardEmpty, updateItem, removeItem,
    setItemWeight,
    addChild, nestItem, unnest, moveItem, duplicateItem,
  };
}
