#!/usr/bin/env node
// PreToolUse hook: records Claude Code's live permission mode so sonata can
// mirror it onto a foreign harness. The mode is not available as an env var.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where this session's mode belongs, or null when sonata is not in play.
 *
 * Mirrors how sonata resolves its config: a project that has its own setup
 * keeps its mode beside it, and a project relying on the machine config keeps
 * its mode beside *that*.
 *
 * The second case is why this is not simply "does the repo use sonata". With a
 * machine config, every directory is potentially a sonata project — but the
 * hook is installed globally and fires on every Bash call, so writing into the
 * repo would scatter .sonata/ directories across the whole machine. Writing
 * beside the machine config instead keeps one location for the sessions that
 * have no project of their own.
 */
function modeDir(cwd, home) {
  if (existsSync(join(cwd, 'sonata.toml')) || existsSync(join(cwd, '.sonata'))) {
    return join(cwd, '.sonata');
  }
  const machine = join(home, '.config', 'sonata');
  if (existsSync(join(machine, 'sonata.toml'))) return machine;
  return null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input || '{}');
    const sessionId = payload.session_id ?? payload.sessionId;
    const mode = payload.permission_mode ?? payload.permissionMode ?? 'default';
    if (!sessionId) process.exit(0);

    const cwd = process.env.SONATA_CWD ?? payload.cwd ?? process.cwd();
    const home = process.env.SONATA_HOME ?? homedir();

    const dir = modeDir(cwd, home);
    if (dir === null) process.exit(0);

    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `session-${sessionId}.json`),
      JSON.stringify({ permissionMode: mode, updatedAt: new Date().toISOString() }),
    );
  } catch {
    // A hook must never break the session it observes.
  }
  process.exit(0);
});
