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
// My Gear stays out. Reaching it means an account token, which is a new surface and a
// separate decision; the issue that asked for this server says so.
//
// The protocol layer (JSON-RPC over one HTTP endpoint) is server/routes/mcp.post.ts;
// this file is the tools, so they can be tested as functions and read as a list.

import type { H3Event } from "h3";
import { listToMarkdown } from "../../shared/exporters/markdown";
import { exportSections } from "../../shared/exporters/rows";
import { colorKeyForName } from "../../shared/categories";
import { uid } from "../../shared/id";
import { editLinkPath, normalizeShareCode } from "../../shared/links";
import { isCatalogId, MAX_CATALOG_ID, MAX_FOLDER_NAME_LEN, MAX_FOLDERS, MAX_GEAR_TYPE_LEN, MAX_ITEM_NAME_LEN, MAX_ITEM_NOTE_LEN, MAX_ITEMS, MAX_TITLE_LEN, normalizeCalendarDate, type Op } from "../../shared/ops";
import { carrierName } from "../../shared/people";
import { dayClimbs, parseProfile } from "../../shared/profile";
import { tidyText } from "../../shared/tidyText";
import { CLEARS_WITH_LINK, normalizeTrailUrl } from "../../shared/trailLink";
import { dayLabel } from "../../shared/tripDay";
import { UNITS, WEIGHT_SOURCES, type Classification, type Folder, type Item, type ListData, type ListSnapshot, type Unit } from "../../shared/types";
import { computeTotals, effectiveClassification, itemDisplayName, nextSortOrder } from "../../shared/weights";
import { catalogRowsById, productVariants, searchCatalog } from "./catalog";
import { useCatalogDb } from "./db";
import { applyOpsByEditHash, createList, getByEditHash, getByShareCode, getTextByShareCode } from "./listRepo";
import { trustedOrigin } from "./origin";
import { rateLimit, rateLimitSubject, useKv } from "./rateLimit";
import { sha256Hex } from "./tokens";

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
  "create_list returns a new list's edit link and share link. Keep the edit link; it is the only way back into the list.",
  "Weights are in grams everywhere. A row's classification is base (in the pack), worn (on your body) or consumable (food, fuel, water).",
  PROVENANCE,
].join(" ");

/** the reducer's own caps on free text (shared/ops), stated in the schemas so a model
 *  knows them before a value is quietly cut to fit */
const BRAND_LEN = 120;
const TRAIL_URL_LEN = 2000;
const TRAIL_LABEL_LEN = 120;

const CLASSIFICATIONS: Classification[] = ["base", "worn", "consumable"];
const SEARCH_LIMIT_MAX = 25;
const SEARCH_LIMIT_DEFAULT = 12;
const QTY_MAX = 9999;

/** the JSON Schema of one row, shared by create_list and add_items */
const ITEM_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", maxLength: MAX_ITEM_NAME_LEN, description: "The product or item name. Required." },
    brand: { type: "string", maxLength: BRAND_LEN, description: "The maker, when known." },
    variant: { type: "string", maxLength: BRAND_LEN, description: "Size, length or configuration that changes the weight, such as Long or 20F." },
    gear_type: { type: "string", maxLength: MAX_GEAR_TYPE_LEN, description: "What kind of thing it is: Tent, Quilt, Trail runners." },
    weight_g: { type: "number", minimum: 0, description: "Weight of ONE unit, in grams. Omit when unknown; the list keeps working without it, and a row with a catalog_id takes the catalog's cited weight." },
    qty: { type: "integer", minimum: 1, maximum: QTY_MAX, description: "How many. Default 1." },
    classification: { type: "string", enum: CLASSIFICATIONS, description: "base, worn or consumable. Omit to follow the folder's default." },
    worn_qty: { type: "integer", minimum: 0, description: "Of qty, how many are worn rather than carried (three pairs of socks, one on your feet). For a row that is entirely worn, set classification to worn instead." },
    note: { type: "string", maxLength: MAX_ITEM_NOTE_LEN, description: "A short free-text note on the row." },
    kcal: { type: "integer", minimum: 0, description: "Calories per unit, for food." },
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

const CREATE_OUTPUT = complete({
  title: str(USER_TEXT),
  edit_link: str("The write capability. Keep it; it is the only way back into the list."),
  share_link: str("The read capability, safe to pass on."),
  share_code: str(),
  folders: { type: "integer", description: "Folders made." },
  items: { type: "integer", description: "Rows made." },
  totals: TOTALS_SCHEMA,
});

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

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** the shape of structuredContent, on every tool that returns it */
  outputSchema?: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ADD = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// destructive, honestly: set_trip REPLACES a title and can clear the dates or the
// trail, and the hint's own definition says false means additive updates only
const SET = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

export const MCP_TOOLS: McpTool[] = [
  {
    name: "get_list",
    title: "Read a shared list",
    description: `A shared list as data: title, unit, dates, trail, totals in grams, and every folder with its rows (brand, name, variant, quantity, weight of one unit in grams, classification, note, calories, who carries it; a nested row without carried_by is carried by its parent's carrier). Takes a share code or share link. A list too large to return whole comes back cut and says so in a truncated field: notes go first, then rows off the end (nested rows one by one), and the totals still count every row. ${PROVENANCE}`,
    inputSchema: { type: "object", properties: { share_code: SHARE_ARG }, required: ["share_code"] },
    outputSchema: LIST_OUTPUT,
    annotations: READ,
  },
  {
    name: "get_list_markdown",
    title: "Read a shared list as Markdown",
    description: `The same list as Markdown: one table per folder and a totals block, the text the site's own Markdown export produces. Takes a share code or share link. A list too large to return whole loses rows off the end of the tables, a line under them says how many, and the totals still count every row. ${PROVENANCE}`,
    inputSchema: { type: "object", properties: { share_code: SHARE_ARG }, required: ["share_code"] },
    annotations: READ,
  },
  {
    name: "search_catalog",
    title: "Search the gear catalog",
    description:
      "Fuzzy search of Mahonia's cited gear catalog by brand, product or kind of gear (\"duplex\", \"zpacks\", \"quilt\"). Each result carries a catalog id, the cited weight in grams and whether it is verified. Use get_catalog_product for every variant of one product.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Two characters or more." },
        limit: { type: "integer", minimum: 1, maximum: SEARCH_LIMIT_MAX, description: `Up to ${SEARCH_LIMIT_MAX}. Default ${SEARCH_LIMIT_DEFAULT}.` },
      },
      required: ["query"],
    },
    outputSchema: SEARCH_OUTPUT,
    annotations: READ,
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
  },
  {
    name: "create_list",
    title: "Make a new list",
    description:
      "Creates a list and returns its edit link and share link. Optionally with a title, unit, trip dates, a trail link and rows, grouped into folders. Keep the edit link: it is the only way back into the list.",
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
              name: { type: "string", maxLength: MAX_FOLDER_NAME_LEN },
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
  },
];

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
  return typeof name === "string" && MCP_TOOLS.some((t) => t.name === name);
}

/**
 * Run one tool. The name is known (the route checks isKnownTool first and answers an
 * unknown one with a protocol error, as the spec wants); everything about the
 * ARGUMENTS is answered inside the result with isError, so the model can read what
 * went wrong and correct itself.
 */
export async function callTool(event: H3Event, name: string, rawArgs: unknown): Promise<ToolResult> {
  const args = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  switch (name) {
    case "get_list":
      return getList(event, args);
    case "get_list_markdown":
      return getListMarkdown(args);
    case "search_catalog":
      return search(args);
    case "get_catalog_product":
      return product(args);
    case "create_list":
      return create(event, args);
    case "add_items":
      return addItems(event, args);
    case "set_trip":
      return setTrip(event, args);
    default:
      return fail(`Unknown tool: ${name}`);
  }
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
export function describeList(snap: ListSnapshot, origin: string): Record<string, unknown> {
  const totals = computeTotals(snap);
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
    share_link: `${origin}/s/${snap.shareCode}`,
    unit: snap.displayUnit,
    totals: {
      base_g: Math.round(totals.baseMg / 1000),
      worn_g: Math.round(totals.wornMg / 1000),
      consumable_g: Math.round(totals.consumableMg / 1000),
      carried_g: Math.round(totals.carriedMg / 1000),
      total_g: Math.round(totals.totalMg / 1000),
      item_count: totals.itemCount,
      ...(totals.hasKcal ? { kcal: totals.kcalTotal } : {}),
    },
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
  if (query.length < 2) return fail("Give at least two characters to search for.");
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
    const used = this.folders.map((f) => f.colorKey ?? "other");
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

async function create(event: H3Event, args: Record<string, unknown>): Promise<ToolResult> {
  // the one write with no list to key on: per address, like the web's create
  await rateLimit(event, "mcp-write");
  const book = new FolderBook([]);
  const items: Item[] = [];
  const counted = new Map<string | null, number>();
  const nextOrder = (folderId: string | null) => {
    const n = counted.get(folderId) ?? 0;
    counted.set(folderId, n + 1);
    return n;
  };
  const place = (raw: unknown, fallbackFolder: Folder | null): string | null => {
    let folder = fallbackFolder;
    const named = raw && typeof raw === "object" ? (raw as Record<string, unknown>).folder : undefined;
    if (typeof named === "string" && named.trim()) {
      const got = book.resolve(named);
      if (typeof got === "string") return got;
      folder = got;
    }
    const item = toItem(raw, folder?.id ?? null, nextOrder(folder?.id ?? null));
    if (typeof item === "string") return item;
    items.push(item);
    return null;
  };
  if (args.folders != null) {
    if (!Array.isArray(args.folders)) return fail("folders must be an array.");
    for (const f of args.folders) {
      if (!f || typeof f !== "object" || typeof (f as Record<string, unknown>).name !== "string") return fail("Each folder needs a name.");
      const fr = f as Record<string, unknown>;
      if (fr.classification != null && !CLASSIFICATIONS.includes(fr.classification as Classification)) {
        return fail(`"${String(fr.classification)}" isn't a classification; use base, worn or consumable.`);
      }
      const folder = book.resolve(fr.name as string, (fr.classification as Classification | undefined) ?? "base");
      if (typeof folder === "string") return fail(folder);
      if (fr.items != null) {
        if (!Array.isArray(fr.items)) return fail("A folder's items must be an array.");
        for (const it of fr.items) {
          const problem = place(it, folder);
          if (problem) return fail(problem);
        }
      }
    }
  }
  if (args.items != null) {
    if (!Array.isArray(args.items)) return fail("items must be an array.");
    for (const it of args.items) {
      const problem = place(it, null);
      if (problem) return fail(problem);
    }
  }
  if (items.length > MAX_ITEMS) return fail(`A list holds at most ${MAX_ITEMS} rows; this would make ${items.length}.`);

  const meta = tripMeta(args, true);
  if (typeof meta === "string") return fail(meta);
  const unlinked = await linkCatalog(items);
  if (unlinked) return fail(unlinked);
  const data: ListData = { folders: book.folders, items };
  const { editToken, snapshot } = await createList({ ...meta, data });
  const origin = trustedOrigin(event);
  return ok({
    title: snapshot.title,
    edit_link: `${origin}${editLinkPath(snapshot.shareCode, editToken)}`,
    share_link: `${origin}/s/${snapshot.shareCode}`,
    share_code: snapshot.shareCode,
    folders: snapshot.folders.length,
    items: snapshot.items.length,
    totals: describeList(snapshot, origin).totals,
  });
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

  const book = new FolderBook(snap.folders);
  let fallback: Folder | null = null;
  if (typeof args.folder === "string" && args.folder.trim()) {
    const got = book.resolve(args.folder);
    if (typeof got === "string") return fail(got);
    fallback = got;
  }
  // new rows go after what the folder already holds: past its highest sortOrder,
  // not its count, since a removed row leaves a hole the count would fill mid-folder
  const counted = new Map<string | null, number>();
  const items: Item[] = [];
  for (const raw of args.items) {
    let folder = fallback;
    const named = raw && typeof raw === "object" ? (raw as Record<string, unknown>).folder : undefined;
    if (typeof named === "string" && named.trim()) {
      const got = book.resolve(named);
      if (typeof got === "string") return fail(got);
      folder = got;
    }
    const folderId = folder?.id ?? null;
    const n = counted.get(folderId) ?? nextSortOrder(snap.items, folderId);
    counted.set(folderId, n + 1);
    const item = toItem(raw, folderId, n);
    if (typeof item === "string") return fail(item);
    items.push(item);
  }
  const unlinked = await linkCatalog(items);
  if (unlinked) return fail(unlinked);
  const ops: Op[] = [
    ...book.made.map((folder): Op => ({ t: "addFolder", folder })),
    ...items.map((item): Op => ({ t: "addItem", item })),
  ];
  const after = await applyOpsByEditHash(hash, ops);
  if (!after) return fail(NO_EDIT_LIST);
  const origin = trustedOrigin(event);
  const result = {
    added: items.length,
    folders_made: book.made.map((f) => f.name),
    share_link: `${origin}/s/${after.shareCode}`,
    totals: describeList(after, origin).totals,
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
