import { randomBytes } from 'node:crypto';

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

export interface TextToolCallCounts { recovered: number; unparsed: number }

const defaultId = (): string => `toolu_${randomBytes(12).toString('hex')}`;

/** One scan of text: what to emit as text, what calls were found, in order. */
type Piece = { kind: 'text'; text: string } | { kind: 'call'; call: ParsedCall };

/**
 * The scanner both rewriters share. `push` returns the pieces that are
 * settled; `end` releases whatever is still held as text.
 */
function createScanner(tools: ToolSchemas, counts: TextToolCallCounts) {
  let pending = '';
  let inCall = false;
  return {
    push(text: string): Piece[] {
      pending += text;
      const pieces: Piece[] = [];
      for (;;) {
        if (inCall) {
          const close = pending.indexOf(TOOL_CALL_CLOSE);
          if (close === -1) return pieces;
          const markup = pending.slice(0, close + TOOL_CALL_CLOSE.length);
          pending = pending.slice(markup.length);
          inCall = false;
          const call = parseToolCallMarkup(markup, tools);
          if (call === undefined) { counts.unparsed += 1; pieces.push({ kind: 'text', text: markup }); } else { counts.recovered += 1; pieces.push({ kind: 'call', call }); }
          continue;
        }
        const lt = pending.indexOf('<');
        if (lt === -1) { if (pending) pieces.push({ kind: 'text', text: pending }); pending = ''; return pieces; }
        if (lt > 0) { pieces.push({ kind: 'text', text: pending.slice(0, lt) }); pending = pending.slice(lt); }
        if (pending.startsWith(TOOL_CALL_OPEN)) { inCall = true; continue; }
        if (TOOL_CALL_OPEN.startsWith(pending)) return pieces; // a prefix: wait for more
        pieces.push({ kind: 'text', text: '<' });
        pending = pending.slice(1);
      }
    },
    end(): Piece[] {
      if (pending === '') return [];
      if (inCall) counts.unparsed += 1;
      const rest = pending;
      pending = '';
      inCall = false;
      return [{ kind: 'text', text: rest }];
    },
  };
}

const sse = (data: Record<string, unknown>): string => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;

function normalizeLineEndings(text: string, final: boolean): string {
  if (!final && text.endsWith('\r')) {
    return text.slice(0, -1).replace(/\r\n?/g, '\n') + '\r';
  }
  return text.replace(/\r\n?/g, '\n');
}

export function rewriteTextToolCallStream(
  body: AsyncIterable<Uint8Array>,
  tools: ToolSchemas,
  onEnd: (counts: TextToolCallCounts) => void,
  newId: () => string = defaultId,
): AsyncIterable<Uint8Array> & { cancel(): void } {
  const counts: TextToolCallCounts = { recovered: 0, unparsed: 0 };
  const encoder = new TextEncoder();
  async function* chunks(): AsyncIterable<Uint8Array> {
    const decoder = new TextDecoder();
    let buffer = '';
    let nextOut = 0;
    const outIndex = new Map<number, number>();
    // The upstream text block being scanned, and where its text goes now.
    let textUpstream: number | undefined;
    let textOut: number | undefined; // undefined = closed by a recovered call
    let scanner: ReturnType<typeof createScanner> | undefined;

    const emitPieces = (pieces: Piece[]): string => {
      let out = '';
      for (const piece of pieces) {
        if (piece.kind === 'text') {
          if (piece.text === '') continue;
          if (textOut === undefined) {
            if (piece.text.trim() === '') continue;
            textOut = nextOut++;
            out += sse({ type: 'content_block_start', index: textOut, content_block: { type: 'text', text: '' } });
          }
          out += sse({ type: 'content_block_delta', index: textOut, delta: { type: 'text_delta', text: piece.text } });
        } else {
          if (textOut !== undefined) out += sse({ type: 'content_block_stop', index: textOut });
          textOut = undefined;
          const index = nextOut++;
          out += sse({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: newId(), name: piece.call.name, input: {} } });
          out += sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(piece.call.input) } });
          out += sse({ type: 'content_block_stop', index });
        }
      }
      return out;
    };

    const handle = (raw: string): string => {
      const dataLines = raw.split('\n').filter((line) => line.startsWith('data:'));
      if (dataLines.length === 0) return `${raw}\n\n`;
      const payload = dataLines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      let data: Record<string, any>;
      try { data = JSON.parse(payload) as Record<string, any>; } catch { return `${raw}\n\n`; }
      switch (data.type) {
        case 'content_block_start': {
          const index = nextOut++;
          outIndex.set(data.index, index);
          if (data.content_block?.type === 'text') {
            textUpstream = data.index; textOut = index; scanner = createScanner(tools, counts);
          }
          return sse({ ...data, index });
        }
        case 'content_block_delta': {
          if (data.index === textUpstream && data.delta?.type === 'text_delta' && scanner !== undefined) {
            return emitPieces(scanner.push(String(data.delta.text ?? '')));
          }
          if (data.index === textUpstream && scanner !== undefined) {
            // This delta belongs to text replaced by a tool call; a closed-block delta breaks client assembly.
            if (textOut === undefined) return '';
            return sse({ ...data, index: textOut });
          }
          return sse({ ...data, index: outIndex.get(data.index) ?? data.index });
        }
        case 'content_block_stop': {
          if (data.index === textUpstream && scanner !== undefined) {
            let out = emitPieces(scanner.end());
            if (textOut !== undefined) out += sse({ type: 'content_block_stop', index: textOut });
            textUpstream = undefined; textOut = undefined; scanner = undefined;
            return out;
          }
          return sse({ ...data, index: outIndex.get(data.index) ?? data.index });
        }
        case 'message_delta':
          if (counts.recovered > 0 && data.delta?.stop_reason === 'end_turn') {
            return sse({ ...data, delta: { ...data.delta, stop_reason: 'tool_use' } });
          }
          return `${raw}\n\n`;
        default:
          return `${raw}\n\n`;
      }
    };

    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        buffer = normalizeLineEndings(buffer, false);
        let out = '';
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          out += handle(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
        }
        if (out !== '') yield encoder.encode(out);
      }
      buffer += decoder.decode();
      buffer = normalizeLineEndings(buffer, true);
      if (buffer.trim() !== '') yield encoder.encode(handle(buffer.replace(/\n+$/, '')));
      if (scanner !== undefined) yield encoder.encode(emitPieces(scanner.end()));
    } finally {
      try { onEnd(counts); } catch { /* bookkeeping never reaches the client */ }
    }
  }
  return Object.assign(chunks(), { cancel: () => { (body as { cancel?: () => void }).cancel?.(); } });
}

export function rewriteTextToolCallJson(body: Buffer, tools: ToolSchemas, newId: () => string = defaultId): { body: Buffer; counts: TextToolCallCounts } {
  const counts: TextToolCallCounts = { recovered: 0, unparsed: 0 };
  let message: { content?: unknown; stop_reason?: unknown };
  try { message = JSON.parse(body.toString()) as typeof message; } catch { return { body, counts }; }
  if (!Array.isArray(message.content) || !message.content.some((b) => b?.type === 'text' && String(b.text).includes(TOOL_CALL_OPEN))) {
    return { body, counts };
  }
  const content: unknown[] = [];
  for (const block of message.content as Array<Record<string, unknown>>) {
    if (block?.type !== 'text' || !String(block.text).includes(TOOL_CALL_OPEN)) { content.push(block); continue; }
    const scanner = createScanner(tools, counts);
    let text = '';
    const flush = (): void => { if (text.trim() !== '') content.push({ type: 'text', text }); text = ''; };
    for (const piece of [...scanner.push(String(block.text)), ...scanner.end()]) {
      if (piece.kind === 'text') text += piece.text;
      else { flush(); content.push({ type: 'tool_use', id: newId(), name: piece.call.name, input: piece.call.input }); }
    }
    flush();
  }
  if (counts.recovered === 0 && counts.unparsed === 0) return { body, counts };
  const stop = counts.recovered > 0 && message.stop_reason === 'end_turn' ? 'tool_use' : message.stop_reason;
  return { body: Buffer.from(JSON.stringify({ ...message, content, stop_reason: stop })), counts };
}
