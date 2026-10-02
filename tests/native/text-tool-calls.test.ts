import { describe, expect, it } from 'vitest';
import { coerceArguments, parseToolCallMarkup, toolSchemas } from '../../src/native/text-tool-calls.js';

const REQUEST = Buffer.from(JSON.stringify({
  model: 'm', messages: [],
  tools: [
    { name: 'Bash', input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } } } },
    { name: 'Edit', input_schema: { type: 'object', properties: {
      file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' },
    } } },
    { name: 'Todo', input_schema: { type: 'object', properties: { items: { type: 'array' }, meta: { type: 'object' }, n: { type: 'integer' } } } },
  ],
}));
const tools = toolSchemas(REQUEST);

describe('toolSchemas', () => {
  it('maps each request tool to its input_schema', () => {
    expect([...tools.keys()]).toEqual(['Bash', 'Edit', 'Todo']);
  });
  it('is empty for a body with no tools or that is not JSON', () => {
    expect(toolSchemas(Buffer.from('{"messages":[]}')).size).toBe(0);
    expect(toolSchemas(Buffer.from('not json')).size).toBe(0);
  });
});

describe('parseToolCallMarkup', () => {
  it('parses the Qwen-Coder form with newlines between tags', () => {
    const markup = '<tool_call>\n<function=Bash>\n<parameter=command>\nls /tmp\n</parameter>\n</function>\n</tool_call>';
    expect(parseToolCallMarkup(markup, tools)).toEqual({ name: 'Bash', input: { command: 'ls /tmp' } });
  });
  it('parses the compact form seen in the incident', () => {
    const markup = '<tool_call><function=Bash><parameter=command>cd /x && python3 -c "print(1)"</parameter></function></tool_call>';
    expect(parseToolCallMarkup(markup, tools)).toEqual({ name: 'Bash', input: { command: 'cd /x && python3 -c "print(1)"' } });
  });
  it('keeps a multi-line value intact apart from the one newline each tag adds', () => {
    const markup = '<tool_call><function=Bash><parameter=command>\nline1\n  line2\n</parameter></function></tool_call>';
    expect(parseToolCallMarkup(markup, tools)?.input).toEqual({ command: 'line1\n  line2' });
  });
  it('types arguments by the tool schema', () => {
    const markup = '<tool_call><function=Edit><parameter=file_path>/a.py</parameter><parameter=old_string>x</parameter>'
      + '<parameter=new_string>y</parameter><parameter=replace_all>false</parameter></function></tool_call>';
    expect(parseToolCallMarkup(markup, tools)?.input).toEqual({ file_path: '/a.py', old_string: 'x', new_string: 'y', replace_all: false });
  });
  it('returns undefined for a tool the request does not offer', () => {
    expect(parseToolCallMarkup('<tool_call><function=SubagentHandback><parameter=message>hi</parameter></function></tool_call>', tools)).toBeUndefined();
  });
  it('returns undefined for malformed markup', () => {
    expect(parseToolCallMarkup('<tool_call><function=Bash><parameter=command>ls</function></tool_call>', tools)).toBeUndefined();
    expect(parseToolCallMarkup('<tool_call>{"name":"Bash"}</tool_call>', tools)).toBeUndefined();
  });
  it('accepts a call with no parameters', () => {
    expect(parseToolCallMarkup('<tool_call><function=Bash></function></tool_call>', tools)).toEqual({ name: 'Bash', input: {} });
  });
});

describe('coerceArguments', () => {
  const schema = (toolSchemas(REQUEST).get('Todo'))!;
  it('converts integer, array and object by schema', () => {
    expect(coerceArguments({ n: '3', items: '[1,2]', meta: '{"a":1}' }, schema)).toEqual({ n: 3, items: [1, 2], meta: { a: 1 } });
  });
  it('leaves a value that does not convert as a string', () => {
    expect(coerceArguments({ n: '3.5', items: '{not json', meta: '[1]' }, schema)).toEqual({ n: '3.5', items: '{not json', meta: '[1]' });
  });
  it('keeps unknown keys and a missing schema as strings', () => {
    expect(coerceArguments({ other: 'true' }, schema)).toEqual({ other: 'true' });
    expect(coerceArguments({ x: '1' }, undefined)).toEqual({ x: '1' });
  });
  it('converts number and boolean', () => {
    const bash = toolSchemas(REQUEST).get('Bash')!;
    expect(coerceArguments({ timeout: '1.5e3', command: 'true' }, bash)).toEqual({ timeout: 1500, command: 'true' });
  });
});
