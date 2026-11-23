/**
 * The header names the client or the platform writes itself, in lower case: a config may not give one (the schema
 * refuses it), and the client drops one given all the same, in any letter case.
 */
export const SET_BY_SERVICE: ReadonlySet<string> = new Set([
  'accept', 'content-type', 'content-length', 'host', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version',
]);
