#!/usr/bin/env node
// PreToolUse hook: records Claude Code's live permission mode so sonata can
// mirror it onto a foreign harness. The mode is not available as an env var.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
