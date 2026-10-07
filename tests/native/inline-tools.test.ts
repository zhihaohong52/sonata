import { describe, expect, it, beforeEach } from 'vitest';
import {
  advertisesInlineTools, clearInlineToolRefusals, foldInlineToolChanges, hasInlineToolDefinitions,
  inlineToolsRefusedFor, markInlineToolsRefused, INLINE_TOOLS_BETA, INLINE_TOOLS_REFUSAL, INLINE_TOOLS_REFUSED_MAX,
} from '../../src/native/inline-tools.js';

// The wire shape Claude Code 2.1.292 sends when its tool set changes
// mid-conversation (its SDK's tool-change builder, and the prompt snapshots of
// the decision_model agents measured 2026-10-07).
const def = (name: string) => ({ name, description: `${name} tool`, input_schema: { type: 'object', properties: { command: { type: 'string' } } } });
const addByValue = (name: string) => ({ type: 'tool_addition', tool: { type: 'tool_definition', definition: def(name) } });
const addByRef = (name: string) => ({ type: 'tool_addition', tool: { type: 'tool_reference', name } });
const remove = (name: string) => ({ type: 'tool_removal', tool: { type: 'tool_reference', name } });
const body = (payload: unknown) => Buffer.from(JSON.stringify(payload));
const fold = (payload: unknown) => JSON.parse(foldInlineToolChanges(body(payload)).toString());
const names = (out: { tools?: Array<{ name: string }> }) => (out.tools ?? []).map((tool) => tool.name);

describe('foldInlineToolChanges', () => {
  it('moves a tool defined inside messages into tools[] and drops the turn that carried it', () => {
    const out = fold({
      tools: [def('Read')],
      messages: [
        { role: 'user', content: 'task' },
        { role: 'system', content: [addByValue('Bash'), addByValue('SubagentHandback')] },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      ],
    });
    expect(names(out)).toEqual(['Read', 'Bash', 'SubagentHandback']);
    expect(out.tools[1]).toEqual(def('Bash'));
    expect(out.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  });

  it('keeps the rest of a turn that also carries tool changes', () => {
    const out = fold({ messages: [{ role: 'system', content: [{ type: 'text', text: 'note' }, addByValue('Bash')] }] });
    expect(out.messages).toEqual([{ role: 'system', content: [{ type: 'text', text: 'note' }] }]);
    expect(names(out)).toEqual(['Bash']);
  });

  it('applies changes in transcript order: remove, re-add by reference, redefine', () => {
    const out = fold({
      tools: [def('Read'), def('Old')],
      messages: [
        { role: 'system', content: [remove('Old'), remove('Read')] },
        { role: 'user', content: 'go' },
        { role: 'system', content: [addByRef('Read'), addByValue('Bash')] },
        { role: 'system', content: [{ type: 'tool_addition', tool: { type: 'tool_definition', definition: { ...def('Bash'), description: 'v2' } } }] },
      ],
    });
    expect(names(out)).toEqual(['Read', 'Bash']);
    expect(out.tools[1].description).toBe('v2');
  });

  it('ignores a reference to a tool tools[] never declared — there is no definition to restore', () => {
    expect(names(fold({ tools: [def('Read')], messages: [{ role: 'system', content: [addByRef('Ghost')] }] }))).toEqual(['Read']);
  });

  it('removes a tool down to an empty tools[] rather than dropping the field', () => {
    const out = fold({ tools: [def('Read')], messages: [{ role: 'system', content: [remove('Read')] }] });
    expect(out.tools).toEqual([]);
  });

  it('returns the same buffer when there is nothing to fold', () => {
    const plain = body({ tools: [def('Read')], messages: [{ role: 'user', content: 'tool_addition is just a word here' }] });
    expect(foldInlineToolChanges(plain)).toBe(plain);
    const raw = Buffer.from('not json "tool_addition"');
    expect(foldInlineToolChanges(raw)).toBe(raw);
  });
});

describe('hasInlineToolDefinitions', () => {
  it('is true only for a tool defined by value inside messages', () => {
    expect(hasInlineToolDefinitions(body({ messages: [{ role: 'system', content: [addByValue('Bash')] }] }))).toBe(true);
    expect(hasInlineToolDefinitions(body({ messages: [{ role: 'system', content: [addByRef('Bash'), remove('X')] }] }))).toBe(false);
    expect(hasInlineToolDefinitions(body({ messages: [{ role: 'user', content: 'a "tool_definition" in prose' }] }))).toBe(false);
  });
});

describe('advertisesInlineTools', () => {
  it('reads the beta from a comma-separated anthropic-beta header, any case', () => {
    expect(advertisesInlineTools({ 'anthropic-beta': `claude-code-20250219, ${INLINE_TOOLS_BETA},effort-2025-11-24` })).toBe(true);
    expect(advertisesInlineTools({ 'Anthropic-Beta': INLINE_TOOLS_BETA })).toBe(true);
    expect(advertisesInlineTools({ 'anthropic-beta': 'mid-conversation-tool-changes-2026-07-01' })).toBe(false);
    expect(advertisesInlineTools({})).toBe(false);
  });
});

describe('INLINE_TOOLS_REFUSAL', () => {
  // Claude Code 2.1.292 sorts a 400 into a fallback by message. This one must
  // land in "inline definitions unsupported" and in no other bucket.
  it("matches Claude Code's inline-definition check and not its tool-change or system-turn checks", () => {
    expect(INLINE_TOOLS_REFUSAL).toMatch(/Input tag 'tool_definition'/);
    expect(INLINE_TOOLS_REFUSAL).not.toMatch(/Input tag 'tool_(addition|removal)'/);
    expect(INLINE_TOOLS_REFUSAL).not.toMatch(/mid-conversation|mid_conv|inline-tools-2026/);
  });
});

describe('refusal memory', () => {
  beforeEach(() => clearInlineToolRefusals());

  it('remembers a refused conversation and evicts the oldest past the bound', () => {
    markInlineToolsRefused('first');
    expect(inlineToolsRefusedFor('first')).toBe(true);
    for (let i = 0; i < INLINE_TOOLS_REFUSED_MAX; i++) markInlineToolsRefused(`c${i}`);
    expect(inlineToolsRefusedFor('first')).toBe(false);
    expect(inlineToolsRefusedFor(`c${INLINE_TOOLS_REFUSED_MAX - 1}`)).toBe(true);
  });
});
