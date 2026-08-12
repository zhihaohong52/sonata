import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mcpRegistered, registerMcp, type McpScope } from '../src/settings.js';

let cwd: string;
let home: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'mcpreg-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'mcpreg-home-'));
});

const entry = (root: string) => ({
  type: 'stdio', command: 'node', args: [join(root, 'dist', 'cli.js'), 'mcp'], env: {},
});

describe('mcpRegistered — reads where Claude Code actually stores servers', () => {
  it('finds a project server in ./.mcp.json', () => {
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { sonata: entry('/pkg') } }));
    expect(mcpRegistered('project', cwd, home, '/pkg')).toBe(true);
  });

  // User scope lives in ~/.claude.json, NOT ~/.claude/mcp.json. Writing the
  // latter produced a registration Claude Code never read, and a doctor check
  // that passed while the server was invisible everywhere but one repo.
  it('finds a user server in ~/.claude.json', () => {
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      projects: {}, mcpServers: { sonata: entry('/pkg') },
    }));
    expect(mcpRegistered('user', cwd, home, '/pkg')).toBe(true);
  });

  it('does not find one in ~/.claude/mcp.json, which nothing reads', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'mcp.json'),
      JSON.stringify({ mcpServers: { sonata: entry('/pkg') } }));
    expect(mcpRegistered('user', cwd, home, '/pkg')).toBe(false);
  });

  it('is false when the server points at a different install', () => {
    writeFileSync(join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { sonata: entry('/somewhere-else') } }));
    expect(mcpRegistered('project', cwd, home, '/pkg')).toBe(false);
  });

  it('is false when nothing is registered anywhere', () => {
    expect(mcpRegistered('project', cwd, home, '/pkg')).toBe(false);
    expect(mcpRegistered('user', cwd, home, '/pkg')).toBe(false);
  });
});

describe('registerMcp — delegates to the claude CLI', () => {
  it('runs `claude mcp add` with the scope and this install', () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const res = registerMcp('user', cwd, '/pkg', (cmd, args) => {
      calls.push({ cmd, args });
      return { ok: true, output: 'Added stdio MCP server sonata' };
    });

    expect(res.changed).toBe(true);
    expect(calls[0].cmd).toBe('claude');
    expect(calls[0].args).toEqual([
      'mcp', 'add', '--scope', 'user', 'sonata', '--', 'node', join('/pkg', 'dist', 'cli.js'), 'mcp',
    ]);
  });

  // Claude Code owns ~/.claude.json — 100+ keys of live state that every
  // running session writes. Read-modify-write from sonata could clobber a
  // concurrent write, so the CLI does it.
  it('treats "already exists" as success, not failure', () => {
    const res = registerMcp('user', cwd, '/pkg', () =>
      ({ ok: false, output: 'MCP server sonata already exists in user config' }));
    expect(res.changed).toBe(false);
    expect(res.ok).toBe(true);
  });

  it('reports a real failure with the command to run by hand', () => {
    const res = registerMcp('user', cwd, '/pkg', () =>
      ({ ok: false, output: 'command not found: claude' }));
    expect(res.ok).toBe(false);
    expect(res.command).toContain('claude mcp add --scope user sonata');
  });
});
