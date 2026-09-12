import Ajv, { type ValidateFunction } from "ajv";
import { MCP_TOOLS } from "../../server/utils/mcp";

// Every declared outputSchema, compiled once under Ajv's strict mode, so a schema that
// is itself malformed fails here before a client ever lists it. The MCP SDK's client
// validates every structuredContent against the tool's outputSchema the same way and
// refuses the call on a mismatch, so a claim here that the code doesn't keep is a
// broken tool for whoever hits that list, not a documentation slip. The two MCP suites
// run every structured result they get through this.
const ajv = new Ajv({ strict: true, allErrors: true });
const validators = new Map<string, ValidateFunction>();
for (const tool of MCP_TOOLS) if (tool.outputSchema) validators.set(tool.name, ajv.compile(tool.outputSchema));

export const declaresOutput = (tool: string): boolean => validators.has(tool);

/** throws, in Ajv's own words, when a tool's structured result doesn't match its declared shape */
export function expectConforms(tool: string, structured: unknown): void {
  const validate = validators.get(tool);
  if (!validate) throw new Error(`${tool} declares no outputSchema`);
  if (!validate(structured)) throw new Error(`${tool} result does not match its outputSchema: ${ajv.errorsText(validate.errors)}`);
}
