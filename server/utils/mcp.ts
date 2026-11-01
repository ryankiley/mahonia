// The tools an assistant gets when Mahonia is added as a connector.
//
// Two capabilities already exist and nothing here mints a third. A SHARE CODE is the
// read capability: whoever holds a share link can read that list, and the read tools
// take the code (or the whole link) and hand back what the share page shows, as data
// or as Markdown, plus the catalog. An EDIT LINK is the write capability: the token in
// its fragment is what the edit endpoints already take as a bearer, and the write tools
// take the link as an argument, hash the token the same way (server/utils/editAuth) and
// reach the same repo functions. An assistant holding an edit link is in the position a
// person holding one is in, no more. It travels in the JSON-RPC body and never in a
// query string, and nothing here logs it.
//
// The account tools are the one exception, and they bring the one credential that is
// neither a share code nor an edit link. An account's lists and its gear belong to the
// account, not to a link, so there is nothing for a tool argument to carry; the account
// tools instead take a bearer in the Authorization header — a token
// minted by hand on the account page (server/utils/accessTokens.ts), or the access
// token of an app the person signed in through the connector's OAuth flow
// (server/utils/oauth.ts). The list tools never look at that header, with one
// exceptions: a get_list with no share_code is asking for the lists filed under the
// account, and an edit_list that names its list by share_code rather than by edit link
// is asking to change one of them; each is an account tool for that call (byAccount).
// The route checks the header for the account tools before any of them
// runs and answers a missing one with the 401 that starts a sign-in (mcp.post.ts); the
// account section at the end of this file is what runs once it has passed.
//
// The protocol layer (JSON-RPC over one HTTP endpoint) is server/routes/mcp.post.ts;
// this file is the tools, so they can be tested as functions and read as a list.

import type { H3Event } from "h3";
import { listToMarkdown } from "../../shared/exporters/markdown";
import { exportSections } from "../../shared/exporters/rows";
import { colorKeyForName, usedColorKeys } from "../../shared/categories";
import { uid } from "../../shared/id";
import { editLinkPath, normalizeShareCode } from "../../shared/links";
import { applyOps, isCatalogId, isSerialId, type ItemPatch, MAX_CATALOG_ID, MAX_FOLDER_NAME_LEN, MAX_FOLDERS, MAX_GEAR_TYPE_LEN, MAX_ITEM_NAME_LEN, MAX_ITEM_NOTE_LEN, MAX_ITEMS, MAX_TITLE_LEN, normalizeCalendarDate, type Op } from "../../shared/ops";
import { carrierName } from "../../shared/people";
import { dayClimbs, parseProfile } from "../../shared/profile";
import { enoughToSearch } from "../../shared/searchText";
import { tidyText } from "../../shared/tidyText";
import { CLEARS_WITH_LINK, normalizeTrailUrl } from "../../shared/trailLink";
import { dayLabel } from "../../shared/tripDay";
import { UNITS, WEIGHT_SOURCES, type Classification, type Folder, type Item, type ListData, type ListSnapshot, type ListState, type Unit, CLASSIFICATIONS } from "../../shared/types";
import { captureFromList, type VaultEntry } from "../../shared/vault";
import { bySortOrder, computeTotals, effectiveClassification, itemDisplayName, nextSortOrder, siblingItems } from "../../shared/weights";
import type { AccessScope } from "../../shared/types";
import { catalogRowsById, productVariants, searchCatalog } from "./catalog";
import { claimLists, claimedEditHash, listClaimedLists } from "./claimRepo";
import { useAccountDb, useCatalogDb, useVaultDb, type Db } from "./db";
import { applyOpsByEditHash, createList, getByEditHash, getByShareCode, getTextByShareCode } from "./listRepo";
import { trustedOrigin } from "./origin";
import { rateLimit, rateLimitSubject, useKv } from "./rateLimit";
import { sha256Hex } from "./tokens";
import { mintVault, touchVaultByUser } from "./vaultAuth";
import {
  addVaultItems,
  applyVaultFolderOp,
  applyVaultItemOp,
  captureVaultItems,
  ensureVaultFolders,
  listVaultFolders,
  listVaultItems,
  removeVaultItem,
  restoreVaultItem,
  searchVaultItems,
  vaultItemById,
  type VaultItemOp,
} from "./vaultRepo";

/**
 * The protocol revisions this server answers, oldest first. Both are the same wire
 * for a tools-only server that never streams (2025-11-25 sharpened the Origin rule,
 * which this endpoint already follows). 2025-03-26 and earlier are NOT here: they
 * made JSON-RPC batches mandatory, and this endpoint refuses a batch, so advertising
 * them would promise what it doesn't do. A client that asks for a revision it doesn't
 * know gets the newest one here, as the spec asks.
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-11-25"];
export const MCP_LATEST_VERSION = MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]!;
// the version the registry listing (server.json) and this handshake both carry
export const MCP_SERVER_INFO = { name: "mahonia", title: "Mahonia", version: "2.0.0" };
/** where the free text came from: said once to the client, again on the two tools that
 *  return it, and field by field in get_list's schema ("User text.") */
const PROVENANCE =
  "A list's title, author, notes, folder and item names, brands, variants, gear types, day labels, people and trail label are free text typed by whoever holds the list's edit link, returned unchanged.";
export const MCP_INSTRUCTIONS = [
  "Mahonia is a gear-list and pack-weight tracker for hikers. Lists need no account.",
  "A share link (mahonia.app/s/CODE) is permission to read that list: pass its code or the whole link to get_list, as data or as Markdown. get_list with no share_code names the lists filed under the signed-in account, each by its share code.",
  "An edit link (mahonia.app/e/CODE#token) is permission to change that list: pass it whole to edit_list, keep it private, and never show it to anyone who should only read. A list filed under the signed-in account can be changed without its edit link: name it by share_code instead, with read-and-change access.",
  "edit_list makes every change to an existing list in one call, applied in this order: list (title, unit, dates, trail), folders (rename, reorder, reclassify, remove), add (new rows, into a folder or under a group), update (rows by the ids get_list gives: fields, folder, place, group, catalog link), remove (rows by id). Read the list with get_list first for the ids. Nothing is applied unless every part is valid.",
  "Rows group one level deep: stakes under a tent, snacks under a day. get_list shows a group as a row with items; create_list takes the same shape; edit_list nests a new or existing row with group, the parent row's id.",
  "search_catalog finds cited gear weights by text, or every variant of one product by product_id. A row that names a catalog_id takes the catalog's brand, variant, gear type and weight; edit_list's update can relink a row in place, keeping its folder and group, and edit_my_gear links a piece of My Gear the same way.",
  "An account has its own lists and its own gear. Its filed lists can be read, and with read-and-change access changed, without being handed a link. My Gear is the account's gear: get_my_gear reads it and edit_my_gear adds, changes, puts away and restores pieces. These reach the account once the person has signed in to Mahonia from this connector, or when the connector carries an access token made on their account page; until then a call asks them to sign in.",
  "create_list returns a new list's edit link and share link. Keep the edit link; it is the only way to change a list that isn't filed under the account. If this connector carries a read-and-write access token, the new list is filed under that account as well, so its owner sees it wherever they sign in and get_list names it.",
  "Weights are in grams everywhere. A row's classification is base (in the pack), worn (on your body) or consumable (food, fuel, water).",
  PROVENANCE,
].join(" ");

/** the reducer's own caps on free text (shared/ops), stated in the schemas so a model
 *  knows them before a value is quietly cut to fit */
const BRAND_LEN = 120;
const TRAIL_URL_LEN = 2000;
const TRAIL_LABEL_LEN = 120;

const SEARCH_LIMIT_MAX = 25;
const SEARCH_LIMIT_DEFAULT = 12;
const QTY_MAX = 9999;

/** the fields of one row, as create_list and edit_list's add take them */
const ROW_FIELDS = {
  name: { type: "string", minLength: 1, maxLength: MAX_ITEM_NAME_LEN, description: "The product or item name. Required." },
  brand: { type: "string", maxLength: BRAND_LEN, description: "The maker, when known." },
  variant: { type: "string", maxLength: BRAND_LEN, description: "Size, length or configuration that changes the weight, such as Long or 20F." },
  gear_type: { type: "string", maxLength: MAX_GEAR_TYPE_LEN, description: "What kind of thing it is: Tent, Quilt, Trail runners." },
  weight_g: { type: "number", minimum: 0, description: "Weight of ONE unit, in grams. Omit when unknown; the list keeps working without it, and a row with a catalog_id takes the catalog's cited weight." },
  qty: { type: "integer", minimum: 1, maximum: QTY_MAX, description: "How many. Default 1." },
  classification: { type: "string", enum: CLASSIFICATIONS, description: "base, worn or consumable. Omit to follow the folder's default." },
  worn_qty: { type: "integer", minimum: 0, description: "Of qty, how many are worn rather than carried (three pairs of socks, one on your feet). For a row that is entirely worn, set classification to worn instead." },
  note: { type: "string", maxLength: MAX_ITEM_NOTE_LEN, description: "A short free-text note on the row." },
  kcal: { type: "integer", minimum: 0, description: "Calories per unit, for food." },
  needs_cooking: { type: "boolean", description: "Food to cook on this trip. Each unit assumes one boil for a rough fuel estimate; no quantity or weight changes." },
  catalog_id: { type: "integer", minimum: 1, maximum: MAX_CATALOG_ID, description: "A catalog row id from search_catalog. The row takes the catalog's brand, name, variant, gear type and cited weight, and follows catalog corrections; a weight_g given as well is kept as your own figure." },
} as const;
/** a row nested under another: the same fields, in its parent's folder */
const NESTED_ITEM_SCHEMA = { type: "object", properties: ROW_FIELDS, required: ["name"] } as const;
/** one row as create_list takes it: its fields, its folder, and the rows nested under it */
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    ...ROW_FIELDS,
    folder: { type: "string", maxLength: MAX_FOLDER_NAME_LEN, description: "The folder to put it in, by name. Created when the list has no folder of that name." },
    items: {
      type: "array",
      description: "Rows nested under this one, making it a group: stakes under a tent, snacks under a day. One level deep; a nested row is in its parent's folder.",
      items: NESTED_ITEM_SCHEMA,
    },
  },
  required: ["name"],
} as const;
/** one row as edit_list's add takes it: create_list's, or nested under a row already on the list */
const ADD_ITEM_SCHEMA = {
  type: "object",
  properties: {
    ...ITEM_SCHEMA.properties,
    group: { type: "string", description: "The id of a top-level row already on the list, from get_list, to nest this row under: it joins that group, in the group's folder. Not with folder or items." },
  },
  required: ["name"],
} as const;

const SHARE_ARG = {
  type: "string",
  description: "The list's share code, its share link (mahonia.app/s/CODE), or its edit link. From an edit link only the code in the address is read, never the part after #.",
};
const EDIT_ARG = {
  type: "string",
  description: "The list's edit link, whole (mahonia.app/e/CODE#token). The part after # is the write capability. Leave it out to name a list filed under the signed-in account by share_code instead.",
};
const BY_ACCOUNT_ARG = {
  type: "string",
  description: "Instead of the edit link: the share code or share link of a list filed under the connector's account, as get_list with no share_code gives it. Takes a sign-in with read-and-change access, and reaches only the lists that account has filed.",
};

// ---- what the tools hand back ---------------------------------------------------
// The result shapes as JSON Schema (MCP's outputSchema), declared so a client that
// validates structured results can, and so the field set is documented where the tool
// is. "User text" marks a field somebody typed into the list; the rest is the server's.
// A stored number is declared `number`, not `integer`: the reducer rounds every one on
// the way in, but a read doesn't check, and a schema is a promise about what THIS code
// hands back, not about what the writer meant to store. `integer` is for figures this
// file computes. additionalProperties is left open on purpose, so a field added later
// doesn't fail a client that validated against the old listing; the test helper closes
// it, so a field added to a producer and not declared here fails the suite instead.

const USER_TEXT = "User text.";
const str = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const nullable = (type: "string" | "number", description?: string) => ({ type: [type, "null"], ...(description ? { description } : {}) });
/** an object every one of whose fields is always present; the schemas that leave a
 *  field out sometimes (a kcal total, a day's label) list their `required` by hand */
const complete = (properties: Record<string, unknown>, description?: string) => ({
  type: "object",
  ...(description ? { description } : {}),
  properties,
  required: Object.keys(properties),
});

const UNIT_SCHEMA = { type: "string", enum: UNITS, description: "The unit the list displays in. Weights are in grams regardless." };

const TOTALS_SCHEMA = {
  type: "object",
  description: "Whole grams, summed over every row of the list.",
  properties: {
    base_g: { type: "integer", description: "In the pack, consumables aside." },
    worn_g: { type: "integer", description: "On your body." },
    consumable_g: { type: "integer", description: "Food, fuel, water." },
    carried_g: { type: "integer", description: "base_g plus consumable_g: what is on your back." },
    total_g: { type: "integer", description: "carried_g plus worn_g." },
    item_count: { type: "integer", description: "Rows, nested ones included." },
    kcal: { type: "number", description: "Only when a food row carries calories." },
  },
  required: ["base_g", "worn_g", "consumable_g", "carried_g", "total_g", "item_count"],
};

/** one row of get_list; a nested row is the same minus its own nesting */
const ROW_PROPS = {
  id: str("The row's id, which edit_list's update, remove and group take."),
  name: str(`The product name, without brand or variant. ${USER_TEXT}`),
  display_name: str("Brand, name and variant joined, the way the list shows the row."),
  qty: { type: "number", description: "How many; weight_g is for one." },
  weight_g: { type: "number", description: "One unit, in grams to a tenth. 0 when the row has no weight." },
  classification: { type: "string", enum: CLASSIFICATIONS, description: "The row's own, or its folder's when it has none." },
  brand: str(USER_TEXT),
  variant: str(`Size, length or configuration. ${USER_TEXT}`),
  gear_type: str(`What kind of thing it is. ${USER_TEXT}`),
  worn_qty: { type: "number", description: "Of qty, how many are worn rather than carried." },
  note: str(USER_TEXT),
  kcal: { type: "number", description: "Calories per unit." },
  needs_cooking: { type: "boolean", description: "Food marked for cooking on this trip." },
  catalog_id: { type: "number", description: "The catalog row the item was picked from." },
  carried_by: str(`Who carries it. A nested row without one is carried by its parent's carrier. ${USER_TEXT}`),
};
const ROW_REQUIRED = ["id", "name", "display_name", "qty", "weight_g", "classification"];
const NESTED_ROW = { type: "object", properties: ROW_PROPS, required: ROW_REQUIRED };
const ROW = {
  type: "object",
  properties: {
    ...ROW_PROPS,
    items: { type: "array", description: "Rows nested under this one. The parent's weight_g is its own, not the group's.", items: NESTED_ROW },
  },
  required: ROW_REQUIRED,
};

const DATES_SCHEMA = complete({ start: nullable("string", "YYYY-MM-DD."), end: nullable("string", "YYYY-MM-DD.") });
const TRAIL_SCHEMA = complete({
  url: nullable("string"),
  label: nullable("string", USER_TEXT),
  distance_m: nullable("number"),
  ascent_m: nullable("number"),
  descent_m: nullable("number"),
});

const LIST_DATA = {
  type: "object",
  description: "The list as data: format data, the default.",
  properties: {
    title: str(USER_TEXT),
    share_code: str("The list's share code, the read capability."),
    share_link: str("The list's share link."),
    unit: UNIT_SCHEMA,
    totals: TOTALS_SCHEMA,
    description: str(`The list's own notes. ${USER_TEXT}`),
    dates: DATES_SCHEMA,
    trail: TRAIL_SCHEMA,
    days: {
      type: "array",
      description: "The trip's days in order, when the owner has planned them.",
      items: {
        type: "object",
        properties: {
          day: str("Day 1; with trip dates, the weekday too: Saturday, Day 1."),
          label: str(`The owner's name for the day. ${USER_TEXT}`),
          distance_m: nullable("number"),
          ascent_m: nullable("number", "Typed by the owner, or read off the route's profile."),
        },
        required: ["day", "distance_m", "ascent_m"],
      },
    },
    people: { type: "array", items: str(USER_TEXT), description: "The people who carry the list's rows, when it names any." },
    author: str(USER_TEXT),
    truncated: {
      type: "object",
      description:
        "Present only when the list was too large to return whole, naming what was cut: notes (true: every row's note), rows (how many came off the end, nested rows counted), fields (which of description, days, trail and people went, only when the rest alone was too large). The totals still count every row. The Markdown form holds about three times as many rows, without notes, and is cut the same way only past that.",
      properties: {
        notes: { type: "boolean" },
        rows: { type: "integer" },
        fields: { type: "array", items: { type: "string", enum: ["description", "days", "trail", "people"] } },
      },
    },
    folders: {
      type: "array",
      description: "In the list's order, each with its rows in order. A folder with no rows is left out; rows in no folder come last, under Unfiled, which has no id.",
      items: {
        type: "object",
        properties: { id: str("The folder's id, which edit_list's folders takes."), name: str(USER_TEXT), items: { type: "array", items: ROW } },
        required: ["name", "items"],
      },
    },
  },
  required: ["title", "share_code", "share_link", "unit", "totals", "folders"],
};
const LIST_MARKDOWN = complete(
  {
    share_code: str("The list's share code, the read capability."),
    share_link: str("The list's share link."),
    markdown: str("One table per folder and a totals block, the text the site's own Markdown export produces; also the whole of the text content."),
  },
  "The list as Markdown: format markdown.",
);
/** get_list's answer takes one of three shapes: the list as data or as Markdown, by the
 *  format asked for, or the account's lists when no share_code was given (MY_LISTS,
 *  declared with the account schemas below) */
let LIST_OUTPUT: Record<string, unknown> = {};

/** one catalog row, in the two catalog tools' common fields */
const CATALOG_ROW = {
  id: { type: "integer", description: "The catalog row id, the one create_list and edit_list take as catalog_id." },
  variant: nullable("string", "Size, length or rating; null on a product sold one way."),
  weight_g: { type: "number", description: "The cited weight in grams, to a tenth." },
  verified: { type: "boolean", description: "Whether the cited weight has been verified." },
  weight_source: { type: "string", enum: WEIGHT_SOURCES, description: "Where the weight comes from." },
  kcal: nullable("number", "Calories per unit, on food."),
};

const CATALOG_RESULT = {
  type: "object",
  properties: {
    ...CATALOG_ROW,
    brand: nullable("string"),
    name: str("The product name, without brand or variant."),
    display_name: str("Brand, name and variant joined."),
    gear_type: nullable("string", "What kind of thing it is: Tent, Quilt, Trail runners."),
    category: nullable("string", "The catalog's category: shelter, sleep, pack, and so on."),
    source_url: nullable("string", "The page the weight was read from. On a product's variants."),
  },
  required: [...Object.keys(CATALOG_ROW), "brand", "name", "display_name", "gear_type", "category"],
};
const CATALOG_OUTPUT = {
  type: "object",
  properties: {
    query: str("The query as searched: trimmed, at most 100 characters. On a search."),
    product: complete(
      { brand: nullable("string"), name: str("The product name, without brand or variant."), gear_type: nullable("string"), category: nullable("string") },
      "The product looked up, when one was.",
    ),
    results: { type: "array", description: "A search's matches, best first; or a product's variants, in variant order.", items: CATALOG_RESULT },
  },
  required: ["results"],
};

const CREATE_FIELDS = {
  title: str(USER_TEXT),
  edit_link: str("The write capability. Keep it; it is the only way to change a list that isn't filed under an account."),
  share_link: str("The read capability, safe to pass on."),
  share_code: str(),
  folders: { type: "integer", description: "Folders made." },
  items: { type: "integer", description: "Rows made." },
  totals: TOTALS_SCHEMA,
  saved_to_account: { type: "boolean", description: "True when the connector's read-and-write access token filed the list under its account, where the owner sees it on every device they sign in on." },
};
const CREATE_OUTPUT = {
  type: "object",
  properties: {
    ...CREATE_FIELDS,
    account_note: str("Only when the connector sent an access token and the list still could not be filed under its account: the reason, and what to do instead."),
  },
  required: Object.keys(CREATE_FIELDS),
};

const EDIT_LIST_OUTPUT = complete({
  title: str(USER_TEXT),
  unit: UNIT_SCHEMA,
  dates: { ...DATES_SCHEMA, type: ["object", "null"] },
  trail: { ...TRAIL_SCHEMA, type: ["object", "null"] },
  share_link: str(),
  totals: TOTALS_SCHEMA,
  added: { type: "integer", description: "Rows added, nested ones counted." },
  updated: { type: "integer", description: "Rows changed, moved or regrouped." },
  removed: { type: "integer", description: "Rows taken off: by remove, with a removed group, or with a removed folder." },
  folders_changed: { type: "integer", description: "Folders renamed, reordered, reclassified or removed." },
  folders_made: { type: "array", items: str(USER_TEXT), description: "Folders that didn't exist and were made for rows named into them." },
  folders: { type: "array", items: str(USER_TEXT), description: "Every folder's name, in the list's order, after the change." },
  repeated: {
    type: "boolean",
    description: "True when this call, with rows to add, repeated one made in the last ten minutes: nothing was done again, and the figures are that call's. Pass again: true to do it a second time.",
  },
});

/** how many rows or folders one edit call may touch */
const EDIT_MAX = 200;

/** One row's changes for edit_list's update: the row by id, then any of the fields
 *  create_list takes, each nullable where it can be cleared, its catalog link, and where
 *  the row goes: folder, place and group. */
const UPDATE_ITEM_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "The row's id, from get_list." },
    name: { type: "string", minLength: 1, maxLength: MAX_ITEM_NAME_LEN, description: "A new name. A row keeps a name; it can't be cleared." },
    brand: { type: ["string", "null"], maxLength: BRAND_LEN, description: "The maker. Null clears it." },
    variant: { type: ["string", "null"], maxLength: BRAND_LEN, description: "Size, length or configuration. Null clears it." },
    gear_type: { type: ["string", "null"], maxLength: MAX_GEAR_TYPE_LEN, description: "What kind of thing it is. Null clears it." },
    weight_g: { type: "number", minimum: 0, description: "Weight of ONE unit, in grams. Kept as your own figure on a row picked from the catalog." },
    qty: { type: "integer", minimum: 1, maximum: QTY_MAX },
    classification: { type: ["string", "null"], enum: [...CLASSIFICATIONS, null], description: "base, worn or consumable; null to follow the folder's default." },
    worn_qty: { type: "integer", minimum: 0, description: "Of qty, how many are worn rather than carried; 0 removes the split." },
    note: { type: ["string", "null"], maxLength: MAX_ITEM_NOTE_LEN, description: "The row's note. Null clears it." },
    kcal: { type: ["integer", "null"], minimum: 0, description: "Calories per unit, for food. Null clears it." },
    needs_cooking: { type: "boolean" },
    carried_by: { type: ["string", "null"], description: "Who carries it, by the name the list gives that person. Null clears it." },
    catalog_id: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: MAX_CATALOG_ID,
      description: "Link or relink the row to this catalog row, from search_catalog: it takes the catalog's brand, name, variant, gear type and cited weight, follows catalog corrections, and keeps its folder, place and group. A name, weight_g or gear_type given in the same change is kept as your own. Null unlinks the row, leaving it as it reads.",
    },
    folder: { type: "string", maxLength: MAX_FOLDER_NAME_LEN, description: "Move the row to this folder, by name; a new name makes the folder, and an empty string takes it out of every folder. A nested row moved to another folder comes out of its group." },
    position: { type: "integer", minimum: 0, description: "Where the row goes among its neighbours, 0 for first. Without it a row moved to another folder or group goes last." },
    group: { type: "string", description: "Nest the row under this top-level row, by its id from get_list, in that row's folder; an empty string takes it out of its group, to the top level of its folder. A row with rows under it can't be nested." },
  },
  required: ["id"],
} as const;

// ---- Your lists -------------------------------------------------------------------
// The lists filed under one account, as the account page's "Your lists" shows them.
// Each is named by its share code, the read capability, and never by its edit token:
// the connector changes a list the way a person does, by holding its edit link. The
// capability is the access token in the Authorization header rather than an argument;
// the account section at the end says how that is read.

const MY_LISTS = complete(
  {
    lists: {
      type: "array",
      description: "Most recently changed first.",
      items: complete({
        title: str(USER_TEXT),
        share_code: str("Pass it to get_list, or to edit_list as share_code."),
        share_link: str("The same code as a link."),
        unit: UNIT_SCHEMA,
        total_g: { type: "number", description: "Everything on the list in grams, worn and consumable rows included." },
        updated_at: str("When the list last changed, ISO 8601."),
      }),
    },
  },
  "The lists filed under the account: no share_code.",
);
LIST_OUTPUT = { type: "object", anyOf: [LIST_DATA, LIST_MARKDOWN, MY_LISTS] };

// ---- My Gear ---------------------------------------------------------------------
// One account's gear. Its capability is the access token in the Authorization header
// rather than an argument; the account section at the end says how that is read.

const GEAR_ROW = complete({
  id: { type: "integer", description: "Names the piece to edit_my_gear." },
  display_name: str(`Brand, name and variant joined, the way the gear page shows a piece. ${USER_TEXT}`),
  name: str(USER_TEXT),
  brand: nullable("string", USER_TEXT),
  variant: nullable("string", USER_TEXT),
  gear_type: nullable("string", `Tent, Quilt, Stove. ${USER_TEXT}`),
  weight_g: { type: "number", description: "Grams for one, to a tenth; 0 when it has never been weighed." },
  classification: { type: ["string", "null"], enum: [...CLASSIFICATIONS, null], description: "base, worn or consumable; null when the owner leaves it to each list." },
  kcal: nullable("number", "Calories in one, on food."),
  catalog_id: nullable("number", "The catalog row the piece is linked to; null when it isn't."),
  note: nullable("string", USER_TEXT),
  price: nullable("number", "What one cost, in the currency's main unit."),
  currency: nullable("string", "ISO 4217 code of price, when one was recorded."),
  product_url: nullable("string"),
  folder: nullable("string", `The folder it is filed in; null when unfiled. ${USER_TEXT}`),
  times_used: { type: "integer", description: "How many list saves have carried this piece into My Gear." },
  last_used: str("When a list last carried it, ISO 8601."),
});
const GEAR_LIST_OUTPUT = complete({
  gear: { type: "array", items: GEAR_ROW, description: "This page of the matches." },
  folders: { type: "array", items: str(USER_TEXT), description: "Every folder My Gear has, in the owner's order, empty ones included." },
  total: { type: "integer", description: "Matches in all, before offset and limit." },
  offset: { type: "integer" },
});
const GEAR_EDIT_OUTPUT = complete({
  added: { type: "integer", description: "Pieces that were new to My Gear." },
  results: {
    type: "array",
    description: "One per piece in add, in the order sent.",
    items: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Position in add." },
        status: { type: "string", enum: ["added", "already_have", "invalid", "full"], description: "already_have: the same brand, name and variant is there already, untouched. invalid: no name. full: My Gear is at its ceiling." },
        item: GEAR_ROW,
      },
      required: ["index", "status"],
    },
  },
  updated: {
    type: "array",
    description: "One per entry in update, in the order sent.",
    items: {
      type: "object",
      properties: {
        id: { type: "integer" },
        status: { type: "string", enum: ["updated", "not_found", "invalid"], description: "invalid: nothing to change, or a change that would not leave a valid piece; nothing was changed on it." },
        item: GEAR_ROW,
      },
      required: ["id", "status"],
    },
  },
  removed: {
    type: "array",
    description: "One per id in remove, then one per id in restore, in the order sent.",
    items: complete({ id: { type: "integer" }, status: { type: "string", enum: ["removed", "restored", "not_found"] } }),
  },
});

const GEAR_PAGE_MAX = 1000;
const GEAR_PAGE_DEFAULT = 300;
/** how many pieces one part of an edit_my_gear call may name */
const GEAR_EDIT_MAX = 50;
/** the vault's own caps on free text (shared/vault), stated in the schemas the way
 *  the reducer's are above */
const GEAR_NAME_LEN = 200;
const GEAR_FIELD_LEN = 120;
const GEAR_NOTE_LEN = 2000;

/**
 * The fields of one piece of gear as edit_my_gear takes them. In add every field is a
 * value; in update each may also be null, which clears it, and the descriptions say so.
 */
function gearInput(mode: "add" | "update") {
  const nullable = mode === "update";
  const t = (type: string) => (nullable ? [type, "null"] : type);
  const orNull = nullable ? " Null clears it." : "";
  return {
    name: { type: "string", minLength: 1, maxLength: GEAR_NAME_LEN, description: "The product or item name, without brand or variant." },
    brand: { type: t("string"), maxLength: GEAR_FIELD_LEN, description: `The maker.${orNull}` },
    variant: { type: t("string"), maxLength: GEAR_FIELD_LEN, description: `Size, length or rating: Long, 20F.${orNull}` },
    gear_type: { type: t("string"), maxLength: GEAR_FIELD_LEN, description: `What kind of thing it is: Tent, Quilt.${orNull}` },
    weight_g: { type: "number", minimum: 0, description: "Grams for one. 0 records it as not weighed yet." },
    classification: { type: t("string"), enum: nullable ? [...CLASSIFICATIONS, null] : CLASSIFICATIONS, description: `base, worn or consumable.${orNull}` },
    kcal: { type: t("integer"), minimum: 0, description: `Calories in one, for food.${orNull}` },
    catalog_id: {
      type: t("integer"),
      minimum: 1,
      maximum: MAX_CATALOG_ID,
      description: nullable
        ? "Link or relink the piece to this catalog row, from search_catalog: it takes the catalog's brand, name, variant, gear type and weight, each unless given here. Null unlinks it, leaving the piece as it reads."
        : "A catalog row from search_catalog. The piece takes the catalog's brand, name, variant, gear type and weight, each unless given here; a name can be left out.",
    },
    note: { type: t("string"), maxLength: GEAR_NOTE_LEN, description: `A note about the piece itself, not about any one trip.${orNull}` },
    product_url: { type: t("string"), maxLength: TRAIL_URL_LEN, description: `The maker's or a shop's page for it.${orNull}` },
    price: { type: t("number"), minimum: 0, description: `What one cost, in the currency's main unit: 199.95.${orNull}` },
    currency: { type: "string", minLength: 3, maxLength: 3, description: "ISO 4217 code for price, such as USD. Ignored without a price." },
    folder: {
      type: "string",
      maxLength: MAX_FOLDER_NAME_LEN,
      description: nullable ? "The folder to file it in, by name; a new name makes the folder, and an empty string unfiles it." : "The folder to file it in, by name; a new name makes the folder.",
    },
  };
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** the shape of structuredContent, on every tool that returns it */
  outputSchema?: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

type McpToolHandler = (event: H3Event, args: Record<string, unknown>) => Promise<ToolResult>;
type RegisteredMcpTool = McpTool & {
  run: McpToolHandler;
  /** what the tool wants from the account behind the request's bearer: the scope it
   *  can't run without, or "optional" for a tool that uses one when it is there, or a
   *  rule that answers from the call's arguments. The route reads this before dispatch
   *  (mcp.post.ts); unset means the tool never looks. */
  account?: AccessScope | "optional" | ((args: Record<string, unknown>) => AccessScope | "optional" | undefined);
};

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// destructive, honestly: an edit REPLACES a title, clears a field, removes a row, and
// the hint's own definition says false means additive updates only; and not idempotent,
// since the same add twice is two sets of rows (the replay window below is the guard)
const EDIT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

/** How edit_list names its list decides what it wants from the account. By edit
 *  link, the capability itself, it never looks. By share_code, a list filed under the
 *  signed-in account, it needs read-and-change access, and asking at the door is what
 *  gets a missing sign-in the Connect card and a read-only one the step-up, rather
 *  than a sentence (mcp.post.ts). An edit link given beside a share code is the one
 *  used: it is the capability in hand. */
const namesByAccount = (args: Record<string, unknown>) => args.edit_link == null && typeof args.share_code === "string";
const byAccount = (args: Record<string, unknown>): AccessScope | undefined => (namesByAccount(args) ? "write" : undefined);

const MCP_TOOL_REGISTRY: RegisteredMcpTool[] = [
  {
    name: "get_list",
    title: "Read a list",
    description: `A shared list by its share code or link, as data or as Markdown; or, with no share_code, the lists filed under the connector's account. Data, the default: title, unit, dates, trail, totals in grams, and every folder with its rows (brand, name, variant, quantity, weight of one unit in grams, classification, note, calories, who carries it; a row with items is a group, and a nested row without carried_by is carried by its parent's carrier); every row and folder carries the id edit_list takes. Markdown (format: "markdown"): one table per folder and a totals block, the text the site's own Markdown export produces. An edit link's address carries the share code too. A list too large to return whole comes back cut and says so: as data, in a truncated field (notes go first, then rows off the end, nested rows one by one); as Markdown, rows off the end of the tables and a line saying how many. The totals still count every row. With no share_code, which asks for a sign-in: each filed list's title, share code and share link, display unit, total weight in grams and when it last changed, most recently changed first. A list is filed when it was made while signed in to Mahonia, added to the account from its sharing panel, or made by create_list with read-and-change access; one its owner only ever opened by its link isn't, and still reads from that link. ${PROVENANCE}`,
    inputSchema: {
      type: "object",
      properties: {
        share_code: SHARE_ARG,
        format: { type: "string", enum: ["data", "markdown"], description: "data (the default) or markdown. Only with a share_code." },
      },
    },
    outputSchema: LIST_OUTPUT,
    annotations: READ,
    // no share_code names nothing a link could: that call is the account's, read scope
    account: (args) => (args.share_code == null ? "read" : undefined),
    run: getList,
  },
  {
    name: "search_catalog",
    title: "Search the gear catalog",
    description:
      "Mahonia's cited gear catalog. With query: a fuzzy search by brand, product or kind of gear (\"duplex\", \"zpacks\", \"quilt\"), best first, each result a catalog row with its id, the cited weight in grams and whether it is verified. With product_id (a row id from a search), or brand and name: every variant of that one product (sizes, lengths, temperature ratings) with the weight and source of each. A row on a list that names a catalog_id takes the catalog's brand, variant, gear type and weight.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for: two characters or more, or a single Chinese character." },
        limit: { type: "integer", minimum: 1, maximum: SEARCH_LIMIT_MAX, description: `Matches to return, up to ${SEARCH_LIMIT_MAX}. Default ${SEARCH_LIMIT_DEFAULT}.` },
        product_id: { type: "integer", minimum: 1, description: "Instead of a query: a catalog row id, for that product's variants." },
        brand: { type: "string", description: "With name, instead of a query: the product's maker." },
        name: { type: "string", description: "With brand, instead of a query: the product name without brand or variant." },
      },
    },
    outputSchema: CATALOG_OUTPUT,
    annotations: READ,
    run: (_event, args) => catalog(args),
  },
  {
    name: "create_list",
    title: "Make a new list",
    description:
      "Creates a list and returns its edit link and share link. Optionally with a title, unit, trip dates, a trail link and rows, grouped into folders; a row with items nested under it is a group (stakes under a tent, snacks under a day). Keep the edit link: it is the only way to change a list that isn't filed under an account. If this connector carries a read-and-write access token the list is filed under that account too, and saved_to_account says whether it was; otherwise the list belongs to whoever holds the edit link, as every list does.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: MAX_TITLE_LEN },
        unit: UNIT_SCHEMA,
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
        trail_url: { type: "string", maxLength: TRAIL_URL_LEN, description: "An http(s) link to the route or trail page." },
        trail_label: { type: "string", maxLength: TRAIL_LABEL_LEN, description: "What to call the trail, when the link's own name won't do." },
        trail_distance_km: { type: "number", minimum: 0 },
        folders: {
          type: "array",
          description: "Folders in order, each with its default classification and, optionally, its rows.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 1, maxLength: MAX_FOLDER_NAME_LEN },
              classification: { type: "string", enum: CLASSIFICATIONS, description: "What rows in this folder count as unless they say otherwise. Default base." },
              items: { type: "array", items: ITEM_SCHEMA },
            },
            required: ["name"],
          },
        },
        items: { type: "array", description: "Rows not placed through a folder above; each may name its folder.", items: ITEM_SCHEMA },
      },
    },
    outputSchema: CREATE_OUTPUT,
    annotations: ADD,
    account: "optional",
    run: create,
  },
  {
    name: "edit_list",
    title: "Change a list",
    description:
      "Changes a list that already exists, all of it in one call. list sets the list's own title, display unit, trip dates and trail (only the fields given; an empty string clears a date or the trail). folders renames, reorders, reclassifies or removes folders, named by id or current name; removing one removes its rows. add puts new rows on, into a folder by name (made when missing) or under a group by the parent row's id. update changes rows by the ids get_list gives: any field, null clearing one that can be cleared; a new folder, place or group; a catalog_id to link or relink the row where it sits, null to unlink. remove takes rows off by id, a group's nested rows with it. The parts apply in that order as one change, and nothing is applied unless every part is valid: a row or folder named that isn't there fails the whole call. A name or weight changed on a catalog-linked row is kept as the owner's own. Takes the list's edit link, or its share code under a signed-in account that has filed it.",
    inputSchema: {
      type: "object",
      properties: {
        edit_link: EDIT_ARG,
        share_code: BY_ACCOUNT_ARG,
        list: {
          type: "object",
          description: "The list's own fields. Only the fields given change.",
          properties: {
            title: { type: "string", maxLength: MAX_TITLE_LEN },
            unit: UNIT_SCHEMA,
            start_date: { type: "string", description: "YYYY-MM-DD, or an empty string to clear." },
            end_date: { type: "string", description: "YYYY-MM-DD, or an empty string to clear." },
            trail_url: { type: "string", maxLength: TRAIL_URL_LEN, description: "An http(s) link, or an empty string to clear the trail and everything that came with it (label, distance, climb, route)." },
            trail_label: { type: "string", maxLength: TRAIL_LABEL_LEN },
            trail_distance_km: { type: "number", minimum: 0, description: "Stored in metres and shown in the list's own distance unit." },
          },
        },
        folders: {
          type: "array",
          maxItems: EDIT_MAX,
          description: "Changes to folders that exist.",
          items: {
            type: "object",
            properties: {
              folder: { type: "string", description: "The folder's id from get_list, or its current name." },
              name: { type: "string", minLength: 1, maxLength: MAX_FOLDER_NAME_LEN, description: "A new name, unique in the list." },
              classification: { type: "string", enum: CLASSIFICATIONS, description: "What rows in this folder count as unless they say otherwise." },
              position: { type: "integer", minimum: 0, description: "Its place in the list's folder order, 0 for first." },
              remove: { type: "boolean", description: "True to remove the folder and every row in it." },
            },
            required: ["folder"],
          },
        },
        add: { type: "array", description: "New rows. Each may name its folder, or the group to join.", items: ADD_ITEM_SCHEMA },
        update: { type: "array", maxItems: EDIT_MAX, description: "Changes to rows that exist, each by id.", items: UPDATE_ITEM_SCHEMA },
        remove: { type: "array", maxItems: EDIT_MAX, description: "Ids of rows to take off, from get_list.", items: { type: "string" } },
        again: {
          type: "boolean",
          description:
            "A call with rows to add that is identical to one made in the last ten minutes is taken as a retry and does nothing: the earlier result comes back with repeated set. Pass true to make the same change a second time on purpose.",
        },
      },
    },
    outputSchema: EDIT_LIST_OUTPUT,
    annotations: EDIT,
    account: byAccount,
    run: editList,
  },
  {
    name: "get_my_gear",
    title: "Read My Gear",
    description:
      "The gear the connector's account owns, most recently used first: for each piece its brand, name, variant, gear type, grams for one, classification, calories, note, price, product link and folder, plus the account's folder names. A query ranks by a search instead; a folder name keeps to that folder. Works only when this connector carries the account's access token. Brands, names, variants, gear types, notes and folder names are text the account holder typed, returned unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Two characters or more (one is enough in Chinese). Ranks by brand, name, variant and gear type instead of by recent use." },
        folder: { type: "string", description: "Keep to one folder, by name. An empty string means the unfiled pieces." },
        limit: { type: "integer", minimum: 1, maximum: GEAR_PAGE_MAX, description: `At most ${GEAR_PAGE_MAX}; ${GEAR_PAGE_DEFAULT} when omitted.` },
        offset: { type: "integer", minimum: 0, description: "How many matches to skip, for the next page." },
      },
    },
    outputSchema: GEAR_LIST_OUTPUT,
    annotations: READ,
    account: "read",
    run: readGear,
  },
  {
    name: "edit_my_gear",
    title: "Change My Gear",
    description:
      "Changes the connector's account's My Gear, in one call. add puts new pieces in; one the account already holds (same brand, name and variant) comes back as already_have and is left as it was. update changes pieces by the ids get_my_gear gives, only the fields sent, null clearing one. A piece that names a catalog_id, as it is added or later, is linked to that catalog row and takes its brand, name, variant, gear type and weight where none were given; null unlinks it. remove puts pieces away by id: they stop being offered on lists, and the lists that still carry them will not bring them back. restore brings put-away pieces back. Each piece answers for itself, in the order sent. What is added or changed here counts as the owner's own word on the piece, so a list saved later cannot overwrite it. Needs a read-and-change access token.",
    inputSchema: {
      type: "object",
      properties: {
        add: { type: "array", maxItems: GEAR_EDIT_MAX, description: "New pieces.", items: { type: "object", properties: gearInput("add"), required: ["name"] } },
        update: {
          type: "array",
          maxItems: GEAR_EDIT_MAX,
          description: "Changes to pieces that exist, each by id.",
          items: { type: "object", properties: { id: { type: "integer", minimum: 1 }, ...gearInput("update") }, required: ["id"] },
        },
        remove: { type: "array", maxItems: GEAR_EDIT_MAX, description: "Ids of pieces to put away.", items: { type: "integer", minimum: 1 } },
        restore: { type: "array", maxItems: GEAR_EDIT_MAX, description: "Ids of put-away pieces to bring back.", items: { type: "integer", minimum: 1 } },
      },
    },
    outputSchema: GEAR_EDIT_OUTPUT,
    annotations: EDIT,
    account: "write",
    run: editGear,
  },
];

/** Public protocol metadata. Handlers and the account rule stay server-only and never
 *  reach tools/list. */
export const MCP_TOOLS: McpTool[] = MCP_TOOL_REGISTRY.map(({ run: _run, account: _account, ...tool }) => tool);
const mcpToolByName = new Map(MCP_TOOL_REGISTRY.map((tool) => [tool.name, tool]));
const argsOf = (raw: unknown) => (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

/** What the account behind the bearer means to one call, for the route's gate: the
 *  scope the tool can't run without, "optional" for a tool that uses an account when
 *  it is there, undefined for one that never looks. Read off the registry, so a tool
 *  can't be in one and not the other; a write tool's answer depends on how the call
 *  names its list (byAccount). */
export function accountUse(name: string, rawArgs: unknown): AccessScope | "optional" | undefined {
  const tool = mcpToolByName.get(name);
  if (!tool?.account) return undefined;
  return typeof tool.account === "function" ? tool.account(argsOf(rawArgs)) : tool.account;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
/** the payload twice, as the spec asks: structured for clients that read it, and the
 *  same JSON as text for the ones (claude.ai among them) that read only text */
const ok = (structured: Record<string, unknown>, text = JSON.stringify(structured)): ToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: structured,
});

export function isKnownTool(name: unknown): name is string {
  return typeof name === "string" && mcpToolByName.has(name);
}

/**
 * Run one tool. The name is known (the route checks isKnownTool first and answers an
 * unknown one with a protocol error, as the spec wants); everything about the
 * ARGUMENTS is answered inside the result with isError, so the model can read what
 * went wrong and correct itself.
 */
export async function callTool(event: H3Event, name: string, rawArgs: unknown): Promise<ToolResult> {
  const tool = mcpToolByName.get(name);
  return tool ? tool.run(event, argsOf(rawArgs)) : fail(`Unknown tool: ${name}`);
}

// ---- reading ---------------------------------------------------------------------

/**
 * A share code out of whatever was pasted: the code, a share link with or without
 * the .md twin's suffix, or an edit link. An edit link's address is /e/CODE#token and
 * its CODE is the share code, so a model holding only the edit link can still read
 * the list it is about to change; the token after # is never looked at here. "" when
 * it can't be a code.
 */
export function shareCodeFrom(input: unknown): string {
  if (typeof input !== "string") return "";
  const s = input.trim();
  const m = /\/[se]\/([^/?#]+?)(?:\.md)?(?:[?#].*)?$/i.exec(s);
  return normalizeShareCode(m ? m[1]! : s);
}

const NO_SHARE = "That isn't a Mahonia share code or link. A share link looks like mahonia.app/s/CODE, and an edit link like mahonia.app/e/CODE#token.";
const NO_LIST = "No list is shared at that code. It may have been deleted, or the link replaced.";

async function getList(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  // no share code: the account's own lists (the account section at the end)
  if (args.share_code == null) return readMyLists(event);
  const code = shareCodeFrom(args.share_code);
  if (!code) return fail(NO_SHARE);
  if (args.format != null && args.format !== "data" && args.format !== "markdown") return fail('format is "data" or "markdown".');
  // the read budget is the list's, not the caller's address's (see RATE_LIMITS "mcp")
  await rateLimitSubject("mcp-read", code);
  const origin = trustedOrigin(event);
  if (args.format === "markdown") {
    const snap = await getTextByShareCode(code);
    if (!snap) return fail(NO_LIST);
    const markdown = fitMarkdown(listToMarkdown(snap));
    // the text content is the Markdown itself, for the clients that read only text,
    // and the structured answer names the list it is of
    return ok({ share_code: code, share_link: shareLink(origin, code), markdown }, markdown);
  }
  const snap = await getByShareCode(code);
  if (!snap) return fail(NO_LIST);
  return ok(fitList(describeList(snap, origin)));
}

/** milligrams to grams, to a tenth: the precision a kitchen scale has */
const grams = (mg: number) => Math.round(mg / 100) / 10;

/**
 * The list as data. A WHITELIST, field by field, rather than the snapshot spread: the
 * snapshot a share code resolves to already carries nothing owner-only (rowToSnapshot),
 * but this is a second read path onto the same rows and it should fail closed on its
 * own. Nothing here reaches for a field it doesn't name.
 */
const shareLink = (origin: string, code: string) => `${origin}/s/${code}`;

/** The totals block every list-returning tool carries, in grams — get_list's, and the
 *  create and edit_list echoes, which used to compute the whole description to read it. */
function describeTotals(snap: ListSnapshot): Record<string, unknown> {
  const totals = computeTotals(snap);
  return {
    base_g: Math.round(totals.baseMg / 1000),
    worn_g: Math.round(totals.wornMg / 1000),
    consumable_g: Math.round(totals.consumableMg / 1000),
    carried_g: Math.round(totals.carriedMg / 1000),
    total_g: Math.round(totals.totalMg / 1000),
    item_count: totals.itemCount,
    ...(totals.hasKcal ? { kcal: totals.kcalTotal } : {}),
  };
}

export function describeList(snap: ListSnapshot, origin: string): Record<string, unknown> {
  const row = (it: Item, children: Item[], parent?: Item): Record<string, unknown> => {
    const out: Record<string, unknown> = {
      id: it.id,
      name: it.name,
      display_name: itemDisplayName(it.brand, it.name, it.variant),
      qty: it.qty,
      weight_g: grams(it.unitWeightMg),
      classification: effectiveClassification(it, snap.folders),
    };
    if (it.brand) out.brand = it.brand;
    if (it.variant) out.variant = it.variant;
    if (it.commonName) out.gear_type = it.commonName;
    if (it.wornQty) out.worn_qty = it.wornQty;
    if (it.description) out.note = it.description;
    if (it.kcal != null) out.kcal = it.kcal;
    if (it.needsCooking) out.needs_cooking = true;
    if (it.catalogItemId != null) out.catalog_id = it.catalogItemId;
    // a nested row names its carrier only when it differs from the parent's, as the
    // exporters do; the description says the rest
    const carrier = carrierName(snap, it, parent);
    if (carrier && (!parent || carrier !== carrierName(snap, parent))) out.carried_by = carrier;
    if (children.length) out.items = children.map((c) => row(c, [], it));
    return out;
  };
  const folders = exportSections(snap)
    .filter((s) => s.rows.length)
    .map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name, items: s.rows.map((r) => row(r.item, r.children)) }));
  const out: Record<string, unknown> = {
    title: snap.title,
    share_code: snap.shareCode,
    share_link: shareLink(origin, snap.shareCode),
    unit: snap.displayUnit,
    totals: describeTotals(snap),
  };
  if (snap.description) out.description = snap.description;
  if (snap.startDate || snap.endDate) out.dates = { start: snap.startDate ?? null, end: snap.endDate ?? null };
  if (snap.trailUrl || snap.trailDistanceM) {
    out.trail = {
      url: snap.trailUrl ?? null,
      label: snap.trailLabel ?? null,
      distance_m: snap.trailDistanceM ?? null,
      ascent_m: snap.trailAscentM ?? null,
      descent_m: snap.trailDescentM ?? null,
    };
  }
  const days = [...(snap.days ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  if (days.length) {
    // a day's climb is typed, or read off the route's profile the way the Trip tab and
    // the share page read it (shared/profile dayClimbs); null only when neither can say
    const climbs = dayClimbs(parseProfile(snap.trailProfile), days.map((d) => d.distanceM ?? 0), snap.trailDistanceM, snap.trailAscentM);
    out.days = days.map((d, i) => ({
      day: dayLabel(i, snap.startDate),
      ...(d.label ? { label: d.label } : {}),
      distance_m: d.distanceM ?? null,
      ascent_m: d.ascentM ?? (d.distanceM ? (climbs[i]?.ascentM ?? null) : null),
    }));
  }
  if (snap.people?.length) out.people = snap.people.map((p) => p.name);
  if (snap.authorName) out.author = snap.authorName;
  // the rows last: a reader meets the trip's facts before tens of kilobytes of them,
  // and fitList's notice slots in between without reordering anything
  out.folders = folders;
  return out;
}

/**
 * The most get_list may answer with, in bytes of its JSON. Claude Code counts a tool
 * result past 25,000 tokens (its MAX_MCP_OUTPUT_TOKENS default) as too large and puts
 * it in a file the model has to read back in slices, notice and all; an in-band cut it
 * can read whole is better. Bytes, not characters: a CJK character is one string unit,
 * three bytes and about one token, so a byte ceiling tracks tokens across scripts where
 * a character one is out by three for the lists tidyText goes to lengths to keep. At
 * ~3 bytes a token for all-CJK text this is under 22,000 tokens; ASCII JSON runs 3.5
 * to 4, so 16,000 to 19,000. A list within MAX_ITEMS can be thirty times this: a row is
 * 150-odd bytes before its note, and a note up to 2,000 characters.
 */
export const GET_LIST_MAX_BYTES = 65_536;

/** the head fields fitList will give up, largest first, when the rest alone is too big */
const SHEDDABLE = ["days", "trail", "description", "people"] as const;

/**
 * A described list cut down to the ceiling when it is over it, in three tiers, each
 * said in the `truncated` field rather than in prose. Notes first: the longest free
 * text on a row, and the field a model needs least to reason about a pack. Then rows
 * off the end in reading order, a nested row counting as its own so a large group is
 * cut inside rather than dropped whole, the most that fit found by bisection. Then, only
 * when the list's own facts are too big by themselves (sixty day labels of control
 * characters, a percent-encoded trail link), those fields, largest first. The totals
 * stay as computed over the whole list. A list under the ceiling comes back as it was.
 */
export function fitList(described: Record<string, unknown>, max = GET_LIST_MAX_BYTES): Record<string, unknown> {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (size(described) <= max) return described;
  type Row = Record<string, unknown> & { items?: Row[] };
  type Folder = { name: string; items: Row[] };
  const { folders: whole, ...head } = described as Record<string, unknown> & { folders: Folder[] };
  let notes = false;
  const stripNote = ({ note, items, ...rest }: Row): Row => {
    if (note !== undefined) notes = true;
    return items ? { ...rest, items: items.map(stripNote) } : rest;
  };
  const folders = whole.map((f) => ({ ...f, items: f.items.map(stripNote) }));
  const rowsIn = (rows: Row[]) => rows.reduce((n, r) => n + 1 + (r.items?.length ?? 0), 0);
  const total = folders.reduce((n, f) => n + rowsIn(f.items), 0);
  // the first n rows in reading order: a parent, then each of its nested rows, so the
  // cut can land inside a group; a folder left with nothing is left out
  const keep = (n: number): Folder[] => {
    const out: Folder[] = [];
    let left = n;
    for (const f of folders) {
      const items: Row[] = [];
      for (const r of f.items) {
        if (left <= 0) break;
        left--;
        if (!r.items) items.push(r);
        else {
          const kids = r.items.slice(0, left);
          left -= kids.length;
          const { items: _, ...own } = r;
          items.push(kids.length ? { ...own, items: kids } : own);
        }
      }
      if (items.length) out.push({ ...f, items });
    }
    return out;
  };
  const build = (n: number, shed: readonly string[] = []) => {
    const kept = keep(n);
    const rows = total - kept.reduce((c, f) => c + rowsIn(f.items), 0);
    const rest = Object.fromEntries(Object.entries(head).filter(([k]) => !shed.includes(k)));
    const truncated = { ...(notes ? { notes: true } : {}), ...(rows ? { rows } : {}), ...(shed.length ? { fields: shed } : {}) };
    return { ...rest, truncated, folders: kept };
  };
  // the largest n whose answer fits; hi is one past the top so the whole note-stripped
  // list is a candidate, and it can't be picked when nothing was stripped, since then
  // it is the input over again
  let lo = 0;
  let hi = total + 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (size(build(mid)) <= max) lo = mid;
    else hi = mid;
  }
  if (lo > 0 || size(build(0)) <= max) return build(lo);
  // the list's own facts are too big by themselves: give them up, largest first; what
  // is left (title, links, unit, totals, author) is a few hundred bytes by the caps
  const shed: string[] = [];
  for (const key of SHEDDABLE) {
    if (!(key in head)) continue;
    shed.push(key);
    if (size(build(0, shed)) <= max) break;
  }
  return build(0, shed);
}

/** the exporter's table scaffolding (shared/exporters/markdown), read back line by line */
const MD_HEADER = "| Item | Qty | Weight |";
const MD_RULE = "| --- | ---: | ---: |";

/**
 * The Markdown answer cut to the same ceiling, when it is over it: rows off the end of
 * the tables, a nested row on its own (it follows its parent, so it goes first), an
 * emptied folder's heading with them, and one line under the tables saying how many
 * are missing. The totals block at the foot is computed over every row and stays. This
 * lives here, not in the exporter, because the exporter is what /s/{code}.md serves
 * byte for byte; only the tool's answer has a budget. Under the ceiling the text is
 * the exporter's, untouched.
 */
export function fitMarkdown(text: string, max = GET_LIST_MAX_BYTES): string {
  const bytes = (line: string) => Buffer.byteLength(line);
  let total = bytes(text);
  if (total <= max) return text;
  const lines = text.split("\n");
  // the foot: the rule and the totals under it, when the list has weights. A row can't
  // be a bare "---" (rows start with a pipe), so the last one is the rule.
  const rule = lines.lastIndexOf("---");
  const foot = rule >= 0 ? lines.slice(rule) : [];
  const body = rule >= 0 ? lines.slice(0, rule) : lines;
  // the body: the title, then per folder a heading, a blank, the header, the rule, its
  // rows and a closing blank, in the exporter's own order
  type Section = { head: string[]; rows: string[] };
  const lead: string[] = [];
  const sections: Section[] = [];
  for (const line of body) {
    const current = sections.at(-1);
    if (line.startsWith("## ")) sections.push({ head: [line], rows: [] });
    else if (!current) lead.push(line);
    else if (line.startsWith("| ") && line !== MD_HEADER && line !== MD_RULE) current.rows.push(line);
    else if (current.rows.length === 0) current.head.push(line);
    // the blank that closes a folder's rows is not kept: the assembly below puts it back
  }
  const notice = (n: number) => `_${n} more row${n === 1 ? "" : "s"} not shown; the totals count every row._`;
  let omitted = 0;
  // what the notice adds: its own line and a blank under it, each with a newline
  const fits = () => total + bytes(notice(omitted)) + 2 <= max;
  while (!fits() && sections.length) {
    const last = sections.at(-1)!;
    const row = last.rows.pop();
    if (row !== undefined) {
      omitted++;
      total -= bytes(row) + 1;
    }
    if (last.rows.length === 0) {
      // the heading, blank, header and rule of a folder with no rows left, and its closing blank
      for (const line of last.head) total -= bytes(line) + 1;
      total -= 1;
      sections.pop();
    }
  }
  const out = [...lead];
  for (const s of sections) out.push(...s.head, ...s.rows, "");
  out.push(notice(omitted), "", ...foot);
  return out.join("\n");
}

/** a catalog row as search_catalog hands it back, the product's fields joined on */
function catalogResult(
  product: { brand: string | null; name: string; commonName?: string | null; categoryHint?: string | null },
  row: { id: number; variant: string | null; weightMg: number; weightSource: string; verified: boolean; kcal?: number | null; sourceUrl?: string | null },
): Record<string, unknown> {
  return {
    id: row.id,
    brand: product.brand,
    name: product.name,
    variant: row.variant,
    display_name: itemDisplayName(product.brand, product.name, row.variant),
    weight_g: grams(row.weightMg),
    gear_type: product.commonName ?? null,
    category: product.categoryHint ?? null,
    kcal: row.kcal ?? null,
    verified: row.verified,
    weight_source: row.weightSource,
    ...(row.sourceUrl !== undefined ? { source_url: row.sourceUrl } : {}),
  };
}

/** One tool, two questions: a search by text, or one product's variants by id or by
 *  brand and name. A product reference wins when both are given, since it is the more
 *  exact ask. */
async function catalog(args: Record<string, unknown>): Promise<ToolResult> {
  const id = clampInt(args.product_id, 1, Number.MAX_SAFE_INTEGER, 0) || undefined;
  const brand = typeof args.brand === "string" ? args.brand.trim().slice(0, 200) : undefined;
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 200) : undefined;
  if (id || name) {
    const found = await productVariants(await useCatalogDb(), { id, brand, name });
    if (!found) return fail("No active catalog product matches that. Search first and pass a product_id from the results.");
    return ok({
      product: { brand: found.brand, name: found.name, gear_type: found.commonName, category: found.categoryHint },
      results: found.variants.map((v) => catalogResult(found, v)),
    });
  }
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 100) : "";
  if (!enoughToSearch(query)) return fail("Give a query of two characters or more (one is enough in Chinese), or a product_id from an earlier search.");
  const limit = clampInt(args.limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  const rows = await searchCatalog(await useCatalogDb(), query, limit);
  return ok({ query, results: rows.map((r) => catalogResult(r, r)) });
}

// ---- writing ---------------------------------------------------------------------

/**
 * The edit hash out of an edit link: the token after the # of a full link, a bare
 * /e/CODE#token path, or the token on its own. Null for anything else, a share link
 * included. The token is hashed here and the hash is all that travels further, the
 * way requireEditHash treats a bearer.
 */
export function editHashFrom(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  const at = s.indexOf("#");
  const token = at >= 0 ? s.slice(at + 1) : s;
  return /^[A-Za-z0-9_-]{16,128}$/.test(token) ? sha256Hex(token) : null;
}

const NO_EDIT = "That isn't an edit link. One looks like mahonia.app/e/CODE#token, and the part after # is what opens the list for changes; a share link can't. A list filed under the signed-in account can be named by share_code instead, with read-and-change access.";
const NO_EDIT_LIST = "That edit link doesn't open a list. Check it was copied whole, including everything after the #.";
const NO_CLAIMED = "No list filed under this account has that share code; get_list with no share_code names the ones that are. For any other list, pass its edit link.";

/**
 * The hash a write tool works under. From the edit link when one is given: the
 * capability itself, as ever. Otherwise from share_code, a list filed under the
 * signed-in account: the same claim the site resolves when a signed-in owner edits a
 * list without its link (claimedEditHash), scoped to the account inside the query, so
 * a code the account hasn't filed answers as one that doesn't exist and nothing here
 * can probe for lists. The route has already asked for read-and-change access at the
 * door (byAccount), so the one refusal left on that path is a call that never passed
 * it. Either way the budget is spent before any lookup: the list's on its hash, the
 * account's on the claim. The hash, or the sentence.
 */
async function writeHashFrom(event: H3Event, args: Record<string, unknown>): Promise<{ hash: string } | string> {
  if (!namesByAccount(args)) {
    const hash = editHashFrom(args.edit_link);
    if (!hash) return NO_EDIT;
    // the write budget is the list's: spent once the link has yielded a hash to key it
    // on, so a call with no link costs nothing past the endpoint's own guard
    await rateLimitSubject("mcp-write", hash);
    return { hash };
  }
  const code = shareCodeFrom(args.share_code);
  if (!code) return NO_SHARE;
  const caller = event.context.connector;
  if (!caller || caller.scope !== "write") return "Naming a list by share_code takes a sign-in with read-and-change access, which the MCP endpoint asks for first; or pass the edit link.";
  await rateLimitSubject("mcp-write", `lists:${caller.userId}`);
  const hash = await claimedEditHash(await useAccountDb(), caller.userId, code);
  return hash ? { hash } : NO_CLAIMED;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

/** One row as the reducer stores it, or the sentence explaining why it can't be. */
function toItem(raw: unknown, folderId: string | null, sortOrder: number): Item | string {
  if (!raw || typeof raw !== "object") return "Each row must be an object with at least a name.";
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name) return "Every row needs a name.";
  if (r.classification != null && !CLASSIFICATIONS.includes(r.classification as Classification)) {
    return `"${String(r.classification)}" isn't a classification; use base, worn or consumable.`;
  }
  if (r.weight_g != null && (typeof r.weight_g !== "number" || !(r.weight_g >= 0))) return `weight_g on "${name}" must be a number of grams, 0 or more.`;
  const qty = clampInt(r.qty, 1, QTY_MAX, 1);
  const item: Item = {
    id: uid(),
    folderId,
    name,
    unitWeightMg: typeof r.weight_g === "number" ? Math.round(r.weight_g * 1000) : 0,
    qty,
    classification: (r.classification as Classification | undefined) ?? null,
    sortOrder,
  };
  if (typeof r.brand === "string" && r.brand.trim()) item.brand = r.brand.trim();
  if (typeof r.variant === "string" && r.variant.trim()) item.variant = r.variant.trim();
  if (typeof r.gear_type === "string" && r.gear_type.trim()) {
    item.commonName = r.gear_type.trim();
    item.commonNameOverridden = true;
  }
  if (typeof r.note === "string" && r.note.trim()) item.description = r.note.trim();
  if (typeof r.worn_qty === "number") {
    // a row that is entirely worn is a worn row, not a base row with a split the size
    // of itself, which the reducer reads as no split at all
    const worn = clampInt(r.worn_qty, 0, qty, 0);
    if (worn > 0 && worn >= qty) item.classification = item.classification ?? "worn";
    else if (worn > 0) item.wornQty = worn;
  }
  if (typeof r.kcal === "number") item.kcal = clampInt(r.kcal, 0, 1_000_000, 0);
  if (typeof r.needs_cooking === "boolean") item.needsCooking = r.needs_cooking;
  if (r.catalog_id != null) {
    if (!isCatalogId(r.catalog_id)) return `catalog_id on "${name}" isn't a catalog id; take one from search_catalog.`;
    item.catalogItemId = r.catalog_id;
    // whether the caller gave a figure of their own, decided before the catalog's
    // arrives (linkCatalog); the reducer keeps the flag either way
    item.weightOverridden = typeof r.weight_g === "number";
  }
  return item;
}

/**
 * What a row takes from the catalog row it names: the editor's own pick, done here.
 * The cited weight becomes the row's weight unless the caller gave one (then theirs
 * stays and is marked overridden, with the catalog's kept as the baseline the
 * "catalog changed" nudge compares against); brand, variant and gear type fill in
 * where the caller left them blank. An id that names nothing is the caller's
 * mistake to hear about, not a silent unlinked row.
 */
async function linkCatalog(items: Item[]): Promise<string | null> {
  const ids = items.map((i) => i.catalogItemId).filter(isCatalogId);
  if (!ids.length) return null;
  const rows = await catalogRowsById(await useCatalogDb(), ids);
  for (const item of items) {
    if (!isCatalogId(item.catalogItemId)) continue;
    const row = rows.get(item.catalogItemId);
    if (!row) return `catalog_id ${item.catalogItemId} isn't in the catalog; take an id from search_catalog.`;
    item.catalogWeightMgAtLink = row.weightMg;
    if (!item.weightOverridden) item.unitWeightMg = row.weightMg;
    if (!item.brand && row.brand) item.brand = row.brand;
    if (!item.variant && row.variant) item.variant = row.variant;
    if (!item.commonName && row.commonName) item.commonName = row.commonName;
    if (item.kcal == null && row.kcal != null) item.kcal = row.kcal;
    // the catalog's name for the product, the way a pick stores it, so the editor's
    // live-resolve keeps it current; a name the caller typed differently is theirs
    if (tidyText(item.name).toLowerCase() === tidyText(row.name).toLowerCase()) item.name = row.name;
    else item.nameOverridden = true;
  }
  return null;
}

/**
 * The folder a row names, found or made. Names compare tidied and case-folded, the
 * spelling the reducer stores ("Ryan's" and "Ryan’s" are one folder). A made folder
 * takes the hue the editor would give it (colorKeyForName: "Shelter" reads in the
 * shelter colour, an unknown name takes the next free one), so a list an assistant
 * built looks like one a person built.
 */
class FolderBook {
  readonly folders: Folder[];
  readonly made: Folder[] = [];
  /** `onMade` hears of each folder as it is made: edit_list plans the addFolder op there,
   *  so a folder exists on its working copy before a row is moved into it */
  constructor(
    existing: readonly Folder[],
    private readonly onMade?: (folder: Folder) => void,
  ) {
    this.folders = [...existing];
  }
  find(name: string): Folder | undefined {
    const want = tidyText(name).toLowerCase();
    return this.folders.find((f) => tidyText(f.name).toLowerCase() === want);
  }
  resolve(name: string, classification: Classification = "base"): Folder | string {
    const found = this.find(name);
    if (found) return found;
    if (this.folders.length >= MAX_FOLDERS) return `A list holds at most ${MAX_FOLDERS} folders.`;
    const used = usedColorKeys(this.folders);
    const folder: Folder = {
      id: uid(),
      name: tidyText(name),
      colorKey: colorKeyForName(name, used),
      defaultClassification: classification,
      sortOrder: this.folders.length,
    };
    this.folders.push(folder);
    this.made.push(folder);
    this.onMade?.(folder);
    return folder;
  }
}

/**
 * create_list and edit_list's add accept rows in different envelopes, but every row
 * follows the same path: an item-level folder wins over the surrounding folder, a
 * missing named folder is made, and its sort order is the next free slot among its
 * siblings. Keeping that policy here means the two cannot quietly diverge on a later
 * validation or ordering change.
 *
 * Groups, one level deep as the editor keeps them: a row's `items` are placed under
 * it, in its folder; a row's `group` (edit_list only, it names an id) places it under a
 * top-level row already on the list, in that row's folder. The reducer enforces the
 * same two rules on its own (addItem coerces a bad parent to top level), so what is
 * refused here would otherwise have been silently flattened.
 */
class ItemPlan {
  readonly items: Item[] = [];
  private readonly counted = new Map<string, number>();

  constructor(
    readonly folders: FolderBook,
    private readonly existingItems: readonly Item[] = [],
  ) {}

  place(raw: unknown, fallbackFolder: Folder | null): string | null {
    if (!raw || typeof raw !== "object") return "Each row must be an object with at least a name.";
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const nested = r.items;
    if (nested != null && !Array.isArray(nested)) return `items on "${name}" must be an array of rows.`;
    let parent: Item | null = null;
    if (r.group != null) {
      if (typeof r.group !== "string" || !r.group.trim()) return `group on "${name}" must be a row's id, from get_list.`;
      if (Array.isArray(nested) && nested.length) return `"${name}" can't both join a group and have rows nested under it; groups are one level deep.`;
      const id = r.group.trim();
      const found = this.existingItems.find((i) => i.id === id);
      if (!found) return `No row on this list has the id "${id}" to group "${name}" under. get_list gives every row's id.`;
      if (found.parentId) return `"${itemDisplayName(found.brand, found.name, found.variant)}" is itself nested; a group is one level deep, so group "${name}" under its parent instead.`;
      parent = found;
    }
    let folder = fallbackFolder;
    const named = r.folder;
    if (typeof named === "string" && named.trim()) {
      const resolved = this.folders.resolve(named);
      if (typeof resolved === "string") return resolved;
      if (parent && resolved.id !== parent.folderId) return `"${name}" is grouped under a row in another folder; a nested row is in its group's folder, so leave folder off it or drop group.`;
      folder = resolved;
    }
    const folderId = parent ? parent.folderId : (folder?.id ?? null);
    const item = toItem(raw, folderId, this.nextSortOrder(folderId, parent?.id ?? null));
    if (typeof item === "string") return item;
    if (parent) item.parentId = parent.id;
    this.items.push(item);
    for (const child of Array.isArray(nested) ? nested : []) {
      if (!child || typeof child !== "object") return `Each row nested under "${item.name}" must be an object with at least a name.`;
      const c = child as Record<string, unknown>;
      if (c.items != null || c.group != null || (typeof c.folder === "string" && c.folder.trim())) {
        return `A row nested under "${item.name}" is in its folder and can't nest rows of its own; leave folder, group and items off it.`;
      }
      const kid = toItem(child, folderId, this.nextSortOrder(folderId, item.id));
      if (typeof kid === "string") return kid;
      kid.parentId = item.id;
      this.items.push(kid);
    }
    return null;
  }

  placeAll(rows: readonly unknown[], fallbackFolder: Folder | null): string | null {
    for (const row of rows) {
      const problem = this.place(row, fallbackFolder);
      if (problem) return problem;
    }
    return null;
  }

  private nextSortOrder(folderId: string | null, parentId: string | null): number {
    // New rows go after what their siblings already hold: past the highest sortOrder,
    // not the count, since a removed row leaves a hole the count would fill mid-folder.
    const key = `${folderId ?? ""}|${parentId ?? ""}`;
    const next = this.counted.get(key) ?? nextSortOrder(this.existingItems, folderId, parentId);
    this.counted.set(key, next + 1);
    return next;
  }
}

async function create(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  // the one write with no list to key on: per address, like the web's create
  await rateLimit(event, "mcp-write");
  const plan = new ItemPlan(new FolderBook([]));
  if (args.folders != null) {
    if (!Array.isArray(args.folders)) return fail("folders must be an array.");
    for (const f of args.folders) {
      if (!f || typeof f !== "object") return fail("Each folder needs a name.");
      const fr = f as Record<string, unknown>;
      if (typeof fr.name !== "string" || !fr.name.trim()) return fail("Each folder needs a name.");
      if (fr.classification != null && !CLASSIFICATIONS.includes(fr.classification as Classification)) {
        return fail(`"${String(fr.classification)}" isn't a classification; use base, worn or consumable.`);
      }
      const folder = plan.folders.resolve(fr.name as string, (fr.classification as Classification | undefined) ?? "base");
      if (typeof folder === "string") return fail(folder);
      if (fr.items != null) {
        if (!Array.isArray(fr.items)) return fail("A folder's items must be an array.");
        const problem = plan.placeAll(fr.items, folder);
        if (problem) return fail(problem);
      }
    }
  }
  if (args.items != null) {
    if (!Array.isArray(args.items)) return fail("items must be an array.");
    const problem = plan.placeAll(args.items, null);
    if (problem) return fail(problem);
  }
  if (plan.items.length > MAX_ITEMS) return fail(`A list holds at most ${MAX_ITEMS} rows; this would make ${plan.items.length}.`);

  const meta = tripMeta(args, true);
  if (typeof meta === "string") return fail(meta);
  const unlinked = await linkCatalog(plan.items);
  if (unlinked) return fail(unlinked);
  const data: ListData = { folders: plan.folders.folders, items: plan.items };
  const { editToken, snapshot } = await createList({ ...meta, data });
  const origin = trustedOrigin(event);
  const filed = await fileUnderAccount(event, editToken, snapshot);
  return ok({
    title: snapshot.title,
    edit_link: `${origin}${editLinkPath(snapshot.shareCode, editToken)}`,
    share_link: shareLink(origin, snapshot.shareCode),
    share_code: snapshot.shareCode,
    folders: snapshot.folders.length,
    items: snapshot.items.length,
    totals: describeTotals(snapshot),
    saved_to_account: filed === true,
    ...(typeof filed === "string" ? { account_note: filed } : {}),
  });
}

/**
 * File the list create_list just made under the connector's account, if it has one
 * with the right scope: the same claim the browser makes for a list it makes while
 * signed in (/api/lists/claim), then the list's own gear folded into My Gear, as a
 * capture from an open editor would fold it. Three answers: true, it is filed; false,
 * the connector carries no bearer, which is the ordinary anonymous call and gets no
 * sentence; or the sentence that explains why a bearer that WAS sent didn't file it.
 *
 * Only a read-and-write bearer files. Filing changes the account — the list joins its
 * lists, its gear joins My Gear — and the owner who allowed read only said the
 * assistant was to change nothing of theirs.
 *
 * Nothing in here may throw past this function. By the time it runs the list exists
 * and its edit link is in the caller's hands, or about to be; a dead bearer, a spent
 * budget or a database fault must end as a note beside that link, not as a failed
 * call that drops the one way back into the list.
 */
async function fileUnderAccount(event: H3Event, editToken: string, snapshot: ListSnapshot): Promise<boolean | string> {
  const where = `${trustedOrigin(event)}/account`;
  const byHand = "Opening the edit link while signed in files it too.";
  try {
    const caller = whoCalls(event);
    if (caller === "anonymous") return false;
    if (caller === "unknown") return `The list was made, but not filed under an account: the connector's sign-in no longer opens one. Sign in again, or mint a new token at ${where}. ${byHand}`;
    if (caller.scope !== "write") return `The list was made, but read-only access can't file it under your account; read-and-change access from ${where} can. ${byHand}`;
    // the claim budget is the account's, as it is for the browser, rather than the
    // shared address every claude.ai call arrives from
    await rateLimitSubject("list-claim", `claim:${caller.userId}`);
    await claimLists(await useAccountDb(), caller.userId, [editToken]);
    // the vault tables as well as the account's: on Neon they're ensured on first use
    // rather than migrated, and the capture below writes them
    const db = await useVaultDb();
    const vaultId = (await touchVaultByUser(db, caller.userId)) ?? (await mintVault(db, caller.userId));
    await captureVaultItems(db, vaultId, captureFromList(snapshot.items, snapshot.folders)).catch((e) => {
      console.error("[vault capture]", e);
    });
    return true;
  } catch (e) {
    console.error("[mcp file list]", e);
    return `The list was made, but filing it under your account didn't go through just now. ${byHand}`;
  }
}

/** The meta fields the two trip tools share, validated, or the sentence that failed.
 *  `creating` is create_list: a new list has no distance unit yet, so a distance given
 *  in kilometres picks km; on an existing list the owner's pick stands. */
function tripMeta(args: Record<string, unknown>, creating = false): Record<string, unknown> | string {
  const meta: Record<string, unknown> = {};
  if (args.title != null) {
    if (typeof args.title !== "string") return "title must be text.";
    meta.title = args.title;
  }
  if (args.unit != null) {
    if (!UNITS.includes(args.unit as Unit)) return `"${String(args.unit)}" isn't a unit; use g, kg, oz or lb.`;
    meta.displayUnit = args.unit;
  }
  for (const [key, field] of [["start_date", "startDate"], ["end_date", "endDate"]] as const) {
    const v = args[key];
    if (v == null) continue;
    if (typeof v !== "string") return `${key} must be a YYYY-MM-DD date.`;
    if (v === "") {
      meta[field] = "";
      continue;
    }
    const date = normalizeCalendarDate(v);
    if (!date) return `"${v}" isn't a date; use YYYY-MM-DD.`;
    meta[field] = date;
  }
  if (typeof meta.startDate === "string" && typeof meta.endDate === "string" && meta.startDate && meta.endDate && meta.endDate < meta.startDate) {
    return "end_date is before start_date.";
  }
  if (args.trail_url != null) {
    if (typeof args.trail_url !== "string") return "trail_url must be an http(s) link.";
    // clearing the link clears what described its route, as the editor does
    if (args.trail_url.trim() === "") Object.assign(meta, { trailUrl: "" }, CLEARS_WITH_LINK);
    else {
      const href = normalizeTrailUrl(args.trail_url);
      if (!href) return `"${args.trail_url}" isn't an http(s) link.`;
      meta.trailUrl = href;
    }
  }
  if (args.trail_label != null) {
    if (typeof args.trail_label !== "string") return "trail_label must be text.";
    meta.trailLabel = args.trail_label;
  }
  if (args.trail_distance_km != null) {
    if (typeof args.trail_distance_km !== "number" || !(args.trail_distance_km >= 0)) return "trail_distance_km must be a number of kilometres, 0 or more.";
    meta.trailDistanceM = Math.round(args.trail_distance_km * 1000);
    if (creating) meta.trailDistanceUnit = "km";
  }
  return meta;
}

// A retried edit_list must not add its rows twice. Clients retry a call that timed
// out or lost its answer, and nothing in the protocol marks the retry; so an edit_list
// with rows to add that is identical to one this list took in the last ten minutes
// (the arguments, stably serialised, hashed with the edit hash) answers with that
// call's result and `repeated: true`, and does nothing. A call with no rows to add is
// not held to the window: its parts are a set of fields, moves and removals that a
// second run repeats harmlessly or refuses by name. The window
// is in the shared KV store the rate limiter uses, so it holds across serverless
// instances; without a shared store it degrades to per instance, as the budgets do.
// A person who means the same rows twice says so with `again: true`, which skips the
// window; the tool's description tells the model, and `repeated` tells it after.
//
// Keyed on the edit hash, so a stored answer only ever goes back to a caller holding
// the same link (it carries the share link and totals, nothing more). create_list has
// no such key: two callers making byte-identical lists from one address range would
// be handed one edit link, so a retried create makes a second list instead, which is
// a spare list rather than a leaked capability.
const REPLAY_WINDOW_S = 10 * 60;
function replayKey(hash: string, tool: string, args: Record<string, unknown>): string {
  const { edit_link: _link, share_code: _code, again: _again, ...rest } = args;
  return `mcp:replay:${sha256Hex(`${hash}|${tool}|${stableJson(rest)}`)}`;
}
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// ---- changing a list that exists ---------------------------------------------------
// The editor's own operations, sent the way the editor sends them: setMeta for the
// list's own fields, updateFolder and removeFolder for folders, addFolder and addItem
// for new rows, updateItem for a row's fields and moveItem for its folder, place and
// group, removeItem. One call reads the list once, plans every part against a working
// copy (applying each op to the copy as it is planned, so a later part sees where an
// earlier one left things) and sends the whole batch at once. A row or folder that
// isn't found fails the call before anything is sent: a half-applied edit is harder
// for the model to reason about than a refusal.

const NO_ROW = (ids: string[]) =>
  `No row on this list has the id${ids.length > 1 ? "s" : ""} ${ids.map((id) => `"${id}"`).join(", ")}. get_list gives every row's id.`;

interface Work {
  work: ListState;
  ops: Op[];
  plan: (op: Op) => void;
}

/** the list a write names, as a working copy to plan against */
async function openForEdit(hash: string): Promise<Work | string> {
  const snap = await getByEditHash(hash);
  if (!snap) return NO_EDIT_LIST;
  const work = structuredClone(snap) as unknown as ListState;
  const ops: Op[] = [];
  return { work, ops, plan: (op) => {
    ops.push(op);
    applyOps(work, [op]);
  } };
}

/**
 * Put a row at `position` among its siblings in a folder (and under a parent), the
 * way the editor's own move does it: the moved row is placed, and every neighbour
 * whose place shifts is renumbered so the folder stays gapless. Only a change of
 * folder is news in the list's history; a reorder and the neighbours' renumbering
 * go out quiet, as the editor sends them.
 */
function placeRow(work: ListState, plan: (op: Op) => void, id: string, folderId: string | null, parentId: string | null, position: number | undefined): void {
  const row = work.items.find((i) => i.id === id);
  if (!row) return;
  const changedFolder = row.folderId !== folderId;
  // named its own folder again with no place: it is already where it was asked to be
  if (position == null && !changedFolder && (row.parentId ?? null) === parentId) return;
  const others = siblingItems(work.items, folderId, parentId)
    .filter((i) => i.id !== id)
    .sort(bySortOrder);
  const idx = position == null ? others.length : Math.min(position, others.length);
  const ordered = [...others.slice(0, idx), row, ...others.slice(idx)];
  ordered.forEach((it, i) => {
    if (it.id === id) {
      if (it.folderId !== folderId || (it.parentId ?? null) !== parentId || it.sortOrder !== i)
        plan({ t: "moveItem", id, folderId, parentId, sortOrder: i, ...(changedFolder ? {} : { quiet: true as const }) });
    } else if (it.sortOrder !== i) {
      plan({ t: "moveItem", id: it.id, folderId, sortOrder: i, quiet: true });
    }
  });
}

/** How a person on the list is named in an argument: the name, compared tidied and
 *  case-folded as folder names are. */
const personKey = (name: string) => tidyText(name).toLowerCase();

/** the catalog rows an update's relinks name, fetched once for the call */
type CatalogRows = Awaited<ReturnType<typeof catalogRowsById>>;

/**
 * One row's changes as the reducer's own patch, or the sentence saying why not.
 * Values are typed and bounded here; cleanItemPatch caps and tidies them on the way
 * in, the same rules the editor's writes get. The owner's-own marks follow the
 * editor: a typed weight on a catalog-linked row is the owner's, and so is a typed
 * name that differs from the catalog's, which keeps the link and the catalog's
 * corrections from rewriting it. A catalog_id is the editor's own pick, done here
 * (ItemRow.onNameCommit): the link and its weight baseline, the catalog's brand,
 * variant, name, gear type and weight, each of which a value given in the same
 * change overrides as the owner's own; null unlinks, and the reducer drops the
 * baseline with the link.
 */
function rowPatch(r: Record<string, unknown>, it: Item, people: ListState["people"], catalogRows: CatalogRows): ItemPatch | string {
  const label = `"${itemDisplayName(it.brand, it.name, it.variant)}"`;
  const patch: ItemPatch = {};
  if (r.name !== undefined) {
    if (typeof r.name !== "string" || !r.name.trim()) return `A row keeps a name; give ${label} a new one or leave name out.`;
    patch.name = r.name.trim();
    if (it.catalogItemId != null && tidyText(patch.name).toLowerCase() !== tidyText(it.name).toLowerCase()) patch.nameOverridden = true;
  }
  const text = (key: string, field: "brand" | "variant" | "commonName" | "description"): string | null => {
    const v = r[key];
    if (v === undefined) return null;
    if (v !== null && typeof v !== "string") return `${key} on ${label} must be text, or null to clear it.`;
    patch[field] = typeof v === "string" ? v.trim() : "";
    return null;
  };
  for (const [key, field] of [["brand", "brand"], ["variant", "variant"], ["gear_type", "commonName"], ["note", "description"]] as const) {
    const problem = text(key, field);
    if (problem) return problem;
  }
  // a gear type the owner typed (or cleared) is theirs, as the editor marks it
  if (r.gear_type !== undefined) patch.commonNameOverridden = true;
  if (r.weight_g !== undefined) {
    if (typeof r.weight_g !== "number" || !(r.weight_g >= 0)) return `weight_g on ${label} must be a number of grams, 0 or more.`;
    patch.unitWeightMg = Math.round(r.weight_g * 1000);
    if (it.catalogItemId != null) patch.weightOverridden = true;
  }
  if (r.qty !== undefined) {
    if (typeof r.qty !== "number" || !Number.isFinite(r.qty)) return `qty on ${label} must be a whole number.`;
    patch.qty = clampInt(r.qty, 1, QTY_MAX, 1);
  }
  if (r.classification !== undefined) {
    if (r.classification !== null && !CLASSIFICATIONS.includes(r.classification as Classification)) {
      return `"${String(r.classification)}" isn't a classification; use base, worn or consumable, or null to follow the folder.`;
    }
    patch.classification = r.classification as Classification | null;
  }
  if (r.worn_qty !== undefined) {
    if (typeof r.worn_qty !== "number" || !Number.isFinite(r.worn_qty)) return `worn_qty on ${label} must be a whole number.`;
    const qty = patch.qty ?? it.qty;
    const worn = clampInt(r.worn_qty, 0, QTY_MAX, 0);
    // a row that is entirely worn is a worn row, not a split the size of itself,
    // which the reducer reads as no split at all (the rule create_list follows)
    if (worn > 0 && worn >= qty) {
      if (patch.classification === undefined) patch.classification = "worn";
      patch.wornQty = 0;
    } else patch.wornQty = worn;
  }
  if (r.kcal !== undefined) {
    if (r.kcal !== null && (typeof r.kcal !== "number" || !(r.kcal >= 0))) return `kcal on ${label} must be a number, or null to clear it.`;
    patch.kcal = r.kcal === null ? null : Math.round(r.kcal as number);
  }
  if (r.needs_cooking !== undefined) {
    if (typeof r.needs_cooking !== "boolean") return `needs_cooking on ${label} must be true or false.`;
    patch.needsCooking = r.needs_cooking;
  }
  if (r.carried_by !== undefined) {
    if (r.carried_by === null || r.carried_by === "") patch.personId = null;
    else if (typeof r.carried_by !== "string") return `carried_by on ${label} must be a name on the list, or null.`;
    else {
      const person = (people ?? []).find((p) => personKey(p.name) === personKey(r.carried_by as string));
      if (!person) {
        const names = (people ?? []).map((p) => p.name);
        return `No one on this list is called "${r.carried_by}".${names.length ? ` The people are: ${names.join(", ")}.` : " The list names no people yet."}`;
      }
      patch.personId = person.id;
    }
  }
  if (r.catalog_id !== undefined) {
    if (r.catalog_id === null) patch.catalogItemId = null;
    else {
      if (!isCatalogId(r.catalog_id)) return `catalog_id on ${label} isn't a catalog id; take one from search_catalog.`;
      const row = catalogRows.get(r.catalog_id);
      if (!row) return `catalog_id ${r.catalog_id} isn't in the catalog; take an id from search_catalog.`;
      patch.catalogItemId = row.id;
      patch.catalogWeightMgAtLink = row.weightMg;
      if (patch.unitWeightMg === undefined) {
        patch.unitWeightMg = row.weightMg;
        patch.weightOverridden = false;
      } else patch.weightOverridden = true;
      if (r.brand === undefined) patch.brand = row.brand ?? "";
      if (r.variant === undefined) patch.variant = row.variant ?? "";
      if (patch.name === undefined) {
        patch.name = row.name;
        patch.nameOverridden = false;
      } else patch.nameOverridden = tidyText(patch.name).toLowerCase() !== tidyText(row.name).toLowerCase();
      if (r.gear_type === undefined && !it.commonNameOverridden) {
        patch.commonName = row.commonName ?? "";
        patch.commonNameOverridden = false;
      }
      if (r.kcal === undefined && row.kcal != null) patch.kcal = row.kcal;
    }
  }
  return patch;
}

/** the `list` part: the list's own fields, as one setMeta */
function planMeta(raw: unknown, { plan }: Work): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "list must be an object of the list's own fields.";
  const meta = tripMeta(raw as Record<string, unknown>);
  if (typeof meta === "string") return meta;
  if (!Object.keys(meta).length) return "list has nothing to set: give a title, unit, start_date, end_date, trail_url, trail_label or trail_distance_km.";
  plan({ t: "setMeta", patch: meta as Extract<Op, { t: "setMeta" }>["patch"] });
  return null;
}

/** the `folders` part: renames, reorders, reclassifications and removals of folders that exist */
function planFolders(entries: unknown[], { work, ops, plan }: Work): { changed: number } | string {
  if (entries.length > EDIT_MAX) return `At most ${EDIT_MAX} folders in one call.`;
  const key = (name: string) => tidyText(name).toLowerCase();
  const find = (ref: unknown) =>
    typeof ref !== "string" ? undefined : (work.folders.find((f) => f.id === ref) ?? work.folders.find((f) => key(f.name) === key(ref)));
  const changes = entries.map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}));
  const missing = changes.filter((c) => !find(c.folder)).map((c) => String(c.folder ?? ""));
  if (missing.length) {
    const names = [...work.folders].sort(bySortOrder).map((f) => f.name);
    return `No folder on this list is ${missing.map((m) => `"${m}"`).join(", ")}. The folders are: ${names.join(", ") || "none yet"}.`;
  }
  let changed = 0;
  for (const c of changes) {
    const folder = find(c.folder);
    // a folder removed earlier in this same call has nothing left to change
    if (!folder) continue;
    const before = ops.length;
    if (c.remove === true) {
      plan({ t: "removeFolder", id: folder.id });
      changed++;
      continue;
    }
    const patch: Partial<Folder> = {};
    if (c.name !== undefined) {
      if (typeof c.name !== "string" || !c.name.trim()) return `A folder keeps a name; give "${folder.name}" a new one or leave name out.`;
      const clash = work.folders.find((f) => f.id !== folder.id && key(f.name) === key(c.name as string));
      if (clash) return `The list already has a folder called "${clash.name}".`;
      patch.name = tidyText(c.name);
    }
    if (c.classification !== undefined) {
      if (!CLASSIFICATIONS.includes(c.classification as Classification)) return `"${String(c.classification)}" isn't a classification; use base, worn or consumable.`;
      patch.defaultClassification = c.classification as Classification;
    }
    if (Object.keys(patch).length) plan({ t: "updateFolder", id: folder.id, patch });
    if (c.position !== undefined) {
      if (typeof c.position !== "number" || !(c.position >= 0)) return "position must be a whole number, 0 for first.";
      // the editor's folder reorder: place it, renumber the rest gapless
      const others = [...work.folders].filter((f) => f.id !== folder.id).sort(bySortOrder);
      const idx = Math.min(Math.round(c.position), others.length);
      [...others.slice(0, idx), folder, ...others.slice(idx)].forEach((f, i) => {
        if (f.sortOrder !== i) plan({ t: "updateFolder", id: f.id, patch: { sortOrder: i } });
      });
    }
    if (ops.length > before) changed++;
    else return `Nothing to change on "${folder.name}": give it a name, a classification, a position or remove: true.`;
  }
  return { changed };
}

/** the `add` part: new rows, into folders by name or under groups by id */
async function planAdds(rows: unknown[], book: FolderBook, { work, plan }: Work): Promise<{ added: number } | string> {
  if (work.items.length + rows.length > MAX_ITEMS) return `A list holds at most ${MAX_ITEMS} rows; this one has ${work.items.length}.`;
  const planned = new ItemPlan(book, work.items);
  const problem = planned.placeAll(rows, null);
  if (problem) return problem;
  if (work.items.length + planned.items.length > MAX_ITEMS) return `A list holds at most ${MAX_ITEMS} rows; this one has ${work.items.length}, and these rows with the ones nested under them are ${planned.items.length}.`;
  const unlinked = await linkCatalog(planned.items);
  if (unlinked) return unlinked;
  for (const item of planned.items) plan({ t: "addItem", item });
  return { added: planned.items.length };
}

/** the `update` part: rows that exist, by id — their fields, catalog link, folder, place and group */
async function planUpdates(entries: unknown[], book: FolderBook, { work, ops, plan }: Work): Promise<{ updated: number } | string> {
  if (entries.length > EDIT_MAX) return `At most ${EDIT_MAX} rows in one call; send the rest in another.`;
  const rows = entries.map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}));
  const unknown = rows.map((r) => String(r.id ?? "")).filter((id) => !work.items.some((i) => i.id === id));
  if (unknown.length) return NO_ROW([...new Set(unknown)]);
  // the catalog rows the relinks name, in one read; an id that isn't one is refused
  // row by row below, as a catalog_id on a new row is
  const linkIds = rows.map((r) => r.catalog_id).filter(isCatalogId);
  const catalogRows: CatalogRows = linkIds.length ? await catalogRowsById(await useCatalogDb(), linkIds) : new Map();

  let updated = 0;
  for (const r of rows) {
    const it = work.items.find((i) => i.id === r.id)!;
    const label = `"${itemDisplayName(it.brand, it.name, it.variant)}"`;
    const patch = rowPatch(r, it, work.people, catalogRows);
    if (typeof patch === "string") return patch;
    const before = ops.length;
    if (Object.keys(patch).length) plan({ t: "updateItem", id: it.id, patch });

    if (r.folder !== undefined || r.position !== undefined || r.group !== undefined) {
      if (r.folder !== undefined && typeof r.folder !== "string") return "folder must be a folder's name, or an empty string for none.";
      if (r.position !== undefined && (typeof r.position !== "number" || !(r.position >= 0))) return "position must be a whole number, 0 for first.";
      if (r.group !== undefined && typeof r.group !== "string") return "group must be a row's id, or an empty string for none.";
      let folderId = it.folderId;
      let parentId = it.parentId ?? null;
      if (typeof r.folder === "string") {
        const named = r.folder.trim();
        if (!named) folderId = null;
        else {
          const folder = book.resolve(named);
          if (typeof folder === "string") return folder;
          folderId = folder.id;
        }
        // a row moved to another folder leaves its group; a group keeps its rows
        if (folderId !== it.folderId) parentId = null;
      }
      if (typeof r.group === "string") {
        const want = r.group.trim();
        if (!want) parentId = null;
        else {
          const parent = work.items.find((i) => i.id === want);
          if (!parent) return `No row on this list has the id "${want}" to group ${label} under. get_list gives every row's id.`;
          if (parent.id === it.id) return `${label} can't be grouped under itself.`;
          if (parent.parentId) return `"${itemDisplayName(parent.brand, parent.name, parent.variant)}" is itself nested; a group is one level deep, so group ${label} under its parent instead.`;
          if (work.items.some((c) => c.parentId === it.id)) return `${label} has rows nested under it, so it can't be nested itself; move its rows out first.`;
          if (typeof r.folder === "string" && r.folder.trim() && folderId !== parent.folderId) return `${label} can't go to another folder and into a group at once; a nested row is in its group's folder, so give group or folder, not both.`;
          parentId = parent.id;
          folderId = parent.folderId;
        }
      }
      placeRow(work, plan, it.id, folderId, parentId, typeof r.position === "number" ? Math.round(r.position) : undefined);
    }
    if (ops.length > before) updated++;
    else return `Nothing to change on ${label}: give it at least one field, a folder, a position or a group.`;
  }
  return { updated };
}

/** the `remove` part: rows off by id, a group's nested rows with it */
function planRemoves(raw: unknown[], { work, plan }: Work): string | null {
  const ids = [...new Set(raw.map(String))];
  if (ids.length > EDIT_MAX) return `At most ${EDIT_MAX} rows in one call; send the rest in another.`;
  const unknown = ids.filter((id) => !work.items.some((i) => i.id === id));
  if (unknown.length) return NO_ROW(unknown);
  // as the editor does: removing a group takes its nested rows with it (the reducer's
  // own cascade), so a nested row named alongside its parent is simply already gone
  for (const id of ids) if (work.items.some((i) => i.id === id)) plan({ t: "removeItem", id });
  return null;
}

/** an array part of edit_list, or the sentence when it isn't one */
function arrayPart(args: Record<string, unknown>, key: string): unknown[] | string {
  const v = args[key];
  if (v == null) return [];
  return Array.isArray(v) ? v : `${key} must be an array.`;
}

async function editList(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  const parts = { folders: arrayPart(args, "folders"), add: arrayPart(args, "add"), update: arrayPart(args, "update"), remove: arrayPart(args, "remove") };
  for (const part of Object.values(parts)) if (typeof part === "string") return fail(part);
  const { folders, add, update, remove } = parts as Record<keyof typeof parts, unknown[]>;
  if (args.list == null && !folders.length && !add.length && !update.length && !remove.length) {
    return fail("Nothing to change: give list, folders, add, update or remove.");
  }
  if (args.again != null && typeof args.again !== "boolean") return fail("again must be true or false.");
  const opened = await writeHashFrom(event, args);
  if (typeof opened === "string") return fail(opened);
  const { hash } = opened;
  // the replay window, for a call that adds rows (the comment above says why only then)
  const key = add.length ? replayKey(hash, "edit_list", args) : null;
  if (key && args.again !== true) {
    const prior = await useKv().getItem<Record<string, unknown>>(key).catch(() => null);
    if (prior) {
      const structured = { ...prior, repeated: true };
      return ok(structured, `${JSON.stringify(structured)}\nThis repeats a call made in the last ten minutes, so nothing was done again. Pass again: true to make the same change a second time.`);
    }
  }
  const w = await openForEdit(hash);
  if (typeof w === "string") return fail(w);
  const rowsBefore = w.work.items.length;

  if (args.list != null) {
    const problem = planMeta(args.list, w);
    if (problem) return fail(problem);
  }
  let foldersChanged = 0;
  if (folders.length) {
    const done = planFolders(folders, w);
    if (typeof done === "string") return fail(done);
    foldersChanged = done.changed;
  }
  // folders named by a new or moved row and missing from the list are made, in the
  // editor's way (FolderBook), and on the working copy before anything is put in them;
  // read after the folders part, so a renamed or removed folder is seen as it now is
  const book = new FolderBook(w.work.folders, (folder) => w.plan({ t: "addFolder", folder }));
  let added = 0;
  if (add.length) {
    const done = await planAdds(add, book, w);
    if (typeof done === "string") return fail(done);
    added = done.added;
  }
  let updated = 0;
  if (update.length) {
    const done = await planUpdates(update, book, w);
    if (typeof done === "string") return fail(done);
    updated = done.updated;
  }
  if (remove.length) {
    const problem = planRemoves(remove, w);
    if (problem) return fail(problem);
  }
  if (!w.ops.length) return fail("Nothing to change.");

  const after = await applyOpsByEditHash(hash, w.ops);
  if (!after) return fail(NO_EDIT_LIST);
  const described = describeList(after, trustedOrigin(event));
  const result = {
    title: described.title,
    unit: described.unit,
    dates: described.dates ?? null,
    trail: described.trail ?? null,
    share_link: described.share_link,
    totals: described.totals,
    added,
    updated,
    removed: rowsBefore + added - w.work.items.length,
    folders_changed: foldersChanged,
    folders_made: book.made.map((f) => f.name),
    folders: [...w.work.folders].sort(bySortOrder).map((f) => f.name),
    repeated: false,
  };
  // remembered after the write, never before: a call that failed leaves no window,
  // so its retry goes through
  if (key) await useKv().setItem(key, result, { ttl: REPLAY_WINDOW_S }).catch(() => {});
  return ok(result);
}

// ---- My Gear ---------------------------------------------------------------------
// The tools below are about an ACCOUNT, where everything above is about a link. A
// list's capability rides in the arguments; an account's cannot, so it arrives as a
// bearer in the Authorization header: a token minted on the account page or the
// access token of an app the person signed in through the connector
// (server/utils/accessTokens.ts). The route resolves that bearer once, before
// dispatch, for every tool whose registry entry names an account use; for the gear
// tools, a get_list with no share_code and an edit_list naming its list by share_code it
// also refuses a missing or dead one with the 401 that opens Claude's sign-in, and a
// read-only one on a write with a 403 (mcp.post.ts). So by the time an account tool
// runs the account is on the event, and create_list — which only uses an account when
// there is one — reads the same answer.

/** Who is calling, as the route left it on the event: an account with a scope, nobody
 *  ("anonymous": no bearer of ours was carried), or a bearer that opens nothing
 *  ("unknown": never issued, revoked, or an app's access token past its hour). */
function whoCalls(event: H3Event): { userId: number; scope: AccessScope } | "anonymous" | "unknown" {
  const caller = event.context.connector;
  if (caller === undefined) return "anonymous";
  return caller ?? "unknown";
}

/**
 * The lists filed under the caller's account, as the account page's "Your lists"
 * shows them (get_list with no share_code): by share code, the read capability, so
 * the assistant can open one without being handed a link, and change it through
 * edit_list's share_code. The edit token is never here. The route has already seen to
 * the sign-in, so the one refusal left is a call that never passed it.
 */
async function readMyLists(event: H3Event): Promise<ToolResult> {
  const caller = event.context.connector;
  if (!caller) return fail("Your lists are reached through the MCP endpoint, which asks for a sign-in first.");
  // the budget is the account's, as get_my_gear's is, never the shared address
  await rateLimitSubject("mcp-read", `lists:${caller.userId}`);
  const origin = trustedOrigin(event);
  const lists = await listClaimedLists(await useAccountDb(), caller.userId);
  return ok({
    lists: lists.map((l) => ({
      title: l.title,
      share_code: l.shareCode,
      share_link: shareLink(origin, l.shareCode),
      unit: l.displayUnit,
      total_g: grams(l.totalMg),
      updated_at: l.updatedAt,
    })),
  });
}

interface GearHandle {
  db: Db;
  userId: number;
  /** null until the account has gear: vaults are minted on the first piece */
  vaultId: number | null;
}

/** The caller's My Gear, opened for a read or a write; the route has already seen to
 *  the sign-in and the scope, so the one refusal left is a call that never passed it. */
async function openGear(event: H3Event, need: AccessScope): Promise<GearHandle | string> {
  const caller = event.context.connector;
  if (!caller) return "My Gear is reached through the MCP endpoint, which asks for a sign-in first.";
  // the budget is the account's, as a list tool's is the list's: one busy assistant
  // runs down its own allowance and nobody else's, whatever address it calls from
  await rateLimitSubject(need === "write" ? "mcp-write" : "mcp-read", `gear:${caller.userId}`);
  const db = await useVaultDb();
  return { db, userId: caller.userId, vaultId: await touchVaultByUser(db, caller.userId) };
}

const NO_SUCH_GEAR = "Nothing in My Gear has that id; get_my_gear gives the ids.";

/** how two folder names are judged the same: the gear page folds case and the
 *  typographic cleanup tidyText applies, so "Shelter", "shelter" and "SHELTER" are one */
const folderKey = (name: string) => tidyText(name).toLowerCase();

interface GearFolders {
  /** folderKey → id, for filing by name */
  idOf: Map<string, number>;
  /** id → name as the page shows it, for answering */
  nameOf: Map<number, string>;
}

/**
 * The vault's folders both ways, from one read — and names in `wanted` the vault
 * lacks made first, which costs the making and a second read. A name that can't be
 * made because the folder ceiling is reached is simply absent from idOf, and the
 * caller decides what that means.
 */
async function gearFolders(db: Db, vaultId: number, wanted: string[] = []): Promise<GearFolders> {
  let folders = await listVaultFolders(db, vaultId);
  const have = new Set(folders.map((f) => folderKey(f.name)));
  const missing = [...new Set(wanted.filter((n) => n && !have.has(folderKey(n))).map((n) => tidyText(n).slice(0, MAX_FOLDER_NAME_LEN)))];
  if (missing.length) {
    await ensureVaultFolders(db, vaultId, missing);
    folders = await listVaultFolders(db, vaultId);
  }
  return { idOf: new Map(folders.map((f) => [folderKey(f.name), f.id])), nameOf: new Map(folders.map((f) => [f.id, f.name])) };
}

/** One piece as the tools return it. Named field by field, as describeList is, so a
 *  column added to the vault later has to be chosen here before it leaves. */
function gearAsRow(piece: VaultEntry, folderNames: Map<number, string>): Record<string, unknown> {
  return {
    id: piece.id,
    display_name: itemDisplayName(piece.brand ?? null, piece.name, piece.variant ?? null),
    name: piece.name,
    brand: piece.brand ?? null,
    variant: piece.variant ?? null,
    gear_type: piece.commonName ?? null,
    weight_g: grams(piece.weightMg),
    classification: piece.classification ?? null,
    kcal: piece.kcal ?? null,
    catalog_id: piece.catalogItemId ?? null,
    note: piece.description ?? null,
    price: piece.priceCents != null ? piece.priceCents / 100 : null,
    currency: piece.currency ?? null,
    product_url: piece.productUrl ?? null,
    folder: piece.folderId != null ? (folderNames.get(piece.folderId) ?? null) : null,
    times_used: piece.timesSeen,
    last_used: piece.lastUsedAt,
  };
}

/**
 * The gear fields of a tool call, translated into the vault repo's own patch (its
 * column names, milligrams, cents) with the folder name set aside. A field that is
 * absent stays absent and one that is null stays null, so the same translation
 * serves an add (where the repo drops a null) and an update (where a null clears).
 * Only the TYPES are checked here; the repo caps, tidies and validates the values by
 * the rules the gear page's own writes get, so the two paths can't disagree.
 */
function gearPatchFrom(raw: unknown): { patch: Record<string, unknown>; folder?: string } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const take = (field: string, column: string) => {
    if (typeof r[field] === "string" || r[field] === null) patch[column] = r[field];
  };
  take("name", "name");
  take("brand", "brand");
  take("variant", "variant");
  take("gear_type", "commonName");
  take("note", "description");
  take("product_url", "productUrl");
  if (typeof r.weight_g === "number" && r.weight_g >= 0 && Number.isFinite(r.weight_g)) patch.weightMg = Math.round(r.weight_g * 1000);
  if (r.classification === null || CLASSIFICATIONS.includes(r.classification as Classification)) patch.classification = r.classification;
  if (r.kcal === null || (typeof r.kcal === "number" && Number.isFinite(r.kcal))) patch.kcal = r.kcal;
  // typed here, checked in editGear: an id that isn't a catalog row refuses the call
  if (r.catalog_id === null || isCatalogId(r.catalog_id)) patch.catalogItemId = r.catalog_id;
  if (r.price === null) patch.priceCents = null;
  else if (typeof r.price === "number" && r.price >= 0 && Number.isFinite(r.price)) {
    patch.priceCents = Math.round(r.price * 100);
    if (typeof r.currency === "string") patch.currency = r.currency.trim().toUpperCase();
  }
  return { patch, folder: typeof r.folder === "string" ? r.folder.trim() : undefined };
}

async function readGear(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  const gear = await openGear(event, "read");
  if (typeof gear === "string") return fail(gear);
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 100) : "";
  if (query && !enoughToSearch(query)) return fail("A query needs two characters or more (one is enough in Chinese); leave it out to read everything.");
  const limit = clampInt(args.limit, 1, GEAR_PAGE_MAX, GEAR_PAGE_DEFAULT);
  const offset = clampInt(args.offset, 0, GEAR_PAGE_MAX, 0);
  // no vault yet is the ordinary state of a new account, and it reads as empty
  if (gear.vaultId == null) return ok({ gear: [], folders: [], total: 0, offset });
  const { db, vaultId } = gear;
  const [pieces, folders] = await Promise.all([
    query ? searchVaultItems(db, vaultId, query, GEAR_PAGE_MAX) : listVaultItems(db, vaultId),
    listVaultFolders(db, vaultId),
  ]);
  let matches = pieces;
  if (typeof args.folder === "string") {
    const want = args.folder.trim();
    if (!want) matches = pieces.filter((p) => p.folderId == null);
    else {
      const inFolder = new Set(folders.filter((f) => folderKey(f.name) === folderKey(want)).map((f) => f.id));
      if (!inFolder.size) return fail(`My Gear has no folder called "${want}". Its folders: ${folders.map((f) => f.name).join(", ") || "none yet"}.`);
      matches = pieces.filter((p) => p.folderId != null && inFolder.has(p.folderId));
    }
  }
  const names = new Map(folders.map((f) => [f.id, f.name]));
  return ok({
    gear: matches.slice(offset, offset + limit).map((p) => gearAsRow(p, names)),
    folders: folders.map((f) => f.name),
    total: matches.length,
    offset,
  });
}

/**
 * The catalog's fields on a piece that names a catalog_id, each where the call gave
 * none: brand, name, variant, gear type, weight and calories, the way a list row takes
 * them from a pick (linkCatalog), so a piece linked here reads as one picked on the
 * site. They go through the ordinary patch, so they are pinned as the owner's choice
 * of product, like every field typed into My Gear.
 */
function fromCatalog(piece: { patch: Record<string, unknown>; folder?: string }, catalogRows: CatalogRows): typeof piece {
  const id = piece.patch.catalogItemId;
  const row = isCatalogId(id) ? catalogRows.get(id) : undefined;
  if (!row) return piece;
  const patch = { ...piece.patch };
  if (patch.name === undefined) patch.name = row.name;
  if (patch.brand === undefined) patch.brand = row.brand ?? null;
  if (patch.variant === undefined) patch.variant = row.variant ?? null;
  if (patch.commonName === undefined && row.commonName) patch.commonName = row.commonName;
  if (patch.weightMg === undefined) patch.weightMg = row.weightMg;
  if (patch.kcal === undefined && row.kcal != null) patch.kcal = row.kcal;
  return { ...piece, patch };
}

/** an array of pieces or ids in edit_my_gear, bounded, or the sentence when it isn't one */
function gearPart(args: Record<string, unknown>, key: string): unknown[] | string {
  const v = args[key];
  if (v == null) return [];
  if (!Array.isArray(v)) return `${key} must be an array.`;
  if (v.length > GEAR_EDIT_MAX) return `At most ${GEAR_EDIT_MAX} pieces in ${key} in one call; send the rest in another.`;
  return v;
}

/**
 * Every change to My Gear, in one call: add, update, remove, restore, in that order.
 * The vault's writes are separate statements, not one batch like a list's ops, so the
 * answer is per piece rather than all-or-nothing: each entry reports what became of
 * it, and an id that names nothing in this vault is "not_found" rather than a refusal
 * of the whole call. What IS refused whole is a malformed call (a part that isn't an
 * array, an id that isn't one), before anything is written.
 */
async function editGear(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  const gear = await openGear(event, "write");
  if (typeof gear === "string") return fail(gear);
  const parts = { add: gearPart(args, "add"), update: gearPart(args, "update"), remove: gearPart(args, "remove"), restore: gearPart(args, "restore") };
  for (const part of Object.values(parts)) if (typeof part === "string") return fail(part);
  const { add, update, remove, restore } = parts as Record<keyof typeof parts, unknown[]>;
  if (!add.length && !update.length && !remove.length && !restore.length) return fail("Nothing to change: give add, update, remove or restore.");
  const updates = update.map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>) : {}));
  if (!updates.every((e) => isSerialId(e.id))) return fail("Every entry in update needs the piece's id, from get_my_gear.");
  if (![...remove, ...restore].every(isSerialId)) return fail("remove and restore take pieces' ids, from get_my_gear.");
  // the catalog rows the adds and updates name, read once; an id that is no catalog
  // row refuses the call before anything is written, as it does on a list row
  const named = [...add, ...updates].map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>).catalog_id : undefined));
  for (const id of named) if (id != null && !isCatalogId(id)) return fail(`catalog_id ${String(id)} isn't a catalog id; take one from search_catalog.`);
  const linkIds = named.filter(isCatalogId);
  const catalogRows: CatalogRows = linkIds.length ? await catalogRowsById(await useCatalogDb(), linkIds) : new Map();
  for (const id of linkIds) if (!catalogRows.has(id)) return fail(`catalog_id ${id} isn't in the catalog; take an id from search_catalog.`);
  const { db, userId } = gear;
  let vaultId = gear.vaultId;

  // add: the named pieces go to the vault in one batch; the nameless keep their place
  // in the answer as invalid. A call with nothing nameable mints no vault for an
  // account that had none.
  const results: { index: number; status: string; item?: Record<string, unknown> }[] = [];
  let added = 0;
  if (add.length) {
    const pieces = add.map((raw) => fromCatalog(gearPatchFrom(raw), catalogRows));
    const hasName = (p: (typeof pieces)[number]) => typeof p.patch.name === "string" && p.patch.name.trim() !== "";
    for (const [index] of pieces.entries()) results.push({ index, status: "invalid" });
    const named = pieces.map((p, index) => ({ p, index })).filter(({ p }) => hasName(p));
    if (named.length) {
      vaultId ??= await mintVault(db, userId);
      const folders = await gearFolders(db, vaultId, named.flatMap(({ p }) => (p.folder ? [p.folder] : [])));
      const outcomes = await addVaultItems(
        db,
        vaultId,
        named.map(({ p }) => ({ t: "add", ...p.patch, folderId: p.folder ? (folders.idOf.get(folderKey(p.folder)) ?? null) : null }) as Extract<VaultItemOp, { t: "add" }>),
      );
      named.forEach(({ index }, i) => {
        const outcome = outcomes[i];
        if (!outcome) return;
        if ("refused" in outcome) results[index] = { index, status: outcome.refused === "duplicate" ? "already_have" : "full" };
        else {
          results[index] = { index, status: "added", item: gearAsRow(outcome.item, folders.nameOf) };
          added++;
        }
      });
    }
  }

  // update: the fields first, which answer with the piece or with nothing for an id
  // that isn't this vault's, and only then a folder, so none is made for a bad id
  const updated: { id: number; status: string; item?: Record<string, unknown> }[] = [];
  for (const e of updates) {
    const id = e.id as number;
    const { patch, folder } = fromCatalog(gearPatchFrom(e), catalogRows);
    if (patch.name === null || patch.name === "" || (!Object.keys(patch).length && folder === undefined)) {
      updated.push({ id, status: "invalid" });
      continue;
    }
    if (vaultId == null) {
      updated.push({ id, status: "not_found" });
      continue;
    }
    let after: VaultEntry | null = null;
    if (Object.keys(patch).length) {
      const outcome = await applyVaultItemOp(db, vaultId, { t: "edit", id, patch } as VaultItemOp);
      if (!outcome) {
        updated.push({ id, status: "not_found" });
        continue;
      }
      if ("refused" in outcome) {
        updated.push({ id, status: "invalid" });
        continue;
      }
      after = outcome.item;
    } else {
      after = await vaultItemById(db, vaultId, id);
      if (!after) {
        updated.push({ id, status: "not_found" });
        continue;
      }
    }
    const folders = await gearFolders(db, vaultId, folder ? [folder] : []);
    if (folder !== undefined) {
      const folderId = folder ? (folders.idOf.get(folderKey(folder)) ?? null) : null;
      // a folder that can't be made (the ceiling) leaves the piece where it was
      if ((!folder || folderId != null) && (await applyVaultFolderOp(db, vaultId, { t: "move", itemId: id, folderId }))) after = { ...after, folderId: folderId ?? undefined };
    }
    updated.push({ id, status: "updated", item: gearAsRow(after, folders.nameOf) });
  }

  const removed: { id: number; status: string }[] = [];
  for (const id of remove as number[]) {
    const done = vaultId != null && (await removeVaultItem(db, vaultId, id));
    removed.push({ id, status: done ? "removed" : "not_found" });
  }
  for (const id of restore as number[]) {
    const done = vaultId != null && (await restoreVaultItem(db, vaultId, id));
    removed.push({ id, status: done ? "restored" : "not_found" });
  }
  return ok({ added, results, updated, removed });
}
