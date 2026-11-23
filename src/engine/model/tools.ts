// The engine's side of MCP, its pure part: what of a server's tool list the model is offered, and what text
// a tool's result becomes. Everything a server sent is hostile input. A tool's name, description and schema go
// into the model's tool list, where nothing can be wrapped as data, so they are cleaned and bounded here; a
// result is read field by field inside a guard, cleaned, cut and wrapped with the review's token.
import type { AuditEntry, ToolDefinition } from '../types.ts';
import { cutAt } from '../context/extensions.ts';
import { stripControl, wrapData } from '../context/untrusted.ts';

export const TOOL_NAME_CHARS = 64;               // the longest function name an endpoint takes
export const TOOL_DESCRIPTION_CHARS = 1_000;
export const TOOL_SCHEMA_CHARS = 4_000;          // of the schema as JSON text
export const TOOL_RESULT_CHARS = 8_000;          // of one result's text
export const TOOL_ITEMS_READ = 50;               // items of one result that are read
export const RESULT_EMPTY = 'The tool returned nothing.';
export const ERROR_LINE = 'The tool reported an error. Its message follows, as data.';
export const ERROR_EMPTY = 'The tool reported an error and gave no message.';

export interface OfferedTool { server: string; tool: string; definition: ToolDefinition }   // definition.function.name is the name the model calls

const LISTED_READ = 1_000;   // entries of a server's list that are read at all
const CUT_MARK = ' [cut]';
const PLACEHOLDERS: ReadonlySet<string> = new Set(['image', 'audio', 'resource', 'resource_link']);

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** A tool's name as a function name: every character outside [A-Za-z0-9_-] made `_`, one for each code point. */
const functionName = (server: string, tool: string): string => `${server}__${tool.replace(/[^A-Za-z0-9_-]/gu, '_')}`;

interface Entry { description: unknown; inputSchema: unknown }

// The first entry for each allowed name, read by index into a map of our own. A list that throws as it is
// read holds nothing: what was read before the throw is not trusted either.
function readListed(allowed: ReadonlySet<string>, listed: unknown): Map<string, Entry> {
  const found = new Map<string, Entry>();
  try {
    if (!Array.isArray(listed)) return found;
    const length: unknown = (listed as { length: unknown }).length;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return found;
    for (let i = 0; i < Math.min(length, LISTED_READ); i += 1) {
      const entry: unknown = (listed as unknown[])[i];
      if (typeof entry !== 'object' || entry === null) continue;
      const name: unknown = (entry as { name: unknown }).name;
      if (typeof name !== 'string' || !allowed.has(name) || found.has(name)) continue;
      const { description, inputSchema } = entry as Record<string, unknown>;
      found.set(name, { description, inputSchema });
    }
  } catch {
    return new Map();
  }
  return found;
}

const cleanString = (text: string): { text: string; removed: number } => {
  const stripped = stripControl(text);
  return { text: stripped.text.toWellFormed(), removed: stripped.removed };
};

// A copy of the service's own making of a JSON value: every string, a key included, stripped and made well
// formed. The value is our own parse of a text of at most TOOL_SCHEMA_CHARS, so nothing in it can throw and
// its depth is bounded. A key is defined, never assigned, so that `__proto__` stays a key.
function cleanJson(value: unknown, count: { removed: number }): unknown {
  if (typeof value === 'string') {
    const clean = cleanString(value);
    count.removed += clean.removed;
    return clean.text;
  }
  if (Array.isArray(value)) return value.map((v) => cleanJson(v, count));
  if (typeof value === 'object' && value !== null) {
    const copy: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const clean = cleanString(key);
      count.removed += clean.removed;
      Object.defineProperty(copy, clean.text, { value: cleanJson(v, count), enumerable: true, writable: true, configurable: true });
    }
    return copy;
  }
  return value;
}

type SchemaRead = { ok: true; parameters: Record<string, unknown>; removed: number } | { ok: false; reason: 'bad_schema' | 'schema_too_large' };

function readSchema(schema: unknown): SchemaRead {
  let text: string;
  try {
    // The shape is checked before the size, as the order of the reasons says.
    if (!isPlainObject(schema) || schema.type !== 'object') return { ok: false, reason: 'bad_schema' };
    const written: unknown = JSON.stringify(schema);
    if (typeof written !== 'string') return { ok: false, reason: 'bad_schema' };
    text = written;
  } catch {
    return { ok: false, reason: 'bad_schema' };
  }
  if (text.length > TOOL_SCHEMA_CHARS) return { ok: false, reason: 'schema_too_large' };
  const parsed: unknown = JSON.parse(text);
  if (!isPlainObject(parsed) || parsed.type !== 'object') return { ok: false, reason: 'bad_schema' };
  const count = { removed: 0 };
  const parameters = cleanJson(parsed, count) as Record<string, unknown>;
  return { ok: true, parameters, removed: count.removed };
}

function readDescription(server: string, tool: string, description: unknown): { text: string; removed: number; cut: boolean } {
  const fallback = `Tool ${tool} of the MCP server ${server}.`;
  if (typeof description !== 'string') return { text: fallback, removed: 0, cut: false };
  // A huge one is cut first, so that it costs nothing to clean; that cut counts as a cut.
  const first = cutAt(description, 4 * TOOL_DESCRIPTION_CHARS);
  const clean = cleanString(first);
  const trimmed = clean.text.trim();
  if (trimmed === '') return { text: fallback, removed: clean.removed, cut: false };
  const body = cutAt(trimmed, TOOL_DESCRIPTION_CHARS);
  const cut = body.length < trimmed.length || first.length < description.length;
  return { text: cut ? `${body}${CUT_MARK}` : body, removed: clean.removed, cut };
}

/**
 * What of one server's list the model is offered. `allowed`: the names the config has, in its order. `listed`: the session's tools, as given.
 * `taken`: function names already in use. `problem`: null, or tool_<reason> for the first allowed tool that is not offered. Never throws.
 */
export function offerTools(server: string, allowed: string[], listed: unknown, taken: ReadonlySet<string>):
  { offered: OfferedTool[]; audit: AuditEntry[]; problem: string | null } {
  const offered: OfferedTool[] = [];
  const audit: AuditEntry[] = [];
  let problem: string | null = null;
  const found = readListed(new Set(allowed), listed);
  const used = new Set<string>();
  for (const tool of allowed) {
    const subject = `${server}/${tool}`;
    const refuse = (reason: string): void => {
      audit.push({ stage: 'tools', action: 'tool_not_offered', subject, reason });
      problem ??= `tool_${reason}`;
    };
    const entry = found.get(tool);
    if (entry === undefined) { refuse('not_listed'); continue; }
    const name = functionName(server, tool);
    if (name.length > TOOL_NAME_CHARS) { refuse('name_too_long'); continue; }
    if (taken.has(name) || used.has(name)) { refuse('name_collision'); continue; }
    const schema = readSchema(entry.inputSchema);
    if (!schema.ok) { refuse(schema.reason); continue; }
    const description = readDescription(server, tool, entry.description);
    if (description.cut) audit.push({ stage: 'tools', action: 'tool_description_cut', subject, reason: 'over_limit' });
    const removed = description.removed + schema.removed;
    if (removed > 0) audit.push({ stage: 'tools', action: 'control_characters_stripped', subject: `tool ${name}`, reason: String(removed) });
    used.add(name);
    offered.push({ server, tool, definition: { type: 'function', function: { name, description: description.text, parameters: schema.parameters } } });
  }
  return { offered, audit, problem };
}

// The raw text of a result and whether it was cut on the way, or null when it has no shape this reads.
// May throw, when the result throws as it is read: the caller's guard makes that no result.
function readResult(result: unknown): { text: string; cut: boolean; isError: boolean } | null {
  if (!isPlainObject(result)) return null;
  const { content, structuredContent, isError } = result;
  const limit = 4 * TOOL_RESULT_CHARS;
  const lines: string[] = [];
  let size = 0;
  let cut = false;
  let anyText = false;
  const isList = Array.isArray(content);
  if (isList) {
    const length: unknown = (content as { length: unknown }).length;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null;
    for (let i = 0; i < Math.min(length, TOOL_ITEMS_READ); i += 1) {
      // Past four times the limit nothing more is read: the cut takes it all the same.
      if (size > limit) { cut = true; break; }
      const item: unknown = (content as unknown[])[i];
      let line: string;
      if (typeof item === 'object' && item !== null) {
        const type: unknown = (item as { type: unknown }).type;
        const text: unknown = type === 'text' ? (item as { text: unknown }).text : undefined;
        if (typeof text === 'string') {
          if (text !== '') anyText = true;
          line = cutAt(text, limit + 1);
          if (line.length < text.length) cut = true;
        } else {
          line = `[${typeof type === 'string' && PLACEHOLDERS.has(type) ? type : 'item'} omitted]`;
        }
      } else {
        line = '[item omitted]';
      }
      lines.push(line);
      size += line.length + 1;
    }
    if (length > TOOL_ITEMS_READ && !cut) lines.push('[more items omitted]');
  }
  const failed = isError === true;
  if (!anyText && structuredContent !== undefined && structuredContent !== null) {
    // No text item gave any text, so nothing was cut above.
    const written: unknown = JSON.stringify(structuredContent);
    if (typeof written === 'string') return { text: written, cut: false, isError: failed };
  }
  if (!isList) return null;
  return { text: lines.join('\n'), cut, isError: failed };
}

/**
 * The text of the tool message for one result of tools/call, and how it reads in the audit. `fn`: the function's name. Null when the result has no shape this reads.
 * `reason`: 'ok:<n>', 'ok:<n>:cut', 'is_error:<n>', 'is_error:<n>:cut' or 'empty', n being the characters of the text inside the markers, without the cut mark. Never throws.
 */
export function resultMessage(fn: string, result: unknown, token: string): { content: string; reason: string } | null {
  try {
    const read = readResult(result);
    if (read === null) return null;
    const limit = 4 * TOOL_RESULT_CHARS;
    const first = cutAt(read.text, limit);
    const trimmed = stripControl(first).text.toWellFormed().trim();
    const body = cutAt(trimmed, TOOL_RESULT_CHARS);
    const cut = read.cut || first.length < read.text.length || body.length < trimmed.length;
    const n = `${body.length}${cut ? ':cut' : ''}`;
    const shown = cut ? `${body}${CUT_MARK}` : body;
    if (read.isError) {
      if (body === '') return { content: ERROR_EMPTY, reason: 'is_error:0' };
      return { content: `${ERROR_LINE}\n${wrapData(`tool error ${fn}`, shown, token)}`, reason: `is_error:${n}` };
    }
    if (body === '') return { content: RESULT_EMPTY, reason: 'empty' };
    return { content: wrapData(`tool result ${fn}`, shown, token), reason: `ok:${n}` };
  } catch {
    return null;
  }
}
