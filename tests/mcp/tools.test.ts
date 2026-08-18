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
  it('exposes exactly dispatch, wait and approve', () => {
    expect(TOOL_DEFS.map((t) => t.name).sort()).toEqual(['approve', 'dispatch', 'wait']);
  });

  it('declares the arguments each tool needs', () => {
    const dispatch = TOOL_DEFS.find((t) => t.name === 'dispatch')!;
    expect(Object.keys((dispatch.inputSchema as any).properties).sort())
      .toEqual(['model', 'role', 'task']);
    expect((dispatch.inputSchema as any).required.sort()).toEqual(['model', 'role', 'task']);

    const wait = TOOL_DEFS.find((t) => t.name === 'wait')!;
    expect((wait.inputSchema as any).required).toEqual(['id']);
  });

  it('raises the result-size ceiling for the tools that return reports', () => {
    for (const name of ['dispatch', 'wait']) {
      const def = TOOL_DEFS.find((t) => t.name === name)!;
      expect(def._meta?.['anthropic/maxResultSizeChars']).toBe(200_000);
    }
  });
});

describe('callTool', () => {
  const env = { cwd: '/repo', home: '/home', rolesDir: '/pkg/roles' };

  it('refuses a tool it does not define', async () => {
    await expect(callTool('rm', {}, env)).rejects.toThrow(/unknown tool/i);
  });

  it('requires the arguments the schema declares', async () => {
    await expect(callTool('dispatch', { role: 'code' }, env)).rejects.toThrow(/model/);
    await expect(callTool('wait', {}, env)).rejects.toThrow(/id/);
  });

  it('no longer offers the polling tools', async () => {
    await expect(callTool('tail', { id: 'abc123' }, env)).rejects.toThrow(/unknown tool/i);
    await expect(callTool('run', { role: 'code', model: 'm', task: 't' }, env))
      .rejects.toThrow(/unknown tool/i);
  });
});
