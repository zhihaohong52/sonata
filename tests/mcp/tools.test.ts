import { describe, it, expect } from 'vitest';
import { TOOL_DEFS, callTool } from '../../src/mcp/tools.js';

describe('TOOL_DEFS', () => {
  it('exposes exactly run, tail and approve', () => {
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(['approve', 'run', 'tail']);
  });

  it('declares the arguments each tool needs', () => {
    const run = TOOL_DEFS.find((t) => t.name === 'run')!;
    expect(Object.keys((run.inputSchema as any).properties).sort())
      .toEqual(['model', 'role', 'task']);
    expect((run.inputSchema as any).required.sort()).toEqual(['model', 'role', 'task']);
  });
});

describe('callTool', () => {
  const env = { cwd: '/repo', home: '/home', rolesDir: '/pkg/roles' };

  it('refuses a tool it does not define', async () => {
    await expect(callTool('rm', {}, env)).rejects.toThrow(/unknown tool/i);
  });

  it('requires the arguments the schema declares', async () => {
    await expect(callTool('run', { role: 'code' }, env)).rejects.toThrow(/model/);
  });
});
