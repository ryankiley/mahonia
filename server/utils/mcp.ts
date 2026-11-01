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
// My Gear is the one exception, and it brings the one credential that is neither a
// share code nor an edit link. Gear belongs to an account, not to a link, so there is
// nothing for a tool argument to carry; the four gear tools instead take a bearer in
// the Authorization header — a token minted by hand on the account page
// (server/utils/accessTokens.ts), or the access token of an app the person signed in
// through the connector's OAuth flow (server/utils/oauth.ts). The list tools never
// look at that header. The route checks it for the gear tools before any of them
// runs and answers a missing one with the 401 that starts a sign-in (mcp.post.ts);
// the gear section at the end of this file is what runs once it has passed.
//
// The protocol layer (JSON-RPC over one HTTP endpoint) is server/routes/mcp.post.ts;
// this file is the tools, so they can be tested as functions and read as a list.

import type { H3Event } from "h3";
import { listToMarkdown } from "../../shared/exporters/markdown";
import { exportSections } from "../../shared/exporters/rows";
import { colorKeyForName, usedColorKeys } from "../../shared/categories";
import { uid } from "../../shared/id";
import { editLinkPath, normalizeShareCode } from "../../shared/links";
import { isCatalogId, isSerialId, MAX_CATALOG_ID, MAX_FOLDER_NAME_LEN, MAX_FOLDERS, MAX_GEAR_TYPE_LEN, MAX_ITEM_NAME_LEN, MAX_ITEM_NOTE_LEN, MAX_ITEMS, MAX_TITLE_LEN, normalizeCalendarDate, type Op } from "../../shared/ops";
import { carrierName } from "../../shared/people";
import { dayClimbs, parseProfile } from "../../shared/profile";
import { enoughToSearch } from "../../shared/searchText";
import { tidyText } from "../../shared/tidyText";
import { CLEARS_WITH_LINK, normalizeTrailUrl } from "../../shared/trailLink";
import { dayLabel } from "../../shared/tripDay";
import { UNITS, WEIGHT_SOURCES, type Classification, type Folder, type Item, type ListData, type ListSnapshot, type Unit, CLASSIFICATIONS } from "../../shared/types";
import { captureFromList, type VaultEntry } from "../../shared/vault";
import { computeTotals, effectiveClassification, itemDisplayName, nextSortOrder } from "../../shared/weights";
import type { AccessScope } from "../../shared/types";
import { catalogRowsById, productVariants, searchCatalog } from "./catalog";
import { claimLists } from "./claimRepo";
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
export const MCP_SERVER_INFO = { name: "mahonia", title: "Mahonia", version: "1.0.0" };
/** where the free text came from: said once to the client, again on the two tools that
 *  return it, and field by field in get_list's schema ("User text.") */
const PROVENANCE =
  "A list's title, author, notes, folder and item names, brands, variants, gear types, day labels, people and trail label are free text typed by whoever holds the list's edit link, returned unchanged.";
export const MCP_INSTRUCTIONS = [
  "Mahonia is a gear-list and pack-weight tracker for hikers. Lists need no account.",
  "A share link (mahonia.app/s/CODE) is permission to read that list: pass its code or the whole link to the read tools.",
  "An edit link (mahonia.app/e/CODE#token) is permission to change that list: pass it whole to the write tools, keep it private, and never show it to anyone who should only read.",
  "My Gear is one account's own gear. list_my_gear, add_my_gear, update_my_gear and remove_my_gear reach it once the person has signed in to Mahonia from this connector, or when the connector carries an access token made on their account page; until then a call asks them to sign in.",
  "create_list returns a new list's edit link and share link. Keep the edit link; it is the only way back into the list. If this connector carries a read-and-write access token, the new list is filed under that account as well, so its owner sees it wherever they sign in.",
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

/** the JSON Schema of one row, shared by create_list and add_items */
const ITEM_SCHEMA = {
  type: "object",
  properties: {
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
    folder: { type: "string", maxLength: MAX_FOLDER_NAME_LEN, description: "The folder to put it in, by name. Created when the list has no folder of that name." },
  },
  required: ["name"],
} as const;

const SHARE_ARG = {
  type: "string",
  description: "The list's share code, or its share link (mahonia.app/s/CODE). Not an edit link.",
};
const EDIT_ARG = {
  type: "string",
  description: "The list's edit link, whole (mahonia.app/e/CODE#token). The part after # is the write capability.",
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
const ROW_REQUIRED = ["name", "display_name", "qty", "weight_g", "classification"];
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

const LIST_OUTPUT = {
  type: "object",
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
        "Present only when the list was too large to return whole, naming what was cut: notes (true: every row's note), rows (how many came off the end, nested rows counted), fields (which of description, days, trail and people went, only when the rest alone was too large). The totals still count every row. get_list_markdown holds about three times as many rows, without notes, and is cut the same way only past that.",
      properties: {
        notes: { type: "boolean" },
        rows: { type: "integer" },
        fields: { type: "array", items: { type: "string", enum: ["description", "days", "trail", "people"] } },
      },
    },
    folders: {
      type: "array",
      description: "In the list's order, each with its rows in order. A folder with no rows is left out; rows in no folder come last, under Unfiled.",
      items: complete({ name: str(USER_TEXT), items: { type: "array", items: ROW } }),
    },
  },
  required: ["title", "share_code", "share_link", "unit", "totals", "folders"],
};

/** one catalog row, in the two catalog tools' common fields */
const CATALOG_ROW = {
  id: { type: "integer", description: "The catalog row id, the one add_items and create_list take as catalog_id." },
  variant: nullable("string", "Size, length or rating; null on a product sold one way."),
  weight_g: { type: "number", description: "The cited weight in grams, to a tenth." },
  verified: { type: "boolean", description: "Whether the cited weight has been verified." },
  weight_source: { type: "string", enum: WEIGHT_SOURCES, description: "Where the weight comes from." },
  kcal: nullable("number", "Calories per unit, on food."),
};

const SEARCH_OUTPUT = complete({
  query: str("The query as searched: trimmed, at most 100 characters."),
  results: {
    type: "array",
    description: "Best first.",
    items: complete({
      ...CATALOG_ROW,
      brand: nullable("string"),
      name: str("The product name, without brand or variant."),
      display_name: str("Brand, name and variant joined."),
      gear_type: nullable("string", "What kind of thing it is: Tent, Quilt, Trail runners."),
      category: nullable("string", "The catalog's category: shelter, sleep, pack, and so on."),
    }),
  },
});

const PRODUCT_OUTPUT = complete({
  brand: nullable("string"),
  name: str("The product name, without brand or variant."),
  gear_type: nullable("string"),
  category: nullable("string"),
  variants: {
    type: "array",
    description: "Every active variant, in variant order.",
    items: complete({ ...CATALOG_ROW, source_url: nullable("string", "The page the weight was read from.") }),
  },
});

const CREATE_FIELDS = {
  title: str(USER_TEXT),
  edit_link: str("The write capability. Keep it; it is the only way back into the list."),
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

const ADD_OUTPUT = complete({
  added: { type: "integer", description: "Rows added." },
  folders_made: { type: "array", items: str(USER_TEXT), description: "Folders that didn't exist and were made for these rows." },
  share_link: str(),
  totals: TOTALS_SCHEMA,
  repeated: {
    type: "boolean",
    description: "True when this call repeated one made in the last ten minutes: nothing was added again, and the figures are that call's. Pass again: true to add the rows a second time.",
  },
});

const TRIP_OUTPUT = complete({
  title: str(USER_TEXT),
  unit: UNIT_SCHEMA,
  dates: { ...DATES_SCHEMA, type: ["object", "null"] },
  trail: { ...TRAIL_SCHEMA, type: ["object", "null"] },
  share_link: str(),
});

// ---- My Gear ---------------------------------------------------------------------
// One account's gear. Its capability is the access token in the Authorization header
// rather than an argument; the gear section at the end says how that is read.

const GEAR_ROW = complete({
  id: { type: "integer", description: "Names the piece to update_my_gear and remove_my_gear." },
  display_name: str(`Brand, name and variant joined, the way the gear page shows a piece. ${USER_TEXT}`),
  name: str(USER_TEXT),
  brand: nullable("string", USER_TEXT),
  variant: nullable("string", USER_TEXT),
  gear_type: nullable("string", `Tent, Quilt, Stove. ${USER_TEXT}`),
  weight_g: { type: "number", description: "Grams for one, to a tenth; 0 when it has never been weighed. On a kit, the whole kit: its items plus its own weight." },
  classification: { type: ["string", "null"], enum: [...CLASSIFICATIONS, null], description: "base, worn or consumable; null when the owner leaves it to each list." },
  kcal: nullable("number", "Calories in one, on food."),
  note: nullable("string", USER_TEXT),
  price: nullable("number", "What one cost, in the currency's main unit."),
  currency: nullable("string", "ISO 4217 code of price, when one was recorded."),
  product_url: nullable("string"),
  folder: nullable("string", `The folder it is filed in; null when unfiled. ${USER_TEXT}`),
  times_used: { type: "integer", description: "How many list saves have carried this piece into My Gear." },
  last_used: str("When a list last carried it, ISO 8601."),
  kit: {
    type: ["object", "null"],
    description: "Null on a single piece. On a KIT, a set the owner keeps together: what it weighs by itself (a stuff sack) and the items it holds, each also a piece of My Gear by its own id. Its weight_g already counts them, so put a kit on a list either as one row or as its items, never both.",
    properties: {
      own_weight_g: { type: "number", description: "What the kit weighs by itself, in grams; usually 0." },
      items: {
        type: "array",
        items: complete({
          id: { type: "integer", description: "The item's own id in My Gear." },
          display_name: str(USER_TEXT),
          count: { type: "integer", description: "How many of it the kit holds." },
          weight_g: { type: "number", description: "Grams for one." },
          put_away: { type: "boolean", description: "Removed from My Gear: still listed in the kit, no longer counted in its weight." },
        }),
      },
    },
    required: ["own_weight_g", "items"],
  },
  in_kits: { type: "array", items: { type: "integer" }, description: "The ids of the kits this piece is in; empty when none." },
});
const GEAR_LIST_OUTPUT = complete({
  gear: { type: "array", items: GEAR_ROW, description: "This page of the matches." },
  folders: { type: "array", items: str(USER_TEXT), description: "Every folder My Gear has, in the owner's order, empty ones included." },
  total: { type: "integer", description: "Matches in all, before offset and limit." },
  offset: { type: "integer" },
});
const GEAR_ADD_OUTPUT = complete({
  added: { type: "integer", description: "Pieces that were new to My Gear." },
  results: {
    type: "array",
    description: "One per piece sent, in the order sent.",
    items: {
      type: "object",
      properties: {
        index: { type: "integer", description: "Position in the request's items." },
        status: { type: "string", enum: ["added", "already_have", "invalid", "full"], description: "already_have: the same brand, name and variant is there already, untouched. invalid: no name. full: My Gear is at its ceiling." },
        item: GEAR_ROW,
      },
      required: ["index", "status"],
    },
  },
});
const GEAR_UPDATE_OUTPUT = complete({ item: GEAR_ROW });
const GEAR_REMOVE_OUTPUT = complete({
  id: { type: "integer" },
  status: { type: "string", enum: ["removed", "restored"] },
});

const GEAR_PAGE_MAX = 1000;
const GEAR_PAGE_DEFAULT = 300;
const GEAR_ADD_MAX = 50;
/** the vault's own caps on free text (shared/vault), stated in the schemas the way
 *  the reducer's are above */
const GEAR_NAME_LEN = 200;
const GEAR_FIELD_LEN = 120;
const GEAR_NOTE_LEN = 2000;

/**
 * The fields of one piece of gear as the write tools take them. For add_my_gear every
 * field is a value; for update_my_gear each may also be null, which clears it, and
 * the descriptions say so.
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
   *  can't run without, or "optional" for a tool that uses one when it is there. The
   *  route reads this before dispatch (mcp.post.ts); unset means the tool never looks. */
  account?: AccessScope | "optional";
};

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// destructive, honestly: set_trip REPLACES a title and can clear the dates or the
// trail, and the hint's own definition says false means additive updates only
const SET = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

const MCP_TOOL_REGISTRY: RegisteredMcpTool[] = [
  {
    name: "get_list",
    title: "Read a shared list",
    description: `A shared list as data: title, unit, dates, trail, totals in grams, and every folder with its rows (brand, name, variant, quantity, weight of one unit in grams, classification, note, calories, who carries it; a nested row without carried_by is carried by its parent's carrier). Takes a share code or share link. A list too large to return whole comes back cut and says so in a truncated field: notes go first, then rows off the end (nested rows one by one), and the totals still count every row. ${PROVENANCE}`,
    inputSchema: { type: "object", properties: { share_code: SHARE_ARG }, required: ["share_code"] },
    outputSchema: LIST_OUTPUT,
    annotations: READ,
    run: getList,
  },
  {
    name: "get_list_markdown",
    title: "Read a shared list as Markdown",
    description: `The same list as Markdown: one table per folder and a totals block, the text the site's own Markdown export produces. Takes a share code or share link. A list too large to return whole loses rows off the end of the tables, a line under them says how many, and the totals still count every row. ${PROVENANCE}`,
    inputSchema: { type: "object", properties: { share_code: SHARE_ARG }, required: ["share_code"] },
    annotations: READ,
    run: (_event, args) => getListMarkdown(args),
  },
  {
    name: "search_catalog",
    title: "Search the gear catalog",
    description:
      "Fuzzy search of Mahonia's cited gear catalog by brand, product or kind of gear (\"duplex\", \"zpacks\", \"quilt\"). Each result carries a catalog id, the cited weight in grams and whether it is verified. Use get_catalog_product for every variant of one product.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Two characters or more; a single Chinese character is enough." },
        limit: { type: "integer", minimum: 1, maximum: SEARCH_LIMIT_MAX, description: `Up to ${SEARCH_LIMIT_MAX}. Default ${SEARCH_LIMIT_DEFAULT}.` },
      },
      required: ["query"],
    },
    outputSchema: SEARCH_OUTPUT,
    annotations: READ,
    run: (_event, args) => search(args),
  },
  {
    name: "get_catalog_product",
    title: "One catalog product, every variant",
    description:
      "One product's variants (sizes, lengths, temperature ratings) with the cited weight and source of each. Give a catalog id from search_catalog, or the brand and product name.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1, description: "A catalog row id; its siblings are the other variants." },
        brand: { type: "string" },
        name: { type: "string", description: "The product name without brand or variant." },
      },
    },
    outputSchema: PRODUCT_OUTPUT,
    annotations: READ,
    run: (_event, args) => product(args),
  },
  {
    name: "create_list",
    title: "Make a new list",
    description:
      "Creates a list and returns its edit link and share link. Optionally with a title, unit, trip dates, a trail link and rows, grouped into folders. Keep the edit link: it is the only way back into the list. If this connector carries a read-and-write access token the list is filed under that account too, and saved_to_account says whether it was; otherwise the list belongs to whoever holds the edit link, as every list does.",
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
    name: "add_items",
    title: "Add rows to a list",
    description: "Adds rows to an existing list. Takes the list's edit link and the rows; each row may name a folder, and a folder that doesn't exist yet is created.",
    inputSchema: {
      type: "object",
      properties: {
        edit_link: EDIT_ARG,
        items: { type: "array", minItems: 1, items: ITEM_SCHEMA },
        folder: { type: "string", maxLength: MAX_FOLDER_NAME_LEN, description: "A folder name for every row that doesn't name its own." },
        again: {
          type: "boolean",
          description:
            "A call identical to one made in the last ten minutes is taken as a retry and adds nothing: the earlier result comes back with repeated set. Pass true to add the same rows a second time on purpose.",
        },
      },
      required: ["edit_link", "items"],
    },
    outputSchema: ADD_OUTPUT,
    annotations: ADD,
    run: addItems,
  },
  {
    name: "set_trip",
    title: "Set a list's title, dates, unit and trail",
    description:
      "Sets any of a list's title, display unit, trip dates and trail on an existing list. Only the fields given change; an empty string clears a date or the trail. Takes the list's edit link.",
    inputSchema: {
      type: "object",
      properties: {
        edit_link: EDIT_ARG,
        title: { type: "string", maxLength: MAX_TITLE_LEN },
        unit: UNIT_SCHEMA,
        start_date: { type: "string", description: "YYYY-MM-DD, or an empty string to clear." },
        end_date: { type: "string", description: "YYYY-MM-DD, or an empty string to clear." },
        trail_url: { type: "string", maxLength: TRAIL_URL_LEN, description: "An http(s) link, or an empty string to clear the trail and everything that came with it (label, distance, climb, route)." },
        trail_label: { type: "string", maxLength: TRAIL_LABEL_LEN },
        trail_distance_km: { type: "number", minimum: 0, description: "Stored in metres and shown in the list's own distance unit." },
      },
      required: ["edit_link"],
    },
    outputSchema: TRIP_OUTPUT,
    annotations: SET,
    run: setTrip,
  },
  {
    name: "list_my_gear",
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
    name: "add_my_gear",
    title: "Add to My Gear",
    description:
      "Puts new pieces of gear into the connector's account's My Gear. A piece the account already holds (same brand, name and variant) comes back as already_have and is left as it was; change it with update_my_gear instead. What is given here counts as the owner's own word on the piece, so a list saved later cannot overwrite it. Needs a read-and-change access token.",
    inputSchema: {
      type: "object",
      properties: {
        items: { type: "array", minItems: 1, maxItems: GEAR_ADD_MAX, items: { type: "object", properties: gearInput("add"), required: ["name"] } },
      },
      required: ["items"],
    },
    outputSchema: GEAR_ADD_OUTPUT,
    annotations: ADD,
    account: "write",
    run: addGear,
  },
  {
    name: "update_my_gear",
    title: "Change a piece of My Gear",
    description:
      "Changes one piece by the id list_my_gear gave it. Only the fields sent change, and null clears one. A changed field counts as the owner's own word on the piece, so a list saved later cannot overwrite it. Needs a read-and-change access token.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 }, ...gearInput("update") },
      required: ["id"],
    },
    outputSchema: GEAR_UPDATE_OUTPUT,
    annotations: SET,
    account: "write",
    run: changeGear,
  },
  {
    name: "remove_my_gear",
    title: "Put away a piece of My Gear",
    description:
      "Puts one piece away by its id: it stops being offered on lists, and the lists that still carry it will not bring it back. Pass restore: true to bring a put-away piece back. Needs a read-and-change access token.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 }, restore: { type: "boolean", description: "True to bring a put-away piece back instead." } },
      required: ["id"],
    },
    outputSchema: GEAR_REMOVE_OUTPUT,
    annotations: SET,
    account: "write",
    run: putAwayGear,
  },
];

/** Public protocol metadata. Handlers and the account rule stay server-only and never
 *  reach tools/list. */
export const MCP_TOOLS: McpTool[] = MCP_TOOL_REGISTRY.map(({ run: _run, account: _account, ...tool }) => tool);
/** The tools that use the account behind the bearer, and how (see RegisteredMcpTool),
 *  for the route's gate — read off the registry, so a tool can't be in one and not
 *  the other. */
export const ACCOUNT_TOOLS: Record<string, AccessScope | "optional"> = Object.fromEntries(
  MCP_TOOL_REGISTRY.flatMap((tool) => (tool.account ? [[tool.name, tool.account]] : [])),
);
const mcpToolByName = new Map(MCP_TOOL_REGISTRY.map((tool) => [tool.name, tool]));

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
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  const tool = mcpToolByName.get(name);
  return tool ? tool.run(event, args) : fail(`Unknown tool: ${name}`);
}

// ---- reading ---------------------------------------------------------------------

/** A share code out of whatever was pasted: the code, or a share link with or
 *  without the .md twin's suffix. "" when it can't be one. */
export function shareCodeFrom(input: unknown): string {
  if (typeof input !== "string") return "";
  const s = input.trim();
  const m = /\/s\/([^/?#]+?)(?:\.md)?(?:[?#].*)?$/i.exec(s);
  return normalizeShareCode(m ? m[1]! : s);
}

const NO_SHARE = "That isn't a Mahonia share code or share link. A share link looks like mahonia.app/s/CODE; an edit link (with #) opens nothing here.";
const NO_LIST = "No list is shared at that code. It may have been deleted, or the link replaced.";

async function getList(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  const code = shareCodeFrom(args.share_code);
  if (!code) return fail(NO_SHARE);
  // the read budget is the list's, not the caller's address's (see RATE_LIMITS "mcp")
  await rateLimitSubject("mcp-read", code);
  const snap = await getByShareCode(code);
  if (!snap) return fail(NO_LIST);
  return ok(fitList(describeList(snap, trustedOrigin(event))));
}

async function getListMarkdown(args: Record<string, unknown>): Promise<ToolResult> {
  const code = shareCodeFrom(args.share_code);
  if (!code) return fail(NO_SHARE);
  await rateLimitSubject("mcp-read", code);
  const snap = await getTextByShareCode(code);
  if (!snap) return fail(NO_LIST);
  return { content: [{ type: "text", text: fitMarkdown(listToMarkdown(snap)) }] };
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
 *  create and add_items echoes, which used to compute the whole description to read it. */
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
    .map((s) => ({ name: s.name, items: s.rows.map((r) => row(r.item, r.children)) }));
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

async function search(args: Record<string, unknown>): Promise<ToolResult> {
  const query = typeof args.query === "string" ? args.query.trim().slice(0, 100) : "";
  if (!enoughToSearch(query)) return fail("Give at least two characters to search for (one is enough in Chinese).");
  const limit = clampInt(args.limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT);
  const rows = await searchCatalog(await useCatalogDb(), query, limit);
  return ok({
    query,
    results: rows.map((r) => ({
      id: r.id,
      brand: r.brand,
      name: r.name,
      variant: r.variant,
      display_name: itemDisplayName(r.brand, r.name, r.variant),
      weight_g: grams(r.weightMg),
      gear_type: r.commonName ?? null,
      category: r.categoryHint ?? null,
      kcal: r.kcal ?? null,
      verified: r.verified,
      weight_source: r.weightSource,
    })),
  });
}

async function product(args: Record<string, unknown>): Promise<ToolResult> {
  const id = clampInt(args.id, 1, Number.MAX_SAFE_INTEGER, 0) || undefined;
  const brand = typeof args.brand === "string" ? args.brand.trim().slice(0, 200) : undefined;
  const name = typeof args.name === "string" ? args.name.trim().slice(0, 200) : undefined;
  if (!id && !name) return fail("Give a catalog id from search_catalog, or the product's name (and brand).");
  const found = await productVariants(await useCatalogDb(), { id, brand, name });
  if (!found) return fail("No active catalog product matches that. Try search_catalog first and pass an id from its results.");
  return ok({
    brand: found.brand,
    name: found.name,
    gear_type: found.commonName,
    category: found.categoryHint,
    variants: found.variants.map((v) => ({
      id: v.id,
      variant: v.variant,
      weight_g: grams(v.weightMg),
      verified: v.verified,
      weight_source: v.weightSource,
      source_url: v.sourceUrl,
      kcal: v.kcal,
    })),
  });
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

const NO_EDIT = "That isn't an edit link. One looks like mahonia.app/e/CODE#token, and the part after # is what opens the list for changes; a share link can't.";
const NO_EDIT_LIST = "That edit link doesn't open a list. Check it was copied whole, including everything after the #.";

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
  constructor(existing: readonly Folder[]) {
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
    return folder;
  }
}

/**
 * The two write tools accept rows in different envelopes, but every row follows the
 * same path: an item-level folder wins over the surrounding folder, a missing named
 * folder is made, and its sort order is the next free slot in that folder. Keeping
 * that policy here means create_list and add_items cannot quietly diverge on a later
 * validation or ordering change.
 */
class ItemPlan {
  readonly items: Item[] = [];
  private readonly counted = new Map<string | null, number>();

  constructor(
    readonly folders: FolderBook,
    private readonly existingItems: readonly Item[] = [],
  ) {}

  place(raw: unknown, fallbackFolder: Folder | null): string | null {
    let folder = fallbackFolder;
    const named = raw && typeof raw === "object" ? (raw as Record<string, unknown>).folder : undefined;
    if (typeof named === "string" && named.trim()) {
      const resolved = this.folders.resolve(named);
      if (typeof resolved === "string") return resolved;
      folder = resolved;
    }
    const folderId = folder?.id ?? null;
    const sortOrder = this.nextSortOrder(folderId);
    const item = toItem(raw, folderId, sortOrder);
    if (typeof item === "string") return item;
    this.items.push(item);
    return null;
  }

  placeAll(rows: readonly unknown[], fallbackFolder: Folder | null): string | null {
    for (const row of rows) {
      const problem = this.place(row, fallbackFolder);
      if (problem) return problem;
    }
    return null;
  }

  private nextSortOrder(folderId: string | null): number {
    // New rows go after what the folder already holds: past its highest sortOrder,
    // not its count, since a removed row leaves a hole the count would fill mid-folder.
    const next = this.counted.get(folderId) ?? nextSortOrder(this.existingItems, folderId);
    this.counted.set(folderId, next + 1);
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

// A retried add_items must not add its rows twice. Clients retry a call that timed
// out or lost its answer, and nothing in the protocol marks the retry; so an
// add_items identical to one this list took in the last ten minutes (same rows, same
// folder, same edit link: the arguments, stably serialised, hashed with the edit hash)
// answers with that call's result and `repeated: true`, and adds nothing. The window
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
  const { edit_link: _link, again: _again, ...rest } = args;
  return `mcp:replay:${sha256Hex(`${hash}|${tool}|${stableJson(rest)}`)}`;
}
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

async function addItems(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  const hash = editHashFrom(args.edit_link);
  if (!hash) return fail(NO_EDIT);
  // the write budget is the list's: spent once the link has yielded a hash to key it
  // on, so a call with no link costs nothing past the endpoint's own guard
  await rateLimitSubject("mcp-write", hash);
  if (!Array.isArray(args.items) || !args.items.length) return fail("items must be a non-empty array of rows.");
  if (args.again != null && typeof args.again !== "boolean") return fail("again must be true or false.");
  const key = replayKey(hash, "add_items", args);
  if (args.again !== true) {
    const prior = await useKv().getItem<Record<string, unknown>>(key).catch(() => null);
    if (prior) {
      const structured = { ...prior, repeated: true };
      return ok(structured, `${JSON.stringify(structured)}\nThis repeats a call made in the last ten minutes, so the rows were not added again. Pass again: true to add them a second time.`);
    }
  }
  const snap = await getByEditHash(hash);
  if (!snap) return fail(NO_EDIT_LIST);
  if (snap.items.length + args.items.length > MAX_ITEMS) return fail(`A list holds at most ${MAX_ITEMS} rows; this one has ${snap.items.length}.`);

  const plan = new ItemPlan(new FolderBook(snap.folders), snap.items);
  let fallback: Folder | null = null;
  if (typeof args.folder === "string" && args.folder.trim()) {
    const got = plan.folders.resolve(args.folder);
    if (typeof got === "string") return fail(got);
    fallback = got;
  }
  const problem = plan.placeAll(args.items, fallback);
  if (problem) return fail(problem);
  const unlinked = await linkCatalog(plan.items);
  if (unlinked) return fail(unlinked);
  const ops: Op[] = [
    ...plan.folders.made.map((folder): Op => ({ t: "addFolder", folder })),
    ...plan.items.map((item): Op => ({ t: "addItem", item })),
  ];
  const after = await applyOpsByEditHash(hash, ops);
  if (!after) return fail(NO_EDIT_LIST);
  const origin = trustedOrigin(event);
  const result = {
    added: plan.items.length,
    folders_made: plan.folders.made.map((f) => f.name),
    share_link: shareLink(origin, after.shareCode),
    totals: describeTotals(after),
    repeated: false,
  };
  // remembered after the write, never before: a call that failed leaves no window,
  // so its retry goes through
  await useKv().setItem(key, result, { ttl: REPLAY_WINDOW_S }).catch(() => {});
  return ok(result);
}

async function setTrip(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  const hash = editHashFrom(args.edit_link);
  if (!hash) return fail(NO_EDIT);
  await rateLimitSubject("mcp-write", hash);
  const meta = tripMeta(args);
  if (typeof meta === "string") return fail(meta);
  if (!Object.keys(meta).length) return fail("Nothing to set: give a title, unit, start_date, end_date, trail_url, trail_label or trail_distance_km.");
  const after = await applyOpsByEditHash(hash, [{ t: "setMeta", patch: meta as Extract<Op, { t: "setMeta" }>["patch"] }]);
  if (!after) return fail(NO_EDIT_LIST);
  const origin = trustedOrigin(event);
  const described = describeList(after, origin);
  return ok({
    title: described.title,
    unit: described.unit,
    dates: described.dates ?? null,
    trail: described.trail ?? null,
    share_link: described.share_link,
  });
}

// ---- My Gear ---------------------------------------------------------------------
// The tools below are about an ACCOUNT, where everything above is about a link. A
// list's capability rides in the arguments; an account's cannot, so it arrives as a
// bearer in the Authorization header: a token minted on the account page or the
// access token of an app the person signed in through the connector
// (server/utils/accessTokens.ts). The route resolves that bearer once, before
// dispatch, for every tool whose registry entry names an account use; for the four
// gear tools it also refuses a missing or dead one with the 401 that opens Claude's
// sign-in, and a read-only one on a write tool with a 403 (mcp.post.ts). So by the
// time a gear tool runs the account is on the event, and create_list — which only
// uses an account when there is one — reads the same answer.

/** Who is calling, as the route left it on the event: an account with a scope, nobody
 *  ("anonymous": no bearer of ours was carried), or a bearer that opens nothing
 *  ("unknown": never issued, revoked, or an app's access token past its hour). */
function whoCalls(event: H3Event): { userId: number; scope: AccessScope } | "anonymous" | "unknown" {
  const caller = event.context.connector;
  if (caller === undefined) return "anonymous";
  return caller ?? "unknown";
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

const NO_SUCH_GEAR = "Nothing in My Gear has that id; list_my_gear gives the ids.";

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
    note: piece.description ?? null,
    price: piece.priceCents != null ? piece.priceCents / 100 : null,
    currency: piece.currency ?? null,
    product_url: piece.productUrl ?? null,
    folder: piece.folderId != null ? (folderNames.get(piece.folderId) ?? null) : null,
    times_used: piece.timesSeen,
    last_used: piece.lastUsedAt,
    kit:
      piece.kind === "kit"
        ? {
            own_weight_g: grams(piece.ownWeightMg ?? 0),
            items: (piece.parts ?? []).map((p) => ({
              id: p.id,
              display_name: itemDisplayName(p.brand ?? null, p.name, p.variant ?? null),
              count: p.qty,
              weight_g: grams(p.weightMg),
              put_away: !!p.removed,
            })),
          }
        : null,
    in_kits: piece.inKits ?? [],
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
    // kits too, with what they hold: a kit is gear the owner keeps, and the row says what it is
    query ? searchVaultItems(db, vaultId, query, GEAR_PAGE_MAX, { kits: true }) : listVaultItems(db, vaultId),
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

async function addGear(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  const gear = await openGear(event, "write");
  if (typeof gear === "string") return fail(gear);
  if (!Array.isArray(args.items) || !args.items.length) return fail("items must be a non-empty array of pieces.");
  if (args.items.length > GEAR_ADD_MAX) return fail(`At most ${GEAR_ADD_MAX} pieces in one call; send the rest in another.`);
  const pieces = args.items.map(gearPatchFrom);
  const hasName = (p: (typeof pieces)[number]) => typeof p.patch.name === "string" && p.patch.name.trim() !== "";
  // a call with nothing nameable in it mints no vault for an account that had none
  if (!pieces.some(hasName)) return fail("Every piece needs a name.");
  const { db, userId } = gear;
  const vaultId = gear.vaultId ?? (await mintVault(db, userId));
  const folders = await gearFolders(db, vaultId, pieces.filter(hasName).flatMap((p) => (p.folder ? [p.folder] : [])));

  // the named pieces go to the vault in one batch; the nameless keep their place in
  // the answer as invalid
  const named = pieces.map((p, index) => ({ p, index })).filter(({ p }) => hasName(p));
  const outcomes = await addVaultItems(
    db,
    vaultId,
    named.map(({ p }) => ({ t: "add", ...p.patch, folderId: p.folder ? (folders.idOf.get(folderKey(p.folder)) ?? null) : null }) as Extract<VaultItemOp, { t: "add" }>),
  );
  const results: { index: number; status: string; item?: Record<string, unknown> }[] = pieces.map((_, index) => ({ index, status: "invalid" }));
  named.forEach(({ index }, i) => {
    const outcome = outcomes[i];
    if (!outcome) return;
    if ("refused" in outcome) results[index] = { index, status: outcome.refused === "duplicate" ? "already_have" : "full" };
    else results[index] = { index, status: "added", item: gearAsRow(outcome.item, folders.nameOf) };
  });
  return ok({ added: results.filter((r) => r.status === "added").length, results });
}

async function changeGear(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  const gear = await openGear(event, "write");
  if (typeof gear === "string") return fail(gear);
  if (!isSerialId(args.id)) return fail("Give the piece's id, from list_my_gear.");
  const id = args.id;
  const { patch, folder } = gearPatchFrom(args);
  if (patch.name === null || patch.name === "") return fail("A piece keeps a name: change it, but it can't be cleared.");
  if (!Object.keys(patch).length && folder === undefined) return fail("Nothing to change; send at least one field.");
  if (gear.vaultId == null) return fail(NO_SUCH_GEAR);
  const { db, vaultId } = gear;

  // the fields first: the edit answers with the row, or with nothing for an id that
  // isn't this vault's — and before any folder is made for it
  let after: VaultEntry | null = null;
  if (Object.keys(patch).length) {
    const outcome = await applyVaultItemOp(db, vaultId, { t: "edit", id, patch } as VaultItemOp);
    if (!outcome || "refused" in outcome) {
      // a kit's weight is its items', so a weight is refused on one; say so rather than "no such piece"
      const row = "weightMg" in patch ? await vaultItemById(db, vaultId, id) : null;
      if (row?.kind === "kit") return fail("That is a kit, and a kit weighs what its items weigh: change an item's weight instead. Nothing was changed.");
      return fail(`${NO_SUCH_GEAR} Or that change would not leave a valid piece; nothing was changed.`);
    }
    after = outcome.item;
  } else {
    after = await vaultItemById(db, vaultId, id);
    if (!after) return fail(NO_SUCH_GEAR);
  }
  const folders = await gearFolders(db, vaultId, folder ? [folder] : []);
  if (folder !== undefined) {
    const folderId = folder ? (folders.idOf.get(folderKey(folder)) ?? null) : null;
    if (folder && folderId == null) return fail("My Gear has as many folders as it can hold; file this piece in one that exists.");
    if (!(await applyVaultFolderOp(db, vaultId, { t: "move", itemId: id, folderId }))) return fail(NO_SUCH_GEAR);
    after = { ...after, folderId: folderId ?? undefined };
  }
  return ok({ item: gearAsRow(after, folders.nameOf) });
}

async function putAwayGear(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  const gear = await openGear(event, "write");
  if (typeof gear === "string") return fail(gear);
  if (!isSerialId(args.id)) return fail("Give the piece's id, from list_my_gear.");
  const restore = args.restore === true;
  const { db, vaultId } = gear;
  const done = vaultId != null && (restore ? await restoreVaultItem(db, vaultId, args.id) : await removeVaultItem(db, vaultId, args.id));
  if (!done) return fail(restore ? "Nothing put away in My Gear has that id." : `${NO_SUCH_GEAR} It may be put away already.`);
  return ok({ id: args.id, status: restore ? "restored" : "removed" });
}
