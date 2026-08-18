import { describe, it, expect } from 'vitest';
import { TOOL_DEFS, callTool, truncateReport, MAX_REPORT_CHARS } from '../../src/mcp/tools.js';

describe('truncateReport', () => {
  it('leaves an ordinary report exactly as it is', () => {
    expect(truncateReport('a short report', 'abc123')).toBe('a short report');
  });

  it('keeps the head and says where the rest is', () => {
    const big = 'x'.repeat(MAX_REPORT_CHARS + 500);
    const out = truncateReport(big, 'abc123');
    expect(out.length).toBeLessThan(big.length);
    expect(out.startsWith('x'.repeat(100))).toBe(true);
    expect(out).toContain('[truncated: full transcript at `sonata log abc123`]');
  });

  it('does not truncate at exactly the limit', () => {
    const exact = 'x'.repeat(MAX_REPORT_CHARS);
    expect(truncateReport(exact, 'abc123')).toBe(exact);
  });
});

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
