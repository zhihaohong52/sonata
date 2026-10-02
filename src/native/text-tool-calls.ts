/**
 * Tool calls a model wrote as text, recovered into real ones.
 *
 * Some open models emit a tool call as markup in their text —
 * `<tool_call><function=Bash><parameter=command>ls</parameter></function></tool_call>`
 * (the Qwen-Coder form) — and rely on the server's tool-call parser to turn it
 * into a structured call. When the serving backend has no matching parser the
 * markup arrives as plain text in a turn that ends `end_turn`, and Claude Code
 * ends the agent. Measured 2026-10-02 on `mimo-v2.6-pro` through one gateway,
 * intermittently within a single agent (spec:
 * docs/superpowers/specs/2026-10-02-text-tool-calls-design.md).
 *
 * Nothing here guesses: a call naming a tool the request did not offer, or
 * markup that does not close, is left as the text it was.
 */

export const TOOL_CALL_OPEN = '<tool_call>';
export const TOOL_CALL_CLOSE = '</tool_call>';

/** Tool name → its `input_schema`, from the request the response answers. */
export type ToolSchemas = Map<string, Record<string, unknown>>;

export interface ParsedCall { name: string; input: Record<string, unknown> }

export function toolSchemas(requestBody: Buffer): ToolSchemas {
  const schemas: ToolSchemas = new Map();
  let tools: unknown;
  try {
    tools = (JSON.parse(requestBody.toString()) as { tools?: unknown }).tools;
  } catch {
    return schemas;
  }
  if (!Array.isArray(tools)) return schemas;
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object') continue;
    const { name, input_schema: schema } = tool as { name?: unknown; input_schema?: unknown };
    if (typeof name !== 'string') continue;
    schemas.set(name, schema !== null && typeof schema === 'object' ? schema as Record<string, unknown> : {});
  }
  return schemas;
}

const CALL = /^<tool_call>\s*<function=([^>\s]+)>([\s\S]*?)<\/function>\s*<\/tool_call>$/;
const PARAMETER = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;

export function parseToolCallMarkup(markup: string, tools: ToolSchemas): ParsedCall | undefined {
  const match = CALL.exec(markup.trim());
  if (match === null) return undefined;
  const [, name, body] = match;
  if (!tools.has(name)) return undefined;
  const raw: Record<string, string> = {};
  for (const parameter of body.matchAll(PARAMETER)) {
    // One newline on each side is the tag layout, not the value.
    raw[parameter[1]] = parameter[2].replace(/^\n/, '').replace(/\n$/, '');
  }
  // Anything but whitespace outside the parameters means the markup is not
  // the form this parser knows — an unclosed parameter, JSON, prose.
  if (body.replace(PARAMETER, '').trim() !== '') return undefined;
  return { name, input: coerceArguments(raw, tools.get(name)) };
}

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function typesOf(schema: Record<string, unknown> | undefined, key: string): string[] {
  const properties = schema?.properties;
  if (properties === null || typeof properties !== 'object') return [];
  const type = (properties as Record<string, { type?: unknown }>)[key]?.type;
  if (typeof type === 'string') return [type];
  return Array.isArray(type) ? type.filter((t): t is string => typeof t === 'string') : [];
}

function convert(value: string, types: string[]): unknown {
  for (const type of types) {
    if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
    if ((type === 'number' || type === 'integer') && NUMBER.test(value.trim())) {
      const n = Number(value.trim());
      if (type === 'number' || Number.isInteger(n)) return n;
    }
    if (type === 'object' || type === 'array') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (type === 'array' ? Array.isArray(parsed) : parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch { /* not JSON: stays a string */ }
    }
  }
  return value;
}

export function coerceArguments(raw: Record<string, string>, schema: Record<string, unknown> | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, convert(value, typesOf(schema, key))]));
}
