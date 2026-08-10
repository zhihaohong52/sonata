#!/usr/bin/env node
// PreToolUse hook: records Claude Code's live permission mode so sonata can
// mirror it onto a foreign harness. The mode is not available as an env var.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * True when this project actually uses sonata. The hook is installed globally
 * and fires on every Bash call, so it must not create .sonata directories in
 * repositories that have nothing to do with sonata.
 */
function usesSonata(cwd) {
  return existsSync(join(cwd, 'sonata.toml')) || existsSync(join(cwd, '.sonata'));
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
    if (!usesSonata(cwd)) process.exit(0);

    const dir = join(cwd, '.sonata');
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
