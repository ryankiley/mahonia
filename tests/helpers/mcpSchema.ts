import Ajv, { type ValidateFunction } from "ajv";
import { MCP_TOOLS } from "../../server/utils/mcp";

// Every declared outputSchema, compiled once under Ajv's strict mode, so a schema that
// is itself malformed fails here before a client ever lists it. The MCP SDK's client
// validates every structuredContent against the tool's outputSchema the same way and
// refuses the call on a mismatch, so a claim here that the code doesn't keep is a
// broken tool for whoever hits that list, not a documentation slip. The two MCP suites
// run every structured result they get through this.
//
// Compiled CLOSED: additionalProperties false on every object, where the published
// schema leaves it open (a client must not fail on a field added later). Open, an
// undeclared field would pass every test and the field set the schema exists to
// document would go stale the first time a producer grew; closed here, it fails loud.
const ajv = new Ajv({ strict: true, allErrors: true });
const closed = (schema: unknown): unknown => {
  if (Array.isArray(schema)) return schema.map(closed);
  if (!schema || typeof schema !== "object") return schema;
  const out = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, closed(v)]));
  return "properties" in out ? { ...out, additionalProperties: false } : out;
};
const validators = new Map<string, ValidateFunction>();
for (const tool of MCP_TOOLS) if (tool.outputSchema) validators.set(tool.name, ajv.compile(closed(tool.outputSchema) as object));

/** throws, in Ajv's own words, when a tool's structured result doesn't match its declared shape */
export function expectConforms(tool: string, structured: unknown): void {
  const validate = validators.get(tool);
  if (!validate) throw new Error(`${tool} declares no outputSchema`);
  if (!validate(structured)) throw new Error(`${tool} result does not match its outputSchema: ${ajv.errorsText(validate.errors)}`);
}

/** the rule both suites hold every call to: a tool that declares a shape answers a
 *  successful call with structuredContent in that shape (an error carries none, and a
 *  tool that declares nothing is held to nothing) */
export function expectResultConforms(tool: string, result: { structuredContent?: unknown; isError?: boolean } | null | undefined): void {
  if (!result || result.isError || !validators.has(tool)) return;
  if (result.structuredContent === undefined) throw new Error(`${tool} declares an outputSchema, so a result needs structuredContent`);
  expectConforms(tool, result.structuredContent);
}
