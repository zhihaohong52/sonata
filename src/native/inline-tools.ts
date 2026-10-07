/**
 * Tools Claude Code declares inside `messages`, and what the LiteLLM path does
 * with them.
 *
 * Claude Code 2.1.292 stopped re-sending `tools[]` when its tool set changes
 * mid-conversation (an MCP server connecting after the first turn, a deferred
 * tool loaded). It keeps `tools[]` stable for the prompt cache and appends a
 * `system` turn instead:
 *
 * ```json
 * { "role": "system", "content": [
 *   { "type": "tool_addition", "tool": { "type": "tool_definition", "definition": { "name": "Bash", … } } },
 *   { "type": "tool_removal",  "tool": { "type": "tool_reference",  "name": "Old" } } ] }
 * ```
 *
 * Anthropic applies those blocks. LiteLLM's Anthropic→OpenAI translation keeps
 * only text, image, document and tool_result blocks in a user turn, so after
 * `demoteSystemTurns` the whole turn is dropped and the model is offered no
 * tool defined there. Measured 2026-10-07 in decision_model: an agent's first
 * turn went upstream at ~103k input tokens, its second — after MCP servers
 * connected — at ~10k, every tool definition gone. mimo-v2.6-pro then wrote
 * its calls in its own `<tool_call>` markup, which the router could not
 * recover (its tool list came from `tools[]` alone), and no model could call
 * `SubagentHandback`, which Claude Code also delivers this way.
 *
 * Two layers, both on the LiteLLM path only:
 *
 * 1. **Refusal.** Claude Code already handles a platform that cannot take an
 *    inline definition: a 400 whose message carries `Input tag
 *    'tool_definition'` is read as `unsupported_on_platform`, and it retries
 *    the same turn with every tool declared in `tools[]`, inline definitions
 *    off for the rest of that conversation. The router answers that 400
 *    itself — nothing goes upstream — once per conversation.
 * 2. **Fold.** Everything else — a conversation already refused that sends
 *    them again, a client that did not advertise the beta, a request with no
 *    conversation key — is folded: the blocks are applied in order onto
 *    `tools[]` and removed from the transcript. The fold depends on nothing
 *    but the wire shape, so it is the layer that must always hold.
 *
 * The refusal leans on a Claude Code internal string, verified against
 * Claude Code 2.1.292 only. If a later version stops recognising it, the 400
 * is an ordinary API error: Claude Code does not retry a 400, so the agent
 * ends on that request. Firing once per conversation bounds that to one agent
 * per conversation, not one turn — which is why it is pinned by a test of the
 * message and must be re-checked when Claude Code changes its fallbacks.
 */

/** The `anthropic-beta` value Claude Code sends when it may define tools inline. */
export const INLINE_TOOLS_BETA = 'inline-tools-2026-09-15';

/**
 * The refusal message. Claude Code matches `/Input tag 'tool_definition'/`
 * (Claude Code 2.1.292, `pse`). It must not name the mid-conversation betas or
 * `Input tag 'tool_addition'`, which route the same 400 to other fallbacks.
 */
export const INLINE_TOOLS_REFUSAL =
  "Input tag 'tool_definition' is not supported on this platform: sonata's gateway translation cannot " +
  'carry tool definitions inside messages. Declare every tool in tools[].';

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function isToolChange(block: unknown): block is Json {
  return isRecord(block) && (block.type === 'tool_addition' || block.type === 'tool_removal');
}

function parse(body: Buffer): Json | undefined {
  try {
    const payload: unknown = JSON.parse(body.toString());
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the client offered inline tool definitions on this request. */
export function advertisesInlineTools(headers: Record<string, string>): boolean {
  const beta = Object.entries(headers).find(([name]) => name.toLowerCase() === 'anthropic-beta')?.[1];
  return beta !== undefined && beta.split(',').some((value) => value.trim() === INLINE_TOOLS_BETA);
}

/** Whether any message carries a tool defined by value — the shape the refusal is for. */
export function hasInlineToolDefinitions(body: Buffer): boolean {
  // A cheap screen first: almost no request carries one, and parsing a
  // 100k-token body to learn that is the common case.
  if (!body.includes('"tool_definition"')) return false;
  const messages = parse(body)?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => isRecord(message) && Array.isArray(message.content) && message.content.some(
    (block) => isRecord(block) && block.type === 'tool_addition' && isRecord(block.tool) && block.tool.type === 'tool_definition',
  ));
}

/**
 * Applies every `tool_addition` / `tool_removal` block, in transcript order,
 * onto `tools[]`, and removes the blocks.
 *
 * - An addition by definition adds that tool, replacing one of the same name.
 * - An addition by reference re-adds a `tools[]` entry a removal took away —
 *   by reference means its definition is already in `tools[]`.
 * - A removal takes the named tool out.
 *
 * A message left with no content is dropped: an empty content array is a 400
 * upstream, and a turn that was only tool changes has nothing else to say.
 * A tool keeps its `tools[]` position; additions append.
 *
 * Deferred tools (`defer_loading: true`) start active here, not withheld
 * until an addition surfaces them. LiteLLM drops `defer_loading` and offers
 * every `tools[]` entry as a plain function regardless (checked against
 * 1.98.0's adapter), and Claude Code's ToolSearch surfaces a deferred tool
 * through `tool_reference` blocks inside a tool result, which LiteLLM drops
 * too — so withholding one would make it uncallable on this path, not lazy.
 *
 * Returns the same
 * buffer when there is nothing to fold, so a request without these blocks is
 * untouched.
 */
export function foldInlineToolChanges(body: Buffer): Buffer {
  if (!body.includes('"tool_addition"') && !body.includes('"tool_removal"')) return body;
  const payload = parse(body);
  if (payload === undefined || !Array.isArray(payload.messages)) return body;

  const declared = new Map<string, unknown>();
  for (const tool of Array.isArray(payload.tools) ? payload.tools : []) {
    if (isRecord(tool) && typeof tool.name === 'string') declared.set(tool.name, tool);
  }
  const current = new Map(declared);
  let changed = false;
  const messages: unknown[] = [];
  for (const message of payload.messages) {
    if (!isRecord(message) || !Array.isArray(message.content) || !message.content.some(isToolChange)) {
      messages.push(message);
      continue;
    }
    changed = true;
    for (const block of message.content.filter(isToolChange)) {
      const tool = isRecord(block.tool) ? block.tool : undefined;
      if (tool === undefined) continue;
      if (block.type === 'tool_removal') {
        if (typeof tool.name === 'string') current.delete(tool.name);
      } else if (tool.type === 'tool_definition' && isRecord(tool.definition) && typeof tool.definition.name === 'string') {
        current.set(tool.definition.name, tool.definition);
      } else if (tool.type === 'tool_reference' && typeof tool.name === 'string' && declared.has(tool.name)) {
        current.set(tool.name, declared.get(tool.name));
      }
    }
    const rest = message.content.filter((block) => !isToolChange(block));
    if (rest.length > 0) messages.push({ ...message, content: rest });
  }
  if (!changed) return body;
  const next: Json = { ...payload, messages };
  if (current.size > 0 || 'tools' in payload) next.tools = [...current.values()];
  return Buffer.from(JSON.stringify(next));
}

/** What a request's tool-change blocks carry, for the router's log; undefined when there are none. */
export function describeInlineToolChanges(body: Buffer): { byValue: number; byReference: number; removals: number } | undefined {
  if (!body.includes('"tool_addition"') && !body.includes('"tool_removal"')) return undefined;
  const messages = parse(body)?.messages;
  if (!Array.isArray(messages)) return undefined;
  const counts = { byValue: 0, byReference: 0, removals: 0 };
  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content.filter(isToolChange)) {
      const kind = isRecord(block.tool) ? block.tool.type : undefined;
      if (block.type === 'tool_removal') counts.removals += 1;
      else if (kind === 'tool_definition') counts.byValue += 1;
      else counts.byReference += 1;
    }
  }
  return counts.byValue + counts.byReference + counts.removals > 0 ? counts : undefined;
}

/**
 * Conversations already sent the refusal. Bounded oldest-first, like the
 * router's sticky map: a key evicted early only costs that conversation one
 * more refusal, which Claude Code answers by retrying.
 */
const refused = new Set<string>();
export const INLINE_TOOLS_REFUSED_MAX = 10_000;

export function inlineToolsRefusedFor(conversation: string): boolean {
  return refused.has(conversation);
}

export function markInlineToolsRefused(conversation: string): void {
  refused.delete(conversation);
  refused.add(conversation);
  while (refused.size > INLINE_TOOLS_REFUSED_MAX) {
    const oldest = refused.values().next().value;
    if (oldest === undefined) break;
    refused.delete(oldest);
  }
}

/**
 * Conversations whose inline tool changes have been logged, so the router
 * says once what a conversation sent rather than on every later turn that
 * still carries the same blocks. Bounded like `refused`.
 */
const noted = new Set<string>();

/** True the first time a conversation is seen here, false after. */
export function firstInlineToolNote(conversation: string): boolean {
  if (noted.has(conversation)) return false;
  noted.add(conversation);
  while (noted.size > INLINE_TOOLS_REFUSED_MAX) {
    const oldest = noted.values().next().value;
    if (oldest === undefined) break;
    noted.delete(oldest);
  }
  return true;
}

/** Test seam, cleared with the router's other per-conversation memory. */
export function clearInlineToolRefusals(): void {
  refused.clear();
  noted.clear();
}
