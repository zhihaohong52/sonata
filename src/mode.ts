import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode } from './types.js';

const VALID: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];

/**
 * Claude Code does not expose the permission mode as an environment variable.
 * A PreToolUse hook writes it to .sonata/session-<id>.json; this reads it back.
 * Falls back to the safest mode when unknown.
 */
export function readPermissionMode(cwd: string, sessionId: string | undefined): PermissionMode {
  if (!sessionId) return 'default';
  const path = join(cwd, '.sonata', `session-${sessionId}.json`);
  if (!existsSync(path)) return 'default';
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { permissionMode?: string };
    const m = parsed.permissionMode as PermissionMode | undefined;
    return m && VALID.includes(m) ? m : 'default';
  } catch {
    return 'default';
  }
}
