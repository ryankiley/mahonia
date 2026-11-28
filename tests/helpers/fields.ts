// How the MCP suites (mcp, mcpGear, mcpAdmin) hold the field set of each tool's answer
// exactly: a producer that grows or loses a field fails there.

/** An object's field names, sorted, to compare with a literal list. */
export const sortedKeys = (value: unknown): string[] => Object.keys(value as object).sort();
